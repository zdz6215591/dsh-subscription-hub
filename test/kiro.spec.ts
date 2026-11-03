/**
 * Kiro route coverage: the AWS event-stream frame format, the conversation body
 * Kiro will accept, the reply's translation into harness chunks, the roster, the
 * credit allowance and key handling.
 *
 * Everything is offline. The frames are built here by a small encoder that is
 * deliberately independent of the decoder under test, so a shared mistake in the
 * offsets has to be made twice to pass.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  assertUsableKiroKey,
  fetchKiroModels,
  fetchKiroUsage,
  buildKiroRequest,
  classifyKiroFailure,
  decodeEventStream,
  exceptionText,
  kiroInputSchema,
  kiroPlanName,
  kiroToolId,
  kiroToolName,
  kiroUsageToProviderUsage,
  maskKiroKey,
  parseKiroModels,
  parseKiroUsage,
  regionOfProfileArn,
  sessionFromKiroKey,
} from '../src/providers/kiro/index.js'
import { readKiroReply, toStreamChunks } from '../src/providers/kiro/translate.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** Encode one frame the way AWS does; CRCs are zero because the decoder ignores them. */
function encodeFrame(headers: Record<string, string>, payload: string): Uint8Array {
  const encoder = new TextEncoder()
  const headerParts: Uint8Array[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name)
    const valueBytes = encoder.encode(value)
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
    part[0] = nameBytes.length
    part.set(nameBytes, 1)
    part[1 + nameBytes.length] = 7 // string
    new DataView(part.buffer).setUint16(1 + nameBytes.length + 1, valueBytes.length)
    part.set(valueBytes, 1 + nameBytes.length + 1 + 2)
    headerParts.push(part)
  }
  const headerLength = headerParts.reduce((sum, part) => sum + part.length, 0)
  const payloadBytes = encoder.encode(payload)
  const total = 12 + headerLength + payloadBytes.length + 4
  const frame = new Uint8Array(total)
  const view = new DataView(frame.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerLength)
  view.setUint32(8, 0) // prelude CRC: not verified
  let offset = 12
  for (const part of headerParts) {
    frame.set(part, offset)
    offset += part.length
  }
  frame.set(payloadBytes, offset)
  // message CRC left as zeros: not verified
  return frame
}

/** A stream that delivers the given byte chunks as they are. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index]!)
      index += 1
    },
  })
}

/** One event frame with `:event-type`. */
function eventFrame(type: string, body: unknown): Uint8Array {
  return encodeFrame({ ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' }, JSON.stringify(body))
}

async function collectFrames(body: ReadableStream<Uint8Array>): Promise<{ headers: Record<string, string>; payload: Uint8Array }[]> {
  const frames: { headers: Record<string, string>; payload: Uint8Array }[] = []
  for await (const frame of decodeEventStream(body)) frames.push(frame)
  return frames
}

test('kiro: the event stream decodes one frame, several frames, and a frame split across chunks', async () => {
  const first = eventFrame('assistantResponseEvent', { content: 'hello' })
  const second = eventFrame('contextUsageEvent', { contextUsagePercentage: 12 })
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first)
  joined.set(second, first.length)

  const together = await collectFrames(streamOf(joined))
  assert.equal(together.length, 2)
  assert.equal(together[0]?.headers[':event-type'], 'assistantResponseEvent')
  assert.equal(new TextDecoder().decode(together[0]?.payload), '{"content":"hello"}')
  assert.equal(together[1]?.headers[':event-type'], 'contextUsageEvent')

  // The same bytes, split mid-frame: the decoder holds the head until it is whole.
  const split = joined.length - 6
  const apart = await collectFrames(streamOf(joined.subarray(0, split), joined.subarray(split)))
  assert.equal(apart.length, 2)
})

test('kiro: a frame that declares an impossible length is refused, not decoded', async () => {
  const frame = eventFrame('assistantResponseEvent', { content: 'x' })
  // total length smaller than the 16-byte envelope
  new DataView(frame.buffer).setUint32(0, 8)
  await assert.rejects(() => collectFrames(streamOf(frame)), /malformed event stream/)
})

test('kiro: a stream that stops mid-frame is refused', async () => {
  const frame = eventFrame('assistantResponseEvent', { content: 'x' })
  await assert.rejects(() => collectFrames(streamOf(frame.subarray(0, frame.length - 3))), /ended mid-frame/)
})

test('kiro: an exception frame becomes a message that names the failure', async () => {
  const frame = encodeFrame({ ':message-type': 'exception', ':exception-type': 'ValidationException' }, JSON.stringify({
    message: 'Input is too long.',
    reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
  }))
  const [decoded] = await collectFrames(streamOf(frame))
  assert.equal(
    exceptionText(decoded?.headers[':exception-type'], decoded!.payload),
    'ValidationException: Input is too long. (CONTENT_LENGTH_EXCEEDS_THRESHOLD)',
  )
  assert.match(exceptionText('ThrottlingException', new TextEncoder().encode('{"message":"slow down"}')), /rate limited/)
})

test('kiro: tool names and ids are the ones Kiro accepts, and stable', () => {
  assert.equal(kiroToolName('read_file'), 'read_file')
  const long = `mcp__plugin_github_server__${'x'.repeat(80)}`
  const shortened = kiroToolName(long)
  assert.ok(shortened.length <= 64)
  assert.match(shortened, /^[A-Za-z0-9_-]+$/)
  assert.equal(kiroToolName(long), shortened, 'the same name always shortens the same way')

  assert.equal(kiroToolId('call_abc:1'), 'call_abc:1')
  const rewritten = kiroToolId('toolu_bad id with spaces')
  assert.match(rewritten, /^[a-zA-Z0-9_.:-]{1,64}$/)
  assert.equal(kiroToolId('toolu_bad id with spaces'), rewritten)
})

test('kiro: a tool schema gets an object root, and only its root is touched', () => {
  assert.deepEqual(kiroInputSchema({ properties: { a: { type: 'string' } } }), {
    type: 'object',
    properties: { a: { type: 'string' } },
  })
  assert.deepEqual(kiroInputSchema({ type: ['object', 'null'], properties: {} }), { type: 'object', properties: {} })
  assert.deepEqual(kiroInputSchema(undefined), { type: 'object', properties: {} })
  // A root naming another type is left exactly as written.
  assert.deepEqual(kiroInputSchema({ type: 'string' }), { type: 'string' })
})

/** A one-message conversation with a tool call and its result. */
function conversation(): { options: Parameters<typeof buildKiroRequest>[0]; messages: readonly TranslatableMessage[] } {
  const options = {
    provider: 'kiro',
    model: 'claude-sonnet-4.5',
    system: 'You are terse.',
    messages: [],
    tools: [{
      name: 'read_file',
      description: 'read a file',
      parameters: { properties: { path: { type: 'string' } }, required: ['path'] },
    }],
  } as unknown as Parameters<typeof buildKiroRequest>[0]
  const messages = [
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'read package.json' }],
      source: { kind: 'user' },
    },
    {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"package.json"}' },
      ],
      source: { kind: 'model' },
    },
    {
      id: 'm3',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '{"name":"x"}' }] }],
      source: { kind: 'tool' },
    },
    {
      id: 'm4',
      role: 'user',
      content: [{ type: 'text', text: 'now the version?' }],
      source: { kind: 'user' },
    },
  ] as unknown as readonly TranslatableMessage[]
  return { options, messages }
}

test('kiro: the body carries the system prompt, the tools, the call and its result', () => {
  const { options, messages } = conversation()
  const body = buildKiroRequest(options, messages, 'claude-sonnet-4.5', 'arn:aws:codewhisperer:eu-central-1:1:profile/abc')
  const state = body.conversationState as Record<string, unknown>
  const current = (state.currentMessage as { userInputMessage: Record<string, unknown> }).userInputMessage

  // The system prompt rides at the head of the message Kiro answers.
  assert.equal(current.content, 'You are terse.\n\nnow the version?')
  assert.equal(current.modelId, 'claude-sonnet-4.5')
  assert.equal(current.origin, 'KIRO_CLI')
  // Tools hang off the current message, with an object root.
  const tools = (current.userInputMessageContext as { tools: { toolSpecification: { name: string; inputSchema: { json: { type: string } } } }[] }).tools
  assert.equal(tools[0]?.toolSpecification.name, 'read_file')
  assert.equal(tools[0]?.toolSpecification.inputSchema.json.type, 'object')
  assert.equal(body.profileArn, 'arn:aws:codewhisperer:eu-central-1:1:profile/abc')

  const history = state.history as Record<string, unknown>[]
  // The assistant turn carries Kiro's `toolUses` shape.
  const assistant = history.find(entry => 'assistantResponseMessage' in entry)?.assistantResponseMessage as
    { content: string; toolUses: { name: string; toolUseId: string; input: unknown }[] }
  assert.equal(assistant.content, 'ok')
  assert.deepEqual(assistant.toolUses[0], { name: 'read_file', toolUseId: 'call_1', input: { path: 'package.json' } })
  // The result is its own user turn, as Kiro expects, with a text-only body.
  const withResult = history.filter(entry => 'userInputMessage' in entry)
    .map(entry => (entry as { userInputMessage: { userInputMessageContext?: { toolResults?: unknown[] } } }).userInputMessage)
    .find(message => message.userInputMessageContext?.toolResults !== undefined)
  assert.deepEqual(withResult?.userInputMessageContext?.toolResults, [
    { toolUseId: 'call_1', status: 'success', content: [{ text: '{"name":"x"}' }] },
  ])
})

test('kiro: a call the history left unanswered is reported as a failed result', () => {
  const { options } = conversation()
  const messages = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } },
    {
      id: 'm2',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_9', name: 'read_file', arguments: '{}' }],
      source: { kind: 'model' },
    },
    { id: 'm3', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } },
  ] as unknown as readonly TranslatableMessage[]
  const body = buildKiroRequest(options, messages, 'm', '')
  const history = body.conversationState.history as Record<string, unknown>[]
  const results = history
    .filter(entry => 'userInputMessage' in entry)
    .flatMap(entry => ((entry as { userInputMessage: { userInputMessageContext?: { toolResults?: unknown[] } } }).userInputMessage.userInputMessageContext?.toolResults) ?? []) as {
      toolUseId: string
      status: string
    }[]
  assert.deepEqual(results, [{ toolUseId: 'call_9', status: 'error', content: [{ text: 'Tool use was interrupted and did not produce a result.' }] }])
  assert.equal(body.profileArn, undefined, 'a key with no profile sends none')
})

test('kiro: reply frames become text, thinking, a tool call, usage and a finish', async () => {
  const frames = [
    eventFrame('assistantResponseEvent', { content: '<thinking>weighing</thinking>answer' }),
    eventFrame('toolUseEvent', { toolUseId: 'call_1', name: 'read_file', input: { path: 'a.txt' } }),
    eventFrame('metadataEvent', {
      stopReason: 'tool_use',
      tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 },
    }),
  ]
  async function* source(): AsyncGenerator<{ headers: Record<string, string>; payload: Uint8Array }> {
    for (const frame of frames) {
      for await (const decoded of decodeEventStream(streamOf(frame))) yield decoded
    }
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of toStreamChunks(readKiroReply(source(), 200_000, true), new Map())) chunks.push(chunk)

  const reasoning = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(reasoning, 'weighing')
  assert.equal(text, 'answer')
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(
    call?.type === 'block-end' ? call.block : undefined,
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  )
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage?.type === 'usage' ? usage.usage : undefined, {
    inputTokens: 105,
    outputTokens: 20,
    cacheReadTokens: 5,
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('kiro: a shortened tool name is handed back under the caller\u2019s own name', async () => {
  const long = `mcp__plugin_x__${'y'.repeat(70)}`
  const shortened = kiroToolName(long)
  const frames = [eventFrame('toolUseEvent', { toolUseId: 'call_2', name: shortened, input: { a: 1 } })]
  async function* source(): AsyncGenerator<{ headers: Record<string, string>; payload: Uint8Array }> {
    for (const frame of frames) {
      for await (const decoded of decodeEventStream(streamOf(frame))) yield decoded
    }
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of toStreamChunks(readKiroReply(source(), 0, false), new Map([[shortened, long]]))) chunks.push(chunk)
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(call?.type === 'block-end' && call.block.type === 'tool-call' ? call.block.name : '', long)
})

test('kiro: an exception frame fails the stream with a classified code', async () => {
  const frames = [encodeFrame(
    { ':message-type': 'exception', ':exception-type': 'ValidationException' },
    JSON.stringify({ message: 'Input is too long.', reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }),
  )]
  async function* source(): AsyncGenerator<{ headers: Record<string, string>; payload: Uint8Array }> {
    for (const frame of frames) {
      for await (const decoded of decodeEventStream(streamOf(frame))) yield decoded
    }
  }
  const chunks: StreamChunk[] = []
  await assert.rejects(async () => {
    for await (const chunk of toStreamChunks(readKiroReply(source(), 0, false), new Map())) chunks.push(chunk)
  }, /input is too long|Input is too long/)
})

test('kiro: failures are classified by what Kiro says', () => {
  assert.equal(classifyKiroFailure('Input is too long. (CONTENT_LENGTH_EXCEEDS_THRESHOLD)'), 'INVALID_REQUEST')
  assert.equal(classifyKiroFailure('MODEL_CONTEXT_WINDOW_EXCEEDED'), 'INVALID_REQUEST')
  assert.equal(classifyKiroFailure('MONTHLY_REQUEST_COUNT exceeded'), 'QUOTA_EXCEEDED')
  assert.equal(classifyKiroFailure('ThrottlingException: too many requests'), 'RATE_LIMIT')
  assert.equal(classifyKiroFailure('INSUFFICIENT_MODEL_CAPACITY'), 'UPSTREAM_ERROR')
})

test('kiro: the roster keeps the default first and reads only the limits it states', () => {
  const parsed = parseKiroModels({
    models: [
      { modelId: 'a', modelName: 'Model A', tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }, supportedInputTypes: ['TEXT'] },
      { modelId: 'b', modelName: 'Model B', supportedInputTypes: ['TEXT', 'IMAGE'] },
    ],
    defaultModel: { modelId: 'b' },
  })
  assert.deepEqual(parsed.models.map(model => model.id), ['a', 'b'])
  assert.deepEqual(parsed.models[0], {
    id: 'a', name: 'Model A', contextWindow: 200000, maxOutputTokens: 64000, supportsImages: false,
  })
  // No limits stated: none invented.
  assert.equal(parsed.models[1]?.contextWindow, undefined)
  assert.equal(parsed.models[1]?.supportsImages, true)
})

test('kiro: the allowance maps to credits, with trial and bonus aside', () => {
  const now = 1_700_000_000_000
  const snapshot = parseKiroUsage({
    subscriptionInfo: { subscriptionTitle: 'KIRO PRO' },
    userInfo: { email: 'a@b.c' },
    usageBreakdownList: [{
      displayNamePlural: 'Credits',
      currentUsageWithPrecision: 250,
      usageLimitWithPrecision: 1000,
      nextDateReset: 1_700_100_000,
      freeTrialInfo: {
        freeTrialStatus: 'ACTIVE', currentUsageWithPrecision: 10, usageLimitWithPrecision: 100, freeTrialExpiry: 1_700_050_000,
      },
      bonuses: [
        { status: 'ACTIVE', currentUsage: 5, usageLimit: 50, expiresAt: 1_700_050_000, displayName: 'First upgrade' },
        { status: 'EXPIRED', currentUsage: 0, usageLimit: 50, expiresAt: 1_700_000_000 },
      ],
    }],
  }, now)
  assert.equal(snapshot?.plan, 'Kiro Pro')
  assert.equal(snapshot?.user, 'a@b.c')
  assert.deepEqual(snapshot?.allowances.map(allowance => allowance.name), ['Free trial', 'Credits', 'First upgrade'])

  const usage = kiroUsageToProviderUsage(snapshot!)
  assert.equal(usage.supported, true)
  assert.equal(usage.unit, 'credits')
  assert.equal(usage.limit, 1000)
  assert.equal(usage.remaining, 750)
  assert.equal(usage.windows?.[1]?.usedPercent, 25)
  assert.equal(usage.windows?.[1]?.unit, 'credits')
})

test('kiro: an answer stating no allowance is not a zero balance', () => {
  assert.equal(parseKiroUsage({ usageBreakdownList: [] }), undefined)
  assert.equal(kiroPlanName('KIRO FREE'), 'Kiro Free')
  assert.equal(kiroPlanName(undefined), undefined)
})

test('kiro: the region comes from the profile ARN, and the key shape is checked', () => {
  assert.equal(regionOfProfileArn('arn:aws:codewhisperer:eu-central-1:123:profile/x'), 'eu-central-1')
  assert.equal(regionOfProfileArn(undefined), 'us-east-1')
  assert.equal(regionOfProfileArn('not-an-arn'), 'us-east-1')

  assert.equal(assertUsableKiroKey('  ksk_AbCdEf123456  ', 'kiro'), 'ksk_AbCdEf123456')
  assert.throws(() => assertUsableKiroKey('', 'kiro'), /empty/)
  assert.throws(() => assertUsableKiroKey('Bearer ksk_abcdefgh', 'kiro'), /whitespace/)
  assert.throws(() => assertUsableKiroKey('ya29.something', 'kiro'), /does not look like a Kiro API key/)
  assert.equal(maskKiroKey('ksk_AbCdEf123456'), 'ksk_AbCd…3456')
})

test('kiro: a pasted key becomes a static session in the region its profile names', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ profile: { arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/p' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const session = await sessionFromKiroKey('ksk_AbCdEf123456', 'kiro-ksk_AbCd…3456', fetchFn)
  assert.equal(session.account, 'kiro-ksk_AbCd…3456')
  assert.equal(session.region, 'eu-central-1')
  assert.equal(session.profileArn, 'arn:aws:codewhisperer:eu-central-1:1:profile/p')
  assert.ok(session.expiresAt > Date.now() + 3000 * 24 * 60 * 60 * 1000)
})

test('kiro: a signed-in token lists models over REST, an API key over AWS-JSON', async () => {
  const roster = { models: [{ modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', tokenLimits: { maxInputTokens: 200000 } }] }
  const calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      ...init.method === undefined ? {} : { method: init.method },
      headers: init.headers as Record<string, string>,
      ...init.body === undefined ? {} : { body: String(init.body) },
    })
    return new Response(JSON.stringify(roster), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  // A browser sign-in: REST path, profile in the query, no AWS-JSON target.
  const signedIn = await fetchKiroModels(fetchFn, {
    region: 'eu-central-1',
    token: 'signed-in-token',
    method: 'social',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/p',
  })
  assert.equal(signedIn.models.length, 1)
  assert.equal(signedIn.api, 'management')
  const rest = calls[0]!
  assert.equal(rest.method, 'GET')
  assert.match(rest.url, /^https:\/\/management\.eu-central-1\.kiro\.dev\/List-Available-Models\?/)
  assert.match(rest.url, /origin=KIRO_CLI/)
  assert.match(rest.url, /profileArn=arn%3Aaws%3Acodewhisperer/)
  assert.equal(rest.headers.Authorization, 'Bearer signed-in-token')
  assert.equal(rest.headers.tokentype, undefined, 'a signed-in token carries no tokentype')
  assert.equal(rest.headers['X-Amz-Target'], undefined)

  // An API key: the AWS-JSON operation at the host root, exactly as kiro-cli does.
  calls.length = 0
  const bearer = await fetchKiroModels(fetchFn, { region: 'us-east-1', token: 'ksk_AbCdEf123456', method: 'apikey' })
  assert.equal(bearer.api, 'bearer')
  const rpc = calls[0]!
  assert.equal(rpc.method, 'POST')
  assert.equal(rpc.url, 'https://management.us-east-1.kiro.dev/?origin=KIRO_CLI')
  assert.equal(rpc.headers['X-Amz-Target'], 'KiroControlPlaneBearerService.ListAvailableModels')
  assert.equal(rpc.headers.tokentype, 'API_KEY')
})

test('kiro: a signed-in sign-in without a profile says so instead of asking', async () => {
  const fetchFn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  await assert.rejects(
    () => fetchKiroModels(fetchFn, { region: 'us-east-1', token: 't', method: 'idc' }),
    /named no profile/,
  )
})

test('kiro: the allowance is read over REST for a sign-in, over AWS-JSON for a key', async () => {
  const allowance = {
    usageBreakdownList: [{
      displayNamePlural: 'Credits',
      currentUsageWithPrecision: 100,
      usageLimitWithPrecision: 1000,
      nextDateReset: 1_700_100_000,
    }],
    subscriptionInfo: { subscriptionTitle: 'KIRO PRO' },
  }
  const calls: { url: string; method?: string; headers: Record<string, string> }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), ...init.method === undefined ? {} : { method: init.method }, headers: init.headers as Record<string, string> })
    return new Response(JSON.stringify(allowance), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const signedIn = await fetchKiroUsage(fetchFn, {
    region: 'us-east-1', token: 't', method: 'social', profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/p',
  })
  assert.equal(signedIn.supported, true)
  assert.equal(signedIn.remaining, 900)
  assert.equal(calls[0]?.method, 'GET')
  assert.match(calls[0]?.url ?? '', /\/Get-Usage-Limits\?.*resourceType=CREDIT/)
  assert.match(calls[0]?.url ?? '', /isEmailRequired=true/)

  calls.length = 0
  const keyed = await fetchKiroUsage(fetchFn, { region: 'us-east-1', token: 'ksk_x', method: 'apikey' })
  assert.equal(keyed.supported, true)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.headers['X-Amz-Target'], 'AmazonCodeWhispererService.GetUsageLimits')
})
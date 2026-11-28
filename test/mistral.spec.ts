/**
 * The Mistral (Vibe Pro / Team) route.
 *
 * The wire is Mistral's own OpenAI-compatible API, so the interesting parts are
 * what this route must NOT invent: a context window the roster did not state, a
 * quota expressed in tokens when the service reports percentages, and a
 * `prompt_cache_key` that would never hit.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  MISTRAL_API_BASE,
  MistralAdapter,
  assertUsableMistralKey,
  maskMistralKey,
  collapseMistralAliases,
  mistralUsageFromBilling,
  parseMistralModels,
  sessionFromMistralKey,
} from '../src/providers/mistral.js'
import type { MistralAdapterOptions } from '../src/providers/mistral.js'
import type { MistralSession } from '../src/auth/store.js'

function tokensFor(session: MistralSession) {
  return {
    session: async () => session,
    list: async () => [{ key: 'a', session, isDefault: true }],
    hasSession: async () => true,
  } as unknown as MistralAdapterOptions['tokens']
}

function adapterWith(fetchFn: typeof fetch, overrides: Partial<MistralAdapterOptions> = {}) {
  return new MistralAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensFor(sessionFromMistralKey('test-key-0123456789', 'mistral-test')),
    discovery: true,
    fetchFn: fetchFn as never,
    ...overrides,
  })
}

const OPTIONS: GenerateOptions = {
  provider: 'mistral',
  model: 'mistral-large-latest',
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
} as never

test('mistral: the roster keeps what /v1/models states and nothing it does not', () => {
  const models = parseMistralModels({
    data: [
      { id: 'mistral-large-latest', name: 'Mistral Large', max_context_length: 131072, capabilities: { vision: true } },
      { id: 'codestral-latest', capabilities: { vision: false } },
      { id: 'codestral-latest', capabilities: {} },
      { notAnId: true },
    ],
  })
  assert.deepEqual(models.map(model => model.id), ['mistral-large-latest', 'codestral-latest'])
  assert.equal(models[0]?.contextWindow, 131072)
  assert.equal(models[0]?.supportsImages, true)
  // No stated window: none published, rather than a plausible default.
  assert.equal(models[1]?.contextWindow, undefined)
  assert.equal(models[1]?.supportsImages, false)
})

test('mistral: usage_percentage is a percentage, not a fraction', () => {
  // The console is the authority here: it showed 0.06 USD used of 15 while the
  // API reported usage_percentage 0.41892786666666665, i.e. 0.4189%.
  const usage = mistralUsageFromBilling(
    { plan_name: 'EDU' },
    {
      vibe_budget: { usage_percentage: 0, initial_budget: 150, currency: 'USD', reset_at: '2026-12-01T00:00:00Z' },
      api_budget: { usage_percentage: 0.41892786666666665, initial_budget: 15, currency: 'USD', reset_at: '2026-12-01T00:00:00Z' },
    },
  )
  assert.equal(usage.supported, true)
  if (!usage.supported) throw new Error('unreachable')
  assert.equal(usage.plan, 'EDU')
  const windows = usage.windows ?? []
  assert.equal(windows.length, 2)
  assert.equal(windows[0]?.usedPercent, 0)
  assert.equal(windows[0]?.limit, 150)
  assert.equal(windows[0]?.unit, 'currency', 'the amounts are dollars, not a percentage')
  // Not scaled: the earlier reading multiplied by 100 and showed 41.89%.
  assert.ok(Math.abs((windows[1]?.usedPercent ?? 0) - 0.41892786666666665) < 1e-12)
  assert.ok(Math.abs((windows[1]?.used ?? 0) - 0.06283918) < 1e-6, 'about the figure the console shows')
  assert.ok(Math.abs((windows[1]?.remaining ?? 0) - 14.93716082) < 1e-6)
  assert.equal(windows[1]?.resetsAt, Date.parse('2026-12-01T00:00:00Z'), 'the reset date is kept')
  // A percentage of 100 is the cap, not 10000.
  const full = mistralUsageFromBilling({}, { budget: { usage_percentage: 100, initial_budget: 100 } })
  if (!full.supported) throw new Error('unreachable')
  assert.equal(full.windows?.[0]?.usedPercent, 100)
  assert.equal(full.windows?.[0]?.remaining, 0)
})

test('mistral: an empty billing answer reports no quota instead of zeroes', () => {
  assert.deepEqual(mistralUsageFromBilling({}, {}), { supported: false })
  assert.deepEqual(mistralUsageFromBilling(undefined, undefined), { supported: false })
})

test('mistral: a pasted key is validated before it reaches the store', () => {
  assert.equal(assertUsableMistralKey('  abcdefghijklmnop1234  ', 'mistral'), 'abcdefghijklmnop1234')
  assert.throws(() => assertUsableMistralKey('', 'mistral'), (error: unknown) => error instanceof LlmError)
  assert.throws(
    () => assertUsableMistralKey('Bearer abcdefghijklmnop1234', 'mistral'),
    /looks like a request header/,
  )
  assert.throws(() => assertUsableMistralKey('short', 'mistral'), /does not look like a Mistral API key/)
  assert.equal(maskMistralKey('abcdefghijklmnop1234'), 'abcd…1234')
})

test('mistral: the stream carries the key, the model and the streamed answer', async () => {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string> ?? {}) }
    requests.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch

  const adapter = adapterWith(fetchFn)
  const options: GenerateOptions = {
    ...OPTIONS,
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  } as never
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, `${MISTRAL_API_BASE}/chat/completions`)
  assert.equal(requests[0]?.headers.authorization, 'Bearer test-key-0123456789')
  assert.equal(requests[0]?.body.model, 'mistral-large-latest')
  assert.equal(requests[0]?.body.stream, true)
  assert.equal(Array.isArray(requests[0]?.body.tools), true, 'tools go out on the OpenAI shape')
  // No cache key: this route does not own a conversation's lifetime, so a key
  // it sent would never hit.
  assert.equal(requests[0]?.body.prompt_cache_key, undefined)

  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'hello')
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), true)
})

test('mistral: a rejected key surfaces as a credential error', async () => {
  const fetchFn = (async () => new Response('{"message":"Invalid API key"}', { status: 401 })) as unknown as typeof fetch
  const adapter = adapterWith(fetchFn)
  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream(OPTIONS)) { /* drain */ }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.match(error.message, /mistral error \(HTTP 401\)/)
      return true
    },
  )
})

test('mistral: the roster merges the operator\'s configured rows over the live list', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    data: [{ id: 'live-model', max_context_length: 32_000 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const adapter = adapterWith(fetchFn, { models: [{ id: 'hand-added' }] })
  const models = await adapter.listOwnModels('mistral')
  assert.deepEqual(models.map(model => model.id).sort(), ['hand-added', 'live-model'])
})

test('mistral: reasoning models advertise efforts, others advertise none', async () => {
  // Measured: `reasoning_effort` is honoured (102 / 193 / 64 reasoning tokens for
  // none / high / low), but only for models declaring `capabilities.reasoning`.
  const fetchFn = (async () => new Response(JSON.stringify({
    data: [
      { id: 'mistral-large-latest', max_context_length: 1_048_576, capabilities: { reasoning: true, vision: true } },
      { id: 'codestral-latest', max_context_length: 256_000, capabilities: { reasoning: false } },
    ],
  }), { status: 200 })) as unknown as typeof fetch
  const adapter = adapterWith(fetchFn)
  await adapter.listOwnModels('mistral')

  const reasoning = await adapter.resolveOwnModel('mistral', 'mistral-large-latest')
  assert.deepEqual(reasoning.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  const plain = await adapter.resolveOwnModel('mistral', 'codestral-latest')
  assert.equal(plain.reasoning, undefined, 'no axis for a model that does not reason')
})

test('mistral: the effort is sent as reasoning_effort, and only for such a model', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'mistral-large-latest', capabilities: { reasoning: true } },
          { id: 'codestral-latest', capabilities: { reasoning: false } },
        ],
      }), { status: 200 })
    }
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const adapter = adapterWith(fetchFn)
  await adapter.listOwnModels('mistral')

  for await (const _chunk of adapter.stream({ ...OPTIONS, model: 'mistral-large-latest', reasoningEffort: 'high' } as never)) { /* drain */ }
  for await (const _chunk of adapter.stream({ ...OPTIONS, model: 'codestral-latest', reasoningEffort: 'high' } as never)) { /* drain */ }

  assert.equal(bodies[0]?.reasoning_effort, 'high', 'a reasoning model gets the level it asked for')
  assert.equal(bodies[1]?.reasoning_effort, undefined, 'a model without the capability is not sent one')
})
test('mistral: a wallet funded with nothing is not shown', () => {
  // The Vibe CLI's own credential reports exactly this: a 10 USD plan allowance and
  // an `api_budget` of 0, which used to render as a "$0 / $0" line.
  const usage = mistralUsageFromBilling(
    { plan_name: 'FREE' },
    {
      vibe_budget: { usage_percentage: 0, initial_budget: 10, currency: 'USD' },
      api_budget: { usage_percentage: 0, initial_budget: 0, currency: 'USD' },
    },
  )
  assert.equal(usage.supported, true)
  if (!usage.supported) throw new Error('unreachable')
  assert.equal(usage.plan, 'FREE')
  assert.deepEqual((usage.windows ?? []).map(window => window.scope), ['Vibe allowance (plan)'])
  // Every wallet empty still reports unsupported rather than a row of zeroes.
  assert.deepEqual(mistralUsageFromBilling({}, { api_budget: { initial_budget: 0 } }), { supported: false })
})
test('mistral: the picker serves the union of every account, because one roster can be partial', async () => {
  // Measured: a FREE Vibe key listed 51 Mistral-only ids while
  // `deepseek-v4-1-flash-1017` answered 200 for that same key.
  const session = sessionFromMistralKey('test-key-0123456789', 'mistral-test')
  const fetchFn = (async () => new Response(JSON.stringify({
    data: [{ id: 'mistral-small-latest', capabilities: {} }],
  }), { status: 200 })) as unknown as typeof fetch
  const adapter = new MistralAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    discovery: true,
    fetchFn: fetchFn as never,
    tokens: {
      session: async () => session,
      list: async () => [
        { key: 'a', session, isDefault: true },
        { key: 'b', session, isDefault: false },
      ],
      hasSession: async () => true,
    } as unknown as MistralAdapterOptions['tokens'],
  })
  const models = await adapter.listOwnModels('mistral')
  assert.deepEqual(models.map(model => model.id), ['mistral-small-latest'], 'duplicates collapse across accounts')
})
test('mistral: requests carry the Vibe attribution metadata that bills the plan allowance', async () => {
  // Measured on the live account: the same key and model billed `api_budget`
  // without this metadata and `vibe_budget` with it (+0.000029 % of the 150 USD
  // allowance, API wallet untouched). `call_type` follows the CLI: the turn's first
  // call is main_call, later ones secondary_call.
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'mistral-medium-latest', capabilities: {} }] }), { status: 200 })
    }
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const adapter = new MistralAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    discovery: true,
    fetchFn: fetchFn as never,
    planName: 'EDU',
    tokens: {
      session: async () => sessionFromMistralKey('test-key-0123456789', 'mistral-test'),
      list: async () => [{ key: 'a', session: sessionFromMistralKey('test-key-0123456789', 'mistral-test'), isDefault: true }],
      hasSession: async () => true,
    } as unknown as MistralAdapterOptions['tokens'],
  })
  for await (const _chunk of adapter.stream({ ...OPTIONS, model: 'mistral-medium-latest' } as never)) { /* drain */ }
  const metadata = bodies[0]?.metadata as Record<string, unknown> | undefined
  assert.ok(metadata !== undefined, 'the attribution metadata is present')
  assert.equal(metadata.call_type, 'main_call')
  assert.equal(metadata.user_plan, 'EDU')
  assert.equal(typeof metadata.version, 'string')
  assert.equal(typeof metadata.os, 'string')
  assert.equal(metadata.session_id, undefined, 'no session id on an options object without one')
})

test('mistral: the attribution can be switched off', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const adapter = new MistralAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    discovery: false,
    fetchFn: fetchFn as never,
    vibeAttribution: false,
    tokens: {
      session: async () => sessionFromMistralKey('test-key-0123456789', 'mistral-test'),
      list: async () => [{ key: 'a', session: sessionFromMistralKey('test-key-0123456789', 'mistral-test'), isDefault: true }],
      hasSession: async () => true,
    } as unknown as MistralAdapterOptions['tokens'],
  })
  for await (const _chunk of adapter.stream(OPTIONS)) { /* drain */ }
  assert.equal(bodies[0]?.metadata, undefined, 'switched off means no metadata at all')
})
test('mistral: an empty allowance falls back to the pay-as-you-go wallet, once', async () => {
  // Measured: a 402 means the plan allowance is spent, and the SAME request without
  // the attribution metadata bills the API wallet instead.
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(payload)
    if (payload.metadata !== undefined) {
      return new Response('{"error":{"code":"billing_api_budget_exhausted"}}', { status: 402 })
    }
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const adapter = new MistralAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    discovery: false,
    fetchFn: fetchFn as never,
    planName: 'EDU',
    tokens: {
      session: async () => sessionFromMistralKey('test-key-0123456789', 'mistral-test'),
      list: async () => [{ key: 'a', session: sessionFromMistralKey('test-key-0123456789', 'mistral-test'), isDefault: true }],
      hasSession: async () => true,
    } as unknown as MistralAdapterOptions['tokens'],
  })
  let text = ''
  for await (const chunk of adapter.stream(OPTIONS)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  assert.equal(text, 'ok', 'the retry streamed the answer')
  assert.equal(bodies.length, 2, 'one attempt on the allowance, one on the wallet')
  assert.ok(bodies[0]?.metadata !== undefined)
  assert.equal(bodies[1]?.metadata, undefined, 'the fallback carries no attribution')
})
test('mistral: alias rows collapse to one model, so no label repeats', () => {
  // Live shape: `mistral-medium-latest` and its eight aliases arrive as nine rows
  // that all carry the same display name.
  const parsed = parseMistralModels({
    data: [
      { id: 'mistral-medium-latest', name: 'mistral-medium-latest', aliases: ['mistral-medium', 'mistral-medium-3'] },
      { id: 'mistral-medium', name: 'mistral-medium-latest', aliases: ['mistral-medium-latest', 'mistral-medium-3'] },
      { id: 'mistral-medium-3', name: 'mistral-medium-latest', aliases: ['mistral-medium-latest', 'mistral-medium'] },
      { id: 'codestral-2508', name: 'codestral-2508', aliases: ['codestral-latest'] },
      { id: 'codestral-latest', name: 'codestral-2508', aliases: ['codestral-2508'] },
      { id: 'zai-glm-5-3', name: 'zai-glm-5-3' },
    ],
  })
  assert.equal(parsed.length, 6)
  const collapsed = collapseMistralAliases(parsed)
  assert.deepEqual(collapsed.map(model => model.id).sort(), ['codestral-2508', 'mistral-medium-latest', 'zai-glm-5-3'])
  assert.equal(new Set(collapsed.map(model => model.name)).size, collapsed.length, 'no repeated labels')
  const medium = collapsed.find(model => model.id === 'mistral-medium-latest')
  assert.deepEqual([...(medium?.aliases ?? [])].sort(), ['mistral-medium', 'mistral-medium-3'])
})
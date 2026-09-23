/**
 * The SSE envelope decoder.
 *
 * Golden fixtures ported from the reference's `tests/qoder/sse.test.ts`, kept
 * verbatim in their wire shapes: the empty/null tool-call ids and names that
 * real gateways emit in parameter deltas, the interleaved parallel tool calls,
 * the split thinking tag, and the 200-with-a-failure-envelope rejection whose
 * body is the only place the real reason appears.
 *
 * Only the CODE expectations differ, because the hub's vocabulary does: the
 * reference's provider-private `MALFORMED_RESPONSE` folds into `TRANSPORT`, and
 * an exhausted quota now classifies as `QUOTA` rather than `AUTH` (the defect
 * the reference's own comment describes — a rejected-for-credits chat that told
 * the user to sign in again).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { parseQoderSse } from '../src/providers/qoder/sse.js'
import { qoderEncodeBody } from '../src/providers/qoder/encoding.js'

function streamOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function data(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}`
}

const done = `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`

test('parseQoderSse unwraps text, disjoint usage, and envelope-body DONE', async () => {
  const body = JSON.stringify({
    choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    },
  })
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    `data: ${JSON.stringify({ statusCodeValue: 200, body })}`,
    `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`,
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual((chunks[3] as { usage: unknown }).usage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  })
})

test('parseQoderSse reports reasoning tokens when the provider counts them', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: {
      prompt_tokens: 5,
      completion_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 4 },
    } }),
    done,
  ]))) chunks.push(chunk)
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 5, outputTokens: 9, reasoningTokens: 4 } })
})

test('parseQoderSse separates native reasoning and removes cross-channel thinking tags', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { reasoning_content: '<thinking>inspect the input' } }] }),
    data({ choices: [{ delta: { content: '</thinking>\n\nFinal answer' }, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)

  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end', 'finish',
  ])
  assert.deepEqual((chunks[2] as { block: unknown }).block, { type: 'reasoning', text: 'inspect the input' })
  assert.deepEqual((chunks[5] as { block: unknown }).block, { type: 'text', text: 'Final answer' })
  assert.equal((chunks[6] as { reason: { kind: string } }).reason.kind, 'stop')
})

test('parseQoderSse extracts thinking tags split across content chunks', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { content: '<thi' } }] }),
    data({ choices: [{ delta: { content: 'nk>careful</th' } }] }),
    data({ choices: [{ delta: { content: 'ink>\nanswer' }, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: 'careful' },
    { type: 'text', text: 'answer' },
  ])
})

test('parseQoderSse assembles interleaved parallel tool calls', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-a', function: { name: 'add', arguments: '{"a":' } },
      { index: 1, id: 'call-b', function: { name: 'echo', arguments: '{"text":' } },
    ] } }] }),
    data({ choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: '"ok"}' } },
      { index: 0, function: { arguments: '2}' } },
    ] }, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)

  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'tool-call', id: 'call-a', name: 'add', arguments: '{"a":2}' },
    { type: 'tool-call', id: 'call-b', name: 'echo', arguments: '{"text":"ok"}' },
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
})

test('parseQoderSse normalizes absent tool arguments to an empty object', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-empty', function: { name: 'ping' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(blockEnd?.block, {
    type: 'tool-call', id: 'call-empty', name: 'ping', arguments: '{}',
  })
})

test('parseQoderSse tolerates subsequent tool-call deltas with empty string or null id', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-tolerant', function: { name: 'calc', arguments: '{"x":' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '1' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { arguments: '0}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(blockEnd?.block, {
    type: 'tool-call', id: 'call-tolerant', name: 'calc', arguments: '{"x":10}',
  })
})

test('parseQoderSse tolerates subsequent tool-call deltas with empty string or null name', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-tolerant-name', function: { name: 'calc', arguments: '{"x":' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '1' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '0}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    done,
  ]))) chunks.push(chunk)
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(blockEnd?.block, {
    type: 'tool-call', id: 'call-tolerant-name', name: 'calc', arguments: '{"x":10}',
  })
})

test('parseQoderSse accepts a reasoning-only response', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { reasoning_content: 'Only reasoning' }, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-end', 'finish',
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'stop')
})

test('parseQoderSse reports an empty completion as an error finish, not an empty turn', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    done,
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'Model returned a completed response with no content.', code: 'EMPTY_RESPONSE' },
    },
  }])
})

test('parseQoderSse maps a length stop to max-tokens', async () => {
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { content: 'truncated' }, finish_reason: 'length' }] }),
    done,
  ]))) chunks.push(chunk)
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'max-tokens')
})

test('parseQoderSse rejects malformed tool calls and unknown finish reasons', async () => {
  const invalidStreams = [
    [
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-bad', function: { name: 'bad', arguments: '{' } }] } }] }),
      done,
    ],
    [data({ choices: [{ delta: { content: 'blocked' }, finish_reason: 'new_reason' }] }), done],
  ]
  for (const lines of invalidStreams) {
    await assert.rejects(async () => {
      for await (const _chunk of parseQoderSse(streamOf(lines))) continue
    }, (error: Error) => error instanceof LlmError && error.code === 'TRANSPORT')
  }
})

test('parseQoderSse classifies a content-filter stop as unsupported', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      data({ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }),
      done,
    ]))) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'UNSUPPORTED')
})

test('parseQoderSse accepts a final frame without a trailing newline', async () => {
  const encoder = new TextEncoder()
  const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n`))
      controller.enqueue(encoder.encode('data: [DONE]'))
      controller.close()
    },
  })
  const chunks = []
  for await (const chunk of parseQoderSse(stream)) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('parseQoderSse accepts statusless envelopes and ignores bodyless control frames', async () => {
  const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    `data: ${JSON.stringify({ event: 'ping' })}`,
    `data: ${JSON.stringify({ body: inner })}`,
    `data: ${JSON.stringify({ body: '[DONE]' })}`,
  ]))) chunks.push(chunk)

  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'block-end', 'finish',
  ])
  assert.equal((chunks.at(-1) as { reason: { kind: string } }).reason.kind, 'stop')
})

test('parseQoderSse ignores SSE comment and non-data lines', async () => {
  const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    ': keep-alive',
    'event: message',
    `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}`,
    done,
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
})

test('parseQoderSse reports call activity so a caller watchdog can re-arm', async () => {
  let activity = 0
  for await (const _chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    done,
  ]), { onActivity: () => { activity++ } })) continue
  assert.ok(activity > 0)
})

test('parseQoderSse rejects invalid status, malformed body, and premature EOF', async () => {
  const invalid = [
    [`data: ${JSON.stringify({ statusCodeValue: '200', body: '{}' })}`],
    [`data: ${JSON.stringify({ statusCodeValue: 200, body: 42 })}`],
    [`data: ${JSON.stringify({ statusCodeValue: 200, body: '{}' })}`],
  ]
  for (const lines of invalid) {
    await assert.rejects(async () => {
      for await (const _chunk of parseQoderSse(streamOf(lines))) continue
    }, (error: Error) => {
      assert.ok(error instanceof LlmError)
      return true
    })
  }
})

test('parseQoderSse treats EOF after finish_reason as a retryable transport truncation', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      data({ choices: [{ delta: { content: 'complete-looking' }, finish_reason: 'stop' }] }),
    ]))) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'TRANSPORT')
})

test('parseQoderSse preserves explicit upstream error statuses', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      `data: ${JSON.stringify({ statusCodeValue: 503, body: 'unavailable' })}`,
    ]))) continue
  }, (error: Error) => (
    error instanceof LlmError
    && error.code === 'SERVER'
    && error.failure.status === 503
    && error.message === 'Qoder service returned upstream error status 503: unavailable'
  ))
})

test('parseQoderSse forwards the envelope body into the error message', async () => {
  // A non-200 envelope's body carries the upstream's own reason (quota, region
  // permission, risk control, ...). Discarding it left every such rejection
  // reading as a bare "invalid API key", so the real cause was invisible.
  const upstreamBody = JSON.stringify({ code: 403, message: 'region permission denied' })
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      `data: ${JSON.stringify({ statusCodeValue: 403, body: upstreamBody })}`,
    ]))) continue
  }, (error: Error) => (
    error instanceof LlmError
    && error.code === 'AUTH'
    && error.failure.status === 403
    && error.message === `Qoder service returned upstream error status 403: ${upstreamBody}`
  ))
})

test('parseQoderSse classifies an exhausted-credit rejection as QUOTA, not AUTH', async () => {
  // The reference reported this shape as AUTH — "invalid API key" for a chat it
  // had refused for credits — which sends the user to re-mint a working token.
  const upstreamBody = JSON.stringify({ code: 403, message: 'quota exhausted for this model' })
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(streamOf([
      `data: ${JSON.stringify({ statusCodeValue: 403, body: upstreamBody })}`,
    ]))) continue
  }, (error: Error) => (
    error instanceof LlmError
    && error.code === 'QUOTA'
    && error.failure.status === 403
    && error.message === `Qoder service returned upstream error status 403: ${upstreamBody}`
  ))
})

test('parseQoderSse rejects an oversized unterminated frame', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: 12345678901234567890'))
      controller.close()
    },
  })
  await assert.rejects(async () => {
    for await (const _chunk of parseQoderSse(stream, { maxBufferChars: 16 })) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'TRANSPORT')
})

test('parseQoderSse reverses the WAF encoding when the deployment answers encoded', async () => {
  // The reference has no response-decode path (its envelope body is plain
  // JSON), so this is off by default and enabled only for a deployment that
  // encodes responses too. The controller proves both settings on one stream.
  const inner = JSON.stringify({ choices: [{ delta: { content: 'decoded' }, finish_reason: 'stop' }] })
  const encoded = qoderEncodeBody(inner)
  for (const [decodeBody, expected] of [[true, 'decoded'], [false, undefined]] as const) {
    const chunks = []
    try {
      for await (const chunk of parseQoderSse(streamOf([
        `data: ${JSON.stringify({ statusCodeValue: 200, body: encoded })}`,
        done,
      ]), { decodeBody })) chunks.push(chunk)
    } catch (error) {
      assert.equal(decodeBody, false, 'the encoded body must decode when asked')
      assert.ok(error instanceof LlmError && error.code === 'TRANSPORT')
      continue
    }
    assert.equal(decodeBody, true)
    const block = chunks.find(chunk => chunk.type === 'block-end')
    assert.deepEqual(block?.block, { type: 'text', text: expected })
  }
})

test('parseQoderSse never decodes the [DONE] marker', async () => {
  // The marker is matched on the RAW body, before any decoding, or an encoded
  // stream could never terminate: decoding "[DONE]" yields garbage, and the
  // parser would report a malformed inner payload instead of a clean finish.
  const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
  const chunks = []
  for await (const chunk of parseQoderSse(streamOf([
    `data: ${JSON.stringify({ statusCodeValue: 200, body: qoderEncodeBody(inner) })}`,
    `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`,
  ]), { decodeBody: true })) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.deepEqual((chunks[2] as { block: unknown }).block, { type: 'text', text: 'ok' })
  assert.equal((chunks[3] as { reason: { kind: string } }).reason.kind, 'stop')
})

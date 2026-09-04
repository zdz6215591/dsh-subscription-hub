/**
 * Antigravity thought_signature round-trip tests.
 *
 * The documented failure was an HTTP 400 from the upstream:
 *   "Function call is missing a thought_signature in functionCall parts"
 * which happens when the adapter replays an assistant functionCall WITHOUT the
 * real signature the model returned with it. These tests pin the two seams of
 * the fix (see agy/signature-cache.ts, agy/parse.ts `onToolSignature`, and
 * agy/translate.ts `blockToParts`):
 *   1. streaming a functionCall part that carries a thoughtSignature captures
 *      id→signature into the cache; and
 *   2. the NEXT turn's request re-attaches that exact signature onto the
 *      assistant functionCall part — never an invented empty value; and
 *   3. a tool-call with no cached signature raises the explainable error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { parseAgySse } from '../src/providers/agy/parse.js'
import {
  clearToolSignaturesForTests,
  getToolSignature,
  recordToolSignature,
} from '../src/providers/agy/signature-cache.js'
import { toAgyRequestBody } from '../src/providers/agy/translate.js'

/** Encode one SSE `data:` line as a ReadableStream<Uint8Array>. */
function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const s = lines.map((l) => `data: ${l}\n\n`).join('')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s))
      controller.close()
    },
  })
}

function drain(gen: AsyncGenerator<unknown, void>): Promise<unknown[]> {
  return (async () => {
    const out: unknown[] = []
    for await (const item of gen) out.push(item)
    return out
  })()
}

function message(role: Message['role'], content: ContentBlock[]): Message {
  const source = role === 'assistant'
    ? { kind: 'model' as const, provider: 'agy', model: 'gemini-3.8-flash-tiered' }
    : { kind: 'user' as const }
  return { id: MessageId('m-' + Math.random().toString(36).slice(2)), role, content, source }
}

interface ContentBlockLike {
  type: string
  [k: string]: unknown
}

/** Minimal implementable shape to TypeScript; runtime values come from object literals. */
function baseOptions(messages: Message[], model = 'gemini-3.7-flash-tiered'): GenerateOptions {
  return {
    provider: 'agy',
    model,
    messages,
    tools: [{ name: 'default_api:pwsh', description: 'run a command', parameters: {} }],
  } as unknown as GenerateOptions
}

test('agy: functionCall thoughtSignature is captured from the stream', async () => {
  clearToolSignaturesForTests()
  const captured: Array<[string, string]> = []
  const payload = JSON.stringify([{
    candidates: [{
      content: { role: 'model', parts: [
        { thought: true, text: 'I will call a tool.' },
        { functionCall: { id: 'fc1', name: 'default_api:pwsh', args: '{"command":"dir"}' }, thoughtSignature: 'SG-LIVE-123' },
      ] },
      finishReason: 'TOOL_CALLS',
    }],
  }])
  const chunks = await drain(parseAgySse(sseBody([payload, '[DONE]']), {
    // Mirror the real adapter (`streamCore` passes onToolSignature:
    // recordToolSignature) plus a spy to pin the wiring.
    onToolSignature: (id, sig) => { captured.push([id, sig]); recordToolSignature(id, sig) },
  }))
  assert.deepEqual(captured, [['fc1', 'SG-LIVE-123']], 'onToolSignature must fire with id + signature')
  assert.equal(getToolSignature('fc1'), 'SG-LIVE-123', 'signature must be recorded keyed by tool call id')
  const toolBlocks = chunks.filter((c) => (c as { type?: string }).type === 'tool-call-delta')
  assert.ok(toolBlocks.length > 0, 'a tool-call-delta should be yielded')
})

test('agy: signature carried by the PRECEDING thought part is captured for the functionCall', async () => {
  clearToolSignaturesForTests()
  const captured: Array<[string, string]> = []
  // Antigravity often streams the thoughtSignature on the thought part that
  // precedes the functionCall part, not on the functionCall itself. The
  // signature must ride forward and be keyed by the functionCall id — this
  // is the `pwsh` failure: capture missed it so replay had no signature.
  const payload = JSON.stringify([{
    candidates: [{
      content: { role: 'model', parts: [
        { thought: true, text: 'I need to run pwsh.', thoughtSignature: 'SG-THOUGHT-889' },
        { functionCall: { id: 'fc-2', name: 'default_api:pwsh', args: '{"command":"dir"}' } },
      ] },
      finishReason: 'TOOL_CALLS',
    }],
  }])
  const chunks = await drain(parseAgySse(sseBody([payload, '[DONE]']), {
    onToolSignature: (id, sig) => { captured.push([id, sig]); recordToolSignature(id, sig) },
  }))
  assert.deepEqual(captured, [['fc-2', 'SG-THOUGHT-889']],
    'signature on the preceding thought part must be captured keyed by the functionCall id')
  assert.equal(getToolSignature('fc-2'), 'SG-THOUGHT-889', 'signature must be replayable next turn')
  assert.ok(chunks.some((c) => (c as { type?: string }).type === 'tool-call-delta'), 'a tool-call-delta should be yielded')
})

test('agy: next-turn request replays the real thoughtSignature', () => {
  clearToolSignaturesForTests()
  recordToolSignature('fc1', 'SG-LIVE-123')
  const history: Message[] = [
    message('user', [{ type: 'text', text: 'list the dir' }]),
    message('assistant', [{ type: 'tool-call', id: ToolCallId('fc1'), name: 'default_api:pwsh', arguments: '{"command":"dir"}' }]),
    message('user', [
      { type: 'tool-result', toolCallId: ToolCallId('fc1'), content: [{ type: 'text', text: 'ok' }] },
    ]),
  ]
  const req = toAgyRequestBody(baseOptions(history), {})
  const model = req.request.contents.find((c) => c.role === 'model')
  assert.ok(model, 'assistant → one model part expected')
  let sawFunctionCall = false
  for (const part of model.parts) {
    if ('functionCall' in part) {
      sawFunctionCall = true
      assert.equal(part.thoughtSignature, 'SG-LIVE-123', 'replay must carry the REAL signature, not empty')
    }
  }
  assert.ok(sawFunctionCall, 'the functionCall part must survive translation')
})

test('agy: a tool-call with no cached signature raises an explainable error', () => {
  clearToolSignaturesForTests()
  const history: Message[] = [
    message('user', [{ type: 'text', text: 'hi' }]),
    message('assistant', [{ type: 'tool-call', id: ToolCallId('fc-missing'), name: 'default_api:pwsh', arguments: '{"command":"dir"}' }]),
  ]
  assert.throws(
    () => toAgyRequestBody(baseOptions(history), {}),
    /no cached thought_signature/,
    'an unreplayable functionCall must fail loudly instead of sending an empty sentinel',
  )
})
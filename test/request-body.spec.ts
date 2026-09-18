/**
 * Request-body construction for the two Responses-wire providers: the tool
 * trio (`tools` / `tool_choice` / `parallel_tool_calls`) must render together
 * or not at all. These offline tests verify emitted requests, not the
 * acceptance policy of a live provider endpoint.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { codexRequestBody, CodexAdapter, CODEX_API_URL } from '../src/providers/codex.js'
import { grokRequestBody, GrokAdapter, GROK_API_URL } from '../src/providers/grok.js'
import { copilotResponsesRequestBody } from '../src/providers/copilot.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { toResponsesInput } from '../src/translate/responses.js'

const TOOL = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
}

function options(tools?: GenerateOptions['tools']): GenerateOptions {
  return {
    provider: 'grok',
    model: 'grok-4.20-0309-non-reasoning',
    messages: [],
    system: 'judge',
    maxTokens: 16,
    ...tools === undefined ? {} : { tools },
  }
}

const resolved = toResponsesInput([], 'judge')

test('Responses providers preserve optional escalation fields and apply strict opt-out only where intended', () => {
  const parameters = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
      justification: { type: 'string' },
    },
    required: ['command', 'description'],
  }
  const original = structuredClone(parameters)
  const tool = { name: 'bash', description: 'Run a command', parameters }
  const request = options([tool])
  const bodies = [
    ['codex', codexRequestBody(request, resolved, false)],
    ['copilot', copilotResponsesRequestBody(request, resolved)],
    ['grok', grokRequestBody(request, resolved)],
  ] as const
  for (const [provider, body] of bodies) {
    const [mapped] = body.tools as Record<string, unknown>[]
    assert.deepEqual(mapped.parameters, original, `${provider}: preserve optional, non-nullable fields`)
    assert.deepEqual(mapped, {
      type: 'function', name: 'bash', description: 'Run a command', parameters: original,
      ...provider === 'grok' ? {} : { strict: false },
    }, `${provider}: strict policy belongs to the provider`)
  }
  assert.deepEqual(parameters, original, 'request assembly must not mutate the harness schema')
})

test('grok: tool-less request carries no tool_choice / parallel_tool_calls', () => {
  const body = grokRequestBody(options(), resolved)
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.parallel_tool_calls, undefined)
  assert.equal(body.tools, undefined)
})

test('grok: request with tools keeps the whole trio', () => {
  const body = grokRequestBody(options([TOOL]), resolved)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, true)
  assert.equal((body.tools as unknown[]).length, 1)
})

test('grok: empty tools array counts as tool-less', () => {
  const body = grokRequestBody(options([]), resolved)
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.parallel_tool_calls, undefined)
  assert.equal(body.tools, undefined)
})

test('codex: tool-less request carries no tool_choice / parallel_tool_calls', () => {
  const body = codexRequestBody(options(), resolved, false)
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.parallel_tool_calls, undefined)
  assert.equal(body.tools, undefined)
})

test('codex: request with tools keeps the whole trio', () => {
  const body = codexRequestBody(options([TOOL]), resolved, false)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, true)
  assert.equal((body.tools as unknown[]).length, 1)
})

test('codex: tool controls and orphan-call repair coexist for every tools shape', () => {
  for (const tools of [undefined, [], [TOOL]]) {
    const input = [{ type: 'function_call', call_id: 'call_missing', name: 'echo', arguments: '{}' }]
    const body = codexRequestBody(options(tools), { input }, false)
    const repaired = body.input as Record<string, unknown>[]
    assert.equal(repaired.length, 2)
    assert.equal(repaired[1].call_id, 'call_missing')
    assert.match(String(repaired[1].output), /outcome is unknown/)
    assert.equal(input.length, 1, 'request repair must not mutate history')
    assert.equal(body.tool_choice, tools?.length ? 'auto' : undefined)
    assert.equal(body.parallel_tool_calls, tools?.length ? true : undefined)
    assert.equal(body.tools === undefined, !tools?.length)
  }
})

for (const provider of ['codex', 'grok'] as const) {
  test(`${provider}: stream dispatches all three tool shapes and preserves non-tool fields`, async (t) => {
    const session = {
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
      expiresAt: Date.now() + 3_600_000, accountId: 'synthetic-account',
      tokenEndpoint: 'https://example.invalid/token',
    }
    const tokens = new AccountTokenManager({
      provider, displayName: 'Test',
      makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
      io: {
        list: async () => [{ key: 'acct', session }], get: async () => session,
        save: async () => {}, remove: async () => {},
      },
    })
    const settings = { models: [{ id: 'test-model', name: 'Test' }], tokens, discovery: false, streamIdleTimeoutMs: 1000 }
    const adapter = provider === 'codex' ? new CodexAdapter(settings) : new GrokAdapter(settings)
    const requests: { url: string; body: Record<string, unknown> }[] = []
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n')
    })
    for (const tools of [undefined, [], [TOOL]]) {
      const request: GenerateOptions = {
        ...options(tools), provider, model: 'test-model', maxTokens: 32,
        sessionId: 'test-session' as NonNullable<GenerateOptions['sessionId']>,
        messages: [{ id: MessageId('user'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
      }
      for await (const chunk of adapter.stream(request)) void chunk
    }
    assert.equal(requests.length, 3)
    for (const [index, { url, body }] of requests.entries()) {
      assert.equal(url, provider === 'codex' ? CODEX_API_URL : GROK_API_URL)
      assert.equal(body.model, 'test-model')
      assert.equal(body.instructions, 'judge')
      assert.equal(body.prompt_cache_key, 'test-session')
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }])
      if (provider === 'grok') assert.equal(body.max_output_tokens, 32)
      if (index < 2) {
        for (const key of ['tools', 'tool_choice', 'parallel_tool_calls']) assert.equal(Object.hasOwn(body, key), false)
      } else {
        assert.equal(body.tool_choice, 'auto')
        assert.equal(body.parallel_tool_calls, true)
        assert.equal((body.tools as unknown[]).length, 1)
      }
    }
  })
}

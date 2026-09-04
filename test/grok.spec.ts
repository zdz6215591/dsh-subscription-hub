/**
 * Grok request-shape tests: the Responses body carries `prompt_cache_key`
 * (xAI's cache-affinity hint — the Responses-API equivalent of the
 * `x-grok-conv-id` header) exactly when the harness supplies a session id,
 * mirroring the codex route. Without it, xAI routes repeat requests to
 * arbitrary shards and every cache hit is luck — see issue #49.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { GrokAdapter, GROK_API_URL } from '../src/providers/grok.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { GrokSession } from '../src/auth/store.js'

const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.x.ai/token',
}

/** An AccountTokenManager over an in-memory session; refresh never fires here. */
function memoryTokens(initial: GrokSession): AccountTokenManager<GrokSession> {
  let stored: GrokSession | undefined = initial
  return new AccountTokenManager<GrokSession>({
    provider: 'grok',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve(stored === undefined ? [] : [{ key: 'acct', session: stored }]),
      get: () => Promise.resolve(stored),
      save: (_account, session) => {
        stored = session
        return Promise.resolve()
      },
      remove: () => {
        stored = undefined
        return Promise.resolve()
      },
    },
  })
}

/** A minimal completed Responses SSE payload (one text item, then finish). */
const COMPLETED_SSE = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'

/**
 * Record-and-replay stub for the AMBIENT generation fetch: the adapter sends
 * provider traffic through global fetch (the repo-wide adapter pattern; only
 * discovery takes an injected fetchFn), so stream tests patch the global and
 * restore it in a finally. node:test runs one file's tests sequentially, so
 * the patch window is race-free.
 */
function recordingSseFetch(): {
  calls: { url: string; body: Record<string, unknown> }[]
  restore(): void
} {
  const original = globalThis.fetch
  const calls: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return Promise.resolve(new Response(COMPLETED_SSE))
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** Minimal generate options for adapter.stream() calls. */
const STREAM_OPTIONS: GenerateOptions = {
  provider: 'grok',
  model: 'grok-4',
  messages: [{
    id: MessageId('m-stream'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
  maxTokens: 1_000,
}

function grokAdapter(): GrokAdapter {
  return new GrokAdapter({
    models: [{ id: 'grok-4', name: 'Grok 4' }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: false,
  })
}

async function drain(adapter: GrokAdapter, options: GenerateOptions): Promise<void> {
  for await (const chunk of adapter.stream(options)) void chunk
}

test('the request carries prompt_cache_key = sessionId when the harness supplies one', async () => {
  const { calls, restore } = recordingSseFetch()
  try {
    await drain(grokAdapter(), { ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, GROK_API_URL)
    assert.equal(calls[0]?.body.prompt_cache_key, 'sess-1')
  } finally {
    restore()
  }
})

test('the request omits prompt_cache_key entirely when no sessionId is set', async () => {
  const { calls, restore } = recordingSseFetch()
  try {
    await drain(grokAdapter(), STREAM_OPTIONS)
    assert.equal(calls.length, 1)
    assert.ok(!('prompt_cache_key' in (calls[0]?.body ?? {})),
      'an absent session id must not serialize a key at all (not even null/undefined)')
  } finally {
    restore()
  }
})

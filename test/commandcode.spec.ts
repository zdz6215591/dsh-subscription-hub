/**
 * The Command Code adapter's durable catalog fallback (F8).
 *
 * The value this protects: the roster supplies each model's real context window
 * and output cap. Before the durable cache, any `/models` failure collapsed the
 * picker to a two-model static list and mis-sized every other model — a fresh
 * process hit that on its very first request, because the cache was memory-only.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandCodeAdapter, COMMANDCODE_MESSAGES_ONLY_MODELS, requiresMessagesEndpoint } from '../src/providers/commandcode.js'
import type { CommandCodeSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { writeCommandCodeCatalog } from '../src/providers/commandcode-catalog-cache.js'
import type { FetchFn } from '../src/providers/common.js'

const SESSION: CommandCodeSession = {
  accessToken: 'cc_test_key',
  refreshToken: 'cc_test_key',
  expiresAt: Date.now() + 3_600_000,
  account: 'tester',
  userId: 'u1',
}

function tokens(): AccountTokenManager<CommandCodeSession> {
  return new AccountTokenManager<CommandCodeSession>({
    provider: 'commandcode',
    displayName: 'Command Code',
    makeOptions: () => ({ preemptMs: 0, refresh: async s => s, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'default', session: SESSION }],
      get: async () => SESSION,
      save: async () => {},
      remove: async () => {},
    },
  })
}

/** A fetcher that always fails, whatever the caller asks for. */
const failingFetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as FetchFn

function harness(catalogCachePath: string, fetchFn: FetchFn): CommandCodeAdapter {
  return new CommandCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 10_000,
    tokens: tokens(),
    discovery: true,
    fetchFn,
    catalogCachePath,
  })
}

const PERSISTED = [
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 262_144, maxTokens: 32_768 },
  // A window the live gateway does NOT report for this id, so a passing
  // assertion cannot be a live fetch in disguise.
  { id: 'z-ai/glm-5.3-flashx', name: 'GLM 5.3 FlashX', contextWindow: 999_936, maxTokens: 65_536 },
]

test('a failed /models read serves the persisted catalog, not the static list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f8-'))
  const path = join(dir, 'commandcode-models.json')
  try {
    await writeCommandCodeCatalog(PERSISTED, path)
    const adapter = harness(path, failingFetch)
    const models = await adapter.listModels('commandcode')
    const ids = models.map(model => model.id).sort()
    // Both persisted models are known — including the 1M-window one the static
    // two-model list does not carry at all.
    assert.deepEqual(ids, PERSISTED.map(entry => entry.id).sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the persisted catalog also resolves a model\'s real window and cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f8-'))
  const path = join(dir, 'commandcode-models.json')
  try {
    await writeCommandCodeCatalog(PERSISTED, path)
    const adapter = harness(path, failingFetch)
    const resolved = await adapter.resolveModel('commandcode', 'z-ai/glm-5.3-flashx')
    // The persisted row's window, not the live gateway's 1M and not an invented
    // 128k fallback: the fixture uses a value only the cache could produce.
    assert.equal(resolved.context?.contextWindow, 999_936)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with nothing persisted a failed read still degrades quietly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f8-'))
  try {
    const warnings: string[] = []
    const adapter = new CommandCodeAdapter({
      models: [],
      streamIdleTimeoutMs: 10_000,
      tokens: tokens(),
      discovery: true,
      fetchFn: failingFetch,
      catalogCachePath: join(dir, 'absent.json'),
      onWarn: message => warnings.push(message),
    })
    // No throw: the caller keeps a usable (if small) roster.
    const models = await adapter.listModels('commandcode')
    assert.ok(Array.isArray(models))
    // And the failure is reported rather than silent.
    assert.ok(warnings.some(message => message.includes('commandcode catalog failed')), JSON.stringify(warnings))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful live read wins over the persisted one and refreshes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f8-'))
  const path = join(dir, 'commandcode-models.json')
  try {
    await writeCommandCodeCatalog(PERSISTED, path)
    const live = [{ id: 'brand/new-model', object: 'model', created: 1, owned_by: 'x', name: 'Brand New', context_length: 500_000 }]
    const fetchFn = (async () => new Response(JSON.stringify(live), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as FetchFn
    const adapter = harness(path, fetchFn)
    const models = await adapter.listModels('commandcode')
    assert.deepEqual(models.map(model => model.id), ['brand/new-model'])

    // The write-through is fire-and-forget, so give it a moment, then confirm
    // the durable copy now carries the live row.
    const { readCommandCodeCatalog } = await import('../src/providers/commandcode-catalog-cache.js')
    let stored = await readCommandCodeCatalog(path)
    for (let attempt = 0; attempt < 50 && stored?.[0]?.id !== 'brand/new-model'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      stored = await readCommandCodeCatalog(path)
    }
    assert.equal(stored?.[0]?.id, 'brand/new-model')
    assert.equal(stored?.[0]?.contextWindow, 500_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// F2 — the Claude family rides the CLI transport
// ---------------------------------------------------------------------------

/** The exact body the live gateway returns for a Claude id on chat-completions. */
function messagesOnlyBody(model: string): string {
  return JSON.stringify({
    error: {
      message: `Model "${model}" must be called via /provider/v1/messages (Anthropic Messages shape).`,
      code: 'unsupported_model',
    },
  })
}

/** A fetcher that records every URL it is asked for. */
function recordingFetch(handler: (url: string) => Response): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    return handler(url)
  }) as unknown as FetchFn
  return { fetchFn, calls }
}

/** A minimal SSE body so a successful transport yields at least one chunk. */
function okStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function drain(adapter: CommandCodeAdapter, model: string): Promise<void> {
  for await (const _ of adapter.stream({
    provider: 'commandcode',
    model,
    messages: [{ id: 'm1' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  } as never)) { void _ }
}

test('the Messages-only set covers the live Claude catalog ids', () => {
  // Every one of these was measured returning 400 on chat-completions.
  for (const id of [
    'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5-1', 'claude-fable-5',
    'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-haiku-4-5-20251001',
  ]) {
    assert.equal(requiresMessagesEndpoint(id), true, id)
    assert.equal(COMMANDCODE_MESSAGES_ONLY_MODELS.has(id), true, id)
  }
  // The prefix rule covers a Claude model shipped after this table.
  assert.equal(requiresMessagesEndpoint('claude-sonnet-9'), true)
  // And nothing else is swept in: the DeepSeek/GLM/Qwen families are served by
  // the Provider API and must keep leading with it.
  for (const id of ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.3-flashx', 'Qwen/Qwen3.8-Max', 'gpt-5.6-sol']) {
    assert.equal(requiresMessagesEndpoint(id), false, id)
  }
})

test('a Claude model goes straight to the CLI transport, without a doomed request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f2-'))
  try {
    const { fetchFn, calls } = recordingFetch(() => okStream())
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    await drain(adapter, 'claude-opus-5')
    assert.equal(calls.length, 1, 'exactly one request')
    // The CLI transport, first and only — not a chat-completions 400 then a retry.
    assert.ok(calls[0]!.includes('/alpha/generate'), calls[0])
    assert.ok(!calls[0]!.includes('/provider/v1/chat/completions'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-Claude model still leads with the Provider API transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f2-'))
  try {
    const { fetchFn, calls } = recordingFetch(() => okStream())
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    await drain(adapter, 'deepseek/deepseek-v4-pro')
    assert.equal(calls.length, 1)
    // The Provider API is the one that replays `reasoning_content`, so it must
    // keep leading for the families it serves.
    assert.ok(calls[0]!.includes('/provider/v1/chat/completions'), calls[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unrecognised model that answers "needs Messages" retries on the CLI transport', async () => {
  // The safety net for a Messages-only model the prefix test cannot know about:
  // the gateway's 400 names the endpoint, so the request is retried once on the
  // transport that can serve it.
  const dir = mkdtempSync(join(tmpdir(), 'cc-f2-'))
  try {
    const { fetchFn, calls } = recordingFetch((url) =>
      url.includes('/provider/v1/chat/completions')
        ? new Response(messagesOnlyBody('future-model-9'), { status: 400, headers: { 'content-type': 'application/json' } })
        : okStream())
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    await drain(adapter, 'future-model-9')
    assert.equal(calls.length, 2, 'one rejected attempt, then the CLI transport')
    assert.ok(calls[0]!.includes('/provider/v1/chat/completions'))
    assert.ok(calls[1]!.includes('/alpha/generate'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ordinary 400 is NOT retried on the other transport', async () => {
  // Only the explicit "needs the Messages shape" rejection may reroute: a plain
  // malformed-request 400 would fail identically on the CLI transport, so
  // retrying it would double the cost of every real error.
  const dir = mkdtempSync(join(tmpdir(), 'cc-f2-'))
  try {
    const { fetchFn, calls } = recordingFetch(() =>
      new Response(JSON.stringify({ error: { message: 'invalid request body' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    await assert.rejects(drain(adapter, 'deepseek/deepseek-v4-pro'))
    assert.equal(calls.length, 1, 'no reroute for a generic 400')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A newly shipped model: context from the live catalog, levels from the table
// ---------------------------------------------------------------------------

/** The exact rows the live catalog returns for the GPT-6 family. */
const LIVE_GPT6_ROWS = [
  { id: 'gpt-6-astra', object: 'model', created: 1790126711, owned_by: 'command-code', name: 'GPT-6 Astra', context_length: 1_050_000, supported_endpoints: ['/chat/completions', '/responses'] },
  { id: 'gpt-6-sol', object: 'model', created: 1790126711, owned_by: 'command-code', name: 'GPT-6 Sol', context_length: 1_050_000, supported_endpoints: ['/chat/completions', '/responses'] },
  { id: 'gpt-6-luna', object: 'model', created: 1790126711, owned_by: 'command-code', name: 'GPT-6 Luna', context_length: 1_050_000, supported_endpoints: ['/chat/completions', '/responses'] },
]

test('a newly shipped model gets its context from the live catalog and its levels from the table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-gpt6-'))
  try {
    // The live catalog is the authority for CONTEXT: it reports exact tokens the
    // moment a model ships, where the vendored table rounds (`1.05M`).
    const fetchFn = (async () => new Response(JSON.stringify({ object: 'list', data: LIVE_GPT6_ROWS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as FetchFn
    const adapter = harness(join(dir, 'absent.json'), fetchFn)

    const resolved = await adapter.resolveModel('commandcode', 'gpt-6-luna')
    assert.equal(resolved.context?.contextWindow, 1_050_000)
    // THE REGRESSION: this returned no reasoning block at all while the effort
    // table was hand-maintained, so the picker offered no thinking-level selector
    // for a model that has five.
    assert.equal(resolved.reasoning?.efforts.length, 5)
    assert.deepEqual(resolved.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'medium', 'high', 'xhigh', 'max'])

    // The same for its siblings, neither of which was in the hand-kept map.
    for (const id of ['gpt-6-sol', 'gpt-6-astra']) {
      const sibling = await adapter.resolveModel('commandcode', id)
      assert.equal(sibling.context?.contextWindow, 1_050_000, id)
      assert.equal(sibling.reasoning?.efforts.length, 5, id)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a published model with NO levels gets no picker, and no stale-snapshot warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-gpt6-'))
  try {
    const warnings: string[] = []
    const fetchFn = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'tencent/hy3-paid', object: 'model', name: 'Tencent Hy3', context_length: 262_000 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as FetchFn
    const adapter = new CommandCodeAdapter({
      models: [], streamIdleTimeoutMs: 10_000, tokens: tokens(), discovery: true,
      fetchFn, catalogCachePath: join(dir, 'absent.json'), onWarn: message => warnings.push(message),
    })
    await adapter.listModels('commandcode')
    const resolved = await adapter.resolveModel('commandcode', 'tencent/hy3-paid')
    // Published without levels: no selector, which is a fact rather than a gap.
    assert.equal(resolved.reasoning, undefined)
    assert.equal(warnings.some(message => message.includes('absent from the vendored model table')), false,
      JSON.stringify(warnings))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an UNPUBLISHED model warns that the snapshot needs regenerating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-gpt6-'))
  try {
    const warnings: string[] = []
    const fetchFn = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'brand/new-model-9', object: 'model', name: 'Brand New', context_length: 500_000 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as FetchFn
    const adapter = new CommandCodeAdapter({
      models: [], streamIdleTimeoutMs: 10_000, tokens: tokens(), discovery: true,
      fetchFn, catalogCachePath: join(dir, 'absent.json'), onWarn: message => warnings.push(message),
    })
    await adapter.listModels('commandcode')
    // The warning names the remedy, because the fix is a command the operator runs.
    const warning = warnings.find(message => message.includes('brand/new-model-9'))
    assert.ok(warning !== undefined, JSON.stringify(warnings))
    assert.match(warning, /sync-commandcode-models\.mjs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Messages-only model discovered from the live catalog skips the doomed request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-f2-'))
  const path = join(dir, 'commandcode-models.json')
  try {
    // The gateway's own declaration, as the live catalog carries it.
    await writeCommandCodeCatalog([
      { id: 'brand/messages-only', name: 'Messages Only', contextWindow: 200_000, maxTokens: 64_000, messagesOnly: true },
    ], path)
    const adapter = harness(path, failingFetch)
    assert.equal((await adapter.listModels('commandcode')).length, 1)
    const { fetchFn, calls } = recordingFetch(() => okStream())
    // Rebuild with the recording fetcher, then confirm the persisted flag alone
    // decides the transport — no request to the Provider API at all.
    const live = harness(path, fetchFn)
    await drain(live, 'brand/messages-only')
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.includes('/alpha/generate'), calls[0])
    void adapter
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
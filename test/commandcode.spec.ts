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
import {
  CommandCodeAdapter,
  COMMANDCODE_MESSAGES_ONLY_MODELS,
  COMMAND_CODE_CLI_VERSION,
  commandCodePublishedEfforts,
  isUnpublishedModel,
  requiresMessagesEndpoint,
} from '../src/providers/commandcode.js'
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

// ---------------------------------------------------------------------------
// Reference alignment (Mars-Sea/dsh-commandcode-provider @ 2e4d35d)
//
// Every citation in this block is a GIT OBJECT of the reference clone, not a
// path in its worktree: that checkout sits on the v0.11.14 tag, 13 releases
// behind its own `origin/main`, and the values below only exist on origin/main.
// ---------------------------------------------------------------------------

/** One recorded request: URL, the headers it carried and its parsed JSON body. */
interface RecordedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

/** A fetcher that records every request's URL, headers and parsed body. */
function recordingRequests(handler: (url: string) => Response): { fetchFn: FetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, any> : {},
    })
    return handler(url)
  }) as unknown as FetchFn
  return { fetchFn, requests }
}

/** A fetcher that answers `/provider/v1/models` with `rows` and every chat call with a stream. */
function catalogAndStream(rows: readonly Record<string, unknown>[]): { fetchFn: FetchFn; requests: RecordedRequest[] } {
  return recordingRequests(url => url.includes('/provider/v1/models')
    ? new Response(JSON.stringify({ object: 'list', data: rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    : okStream())
}

/** `drain`, but with extra `GenerateOptions` a call needs (e.g. a chosen effort). */
async function drainWith(adapter: CommandCodeAdapter, model: string, extra: Record<string, unknown> = {}): Promise<void> {
  const options = {
    provider: 'commandcode',
    model,
    messages: [{ id: 'm1' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
    ...extra,
  }
  for await (const _ of adapter.stream(options as never)) { void _ }
}

test('every request claims CLI 1.88.0 — the release the reference sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ver-'))
  try {
    const { fetchFn, requests } = recordingRequests(() => okStream())
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    await drain(adapter, 'deepseek/deepseek-v4-pro')
    assert.equal(requests.length, 1)
    // Reference `src/adapter.ts:103` @ 2e4d35d: `COMMAND_CODE_CLI_VERSION = '1.88.0'`,
    // 40 releases past the 1.47.0 this route used to claim.
    assert.equal(requests[0]!.headers['x-command-code-version'], '1.88.0')
    // The header must ride the constant, not a second literal that could drift.
    assert.equal(COMMAND_CODE_CLI_VERSION, '1.88.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('max_tokens is capped at the MEASURED 200 000 ceiling, not the old 64 000', async () => {
  // Reference `src/output-budget.ts:16-23` @ 2e4d35d probed `/alpha/generate`
  // directly: 200 000 answered HTTP 200 and 200 704 answered HTTP 400, so the
  // server's cap is 200 000. A row declaring a larger per-model max_tokens is
  // therefore still cut at 200 000.
  const dir = mkdtempSync(join(tmpdir(), 'cc-cap-'))
  try {
    const { fetchFn, requests } = catalogAndStream([
      {
        id: 'deepseek/deepseek-v4-pro',
        object: 'model',
        name: 'DeepSeek V4 Pro',
        context_length: 1_000_000,
        max_tokens: 262_144,
        supported_endpoints: ['/chat/completions'],
      },
    ])
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    // Prime the live catalog, or the row below is never read and the request
    // falls back to the default budget instead of exercising the ceiling.
    await adapter.listModels('commandcode')
    await drainWith(adapter, 'deepseek/deepseek-v4-pro')
    const generate = requests.find(request => request.url.includes('/provider/v1/chat/completions'))
    assert.ok(generate !== undefined, JSON.stringify(requests.map(request => request.url)))
    assert.equal(generate.body.max_tokens, 200_000)
    // The old 64 000 cap would have answered 64 000 here for every request.
    assert.notEqual(generate.body.max_tokens, 64_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a model with no published max_tokens asks for the reference default, 131 072', async () => {
  // Reference `src/output-budget.ts:47` @ 2e4d35d: MAX_OUTPUT_TOKEN_LIMIT is
  // 131 072 — a 35 % margin under the measured ceiling, chosen to cover the real
  // output ceiling of the models that have one.
  const dir = mkdtempSync(join(tmpdir(), 'cc-cap-'))
  try {
    const { fetchFn, requests } = catalogAndStream([
      {
        id: 'z-ai/glm-5.3-flash',
        object: 'model',
        name: 'GLM 5.3 Flash',
        context_length: 1_000_000,
        supported_endpoints: ['/chat/completions'],
      },
    ])
    const adapter = harness(join(dir, 'absent.json'), fetchFn)
    await adapter.listModels('commandcode')
    await drainWith(adapter, 'z-ai/glm-5.3-flash')
    const generate = requests.find(request => request.url.includes('/provider/v1/chat/completions'))
    assert.ok(generate !== undefined)
    assert.equal(generate.body.max_tokens, 131_072)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the DeepSeek V4 ladders carry the `off` level the reference publishes', () => {
  // Reference `src/capabilities.ts:90-92` and `:83` @ 2e4d35d. `off` is the
  // family's "do not think" level, added by command-code@1.73.3 — exactly to the
  // DeepSeek V4 line, which is why this must NOT be generalised by family name.
  for (const id of [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-flash-vision-exp',
  ]) {
    assert.deepEqual(commandCodePublishedEfforts(id), ['off', 'high', 'max'], id)
  }
  assert.deepEqual(commandCodePublishedEfforts('deepseek/deepseek-v4.1-flash'), ['off', 'low', 'high', 'max'])
  // THE OVER-GENERALISATION GUARD: its sibling never gained `off` upstream and
  // the reference still ships it at three levels (`src/capabilities.ts:81`).
  assert.deepEqual(commandCodePublishedEfforts('deepseek/deepseek-v4-flash-fast'), ['low', 'high', 'max'])
  // And no other family was touched by the change.
  assert.deepEqual(commandCodePublishedEfforts('z-ai/glm-5.3-flash'), ['low', 'high', 'max'])
  assert.deepEqual(commandCodePublishedEfforts('google/gemini-3.8-flash'), ['low', 'medium', 'high'])
  assert.deepEqual(commandCodePublishedEfforts('claude-sonnet-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('the picker offers `off` on the models that publish it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-off-'))
  try {
    const adapter = harness(join(dir, 'absent.json'), failingFetch)
    const resolved = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4-pro')
    assert.deepEqual(resolved.reasoning?.efforts.map(effort => String(effort.id)), ['off', 'high', 'max'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selecting `off` really disables thinking — but only where the model lists it', async () => {
  // Reference `src/adapter.ts:3427-3438` @ 2e4d35d: `off` carries two meanings.
  // A model that LISTS it gets `reasoning_effort: "off"` on the wire (the
  // official CLI spreads the value rather than dropping the field); every other
  // model keeps dropping it, which is what "no strength requested" relies on.
  const dir = mkdtempSync(join(tmpdir(), 'cc-off-'))
  try {
    const listed = recordingRequests(() => okStream())
    await drainWith(harness(join(dir, 'a.json'), listed.fetchFn), 'deepseek/deepseek-v4-pro', { reasoningEffort: 'off' })
    const sent = listed.requests.find(request => request.url.includes('/provider/v1/chat/completions'))
    assert.ok(sent !== undefined)
    assert.equal(sent.body.reasoning_effort, 'off')

    const unlisted = recordingRequests(() => okStream())
    await drainWith(harness(join(dir, 'b.json'), unlisted.fetchFn), 'z-ai/glm-5.3-flash', { reasoningEffort: 'off' })
    const dropped = unlisted.requests.find(request => request.url.includes('/provider/v1/chat/completions'))
    assert.ok(dropped !== undefined)
    // Absent, not `null` and not the string: the field must not be invented for a
    // model whose ladder does not list the level.
    assert.equal('reasoning_effort' in dropped.body, false, JSON.stringify(dropped.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI transport sends the real client\'s permissionMode and taste flag', async () => {
  // Reference `src/adapter.ts:2063-2072` @ 2e4d35d sends `permissionMode:
  // 'standard'` (the CLI's `toWirePermissionMode()` normalization of its internal
  // `default`), and `:2340` sends `'x-taste-learning': 'false'` on every request.
  // A Claude id is used because it is the transport the CLI body belongs to.
  const dir = mkdtempSync(join(tmpdir(), 'cc-wire-'))
  try {
    const { fetchFn, requests } = recordingRequests(() => okStream())
    await drainWith(harness(join(dir, 'absent.json'), fetchFn), 'claude-opus-5')
    const cli = requests.find(request => request.url.includes('/alpha/generate'))
    assert.ok(cli !== undefined, JSON.stringify(requests.map(request => request.url)))
    assert.equal(cli.body.permissionMode, 'standard')
    assert.equal(cli.headers['x-taste-learning'], 'false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the roster carries the reference rows this route can also price', () => {
  // Reference `src/capabilities.ts:77` (levels) + `:1002` (GOAT tier) and
  // `:193` (levels) + `:1059` (the only Max-only row) @ 2e4d35d. Both are priced
  // by `src/stats/model-prices.ts`, so adding them costs nothing elsewhere.
  assert.deepEqual(commandCodePublishedEfforts('claude-sonnet-5-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(commandCodePublishedEfforts('gpt-6.1-sol'), ['low', 'medium', 'high', 'xhigh', 'max'])
  // Published, so resolving them must not report a stale snapshot.
  assert.equal(isUnpublishedModel('claude-sonnet-5-5'), false)
  assert.equal(isUnpublishedModel('gpt-6.1-sol'), false)
  // The lapsed free twin is NOT carried as a live fact any more: the reference
  // records it leaving the catalog, the pricing page and the CLI artifact on
  // 2026-10-16 (`src/capabilities.ts:849-851`, `:1258-1261`).
  assert.equal(isUnpublishedModel('inclusionai/ling-3.0-flash-sante:free'), true)
  // Its still-live neighbour must stay: a free row the reference DOES serve.
  assert.equal(isUnpublishedModel('poolside/laguna-s-2.1-free'), false)
})
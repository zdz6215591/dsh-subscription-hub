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
import { CommandCodeAdapter } from '../src/providers/commandcode.js'
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
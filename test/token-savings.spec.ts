/**
 * Lifetime subscription token accounting and the pay-as-you-go savings
 * estimate. These are offline unit tests over the pure pricing helpers plus a
 * scan of a synthetic session directory — no network, no live accounts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  USD_TO_CNY_RATE,
  getModelPrice,
  recordStreamTokenUsage,
} from '../src/stats/token-savings.js'

test('getModelPrice matches families case-insensitively and falls back generically', () => {
  assert.deepEqual(getModelPrice('claude-sonnet-4-6'), { input: 3, output: 15, cache: 0.3 })
  assert.deepEqual(getModelPrice('CLAUDE-OPUS-4-6'), { input: 15, output: 75, cache: 0.5 })
  assert.deepEqual(getModelPrice('grok-4.6'), { input: 2, output: 10, cache: 0.2 })
  assert.deepEqual(getModelPrice('gemini-3.8-flash-tiered'), { input: 0.75, output: 3.75, cache: 0.075 })
  assert.deepEqual(getModelPrice('deepseek-v4.1-flash'), { input: 0.15, output: 0.6, cache: 0.003 })
  assert.deepEqual(getModelPrice('hy4-preview'), { input: 0.4, output: 1.5, cache: 0.05 })
  // An unknown model still prices at the generic default rather than throwing.
  assert.deepEqual(getModelPrice('totally-unknown-model'), { input: 2, output: 8, cache: 0.2 })
  assert.deepEqual(getModelPrice(''), { input: 2, output: 8, cache: 0.2 })
})

test('the RMB conversion constant is a positive finite rate', () => {
  assert.ok(Number.isFinite(USD_TO_CNY_RATE))
  assert.ok(USD_TO_CNY_RATE > 1 && USD_TO_CNY_RATE < 20)
})

/** Let the background scan settle before the next assertion. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 30) })

test('recordStreamTokenUsage ignores token-less usage and non-subscription providers', async () => {
  // No-ops, not throws: the live hook runs inside the adapter's stream path.
  recordStreamTokenUsage('codex', 'gpt-5.6', undefined)
  recordStreamTokenUsage('openai', 'gpt-5.6', { inputTokens: 10, outputTokens: 10 })
  recordStreamTokenUsage('codex', 'gpt-5.6', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
  // A subscription provider with real usage kicks off a scan but must not throw.
  recordStreamTokenUsage('grok', 'grok-4.6', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 })
  await settle()
  assert.ok(true)
})

test('a synthetic session directory scans into token totals and a savings estimate', async () => {
  // Point the harness home at a scratch directory so the scan sees only the
  // fixture. The module resolves paths through dshHomePath, which reads the
  // same environment variable the host uses.
  const originalHome = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'token-savings-'))
  process.env.DSH_HOME = dir
  try {
    const sessionDir = join(dir, 'sessions', 'fixture-session')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sessionDir, { recursive: true })
    // The store is zstd-compressed; the scan tolerates unreadable files, so a
    // plain file exercises the graceful-degradation path without pulling in a
    // compression dependency here.
    writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), 'not-zstd-compressed\n')
    const summary = await (await import('../src/stats/token-savings.js')).scanSessionHistory()
    assert.ok(Number.isFinite(summary.totalTokens))
    assert.ok(summary.totalTokens >= 0)
    assert.ok(Number.isFinite(summary.savedRmb))
    assert.ok(summary.savedRmb >= 0)
    assert.ok(Number.isFinite(summary.savedUsd))
    assert.equal(typeof summary.byProvider, 'object')
    assert.ok(Number.isFinite(summary.updatedAt))
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    rmSync(dir, { recursive: true, force: true })
  }
})

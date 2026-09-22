/**
 * Lifetime subscription token accounting and the pay-as-you-go savings
 * estimate. These are offline unit tests over the pricing engine plus scans of
 * synthetic session directories — no network, no live accounts.
 *
 * The module under test keeps its summary in memory, so the order of the tests
 * below matters: the persisted-document checks run before the first scan loads
 * anything, and every scan-driven test forces its own walk against a scratch
 * `DSH_HOME` (`dshHomePath` reads that variable per call).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as zlib from 'node:zlib'
import {
  priceSlugCandidates,
  priceUsage,
  resolveModelPrice,
  isPeakPricingHour,
} from '../src/stats/model-prices.js'
import {
  SCAN_VERSION,
  USD_TO_CNY_RATE,
  getTokenSavingsSummary,
  recordStreamTokenUsage,
  scanSessionHistory,
} from '../src/stats/token-savings.js'

/** Monday 2026-09-21, 12:00 UTC: a weekday off-peak instant. */
const MONDAY_OFF_PEAK = Date.parse('2026-09-21T12:00:00Z')
/** Monday 2026-09-21, 02:00 UTC: inside the 01–04 peak window. */
const MONDAY_PEAK = Date.parse('2026-09-21T02:00:00Z')
/** Saturday 2026-09-19, 02:00 UTC: the same hour, but weekends are fully off-peak. */
const SATURDAY_PEAK_HOUR = Date.parse('2026-09-19T02:00:00Z')

/** Money assertions compare with a tolerance: the buckets are summed as floats. */
function close(actual: number | undefined, expected: number, message?: string): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message ?? 'money'} expected ${String(expected)}, got ${String(actual)}`)
}

/** Run `body` against a scratch DSH home and restore the real one afterwards. */
async function withScratchHome(body: (dir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'token-savings-'))
  process.env.DSH_HOME = dir
  try {
    await body(dir)
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write one zstd-compressed transcript the way the harness does.
 * @param dir - the scratch DSH home.
 * @param session - the session directory name.
 * @param lines - the transcript's events.
 * @param name - the transcript generation's file name.
 */
function writeTranscript(dir: string, session: string, lines: object[], name = 'session.v3.jsonl.zstd'): void {
  const sessionDir = join(dir, 'sessions', session)
  mkdirSync(sessionDir, { recursive: true })
  const body = `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
  writeFileSync(join(sessionDir, name), zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
}

/** The live-usage chunk carrier, as the legacy transcript generation records it. */
const chunkEvent = (turn: number, step: number, usage: object, time: number): object => ({ type: 'assistant/chunk', time, data: { turn, step, chunk: { type: 'usage', usage } } })

/** The settled-message carrier, the only one the current generation records. */
const messageEvent = (turn: number, step: number, usage: object, time: number): object => ({ type: 'assistant/message', time, data: { turn, step, message: { role: 'assistant', content: [] }, usage } })

const headerEvent = (provider: string, model: string): object => ({ type: 'request/header', data: { header: { config: { provider, model } } } })

test('peak windows are weekday-only and match the published schedule', () => {
  assert.equal(isPeakPricingHour(MONDAY_PEAK), true)
  assert.equal(isPeakPricingHour(MONDAY_OFF_PEAK), false)
  assert.equal(isPeakPricingHour(SATURDAY_PEAK_HOUR), false)
  // The boundary hours: 03:59 is peak, 04:00 is not.
  assert.equal(isPeakPricingHour(Date.parse('2026-09-21T03:59:00Z')), true)
  assert.equal(isPeakPricingHour(Date.parse('2026-09-21T04:00:00Z')), false)
  assert.equal(isPeakPricingHour(Date.parse('2026-09-21T06:00:00Z')), true)
  assert.equal(isPeakPricingHour(Date.parse('2026-09-21T10:00:00Z')), false)
})

test('a published row wins over a vendor-family substring', () => {
  // The row's own rates, not the `gpt-5` family's 2.5/10/0.25 the old substring
  // table charged — a 12x overcharge on this model.
  const luna = resolveModelPrice('gpt-5.6-luna')
  assert.equal(luna.source, 'catalog')
  assert.deepEqual(luna.rates, { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 })
  // A resold model resolves by its own id rather than by the vendor name inside it.
  assert.equal(resolveModelPrice('cline-pass/deepseek-v4.1-flash').price?.id, 'deepseek-v4.1-flash')
  // A model neither the page nor a family rule covers stays UNPUBLISHED and is
  // reported as approximate, instead of being quietly priced as something else.
  const mimo = resolveModelPrice('cline-pass/mimo-v2.6-pro')
  assert.equal(mimo.source, 'default')
  assert.equal(priceUsage('cline-pass/mimo-v2.6-pro', undefined, { inputTokens: 1_000_000 }).approximate, true)
  // A family hit is explicitly marked approximate, and is only reached after the
  // published table misses.
  const family = priceUsage('z-ai/glm-5.3-flashx', undefined, { inputTokens: 1_000_000 })
  assert.equal(family.source, 'family')
  assert.equal(family.key, 'family:glm')
  assert.equal(family.approximate, true)
  // The page keeps the vendor segment on one row: the bare catalog id must still find it.
  assert.equal(resolveModelPrice('hy4-preview').price?.id, 'tencent/hy4-preview')
  // A decorating suffix the page does not carry is trimmed only after the exact miss.
  assert.equal(resolveModelPrice('gemini-3.8-flash-tiered').price?.id, 'gemini-3.8-flash')
  // ...and trimming never shadows the longer sibling, which has its own row.
  assert.equal(resolveModelPrice('deepseek-v4-flash-fast').price?.id, 'deepseek-v4-flash-fast')
  assert.equal(resolveModelPrice('deepseek-v4-flash-vision-exp').price?.id, 'deepseek-v4-flash-vision-exp')
  // An unpublished model falls back, and says that is what happened.
  const unknown = resolveModelPrice('stealth/ox-alpha')
  assert.equal(unknown.source, 'default')
  assert.equal(unknown.rates.input, 2)
  // Candidates are most-specific-first and de-duplicated.
  assert.deepEqual(priceSlugCandidates('z-ai/GLM-5.3'), ['z-ai/glm-5.3', 'glm-5.3'])
  assert.deepEqual(priceSlugCandidates('glm5.3-flash'), ['glm5.3-flash', 'glm-5.3-flash'])
})

test('rates follow the context band, then the peak window', () => {
  close(priceUsage('grok-4.6', MONDAY_OFF_PEAK, { inputTokens: 100_000 }).usd, 0.2)
  // Past the 200k band the row doubles, and a tiered row does NOT then apply peak.
  const large = priceUsage('grok-4.6', MONDAY_PEAK, { inputTokens: 300_000, cacheReadTokens: 100_000 })
  assert.equal(large.tierMaxContext, undefined)
  close(large.usd, 300_000 * 4 / 1_000_000 + 100_000 * 1 / 1_000_000)

  // A time-of-day row charges the peak triplet inside a weekday window...
  close(priceUsage('deepseek-v4.1-flash', MONDAY_PEAK, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }).usd, 0.306)
  // ...and the off-peak rates at every other hour, weekends included.
  close(priceUsage('deepseek-v4.1-flash', MONDAY_OFF_PEAK, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }).usd, 0.153)
  close(priceUsage('deepseek-v4.1-flash', SATURDAY_PEAK_HOUR, { inputTokens: 1_000_000 }).usd, 0.15)
  // A timestamp-less turn is priced off-peak, never guessed into the peak rate.
  close(priceUsage('deepseek-v4.1-flash', undefined, { inputTokens: 1_000_000 }).usd, 0.15)
})

test('cache writes are billed only when the published table carries a rate', () => {
  const priced = priceUsage('claude-sonnet-4-6', MONDAY_OFF_PEAK, { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 })
  assert.equal(priced.pricedCacheWrite, true)
  close(priced.usd, 3 + 3.75)
  assert.equal(priced.unpricedCacheWriteTokens, 0)

  // No published rate means the tokens are reported, never invented: a 1.25x
  // input multiplier must not silently appear, and the total stays a floor.
  const unpriced = priceUsage('deepseek-v4.1-flash', MONDAY_OFF_PEAK, { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 })
  assert.equal(unpriced.pricedCacheWrite, false)
  close(unpriced.usd, 0.15)
  assert.equal(unpriced.unpricedCacheWriteTokens, 1_000_000)

  // A published literal zero is a real zero, not a missing key.
  const zero = priceUsage('gpt-5.4', MONDAY_OFF_PEAK, { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 })
  assert.equal(zero.pricedCacheWrite, true)
  close(zero.usd, 2.5)
  assert.equal(zero.unpricedCacheWriteTokens, 0)
})

test('the RMB conversion constant is a positive finite rate', () => {
  assert.ok(Number.isFinite(USD_TO_CNY_RATE))
  assert.ok(USD_TO_CNY_RATE > 1 && USD_TO_CNY_RATE < 20)
})

test('a stats file from an older reader generation is discarded, not trusted', async () => {
  // Runs before any scan, so the module has no in-memory summary yet.
  await withScratchHome(async (dir) => {
    // A document an older scan wrote: well-formed, complete, and under-counted
    // because it read one transcript carrier. It must be rebuilt, not displayed.
    const statsDir = join(dir, 'plugins', 'subscriptions')
    mkdirSync(statsDir, { recursive: true })
    writeFileSync(join(statsDir, 'token-stats.json'), `${JSON.stringify({
      version: 1,
      totalTokens: 2_147_483_647,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      turns: 1,
      savedUsd: 457.61,
      savedRmb: 3308.52,
      byProvider: { grok: { tokens: 1, costUsd: 1, turns: 1 } },
      updatedAt: Date.now(),
    })}\n`)

    const summary = await getTokenSavingsSummary()
    // The scratch home holds no transcripts, so the rebuild is empty — and that
    // emptiness IS the assertion: the stale document contributed nothing.
    assert.equal(summary.totalTokens, 0)
    assert.equal(summary.savedUsd, 0)
    assert.equal(summary.version, SCAN_VERSION)
  })
})

/** Let a background scan settle before the next assertion. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 30) })

test('the live hook prices a turn with the published row, cache write included', async () => {
  // An empty scratch home gives the hook a zeroed summary to accumulate into.
  await withScratchHome(async () => {
    const zeroed = await scanSessionHistory(true)
    assert.equal(zeroed.totalTokens, 0)
    assert.equal(zeroed.version, SCAN_VERSION)

    recordStreamTokenUsage('claude', 'claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    const summary = await getTokenSavingsSummary()
    assert.equal(summary.turns, 1)
    assert.equal(summary.totalTokens, 3_000_000)
    assert.equal(summary.cacheWriteTokens, 1_000_000)
    assert.equal(summary.unpricedCacheWriteTokens, 0)
    // 3 + 0.3 + 3.75, rounded to the cent the panel prints (¥50.97).
    assert.equal(summary.savedUsd, 7.05)
    assert.equal(summary.savedRmb, 50.97)
    assert.equal(summary.rmbPerUsd, USD_TO_CNY_RATE)
    assert.equal(summary.byProvider.claude?.turns, 1)

    // A model whose row publishes no cache-write rate charges nothing for those
    // tokens but still reports them, so the figure reads as a floor.
    recordStreamTokenUsage('cline', 'cline-pass/deepseek-v4.1-flash', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 })
    const after = await getTokenSavingsSummary()
    assert.equal(after.unpricedCacheWriteTokens, 1_000_000)
    assert.equal(after.turns, 2)
  })
})

test('a scan prices BOTH transcript generations and never sums the two carriers', async () => {
  await withScratchHome(async (dir) => {
    // 1. Current generation (v3), message carrier only — invisible to the old scan.
    writeTranscript(dir, 'v3-cline', [
      headerEvent('cline', 'cline-pass/deepseek-v4.1-flash'),
      messageEvent(1, 1, { inputTokens: 100_000 }, MONDAY_OFF_PEAK),
      // The same model inside a weekday peak window bills at twice the rate.
      messageEvent(1, 2, { inputTokens: 100_000 }, MONDAY_PEAK),
      messageEvent(2, 1, { inputTokens: 100_000 }, SATURDAY_PEAK_HOUR),
    ], 'session.v3.jsonl.zstd')
    // 2. Legacy generation, chunk carrier.
    writeTranscript(dir, 'legacy-grok', [
      headerEvent('grok', 'grok-4.6'),
      chunkEvent(1, 1, { inputTokens: 100_000, outputTokens: 10_000 }, MONDAY_OFF_PEAK),
    ], 'session.jsonl.zstd')
    // 3. One transcript carrying BOTH carriers for the same (turn, step). The two
    //    numbers differ on purpose, so summing them instead of merging is visible.
    writeTranscript(dir, 'both-carriers', [
      headerEvent('grok', 'grok-4.6'),
      messageEvent(1, 1, { inputTokens: 999_999 }, MONDAY_OFF_PEAK),
      chunkEvent(1, 1, { inputTokens: 100_000 }, MONDAY_OFF_PEAK),
    ], 'session.jsonl.zstd')
    // 4. A provider the hub does not serve: counted by nobody.
    writeTranscript(dir, 'other-provider', [
      headerEvent('tencent', 'Deepseek-v4-flash'),
      chunkEvent(1, 1, { inputTokens: 5_000_000 }, MONDAY_OFF_PEAK),
    ], 'session.jsonl.zstd')

    const summary = await scanSessionHistory(true)
    assert.equal(summary.version, SCAN_VERSION)
    // 5 billed turns: three cline, one legacy grok, one merged grok. The 999_999
    // message record for the same (turn, step) as a chunk is dropped, never added.
    assert.equal(summary.turns, 5)
    assert.equal(summary.totalTokens, 510_000)
    assert.equal(summary.inputTokens, 500_000)
    assert.equal(summary.outputTokens, 10_000)
    assert.deepEqual(Object.keys(summary.byProvider).sort(), ['cline', 'grok'])
    // cline: 0.015 + 0.030 (peak) + 0.015 = 0.06.
    close(summary.byProvider.cline?.costUsd, 0.06)
    assert.equal(summary.byProvider.cline?.turns, 3)
    // grok: (100k in + 10k out) + 100k in = 0.26 + 0.2.
    close(summary.byProvider.grok?.costUsd, 0.46)
    assert.equal(summary.savedUsd, 0.52)

    // The scan persists what it priced, so a later reader sees the same figures.
    const reread = await getTokenSavingsSummary()
    assert.equal(reread.savedUsd, 0.52)
    assert.equal(reread.turns, 5)
    assert.equal(reread.totalTokens, 510_000)
  })
})

test('a scan tolerates an unreadable transcript instead of failing', async () => {
  await withScratchHome(async (dir) => {
    const sessionDir = join(dir, 'sessions', 'fixture-session')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), 'not-zstd-compressed\n')
    const summary = await scanSessionHistory(true)
    assert.ok(Number.isFinite(summary.totalTokens))
    assert.ok(Number.isFinite(summary.savedRmb))
    assert.ok(summary.savedRmb >= 0)
    assert.equal(typeof summary.byProvider, 'object')
    assert.ok(Number.isFinite(summary.updatedAt))
  })
})

/** Write one transcript under an explicit session directory (two files, one session). */
function writeInSession(dir: string, session: string, name: string, lines: object[]): void {
  const sessionDir = join(dir, 'sessions', session)
  mkdirSync(sessionDir, { recursive: true })
  const body = `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
  writeFileSync(join(sessionDir, name), zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
}

test('one session recorded in BOTH transcript formats is counted once', async () => {
  await withScratchHome(async (dir) => {
    // A real session crosses the format change: the legacy file keeps the turns
    // it already wrote, the new file rewrites a core of them and adds the rest.
    const shared = { inputTokens: 100_000, outputTokens: 1_000 }
    writeInSession(dir, 'migrated', 'session.jsonl.zstd', [
      headerEvent('grok', 'grok-4.6'),
      chunkEvent(1, 1, shared, MONDAY_OFF_PEAK),
      chunkEvent(2, 1, { inputTokens: 50_000 }, MONDAY_OFF_PEAK),
    ])
    writeInSession(dir, 'migrated', 'session.v3.jsonl.zstd', [
      headerEvent('grok', 'grok-4.6'),
      messageEvent(1, 1, shared, MONDAY_OFF_PEAK),
      messageEvent(3, 1, { inputTokens: 25_000 }, MONDAY_OFF_PEAK),
    ])
    // An identical request in a DIFFERENT session is a different request: the
    // dedup is scoped to one session directory, never global.
    writeInSession(dir, 'other-session', 'session.v3.jsonl.zstd', [
      headerEvent('grok', 'grok-4.6'),
      messageEvent(1, 1, shared, MONDAY_OFF_PEAK),
    ])

    const summary = await scanSessionHistory(true)
    // 5 records exist, 4 are billed: turn 1/1 twice (one session's two files) and
    // the other session's copy once, plus each file's unique turn.
    assert.equal(summary.turns, 4)
    assert.equal(summary.totalTokens, 277_000)
    assert.equal(summary.byProvider.grok?.turns, 4)
  })
})

test('a compaction summary is billed, as its own route', async () => {
  await withScratchHome(async (dir) => {
    writeTranscript(dir, 'compacted', [
      headerEvent('grok', 'grok-4.6'),
      chunkEvent(1, 1, { inputTokens: 100_000 }, MONDAY_OFF_PEAK),
      // The summarizer call: its own provider/model, no turn/step, and the same
      // numbers are NOT repeated on any message event.
      { type: 'compaction/summary', time: MONDAY_OFF_PEAK, data: { provider: 'cline', model: 'cline-pass/deepseek-v4.1-flash', usage: { inputTokens: 200_000, outputTokens: 2_000 } } },
    ])
    const summary = await scanSessionHistory(true)
    assert.equal(summary.turns, 2)
    assert.equal(summary.totalTokens, 302_000)
    // grok: 100k input at 2/M; the compaction's own row prices the deepseek leg.
    assert.equal(summary.byProvider.grok?.turns, 1)
    assert.equal(summary.byProvider.cline?.turns, 1)
    close(summary.byProvider.grok?.costUsd, 0.2)
    // 200k input at the DeepSeek row's off-peak 0.15/M, plus 2k output at 0.6/M.
    close(summary.byProvider.cline?.costUsd, 0.0312)
  })
})

// Last on purpose: with no loaded summary the hook starts a background walk, so
// it runs after every test that depends on a scratch home. It asserts nothing
// beyond "does not throw", being a no-op path inside a stream wrapper.
test('recordStreamTokenUsage ignores token-less usage and non-subscription providers', async () => {
  await withScratchHome(async () => {
    // A known-empty summary, so nothing this test does reaches the real home.
    await scanSessionHistory(true)
    recordStreamTokenUsage('codex', 'gpt-5.6', undefined)
    recordStreamTokenUsage('openai', 'gpt-5.6', { inputTokens: 10, outputTokens: 10 })
    recordStreamTokenUsage('codex', 'gpt-5.6', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
    recordStreamTokenUsage('grok', 'grok-4.6', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 })
    await settle()
    const summary = await getTokenSavingsSummary()
    // Only the subscription-provider turn landed, and its tokens are all buckets.
    assert.equal(summary.turns, 1)
    assert.equal(summary.totalTokens, 175)
    assert.equal(summary.byProvider.openai, undefined)
    assert.equal(summary.byProvider.codex, undefined)
  })
})

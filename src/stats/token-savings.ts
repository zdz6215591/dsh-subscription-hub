/**
 * Token stats and cost savings estimation engine.
 *
 * Scans DSH session history and listens to live stream usage across all
 * subscription providers (Codex, Claude, Grok, Copilot, Antigravity, Command
 * Code, Cline, CodeBuddy, Trae, Zed).
 *
 * Each turn is priced with the published pay-as-you-go rates for the model it
 * ran on (see `./model-prices.ts`), including the peak/off-peak windows,
 * context-length bands and cache-write rates those rates carry, then converted
 * to RMB (¥) to estimate the money a flat-rate / bundled subscription saved
 * against an API key.
 *
 * TWO TRANSCRIPT GENERATIONS MUST BOTH BE READ. A turn's usage is recorded in
 * one of three places, and which one depends on the transcript format, never on
 * the provider:
 *
 *  - `session.jsonl.zstd` (legacy) writes a `usage` chunk into the stream, i.e.
 *    `assistant/chunk` -> `chunk.usage`;
 *  - `session.v3.jsonl.zstd` (current) writes NO stream chunks at all and hangs
 *    the same numbers off the settled message, i.e. `assistant/message` ->
 *    `data.usage`;
 *  - a context compaction is its own request, recorded as `compaction/summary` ->
 *    `data.usage` with its own `provider`/`model`.
 *
 * Reading only the chunk carrier silently priced the legacy generation and
 * skipped every session recorded in the current one — which, measured over this
 * machine's whole history, was 16,976 of 26,198 billed turns (61% of the
 * estimate), Cline included in full. Where a transcript carries both, the values
 * are IDENTICAL per (turn, step) — verified across every file that has both — so
 * the two are merged by that key and never summed.
 *
 * ONE SESSION CAN HOLD BOTH FILES AT ONCE. A directory written across the format
 * change keeps the legacy transcript beside the new one, and the two then repeat
 * a large core of the same requests verbatim: 349M tokens across this machine's
 * 56 dual-format directories, which is 5% of the estimate. The walk therefore
 * deduplicates per DIRECTORY by request identity (provider, model, every billed
 * bucket and the timestamp) — never globally, so two identical requests in two
 * different sessions stay two requests.
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { priceUsage } from './model-prices.js'

export interface ProviderSavingsStat {
  tokens: number
  costUsd: number
  turns: number
}

export interface TokenSavingsSummary {
  /**
   * The reader/pricing generation that produced this document.
   *
   * A file written by an older generation is not merely old, it is WRONG — it was
   * priced from one transcript carrier and cannot be repaired by adding to it — so
   * the version gate drops it and lets the history scan rebuild it.
   */
  version: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Cache-write tokens that carry no published rate and are therefore billed at nothing. */
  unpricedCacheWriteTokens: number
  savedRmb: number
  savedUsd: number
  /** The conversion the host applied, so a client never restates the rate. */
  rmbPerUsd: number
  turns: number
  byProvider: Record<string, ProviderSavingsStat>
  updatedAt: number
}

/** Bumped whenever the scan's reading or pricing changes what the totals mean. */
export const SCAN_VERSION = 3

const SUBSCRIPTION_PROVIDERS = new Set([
  'codex',
  'claude',
  'grok',
  'copilot',
  'agy',
  'commandcode',
  'cline',
  'codebuddy',
  'trae',
  'zed',
])

export const USD_TO_CNY_RATE = 7.23

function statsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'token-stats.json')
}

let inMemorySummary: TokenSavingsSummary | undefined
/**
 * The unrounded USD total behind {@link inMemorySummary}.
 *
 * The summary itself carries cents, because that is what it is displayed as; the
 * live hook must not add its sub-cent turns to a rounded figure or the rounding
 * error accumulates turn after turn.
 */
let inMemoryCostUsd: number | undefined
let isScanning = false
/**
 * The walk currently in flight, so concurrent callers join it instead of
 * starting their own. Without this, every live usage chunk during the first
 * turns after a start launched a full scan of the sessions tree.
 */
let inFlightScan: Promise<TokenSavingsSummary> | undefined

/** A zeroed summary, used to answer a caller that joins an in-flight scan. */
function emptySummary(): TokenSavingsSummary {
  return {
    version: SCAN_VERSION,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unpricedCacheWriteTokens: 0,
    turns: 0,
    savedUsd: 0,
    savedRmb: 0,
    rmbPerUsd: USD_TO_CNY_RATE,
    byProvider: {},
    updatedAt: Date.now(),
  }
}

async function decompressZstd(buf: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    const slice = buf.subarray(offset)
    const decompressor = new zlib.ZstdDecompress()
    const parts: Buffer[] = []
    let usedBytes = 0
    let hasError = false
    await new Promise<void>((resolve) => {
      decompressor.on('data', chunk => parts.push(Buffer.from(chunk)))
      decompressor.on('error', () => { hasError = true; resolve() })
      decompressor.on('end', () => { usedBytes = decompressor.bytesWritten; resolve() })
      decompressor.write(slice)
      decompressor.end()
    })
    // A session file is a CONCATENATION of zstd frames, so the walk must continue
    // past each one; a single-frame decode returns only the transcript's head.
    if (hasError || usedBytes <= 0) break
    chunks.push(...parts)
    offset += usedBytes
  }
  return Buffer.concat(chunks)
}

async function walkSessionFiles(dir: string, acc: string[] = []): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walkSessionFiles(fullPath, acc)
      } else if (entry.name === 'session.v3.jsonl.zstd' || entry.name === 'session.jsonl.zstd') {
        acc.push(fullPath)
      }
    }
  } catch {}
  return acc
}

/** One billed turn, already attributed to the provider and model that ran it. */
interface BilledTurn {
  provider: string
  model: string
  usage: TokenUsage
  /** The transcript timestamp, which decides peak/off-peak; undefined when absent. */
  at: number | undefined
  /**
   * Identity of the request itself: provider, model, every billed bucket and the
   * timestamp.
   *
   * One session's directory can hold BOTH transcript files at once (DSH rewrites
   * the transcript into the current format while keeping the old one), and the
   * two then repeat a large core of the same requests verbatim — 349M tokens
   * across this machine's 56 dual-format directories, billed twice. Records that
   * agree on all of these fields are the same request; nothing else is.
   */
  signature: string
}

/** The identity spelled out above, from the fields a turn already carries. */
function signatureOf(provider: string, model: string, usage: TokenUsage, at: number | undefined): string {
  const bucket = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return [
    provider,
    model,
    bucket(usage.inputTokens),
    bucket(usage.outputTokens),
    bucket(usage.cacheReadTokens),
    bucket(usage.cacheWriteTokens),
    at ?? '',
  ].join('|')
}

/**
 * Every billed turn in one transcript, whichever carrier it uses.
 *
 * Three carriers exist, and a turn uses exactly one of them:
 *
 *  - `assistant/chunk` -> `chunk.usage` (the legacy transcript format);
 *  - `assistant/message` -> `data.usage` (the current format, which writes no
 *    stream chunks at all);
 *  - `compaction/summary` -> `data.usage`, a summarizer request that carries its
 *    own `provider`/`model` because it is not part of a turn — the context
 *    compaction itself is billed, and reading only turns left it uncounted.
 *
 * A turn is identified by `(turn, step)` so the two per-turn carriers merge
 * instead of double-counting; the chunk carrier wins that merge, being the
 * stream's own record. Events without a turn/step pair get a unique key, because
 * no deduplication is possible without one and dropping them would lose usage.
 * @param content - the decompressed transcript.
 * @returns one entry per billed request.
 */
function collectBilledTurns(content: string): BilledTurn[] {
  const turns = new Map<string, BilledTurn & { carrier: 'chunk' | 'message' | 'compaction' }>()
  let provider = ''
  let model = ''
  let unique = 0
  for (const line of content.split('\n')) {
    if (!line) continue
    let event: {
      type?: string
      time?: number
      data?: {
        turn?: number
        step?: number
        provider?: string
        model?: string
        header?: { config?: { provider?: string; model?: string } }
        chunk?: { type?: string; usage?: TokenUsage }
        usage?: TokenUsage
      }
    }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (event.type === 'request/header') {
      provider = event.data?.header?.config?.provider ?? ''
      model = event.data?.header?.config?.model ?? ''
      continue
    }
    const data = event.data
    if (data === undefined) continue
    let usage: TokenUsage | undefined
    let carrier: 'chunk' | 'message' | 'compaction'
    // A compaction summary names its own route: it is not the session's model.
    let turnProvider = provider
    let turnModel = model
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') {
      usage = data.chunk.usage
      carrier = 'chunk'
    } else if (event.type === 'assistant/message' && data.usage !== undefined) {
      usage = data.usage
      carrier = 'message'
    } else if (event.type === 'compaction/summary' && data.usage !== undefined) {
      usage = data.usage
      carrier = 'compaction'
      turnProvider = data.provider ?? provider
      turnModel = data.model ?? model
    } else {
      continue
    }
    if (usage === undefined || usage === null || typeof usage !== 'object') continue
    const key = carrier === 'compaction'
      ? `compaction:${String(unique++)}`
      : typeof data.turn === 'number' && typeof data.step === 'number'
        ? `${String(data.turn)}/${String(data.step)}`
        : `#${String(unique++)}`
    const existing = turns.get(key)
    if (existing !== undefined && !(existing.carrier === 'message' && carrier === 'chunk')) continue
    const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
    turns.set(key, {
      provider: turnProvider,
      model: turnModel,
      usage,
      at,
      signature: signatureOf(turnProvider, turnModel, usage, at),
      carrier,
    })
  }
  return [...turns.values()]
}

/** Running totals; one accumulator serves both the scan and the live hook. */
interface Accumulator {
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheWrite: number
  unpricedCacheWrite: number
  turns: number
  costUsd: number
  byProvider: Record<string, ProviderSavingsStat>
}

function emptyAccumulator(): Accumulator {
  return { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, unpricedCacheWrite: 0, turns: 0, costUsd: 0, byProvider: {} }
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Price one turn and fold it into the running totals.
 *
 * The scan and the live hook share this so the two can never disagree about how
 * a turn is billed — the previous version priced them in two separate places.
 * @param acc - the accumulator to fold into.
 * @param provider - the subscription provider route.
 * @param model - the catalog model id the turn ran on.
 * @param usage - the billed buckets.
 * @param at - the request time in epoch ms, or undefined when unknown.
 * @returns the priced amount in USD.
 */
function accumulateTurn(acc: Accumulator, provider: string, model: string, usage: TokenUsage, at: number | undefined): number {
  const inputTokens = count(usage.inputTokens)
  const outputTokens = count(usage.outputTokens)
  const cacheReadTokens = count(usage.cacheReadTokens)
  const cacheWriteTokens = count(usage.cacheWriteTokens)
  const tokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (tokens <= 0) return 0

  const priced = priceUsage(model, at, usage)

  acc.totalInput += inputTokens
  acc.totalOutput += outputTokens
  acc.totalCacheRead += cacheReadTokens
  acc.totalCacheWrite += cacheWriteTokens
  acc.unpricedCacheWrite += priced.unpricedCacheWriteTokens
  acc.turns += 1
  acc.costUsd += priced.usd

  const stat = acc.byProvider[provider] ?? { tokens: 0, costUsd: 0, turns: 0 }
  stat.tokens += tokens
  stat.costUsd += priced.usd
  stat.turns += 1
  acc.byProvider[provider] = stat
  return priced.usd
}

/** Fold an accumulator's totals into a persistable summary. */
function summarize(acc: Accumulator): TokenSavingsSummary {
  const totalCostUsd = acc.costUsd
  return {
    version: SCAN_VERSION,
    totalTokens: acc.totalInput + acc.totalOutput + acc.totalCacheRead + acc.totalCacheWrite,
    inputTokens: acc.totalInput,
    outputTokens: acc.totalOutput,
    cacheReadTokens: acc.totalCacheRead,
    cacheWriteTokens: acc.totalCacheWrite,
    unpricedCacheWriteTokens: acc.unpricedCacheWrite,
    savedRmb: Math.round(totalCostUsd * USD_TO_CNY_RATE * 100) / 100,
    savedUsd: Math.round(totalCostUsd * 100) / 100,
    rmbPerUsd: USD_TO_CNY_RATE,
    turns: acc.turns,
    byProvider: acc.byProvider,
    updatedAt: Date.now(),
  }
}

/** Rebuild an accumulator from a summary, so the live hook continues its totals. */
function accumulatorOf(summary: TokenSavingsSummary, exactCostUsd: number): Accumulator {
  return {
    totalInput: summary.inputTokens,
    totalOutput: summary.outputTokens,
    totalCacheRead: summary.cacheReadTokens,
    totalCacheWrite: summary.cacheWriteTokens,
    unpricedCacheWrite: summary.unpricedCacheWriteTokens,
    turns: summary.turns,
    costUsd: exactCostUsd,
    byProvider: summary.byProvider,
  }
}

/**
 * Scan the session history, or join the scan already running.
 * @param force - start a fresh walk even when a summary is already loaded.
 * @returns the summary.
 */
export function scanSessionHistory(force = false): Promise<TokenSavingsSummary> {
  // Coalesce: one walk runs at a time, and every concurrent caller joins it.
  // The old condition returned early only when a summary already existed, so
  // while the first scan was running EVERY live usage chunk started another full
  // walk + zstd decompression of the whole sessions tree.
  if (inFlightScan !== undefined) return inFlightScan
  if (inMemorySummary !== undefined && !isScanning && !force) {
    return Promise.resolve(inMemorySummary)
  }
  const scan = runScan().finally(() => {
    if (inFlightScan === scan) {
      inFlightScan = undefined
      isScanning = false
    }
  })
  inFlightScan = scan
  isScanning = true
  return scan
}

/** The walk itself; {@link scanSessionHistory} owns the coalescing around it. */
async function runScan(): Promise<TokenSavingsSummary> {
  try {
    const sessionsDir = dshHomePath('sessions')
    const files = await walkSessionFiles(sessionsDir)
    const acc = emptyAccumulator()

    // Group by session directory: a directory written across the transcript
    // format change holds BOTH files, and they repeat a core of the same
    // requests. Dedup is scoped to that group, never global — two identical
    // requests in different sessions are two requests.
    const byDirectory = new Map<string, string[]>()
    for (const file of files) {
      const dir = dirname(file)
      const list = byDirectory.get(dir)
      if (list === undefined) byDirectory.set(dir, [file])
      else list.push(file)
    }

    for (const directory of byDirectory.values()) {
      /** Signature -> the transcript that already claimed it in this directory. */
      const claimed = new Map<string, string>()
      for (const file of directory) {
        let content: string
        try {
          const raw = await fs.readFile(file)
          content = (await decompressZstd(raw)).toString('utf8')
        } catch {
          continue
        }
        for (const turn of collectBilledTurns(content)) {
          if (!SUBSCRIPTION_PROVIDERS.has(turn.provider)) continue
          const owner = claimed.get(turn.signature)
          if (owner !== undefined && owner !== file) continue
          claimed.set(turn.signature, file)
          accumulateTurn(acc, turn.provider, turn.model, turn.usage, turn.at)
        }
      }
    }

    const summary = summarize(acc)
    inMemorySummary = summary
    inMemoryCostUsd = acc.costUsd
    await persistStats(summary).catch(() => undefined)
    return summary
  } catch {
    // A failed walk still leaves the caller with a usable summary rather than a
    // rejected promise; scanSessionHistory's finally releases the latch.
    return inMemorySummary ?? emptySummary()
  }
}

async function persistStats(summary: TokenSavingsSummary): Promise<void> {
  const filePath = statsFilePath()
  const dir = dshHomePath('plugins', 'subscriptions')
  await fs.mkdir(dir, { recursive: true })
  // A random nonce, like every other store in this plugin. A pid-only name was
  // shared by two concurrent increments in one process (multiple sessions each
  // recording usage), so both wrote the same temp file and the rename could
  // publish torn content or lose a write entirely.
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, filePath)
}

/**
 * The lifetime totals and savings estimate.
 * @param force - re-walk the session history instead of answering from cache.
 * @returns the summary.
 */
export async function getTokenSavingsSummary(force = false): Promise<TokenSavingsSummary> {
  if (inMemorySummary !== undefined && !force) {
    // If stats are older than 6 hours, re-scan in background
    if (Date.now() - inMemorySummary.updatedAt > 6 * 3600_000 && !isScanning) {
      void scanSessionHistory()
    }
    return inMemorySummary
  }
  if (force) {
    // A caller that asked explicitly gets the walk's own answer, not a cached one.
    if (inMemorySummary === undefined) {
      try {
        const raw = await fs.readFile(statsFilePath(), 'utf8')
        const parsed = sanitizePersisted(JSON.parse(raw) as unknown)
        if (parsed !== undefined) {
          inMemorySummary = parsed
          inMemoryCostUsd = parsed.savedUsd
        }
      } catch {}
    }
    return scanSessionHistory(true)
  }

  // Try reading persisted stats
  try {
    const raw = await fs.readFile(statsFilePath(), 'utf8')
    const parsed = sanitizePersisted(JSON.parse(raw) as unknown)
    if (parsed !== undefined) {
      inMemorySummary = parsed
      inMemoryCostUsd = parsed.savedUsd
      return parsed
    }
  } catch {}

  // Fall back to scanning session history
  return scanSessionHistory()
}

/**
 * Validate a persisted stats file into the full summary shape.
 *
 * A partially-written or hand-edited file used to be accepted on the strength of
 * `totalTokens` alone, and the next `recordStreamTokenUsage` then threw
 * `TypeError: Cannot read properties of undefined (reading '<provider>')` on
 * `byProvider` — from inside the adapter's stream wrapper, so the user's turn
 * failed at the usage chunk AFTER the model had already answered. Every field the
 * increment path touches is therefore required here; anything missing discards the
 * file and lets the history scan rebuild it.
 *
 * A document from an older {@link SCAN_VERSION} is discarded for a different
 * reason: its totals were priced from one transcript carrier, so they are not
 * merely stale but under-counted, and no incremental update can repair that.
 * @param value - the parsed JSON document.
 * @returns the validated summary, or undefined when the shape is unusable.
 */
function sanitizePersisted(value: unknown): TokenSavingsSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.version !== SCAN_VERSION) return undefined
  const numeric = ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'turns', 'savedUsd', 'savedRmb'] as const
  const out: Record<string, number> = {}
  for (const key of numeric) {
    const field = raw[key]
    if (typeof field !== 'number' || !Number.isFinite(field)) return undefined
    out[key] = field
  }
  const byProvider = raw.byProvider
  if (typeof byProvider !== 'object' || byProvider === null || Array.isArray(byProvider)) return undefined
  const optional = (key: string): number => (typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] as number : 0)
  return {
    version: SCAN_VERSION,
    totalTokens: out.totalTokens!,
    inputTokens: out.inputTokens!,
    outputTokens: out.outputTokens!,
    cacheReadTokens: out.cacheReadTokens!,
    cacheWriteTokens: optional('cacheWriteTokens'),
    unpricedCacheWriteTokens: optional('unpricedCacheWriteTokens'),
    turns: out.turns!,
    savedUsd: out.savedUsd!,
    savedRmb: out.savedRmb!,
    rmbPerUsd: typeof raw.rmbPerUsd === 'number' && Number.isFinite(raw.rmbPerUsd) && raw.rmbPerUsd > 0
      ? raw.rmbPerUsd
      : USD_TO_CNY_RATE,
    byProvider: byProvider as TokenSavingsSummary['byProvider'],
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/**
 * Increment live token stats when a stream completes.
 *
 * The hook runs inside the adapter's stream wrapper, so it must never throw and
 * never block the turn; the first call after a start only kicks off the scan that
 * gives it totals to add to.
 */
export function recordStreamTokenUsage(
  provider: string,
  model: string,
  usage: TokenUsage | undefined,
): void {
  if (!usage || !SUBSCRIPTION_PROVIDERS.has(provider)) return
  if (count(usage.inputTokens) + count(usage.outputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens) <= 0) return

  if (inMemorySummary === undefined) {
    // One scan at a time. The old guard returned early only when a summary
    // already existed, so while the first scan was still running EVERY live
    // usage chunk started another full walk + zstd decompression of the whole
    // sessions tree. `isScanning` is the coalescing latch here.
    void scanSessionHistory()
    return
  }

  const acc = accumulatorOf(inMemorySummary, inMemoryCostUsd ?? inMemorySummary.savedUsd)
  accumulateTurn(acc, provider, model, usage, Date.now())
  inMemorySummary = summarize(acc)
  inMemoryCostUsd = acc.costUsd
  void persistStats(inMemorySummary).catch(() => undefined)
}

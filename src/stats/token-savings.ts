/**
 * Token stats and cost savings estimation engine.
 *
 * Scans DSH session history and listens to live stream usage across all
 * subscription providers (Codex, Claude, Grok, Copilot, Antigravity,
 * CommandCode, CodeBuddy, Zed).
 *
 * Prices each model using standard public pay-per-token API rates (USD per million
 * tokens) reference from `dsh-chat-cost`, and converts to RMB (¥) to estimate
 * total money saved by using flat-rate / bundled subscriptions instead of
 * pay-as-you-go API keys.
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

export interface ProviderSavingsStat {
  tokens: number
  costUsd: number
  turns: number
}

export interface TokenSavingsSummary {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  savedRmb: number
  savedUsd: number
  turns: number
  byProvider: Record<string, ProviderSavingsStat>
  updatedAt: number
}

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

/**
 * Standard pay-per-token API rates per 1,000,000 tokens (in USD).
 * Sourced from official pricing & dsh-chat-cost catalog.
 */
const PRICING_RULES: Record<string, { input: number; output: number; cache: number }> = {
  // Anthropic / Claude
  'claude-opus': { input: 15, output: 75, cache: 0.5 },
  'claude-sonnet': { input: 3, output: 15, cache: 0.3 },
  'claude-fable': { input: 10, output: 50, cache: 0.25 },
  'claude-haiku': { input: 1, output: 5, cache: 0.1 },
  // OpenAI / Codex / Zed
  'gpt-5': { input: 2.5, output: 10, cache: 0.25 },
  'gpt-6': { input: 5, output: 20, cache: 0.5 },
  'gpt-4': { input: 2.5, output: 10, cache: 0.25 },
  // xAI / Grok
  'grok': { input: 2, output: 10, cache: 0.2 },
  // Google / Antigravity
  'gemini-3.1-pro': { input: 2, output: 12, cache: 0.2 },
  'gemini-3-pro': { input: 2, output: 12, cache: 0.2 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cache: 0.075 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cache: 0.075 },
  'gemini-3-flash': { input: 0.5, output: 3, cache: 0.05 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cache: 0.03 },
  'gemini-flash': { input: 0.3, output: 2.5, cache: 0.03 },
  // DeepSeek / CommandCode
  'deepseek': { input: 0.15, output: 0.6, cache: 0.003 },
  'glm': { input: 0.2, output: 0.8, cache: 0.02 },
  // Tencent / CodeBuddy
  'hy4': { input: 0.4, output: 1.5, cache: 0.05 },
  'codebuddy': { input: 0.4, output: 1.5, cache: 0.05 },
  // Trae (ByteDance) serves third-party models through its own gateway; the
  // per-model family rules above already price them, and this entry covers the
  // Trae-branded names (Doubao / Seed).
  'doubao': { input: 0.4, output: 1.5, cache: 0.05 },
  'seed': { input: 0.4, output: 1.5, cache: 0.05 },
}

export const USD_TO_CNY_RATE = 7.23

export function getModelPrice(modelName: string): { input: number; output: number; cache: number } {
  const m = (modelName || '').toLowerCase()
  for (const [key, price] of Object.entries(PRICING_RULES)) {
    if (m.includes(key)) return price
  }
  return { input: 2.0, output: 8.0, cache: 0.2 }
}

function statsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'token-stats.json')
}

let inMemorySummary: TokenSavingsSummary | undefined
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
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    savedUsd: 0,
    savedRmb: 0,
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

export function scanSessionHistory(): Promise<TokenSavingsSummary> {
  // Coalesce: one walk runs at a time, and every concurrent caller joins it.
  // The old condition returned early only when a summary already existed, so
  // while the first scan was running EVERY live usage chunk started another full
  // walk + zstd decompression of the whole sessions tree.
  if (inFlightScan !== undefined) return inFlightScan
  if (inMemorySummary !== undefined && !isScanning) {
    // A summary is already loaded; a caller wanting a refresh still gets a fresh
    // walk only when one is not already running (handled above).
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

    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCostUsd = 0
    let totalTurns = 0
    const byProvider: Record<string, ProviderSavingsStat> = {}

    for (const file of files) {
      let content: string
      try {
        const raw = await fs.readFile(file)
        content = (await decompressZstd(raw)).toString('utf8')
      } catch {
        continue
      }

      const lines = content.split('\n')
      let currentProvider = ''
      let currentModel = ''

      for (const line of lines) {
        if (!line) continue
        try {
          const event = JSON.parse(line) as {
            type?: string
            data?: {
              header?: { config?: { provider?: string; model?: string } }
              chunk?: { type?: string; usage?: TokenUsage }
            }
          }
          if (event.type === 'request/header') {
            currentProvider = event.data?.header?.config?.provider || ''
            currentModel = event.data?.header?.config?.model || ''
          } else if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
            if (!SUBSCRIPTION_PROVIDERS.has(currentProvider)) continue
            const usage = event.data.chunk.usage
            if (!usage) continue

            const inp = usage.inputTokens || 0
            const out = usage.outputTokens || 0
            const cache = usage.cacheReadTokens || 0
            const tokens = inp + out + cache

            totalInput += inp
            totalOutput += out
            totalCacheRead += cache
            totalTurns += 1

            const price = getModelPrice(currentModel || currentProvider)
            const cost = (inp * price.input + out * price.output + cache * price.cache) / 1_000_000
            totalCostUsd += cost

            if (!byProvider[currentProvider]) {
              byProvider[currentProvider] = { tokens: 0, costUsd: 0, turns: 0 }
            }
            byProvider[currentProvider]!.tokens += tokens
            byProvider[currentProvider]!.costUsd += cost
            byProvider[currentProvider]!.turns += 1
          }
        } catch {}
      }
    }

    const totalTokens = totalInput + totalOutput + totalCacheRead
    const savedRmb = Math.round(totalCostUsd * USD_TO_CNY_RATE * 100) / 100
    const savedUsd = Math.round(totalCostUsd * 100) / 100

    const summary: TokenSavingsSummary = {
      totalTokens,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      savedRmb,
      savedUsd,
      turns: totalTurns,
      byProvider,
      updatedAt: Date.now(),
    }

    inMemorySummary = summary
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

export async function getTokenSavingsSummary(): Promise<TokenSavingsSummary> {
  if (inMemorySummary !== undefined) {
    // If stats are older than 6 hours, re-scan in background
    if (Date.now() - inMemorySummary.updatedAt > 6 * 3600_000 && !isScanning) {
      void scanSessionHistory()
    }
    return inMemorySummary
  }

  // Try reading persisted stats
  try {
    const raw = await fs.readFile(statsFilePath(), 'utf8')
    const parsed = sanitizePersisted(JSON.parse(raw) as unknown)
    if (parsed !== undefined) {
      inMemorySummary = parsed
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
 * failed at the usage chunk AFTER the model had already answered. Every field
 * the increment path touches is therefore required here; anything missing
 * discards the file and lets the history scan rebuild it.
 * @param value - the parsed JSON document.
 * @returns the validated summary, or undefined when the shape is unusable.
 */
function sanitizePersisted(value: unknown): TokenSavingsSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const numeric = ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'turns', 'savedUsd', 'savedRmb'] as const
  const out: Record<string, number> = {}
  for (const key of numeric) {
    const field = raw[key]
    if (typeof field !== 'number' || !Number.isFinite(field)) return undefined
    out[key] = field
  }
  const byProvider = raw.byProvider
  if (typeof byProvider !== 'object' || byProvider === null || Array.isArray(byProvider)) return undefined
  return {
    totalTokens: out.totalTokens!,
    inputTokens: out.inputTokens!,
    outputTokens: out.outputTokens!,
    cacheReadTokens: out.cacheReadTokens!,
    turns: out.turns!,
    savedUsd: out.savedUsd!,
    savedRmb: out.savedRmb!,
    byProvider: byProvider as TokenSavingsSummary['byProvider'],
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/**
 * Increment live token stats when a stream completes.
 */
export function recordStreamTokenUsage(
  provider: string,
  model: string,
  usage: TokenUsage | undefined,
): void {
  if (!usage || !SUBSCRIPTION_PROVIDERS.has(provider)) return
  const inp = usage.inputTokens || 0
  const out = usage.outputTokens || 0
  const cache = usage.cacheReadTokens || 0
  const tokens = inp + out + cache
  if (tokens <= 0) return

  const price = getModelPrice(model || provider)
  const cost = (inp * price.input + out * price.output + cache * price.cache) / 1_000_000

  if (inMemorySummary === undefined) {
    // One scan at a time. The old guard returned early only when a summary
    // already existed, so while the first scan was still running EVERY live
    // usage chunk started another full walk + zstd decompression of the whole
    // sessions tree — dozens of concurrent history scans during the first turns
    // after a start. `isScanning` is the coalescing latch here.
    void scanSessionHistory()
    return
  }

  inMemorySummary.totalTokens += tokens
  inMemorySummary.inputTokens += inp
  inMemorySummary.outputTokens += out
  inMemorySummary.cacheReadTokens += cache
  inMemorySummary.turns += 1
  inMemorySummary.savedUsd = Math.round((inMemorySummary.savedUsd + cost) * 100) / 100
  inMemorySummary.savedRmb = Math.round(inMemorySummary.savedUsd * USD_TO_CNY_RATE * 100) / 100

  if (!inMemorySummary.byProvider[provider]) {
    inMemorySummary.byProvider[provider] = { tokens: 0, costUsd: 0, turns: 0 }
  }
  inMemorySummary.byProvider[provider]!.tokens += tokens
  inMemorySummary.byProvider[provider]!.costUsd += cost
  inMemorySummary.byProvider[provider]!.turns += 1
  inMemorySummary.updatedAt = Date.now()

  void persistStats(inMemorySummary).catch(() => undefined)
}

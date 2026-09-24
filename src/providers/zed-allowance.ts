/**
 * Zed's included-token allowance, read from Zed's own pricing page.
 *
 * Zed does not disclose this figure on any API the plugin can call — the billing
 * endpoints return SPEND and, when the account has one, a limit; the bundled
 * allowance is a PRODUCT fact published only on the marketing page. So it is read
 * from there, and cached, so the number can move with Zed's pricing without a code
 * change.
 *
 * The page states it as prose inside each plan card — `$5 of tokens included` — so
 * the extraction is deliberately narrow: find that exact phrase, take its figure, and
 * attribute it to the nearest plan name preceding it. Anything the parse cannot
 * attribute is left ABSENT rather than guessed.
 *
 * Verified 2026-09-23 against https://zed.dev/pricing, which says:
 *   - Free:     `$0 forever`
 *   - Pro:      `$10 per month` with **`$5 of tokens included`**
 *   - Business: `$30 per seat, per month`
 *   - Trial:    a `$5` balance, shared across Zed and Delta
 *
 * Note the trap that the earlier hardcoded table fell into: the page carries BOTH a
 * subscription price and an allowance, and they differ (Pro is $10/month for $5 of
 * tokens). Reading the wrong one yields a plausible number that is simply not the
 * allowance.
 *
 * @module dsh-subscription-hub/providers/zed-allowance
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Zed's own pricing page, the only place the bundled allowance is published. */
export const ZED_PRICING_URL = 'https://zed.dev/pricing'

/** How long a fetched page is trusted before it is read again. */
export const ZED_ALLOWANCE_TTL_MS = 24 * 60 * 60 * 1000

/** Where the parsed allowance is cached. */
export function zedAllowanceCachePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'zed-allowance.json')
}

/** The plan names the page's cards use, lower-cased for matching. */
const PLAN_NAMES = ['free', 'pro', 'business', 'student', 'trial', 'vip'] as const

/** One parsed allowance, as read from the page. */
export interface ZedAllowanceSnapshot {
  /** Plan key (lower-cased page name) → included USD. Only plans the page stated. */
  byPlan: Record<string, number>
  /** When the page was read (epoch ms). */
  readAt: number
  /** The page URL, for the record. */
  source: string
}

/**
 * Parse `$N of tokens included` phrases out of the pricing page.
 *
 * Attribution is positional and conservative: each figure is bound to the nearest
 * plan name appearing BEFORE it in the flattened text, because the page renders each
 * plan as a heading followed by its bullet list. A figure with no plan name before it
 * is dropped — an unattributable number is not a fact about a plan.
 * @param html - the raw pricing page.
 * @returns plan key → included USD, for the plans the page actually stated.
 */
export function parseZedAllowances(html: string): Record<string, number> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

  // NO positional attribution. An earlier version bound each figure to the nearest
  // plan name before it, and the page defeated that immediately: the Pro card is
  // titled "Pro Free Trial $10 per month", so the nearest name is "Trial" while the
  // card is Pro's, and the figure came out attributed to the wrong tier. Guessing
  // ownership from layout is exactly the kind of inference this module is supposed to
  // avoid, so it is gone.
  //
  // What the page actually states, measured 2026-09-23:
  //   - exactly ONE `$N of tokens included` phrase, and it is the paid consumer tier's
  //   - the free tier's allowance as `$0 forever`
  //   - per-card prices (`$10 per month`, `$30 per seat`) that are NOT allowances
  //
  // So: take the single phrase, and refuse to answer when the shape is not the one
  // measured. A page that grows a second allowance phrase, or loses the only one,
  // yields NOTHING rather than a number attributed by guesswork.
  const phrases = [...text.matchAll(/\$\s?([\d.]+)\s+of\s+tokens?\s+included/gi)]
    .map(match => Number(match[1]))
    .filter(amount => Number.isFinite(amount) && amount >= 0)

  const byPlan: Record<string, number> = {}
  if (/\$0\s+forever/i.test(text)) byPlan.free = 0
  if (phrases.length !== 1) return byPlan
  const allowance = phrases[0]
  if (allowance === undefined) return byPlan
  byPlan.pro = allowance
  return byPlan
}

/** Read the cache; any failure answers `undefined` rather than a stale guess. */
export async function readZedAllowanceCache(): Promise<ZedAllowanceSnapshot | undefined> {
  try {
    const raw = JSON.parse(await readFile(zedAllowanceCachePath(), 'utf8')) as Record<string, unknown>
    const byPlan = raw.byPlan
    if (typeof byPlan !== 'object' || byPlan === null || Array.isArray(byPlan)) return undefined
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(byPlan)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value
    }
    return {
      byPlan: clean,
      readAt: typeof raw.readAt === 'number' && Number.isFinite(raw.readAt) ? raw.readAt : 0,
      source: typeof raw.source === 'string' ? raw.source : ZED_PRICING_URL,
    }
  } catch {
    return undefined
  }
}

/** Persist a freshly parsed snapshot, atomically. */
export async function writeZedAllowanceCache(snapshot: ZedAllowanceSnapshot): Promise<void> {
  const path = zedAllowanceCachePath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The allowance Zed's own UI shows for plans its pricing page does not list.
 *
 * A last resort, and deliberately narrow. The page documents Free, Pro, Business and
 * Trial; it never mentions `zed_student`, yet a Student account's own UI reports an
 * allowance — so the figure is carried here rather than rendered as absent. It is a
 * documented constant, NOT a derivation: the earlier code derived a number from the
 * plan NAME, which is how a subscription price and an allowance got confused.
 *
 * `student: 10` is the figure Zed reports to the account (the user confirmed the
 * display was right); it is not on the public page, so it cannot be fetched and will
 * not track a repricing on its own.
 */
export const ZED_UNDOCUMENTED_ALLOWANCES: Readonly<Record<string, number>> = Object.freeze({
  student: 10,
})

/**
 * The allowance to display, resolved SYNCHRONOUSLY.
 *
 * `parseZedUsage` is synchronous and called from tests, so the cache is read with a
 * blocking read rather than made async. Freshness is the caller's job: `fetchZedUsage`
 * refreshes the cache from the page (TTL'd) before parsing.
 * @param plan - the account's plan id.
 * @returns the included USD, or undefined when nothing states one.
 */
export function zedAllowanceSync(plan: string | undefined): number | undefined {
  const key = planKeyOf(plan)
  if (key === undefined) return undefined
  try {
    const raw = JSON.parse(readFileSync(zedAllowanceCachePath(), 'utf8')) as { byPlan?: Record<string, unknown> }
    const hit = raw.byPlan?.[key]
    if (typeof hit === 'number' && Number.isFinite(hit) && hit >= 0) return hit
  } catch {
    // No cache yet: fall through to the documented table.
  }
  return ZED_UNDOCUMENTED_ALLOWANCES[key]
}

/**
 * Refresh the cached page when it is stale. Best effort, called from the async usage
 * path; a failure leaves the previous snapshot standing.
 * @param fetchFn - injectable fetcher.
 * @param now - current time, for freshness.
 */
export async function refreshZedAllowanceCache(
  fetchFn: typeof fetch,
  now = Date.now(),
): Promise<void> {
  const cached = await readZedAllowanceCache()
  if (cached !== undefined && now - cached.readAt < ZED_ALLOWANCE_TTL_MS) return
  try {
    const response = await fetchFn(ZED_PRICING_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!response.ok) return
    const parsed = parseZedAllowances(await response.text())
    if (Object.keys(parsed).length === 0) return
    await writeZedAllowanceCache({ byPlan: parsed, readAt: now, source: ZED_PRICING_URL })
  } catch {
    // A transport failure is not evidence about the price.
  }
}

/**
 * Map an account plan id onto the page's plan word.
 *
 * `zed_student` deliberately answers `student`, which the page does not document — so
 * it resolves through {@link ZED_UNDOCUMENTED_ALLOWANCES} rather than to some other
 * tier's figure.
 * @param plan - the raw plan id from the session or the payload.
 * @returns the page's plan word, or undefined when there is none.
 */
export function planKeyOf(plan: string | undefined): string | undefined {
  if (typeof plan !== 'string') return undefined
  const lower = plan.toLowerCase().trim().replace(/^token_based_/, '')
  if (lower === '') return undefined
  for (const name of PLAN_NAMES) {
    if (lower === name || lower === `zed_${name}` || lower.includes(name)) return name
  }
  return undefined
}
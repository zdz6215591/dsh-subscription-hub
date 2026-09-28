/**
 * Freebuff quota read → the hub's `ProviderUsage`.
 *
 * ## What the endpoint discloses
 *
 * `GET {freebuff.com}/api/web/freebuff-session` (cookie) and
 * `GET {codebuff.com}/api/v1/freebuff/session` (Bearer) answer the same balance
 * picture (`src/web_protocol.rs:606-619`, `src/upstream.rs:138-152`):
 * `freebucks{balance, daily{limit,spent,remaining,resetAt}, planId, prices,
 * priceNotices}`, `accessTier`, `subscription`, `rateLimitsByModel{model →
 * {limit, recentCount, resetAt, poolLabel}}`, `referral`, `countryCode` and
 * `countryBlockReason`.
 *
 * The two wires SPELL it differently, and both spellings are read here: the
 * upstream web response is camelCase at top level (`src/web_protocol.rs:727-745`
 * — `accessTier`, `rateLimitsByModel`, `countryCode`), while the reference's own
 * `/api/account/balance` re-emits the same data snake_case
 * (`src/api.rs:576-584` — `access_tier`, `rate_limits_by_model`, `country_code`).
 *
 * ## Units
 *
 * The amounts are CREDITS, and the windows say so: `unit: 'credits'`. The hub's
 * renderer used to assume dollars from the presence of `used`/`limit`, which put
 * a `$` on Qoder's credit pools (`src/providers/common.ts`), and the reference's
 * own panel calls these 积分 (`docs/API_GUIDE.md:191,198`). Credits are the
 * vendor's unit; nothing here converts them.
 *
 * ## What is NOT here
 *
 * The reference computes a per-model "runs left today" as
 * `floor(daily.remaining / prices[model])` capped by the model's admission
 * counter, with `-1` meaning unbounded (`src/api.rs:538-572`). That is
 * ARITHMETIC over two disclosed fields, not a disclosed field of its own, so it
 * is not folded into `ProviderUsage` where it would read as a published number:
 * {@link freebuffDerivedModelBudget} exposes it, named and labelled as a
 * derivation.
 *
 * `countryBlockReason` becomes a WARNING (`{@link freebuffQuotaWarnings}`) rather
 * than a window: it is a statement about where the account is, not an allowance,
 * and inventing a window from it would draw a fabricated quota bar.
 *
 * @module dsh-subscription-hub/providers/freebuff/usage
 */

import { proxiedFetch } from '../../http.js'
import type { ProviderUsage, UsageWindow } from '../common.js'
import type { FetchFn } from '../common.js'
import type { FreebuffCredential } from './client.js'
import {
  freebuffCredentialKind,
  freebuffSessionHeaders,
  freebuffSessionUrl,
  freebuffSessionUnauthenticated,
} from './client.js'

/** Bound on one balance read: a hanging poll must not block the settings card. */
const QUOTA_TIMEOUT_MS = 15_000

/** The daily counter as the wire states it (`src/web_protocol.rs:763-773`). */
export interface FreebuffDailyQuota {
  /** Credits the day allows. */
  limit?: number
  /** Credits already spent today. */
  spent?: number
  /** Credits left today. */
  remaining?: number
  /** The instant the day rolls over, as the wire spelled it. */
  resetAt?: unknown
}

/** The credit block (`src/web_protocol.rs:747-761`). */
export interface FreebuffFreebucks {
  balance?: number
  daily?: FreebuffDailyQuota
  planId?: string
  /** Credit price per model, as disclosed. */
  prices?: Record<string, number>
}

/** One per-model admission row (`src/web_protocol.rs:735-736`, `src/web_threads.rs:4`). */
export interface FreebuffModelAdmission {
  limit?: number
  recentCount?: number
  resetAt?: string
  poolLabel?: string
}

/** The balance payload, in either spelling. */
export interface FreebuffQuota {
  accessTier?: string
  freebucks?: FreebuffFreebucks
  /** `subscription.tierId` — the reference's first choice for a tier label (`src/api.rs:5660-5670`). */
  tierId?: string
  rateLimitsByModel?: Record<string, FreebuffModelAdmission>
  countryCode?: string
  countryBlockReason?: string
}

/** Read a field that the two wires spell differently. */
function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake]
}

/** A finite number, or undefined for anything else (strings included). */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A non-empty string, or undefined. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A nested object, or undefined. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Normalize the balance payload from either wire.
 *
 * Unknown fields are dropped rather than guessed at, and a payload with neither
 * `accessTier` nor `freebucks` normalizes to `undefined` — that is the shape
 * `src/api.rs:5618-5621` uses to decide a credential was NOT honoured, so it is
 * a refusal rather than an empty account.
 * @param payload - the parsed response body.
 * @returns the normalized quota, or undefined when nothing was disclosed.
 */
export function parseFreebuffQuota(payload: unknown): FreebuffQuota | undefined {
  const record = recordOf(payload)
  if (record === undefined) return undefined
  if (freebuffSessionUnauthenticated(record)) return undefined
  const freebucksRaw = recordOf(record.freebucks)
  const dailyRaw = freebucksRaw === undefined ? undefined : recordOf(freebucksRaw.daily)
  const pricesRaw = freebucksRaw === undefined ? undefined : recordOf(freebucksRaw.prices)
  const prices: Record<string, number> = {}
  for (const [model, value] of Object.entries(pricesRaw ?? {})) {
    const price = numberOf(value)
    if (price !== undefined) prices[model] = price
  }
  const limitsRaw = recordOf(field(record, 'rateLimitsByModel', 'rate_limits_by_model'))
  const admissions: Record<string, FreebuffModelAdmission> = {}
  for (const [model, value] of Object.entries(limitsRaw ?? {})) {
    const row = recordOf(value)
    if (row === undefined) continue
    const limit = numberOf(row.limit)
    const recentCount = numberOf(row.recentCount)
    const resetAt = stringOf(row.resetAt)
    const poolLabel = stringOf(row.poolLabel)
    admissions[model] = {
      ...limit === undefined ? {} : { limit },
      ...recentCount === undefined ? {} : { recentCount },
      ...resetAt === undefined ? {} : { resetAt },
      ...poolLabel === undefined ? {} : { poolLabel },
    }
  }
  const limit = dailyRaw === undefined ? undefined : numberOf(dailyRaw.limit)
  const spent = dailyRaw === undefined ? undefined : numberOf(dailyRaw.spent)
  const remaining = dailyRaw === undefined ? undefined : numberOf(dailyRaw.remaining)
  const resetAt = dailyRaw === undefined ? undefined : dailyRaw.resetAt
  const balance = freebucksRaw === undefined ? undefined : numberOf(freebucksRaw.balance)
  const planId = freebucksRaw === undefined ? undefined : stringOf(freebucksRaw.planId)
  const freebucks: FreebuffFreebucks = {
    ...balance === undefined ? {} : { balance },
    ...dailyRaw === undefined ? {} : {
      daily: {
        ...limit === undefined ? {} : { limit },
        ...spent === undefined ? {} : { spent },
        ...remaining === undefined ? {} : { remaining },
        ...resetAt === undefined ? {} : { resetAt },
      },
    },
    ...planId === undefined ? {} : { planId },
    ...Object.keys(prices).length === 0 ? {} : { prices },
  }
  const accessTier = stringOf(field(record, 'accessTier', 'access_tier'))
  const subscription = recordOf(record.subscription)
  const tierId = subscription === undefined ? undefined : stringOf(subscription.tierId)
  const countryCode = stringOf(field(record, 'countryCode', 'country_code'))
  const countryBlockReason = stringOf(field(record, 'countryBlockReason', 'country_block_reason'))
  return {
    ...accessTier === undefined ? {} : { accessTier },
    ...Object.keys(freebucks).length === 0 ? {} : { freebucks },
    ...tierId === undefined ? {} : { tierId },
    ...Object.keys(admissions).length === 0 ? {} : { rateLimitsByModel: admissions },
    ...countryCode === undefined ? {} : { countryCode },
    ...countryBlockReason === undefined ? {} : { countryBlockReason },
  }
}

/** Parse a reset instant the wire may spell as ISO text or as epoch ms/s. */
function resetInstant(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Under 10^11 a number cannot be a millisecond epoch in this century, so the
    // wire meant seconds — the same threshold the shared readers use
    // (`src/providers/rate-limit.ts:resetInstantFromNumber`).
    return value >= 1e11 ? value : value * 1_000
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/**
 * The per-model admission rows, exactly as disclosed.
 *
 * `limit`/`recentCount` are a SEPARATE constraint from the credit balance — the
 * reference describes them as the daily session admission (`src/web_threads.rs:4`:
 * "默认 6/天，recentCount 计已用") — which is why they are reported beside the
 * credit window instead of being merged into it.
 * @param quota - the normalized quota.
 * @returns the rows keyed by model id (empty when the read carried none).
 */
export function freebuffModelAdmissions(quota: FreebuffQuota): Record<string, FreebuffModelAdmission> {
  return quota.rateLimitsByModel ?? {}
}

/** One derived per-model budget. Every field here is ARITHMETIC over disclosed fields. */
export interface FreebuffDerivedModelBudget {
  /** The disclosed credit price, when one was published. */
  price: number
  /** `floor(daily.remaining / price)`, or -1 when the price is 0 (unbounded). */
  byCreditRemaining: number
  /** `limit - recentCount` of the admission row, or -1 when there is none. */
  byLimitRemaining: number
  /** The smaller of the two, or -1 when unbounded — the reference's `usable_today`. */
  usableToday: number
}

/**
 * The reference's per-model "runs left today", labelled as the DERIVATION it is.
 *
 * Ported from `src/api.rs:538-572`, including its `-1` convention: `-1` means
 * "unbounded" (a zero-credit-price model, or a model with no admission row), not
 * "none left". Nothing here is a number the upstream published — it is
 * `floor(remaining / price)` and `limit - recentCount` computed from two
 * disclosed fields, which is why it lives beside `ProviderUsage` rather than
 * inside it.
 * @param quota - the normalized quota.
 * @returns one entry per model the payload priced, or an empty object.
 */
export function freebuffDerivedModelBudget(quota: FreebuffQuota): Record<string, FreebuffDerivedModelBudget> {
  const prices = quota.freebucks?.prices
  if (prices === undefined) return {}
  const dailyRemaining = quota.freebucks?.daily?.remaining
  const remaining = dailyRemaining === undefined ? 0 : dailyRemaining
  const admissions = freebuffModelAdmissions(quota)
  const out: Record<string, FreebuffDerivedModelBudget> = {}
  for (const [model, price] of Object.entries(prices)) {
    const byCredit = price > 0 ? Math.floor(remaining / price) : -1
    const row = admissions[model]
    const limit = row?.limit
    const recent = row?.recentCount ?? 0
    const byLimit = limit !== undefined && limit > 0 ? Math.max(0, limit - recent) : -1
    const bounded = [byCredit, byLimit].filter(value => value !== -1)
    out[model] = {
      price,
      byCreditRemaining: byCredit,
      byLimitRemaining: byLimit,
      usableToday: bounded.length === 0 ? -1 : Math.min(...bounded),
    }
  }
  return out
}

/**
 * The warning lines a quota read earns.
 *
 * `countryBlockReason` is the one that matters: upstream states the account is
 * blocked in its country (`src/web_protocol.rs:741`), and a card that rendered
 * that as a 0-credit window would be inventing a quota rather than reporting a
 * refusal to serve.
 * @param quota - the normalized quota.
 * @returns the lines to surface, in order (empty when there is nothing to say).
 */
export function freebuffQuotaWarnings(quota: FreebuffQuota): string[] {
  const warnings: string[] = []
  if (quota.countryBlockReason !== undefined) {
    const where = quota.countryCode === undefined ? '' : ` (${quota.countryCode})`
    warnings.push(
      `Freebuff reports this account is blocked${where}: ${quota.countryBlockReason}. `
      + 'Requests will be refused while that stands.',
    )
  }
  return warnings
}

/** Options for {@link freebuffUsageFromQuota}. */
export interface FreebuffUsageOptions {
  /** Sink for the warning lines {@link freebuffQuotaWarnings} produces. */
  onWarn?: (message: string) => void
}

/**
 * Project a balance read onto the hub's `ProviderUsage`.
 *
 * One window, because the payload discloses one window: a DAILY credit counter
 * with `limit`/`spent`/`remaining` and a `resetAt` instant. Its `kind` is `other`
 * (the hub's vocabulary has no `daily`) with `scope: 'daily'` naming it.
 *
 * `usedPercent` is COMPUTED from the disclosed `spent`/`limit`, clamped to
 * 0–100: the shape has no other way to state consumption, and the alternative —
 * drawing an empty bar for a spent-out day — would be wrong in the direction
 * that matters. With no `limit` there is nothing to be a percentage OF, so it is
 * 0 and the amounts stand alone.
 *
 * An absent field stays absent: a payload that disclosed no `resetAt` yields a
 * window with no `resetsAt`, never a predicted midnight.
 * @param quota - the normalized quota.
 * @param options - warning sink.
 * @returns the hub-facing usage; `supported: false` when nothing was disclosed.
 */
export function freebuffUsageFromQuota(quota: FreebuffQuota, options: FreebuffUsageOptions = {}): ProviderUsage {
  for (const warning of freebuffQuotaWarnings(quota)) options.onWarn?.(warning)
  const daily = quota.freebucks?.daily
  if (daily === undefined) return { supported: false }
  const limit = daily.limit
  const spent = daily.spent
  const remaining = daily.remaining
  if (limit === undefined && spent === undefined && remaining === undefined) return { supported: false }
  const usedPercent = limit !== undefined && limit > 0 && spent !== undefined
    ? Math.min(100, Math.max(0, (spent / limit) * 100))
    : 0
  const resetsAt = resetInstant(daily.resetAt)
  const window: UsageWindow = {
    kind: 'other',
    scope: 'daily',
    usedPercent,
    ...remaining === undefined ? {} : { remaining },
    ...limit === undefined ? {} : { limit },
    ...spent === undefined ? {} : { used: spent },
    // Credits, declared: see the module doc for why the unit is not optional here.
    unit: 'credits',
    ...resetsAt === undefined ? {} : { resetsAt },
  }
  const plan = quota.tierId ?? quota.freebucks?.planId ?? quota.accessTier
  return {
    supported: true,
    windows: [window],
    ...remaining === undefined ? {} : { remaining },
    ...limit === undefined ? {} : { limit },
    // The provider-level pair sums the very same credits, so it declares the same unit.
    unit: 'credits',
    ...plan === undefined ? {} : { plan },
  }
}

/**
 * Read one account's balance.
 *
 * A read that fails reports `supported: false` rather than throwing: the hub's
 * usage hook expects a shape, and a card that cannot read its quota should say
 * so instead of failing the whole settings page (`src/providers/qoder/usage.ts`
 * takes the same line). A 401/403 is the credential being refused — the same
 * signal that invalidates a stored session on the request path
 * (`src/web_pool.rs:268-275`).
 * @param credential - the account's stored credential.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @param options - warning sink.
 * @returns the hub-facing usage.
 */
export async function fetchFreebuffUsage(
  credential: FreebuffCredential,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  options: FreebuffUsageOptions = {},
): Promise<ProviderUsage> {
  const kind = freebuffCredentialKind(credential)
  if (kind === undefined) return { supported: false }
  const wire = kind === 'cookie' ? 'web' : 'chat-completions'
  const timeout = AbortSignal.timeout(QUOTA_TIMEOUT_MS)
  const perSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const response = await fetchFn(freebuffSessionUrl(wire), {
      method: 'GET',
      headers: freebuffSessionHeaders(credential, wire),
      signal: perSignal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        options.onWarn?.('Freebuff refused the stored credential while reading the balance (HTTP '
          + `${String(response.status)}); it needs to be pasted again.`)
      } else if (response.status === 429) {
        options.onWarn?.('Freebuff rate-limited the balance read (HTTP 429); usage is unavailable until it reopens.')
      }
      return { supported: false }
    }
    const quota = parseFreebuffQuota(await response.json() as unknown)
    if (quota === undefined) return { supported: false }
    return freebuffUsageFromQuota(quota, options)
  } catch (error) {
    // Caller cancellation is the caller's business; anything else is "no reading".
    if (signal?.aborted === true) throw error
    options.onWarn?.(`Freebuff balance read failed: ${error instanceof Error ? error.message : String(error)}`)
    return { supported: false }
  }
}

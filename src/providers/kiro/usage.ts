/**
 * Kiro's credit allowance (`Get-Usage-Limits`).
 *
 * Kiro bills a subscription in CREDITS, not tokens, and says so with
 * `currentUsageWithPrecision` / `usageLimitWithPrecision` per allowance, the
 * month's reset instant, an optional free trial and any bonus grants. It also
 * reports no token counts for a request at all (the reference records the same
 * gap: a repeated prompt is billed about half the credits, so Kiro caches, and
 * it does not say how much).
 *
 * So this route's card shows credits — `unit: 'credits'` — and nothing about
 * tokens. A route that reported a token figure here would be inventing one.
 */

import type { ProviderUsage, UsageWindow } from '../common.js'
import { kiroControlCall, KIRO_ORIGIN } from './protocol.js'

/** One credit allowance. */
export interface KiroAllowance {
  name: string
  used: number
  limit: number
  /** Epoch ms of the monthly reset, when Kiro stated one. */
  resetsAt?: number
  /** True for a trial or a bonus grant: shown, never counted as the month. */
  aside?: boolean
}

/** What `Get-Usage-Limits` said, as this route reads it. */
export interface KiroUsageSnapshot {
  plan?: string
  user?: string
  allowances: KiroAllowance[]
}

/** Coerce anything to a finite number. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Seconds-since-epoch to epoch ms, when positive. */
function at(value: number): number | undefined {
  return value > 0 ? Math.trunc(value) * 1000 : undefined
}

/**
 * Turn a `subscriptionTitle` into a display plan name ("KIRO FREE" → "Kiro Free").
 * @param title - the vendor's title.
 * @returns the display name, or undefined when absent.
 */
export function kiroPlanName(title: unknown): string | undefined {
  if (typeof title !== 'string' || title.trim() === '') return undefined
  return title.toLowerCase().split(/\s+/).filter(Boolean)
    .map(word => (word === 'kiro' ? 'Kiro' : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * Read a `Get-Usage-Limits` answer.
 *
 * @param payload - the parsed response.
 * @param now - current epoch ms (injected so a test can pin "expired").
 * @returns the snapshot, or undefined when it stated no allowance at all.
 */
export function parseKiroUsage(payload: unknown, now: number = Date.now()): KiroUsageSnapshot | undefined {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    usageBreakdownList?: unknown
    subscriptionInfo?: { subscriptionTitle?: unknown }
    userInfo?: { email?: unknown }
    nextDateReset?: unknown
  }
  const allowances: KiroAllowance[] = []
  const breakdown = Array.isArray(source.usageBreakdownList) ? source.usageBreakdownList : []
  for (const raw of breakdown) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const trial = (typeof row.freeTrialInfo === 'object' && row.freeTrialInfo !== null ? row.freeTrialInfo : undefined) as
      Record<string, unknown> | undefined
    if (trial !== undefined && String(trial.freeTrialStatus ?? '').toUpperCase() === 'ACTIVE' && num(trial.usageLimitWithPrecision) > 0) {
      allowances.push({
        name: 'Free trial',
        used: num(trial.currentUsageWithPrecision),
        limit: num(trial.usageLimitWithPrecision),
        ...(at(num(trial.freeTrialExpiry)) === undefined ? {} : { resetsAt: at(num(trial.freeTrialExpiry)) as number }),
        aside: true,
      })
    }
    const bonuses = Array.isArray(row.bonuses) ? row.bonuses : []
    const bonusWindows: KiroAllowance[] = []
    for (const rawBonus of bonuses) {
      const bonus = (typeof rawBonus === 'object' && rawBonus !== null ? rawBonus : {}) as Record<string, unknown>
      const limit = num(bonus.usageLimit)
      const expires = num(bonus.expiresAt)
      if (String(bonus.status ?? '').toUpperCase() !== 'ACTIVE' || limit <= 0) continue
      if (expires > 0 && expires * 1000 <= now) continue
      bonusWindows.push({
        name: typeof bonus.displayName === 'string' && bonus.displayName !== '' ? bonus.displayName : 'Bonus credits',
        used: num(bonus.currentUsage),
        limit,
        ...(at(expires) === undefined ? {} : { resetsAt: at(expires) as number }),
        aside: true,
      })
    }
    const used = num(row.currentUsageWithPrecision)
    const limit = num(row.usageLimitWithPrecision)
    if (limit > 0) {
      const reset = num(row.nextDateReset) || num(source.nextDateReset)
      // The month is spent before a bonus is: when it is used up but a bonus
      // still has credits, the month is shown aside so the account does not read
      // as out of credits.
      const carried = used >= limit && bonusWindows.some(window => window.used < window.limit)
      allowances.push({
        name: typeof row.displayNamePlural === 'string' && row.displayNamePlural !== ''
          ? row.displayNamePlural
          : typeof row.displayName === 'string' && row.displayName !== '' ? row.displayName : 'Credits',
        used,
        limit,
        ...(at(reset) === undefined ? {} : { resetsAt: at(reset) as number }),
        ...carried ? { aside: true } : {},
      })
    }
    allowances.push(...bonusWindows)
  }
  if (allowances.length === 0) return undefined
  const email = source.userInfo?.email
  return {
    ...(() => {
      const plan = kiroPlanName(source.subscriptionInfo?.subscriptionTitle)
      return plan === undefined ? {} : { plan }
    })(),
    ...typeof email === 'string' && email !== '' ? { user: email } : {},
    allowances,
  }
}

/**
 * Map a snapshot onto the hub's usage contract.
 *
 * @param snapshot - what Kiro stated.
 * @returns the card payload: one window per allowance, credits.
 */
export function kiroUsageToProviderUsage(snapshot: KiroUsageSnapshot): ProviderUsage {
  const windows: UsageWindow[] = snapshot.allowances.map((allowance) => ({
    kind: 'other',
    scope: allowance.name,
    usedPercent: allowance.limit > 0 ? Math.min(100, Math.max(0, (allowance.used / allowance.limit) * 100)) : 0,
    used: allowance.used,
    limit: allowance.limit,
    remaining: Math.max(0, allowance.limit - allowance.used),
    unit: 'credits',
    ...allowance.resetsAt === undefined ? {} : { resetsAt: allowance.resetsAt },
  }))
  const primary = snapshot.allowances.find(allowance => allowance.aside !== true) ?? snapshot.allowances[0]
  return {
    supported: true,
    windows,
    ...snapshot.plan === undefined ? {} : { plan: snapshot.plan },
    ...primary === undefined ? {} : {
      remaining: Math.max(0, primary.limit - primary.used),
      limit: primary.limit,
      unit: 'credits',
    },
  }
}

/**
 * Read an API key's allowance from Kiro.
 *
 * @param fetchFn - fetch to use.
 * @param region - the key's region.
 * @param key - API key.
 * @param signal - caller cancellation.
 * @returns the card payload; `{ supported: false }` when Kiro stated none.
 */
export async function fetchKiroUsage(
  fetchFn: typeof fetch,
  region: string,
  key: string,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  try {
    const call = kiroControlCall(
      region,
      key,
      'AmazonCodeWhispererService.GetUsageLimits',
      { origin: KIRO_ORIGIN },
      { origin: KIRO_ORIGIN },
    )
    const response = await fetchFn(call.url, {
      method: 'POST',
      headers: call.headers,
      body: call.body,
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) return { supported: false }
    const snapshot = parseKiroUsage(await response.json())
    return snapshot === undefined ? { supported: false } : kiroUsageToProviderUsage(snapshot)
  } catch {
    // A quota read is never worth failing a card over: say it is unknown.
    return { supported: false }
  }
}

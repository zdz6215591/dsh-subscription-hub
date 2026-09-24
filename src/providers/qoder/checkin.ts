/**
 * Qoder's daily benefit check-in.
 *
 * Qoder grants a daily credit allowance as a *campaign*: the account lists its
 * campaigns, one of them carries `actionType: 'CLAIM_BENEFIT'`, and claiming it
 * mints the day's credits. So the flow is two calls — list, then claim — against
 * the region's OpenAPI host.
 *
 * ## Two upstream rules the reference established, both load-bearing
 *
 * 1. **The campaign family gates on the DESKTOP client identifier.** Measured
 *    upstream: `/sash/api/v1/me/campaigns` answers HTTP 200 with an EMPTY
 *    `campaigns` array when the caller sends the generic client type, and the
 *    real list only for the desktop one. A check-in built on the wrong
 *    identifier therefore looks perfectly healthy at the transport layer — 200,
 *    no error — while reporting "no campaign today" forever. That is the worst
 *    possible failure shape, so the identifier is sent explicitly here.
 *
 * 2. **The day boundary is UTC+8**, not the machine's zone: the upstream resets
 *    at 10:00 Beijing, so "already claimed today" has to be judged on that clock.
 *    A machine in another zone would otherwise double-claim or skip a day.
 *
 * @module dsh-subscription-hub/providers/qoder/checkin
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { proxiedFetch } from '../../http.js'
// The SAME schedule WINDOW helper the CodeBuddy and Trae routes use, so all three
// check-ins pick a random morning time by one rule rather than three. The DAY key is
// deliberately NOT shared — see `qoderBenefitDay`, which exists because this vendor's
// day does not begin at local midnight.
import { generateMorningTargetTime } from '../codebuddy.js'

/**
 * The hour, UTC+8, at which Qoder posts a new day's benefit campaign.
 *
 * The reference records this as the vendor's reset cycle, and it is observable: a claim
 * made on 2026-09-24 at 10:48 UTC+8 succeeded, while the same account at 01:23 UTC+8 the
 * next calendar day was still being answered from the previous day's campaign.
 */
const QODER_RESET_HOUR = 10

/**
 * The BENEFIT DAY an instant belongs to — the vendor's day, NOT the calendar's.
 *
 * This is why the check-in once reported "already claimed today" and "not checked in" at
 * the same time. The ledger and the status view keyed on the LOCAL calendar date while
 * the vendor resets at {@link QODER_RESET_HOUR} UTC+8, so for the ten hours between local
 * midnight and the reset the two disagreed: the ledger correctly held the previous
 * benefit day, the card compared it against the new calendar date, and the message and the
 * status flatly contradicted each other.
 *
 * Judging by the vendor's day makes both agree, because there is then only one answer to
 * "which day is this" and it is the vendor's.
 * @param now - the instant to classify.
 * @returns `YYYY-MM-DD` for the benefit day, in UTC+8.
 */
export function qoderBenefitDay(now = new Date()): string {
  // Shift into UTC+8 wall-clock first, then step back a day if the reset has not passed.
  const wall = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000)
  if (wall.getHours() < QODER_RESET_HOUR) wall.setDate(wall.getDate() - 1)
  const month = String(wall.getMonth() + 1).padStart(2, '0')
  const day = String(wall.getDate()).padStart(2, '0')
  return `${String(wall.getFullYear())}-${month}-${day}`
}
import type { QoderRegion } from './region.js'
import { getQoderCampaignsUrl, getQoderClaimCampaignUrl, resolveQoderEndpoints } from './region.js'
import { openApiJsonRequest } from './request.js'
import { isQoderAuthRejection, qoderError } from './errors.js'
import { QoderAuthService } from './auth.js'
import { qoderDesktopClientType } from './cosy.js'

/** Where the check-in ledger lives, beside the hub's other provider state. */
export function qoderCheckinStatePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'qoder-checkin.json')
}

/** The persisted check-in ledger. */
export interface QoderCheckinState {
  /** UTC+8 day the last successful claim belongs to (`YYYY-MM-DD`). */
  lastDate?: string
  /** Epoch ms of that claim. */
  lastTime?: number
  /** What the upstream said, for the card. */
  lastMessage?: string
  /** The UTC+8 day the next attempt is scheduled for. */
  scheduledDate?: string
  /** Epoch ms at which to attempt it. */
  scheduledTime?: number
}

/** One campaign as the account lists it. */
export interface QoderCampaign {
  campaignId: string
  campaignKey?: string
  actionType?: string
  claimStatus?: string
  benefit?: { kind?: string; amount?: number }
}

/** The outcome of one check-in attempt. */
export interface QoderCheckinOutcome {
  ok: boolean
  /** `claimed` / `already` / `none` / `error`. */
  status: 'claimed' | 'already' | 'none' | 'error'
  message: string
  amount?: number
}

/** Read the ledger; any failure answers an empty one rather than throwing. */
export async function readQoderCheckinState(): Promise<QoderCheckinState> {
  try {
    const raw = JSON.parse(await readFile(qoderCheckinStatePath(), 'utf8')) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return {}
    const state: QoderCheckinState = {}
    if (typeof raw.lastDate === 'string' && raw.lastDate.length > 0) state.lastDate = raw.lastDate
    if (typeof raw.lastTime === 'number' && Number.isFinite(raw.lastTime)) state.lastTime = raw.lastTime
    if (typeof raw.lastMessage === 'string') state.lastMessage = raw.lastMessage
    if (typeof raw.scheduledDate === 'string') state.scheduledDate = raw.scheduledDate
    if (typeof raw.scheduledTime === 'number' && Number.isFinite(raw.scheduledTime)) state.scheduledTime = raw.scheduledTime
    return state
  } catch {
    return {}
  }
}

/** Persist the ledger atomically, through a random-named temp file. */
export async function writeQoderCheckinState(state: QoderCheckinState): Promise<void> {
  const path = qoderCheckinStatePath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await import('node:fs/promises').then(fs => fs.rm(tmp, { force: true })).catch(() => undefined)
    throw error
  }
}

/** List the account's campaigns for one region. */
export async function fetchQoderCampaigns(
  token: string,
  region: QoderRegion,
  fetchFn: typeof proxiedFetch = proxiedFetch,
  signal?: AbortSignal,
): Promise<QoderCampaign[]> {
  const data = await openApiJsonRequest<{ campaigns?: unknown }>(fetchFn, {
    url: getQoderCampaignsUrl(region),
    token,
    // THE identifier that makes the endpoint answer at all; see the module note.
    headers: { 'cosy-clienttype': qoderDesktopClientType },
    ...signal === undefined ? {} : { signal },
    operation: 'Campaigns',
  })
  const list = Array.isArray(data?.campaigns) ? data.campaigns : []
  return list.filter((entry): entry is QoderCampaign => typeof entry === 'object' && entry !== null)
}

/** Claim one campaign. */
async function claimCampaign(
  token: string,
  region: QoderRegion,
  campaignId: string,
  fetchFn: typeof proxiedFetch,
  signal?: AbortSignal,
): Promise<{ status?: string; replayed?: boolean; benefit?: { amount?: number } }> {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return await openApiJsonRequest(fetchFn, {
    url: getQoderClaimCampaignUrl(region, campaignId),
    method: 'POST',
    token,
    headers: { origin: openApiUrl, 'cosy-clienttype': qoderDesktopClientType },
    ...signal === undefined ? {} : { signal },
    operation: 'ClaimCampaign',
  })
}

/**
 * Claim today's benefit for one Personal Access Token.
 *
 * A rejected job token is retried ONCE with a freshly exchanged one before the
 * failure is reported: the stored token can have been rotated by another client
 * between the exchange and the claim, and a one-shot retry turns that into a
 * success rather than an error the user has to interpret.
 * @param pat - the durable Personal Access Token.
 * @param region - which deployment the account belongs to.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @param authService - reusable auth service; one is built when omitted.
 * @returns the outcome, never thrown for an upstream refusal.
 */
export async function claimQoderCheckin(
  pat: string,
  region: QoderRegion,
  fetchFn: typeof proxiedFetch = proxiedFetch,
  signal?: AbortSignal,
  authService?: QoderAuthService,
): Promise<QoderCheckinOutcome> {
  if (typeof pat !== 'string' || pat.trim() === '') {
    return { ok: false, status: 'error', message: 'no Qoder PAT is stored' }
  }
  const auth = authService ?? new QoderAuthService({ region, fetchFn })
  const run = async (token: string): Promise<QoderCheckinOutcome> => {
    const campaigns = await fetchQoderCampaigns(token, region, fetchFn, signal)
    const benefit = campaigns.find(campaign => campaign.actionType === 'CLAIM_BENEFIT')
    if (benefit === undefined) {
      // Either the account has no benefit today or the list came back empty for
      // a reason the endpoint did not disclose. Both are stated as "no campaign"
      // rather than dressed up as a success.
      return { ok: false, status: 'none', message: 'no claimable benefit campaign for this account today' }
    }
    if (benefit.claimStatus === 'CLAIMED') {
      return {
        ok: true,
        status: 'already',
        message: 'already claimed today',
        ...benefit.benefit?.amount === undefined ? {} : { amount: benefit.benefit.amount },
      }
    }
    const claimed = await claimCampaign(token, region, benefit.campaignId, fetchFn, signal)
    const amount = claimed.benefit?.amount ?? benefit.benefit?.amount
    if (claimed.status === 'CLAIMED') {
      const replayed = claimed.replayed === true
      return {
        ok: true,
        status: replayed ? 'already' : 'claimed',
        message: replayed
          ? 'already claimed today'
          : `claimed ${String(amount ?? '')} credits`.trim(),
        ...amount === undefined ? {} : { amount },
      }
    }
    return {
      ok: false,
      status: 'error',
      message: `the claim returned status ${claimed.status ?? 'unknown'}`,
    }
  }

  try {
    const credentials = await auth.getCredentials(pat, signal)
    try {
      return await run(credentials.authToken)
    } catch (error) {
      if (!isQoderAuthRejection(error)) throw error
      const fresh = await auth.exchangeFresh(pat, signal)
      return await run(fresh.authToken)
    }
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Run the daily check-in for every account, once per benefit day.
 *
 * Structurally the SAME as the CodeBuddy and Trae schedulers — the same
 * `generateMorningTargetTime` window, the same
 * `lastDate`/`scheduledDate`/`scheduledTime` ledger and the same
 * schedule-then-wait shape — because a per-provider check-in that behaves
 * differently from the other two is a bug in waiting, not a feature.
 *
 * Three behaviours the schedule alone does not give you, all deliberate:
 *
 * - The day is recorded ONLY when a claim actually succeeded. An attempt that
 *   finds no campaign yet (the benefit can become claimable later than the window
 *   opens) leaves the ledger untouched, so the next tick retries instead of
 *   silently losing that day's credits.
 * - `already` counts as done: the day's credits exist whether this process minted
 *   them or another client did.
 * - A day that is already claimed schedules TOMORROW's window, so the random time
 *   exists in advance rather than being chosen at the moment it fires.
 * @param accounts - the accounts to claim for, with their PATs and regions.
 * @param fetchFn - injectable fetcher for tests.
 * @param now - the instant to judge the day and the window against.
 * @returns the last outcome when an attempt ran, undefined otherwise.
 */
export async function autoCheckinQoder(
  accounts: readonly { pat: string; region: QoderRegion }[],
  fetchFn: typeof proxiedFetch = proxiedFetch,
  now = new Date(),
): Promise<QoderCheckinOutcome | undefined> {
  if (accounts.length === 0) return undefined
  const todayStr = qoderBenefitDay(now)
  const state = await readQoderCheckinState()

  if (state.lastDate === todayStr) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = qoderBenefitDay(tomorrow)
    if (state.scheduledDate !== tomorrowStr || state.scheduledTime === undefined) {
      state.scheduledDate = tomorrowStr
      state.scheduledTime = generateMorningTargetTime(tomorrow)
      await writeQoderCheckinState(state)
    }
    return undefined
  }
  if (state.scheduledDate !== todayStr || state.scheduledTime === undefined) {
    state.scheduledDate = todayStr
    state.scheduledTime = generateMorningTargetTime(now)
    await writeQoderCheckinState(state)
  }
  // The randomly chosen moment has not arrived yet.
  if (now.getTime() < state.scheduledTime) return undefined

  let last: QoderCheckinOutcome | undefined
  let ok = false
  for (const account of accounts) {
    const outcome = await claimQoderCheckin(account.pat, account.region, fetchFn)
    last = outcome
    // `already` counts as done: the day's credits exist either way.
    if (outcome.ok) ok = true
  }
  if (ok) {
    await writeQoderCheckinState({
      ...state,
      lastDate: todayStr,
      lastTime: now.getTime(),
      ...last?.message === undefined ? {} : { lastMessage: last.message },
    })
  }
  return last
}

/**
 * The card's view of the ledger.
 *
 * Deliberately the SAME shape the CodeBuddy and Trae routes already answer with
 * (`checkedInToday` / `lastDate` / `lastMessage` / `scheduled*`), so the card's
 * existing check-in section renders Qoder without a second code path and no wire
 * change is needed.
 */
export interface QoderCheckinStatusView {
  lastDate?: string
  lastTime?: number
  lastMessage?: string
  scheduledDate?: string
  scheduledTime?: number
  checkedInToday: boolean
}

/**
 * Record a check-in the USER triggered, on the shared ledger.
 *
 * Mirrors `recordTraeCheckin` exactly, including scheduling tomorrow's window in
 * the same write: a manual claim has to leave the ledger in the state an
 * automatic one would, or the two disagree about what is done and the next tick
 * re-claims (harmless upstream, but a lie in the card).
 * @param message - what to show as the last outcome.
 * @param now - the instant the claim landed.
 */
export async function recordQoderCheckin(message: string, now = new Date()): Promise<void> {
  const todayStr = qoderBenefitDay(now)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const previous = await readQoderCheckinState()
  await writeQoderCheckinState({
    ...previous,
    lastDate: todayStr,
    lastTime: now.getTime(),
    lastMessage: message,
    scheduledDate: qoderBenefitDay(tomorrow),
    scheduledTime: generateMorningTargetTime(tomorrow),
  })
}

/**
 * The check-in status the Settings card renders.
 *
 * Mirrors the CodeBuddy and Trae views exactly, including the side effect of
 * scheduling the day's window on read: the card asks for the status before the
 * scheduler has necessarily run, and a view that reported no
 * `scheduledTime` there would show "no schedule" for a day that has one.
 * @param now - the instant to judge the day and the window against.
 * @returns the ledger's public face, in the shared view shape.
 */
export async function getQoderCheckinStatusView(now = new Date()): Promise<QoderCheckinStatusView> {
  const todayStr = qoderBenefitDay(now)
  const state = await readQoderCheckinState()
  if (state.lastDate === todayStr) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = qoderBenefitDay(tomorrow)
    if (state.scheduledDate !== tomorrowStr || state.scheduledTime === undefined) {
      state.scheduledDate = tomorrowStr
      state.scheduledTime = generateMorningTargetTime(tomorrow)
      await writeQoderCheckinState(state)
    }
  } else if (state.scheduledDate !== todayStr || state.scheduledTime === undefined) {
    state.scheduledDate = todayStr
    state.scheduledTime = generateMorningTargetTime(now)
    await writeQoderCheckinState(state)
  }
  return {
    ...state.lastDate === undefined ? {} : { lastDate: state.lastDate },
    ...state.lastTime === undefined ? {} : { lastTime: state.lastTime },
    ...state.lastMessage === undefined ? {} : { lastMessage: state.lastMessage },
    ...state.scheduledDate === undefined ? {} : { scheduledDate: state.scheduledDate },
    ...state.scheduledTime === undefined ? {} : { scheduledTime: state.scheduledTime },
    checkedInToday: state.lastDate === todayStr,
  }
}

/** Re-exported so a caller can classify a refusal without importing errors. */
export { qoderError }
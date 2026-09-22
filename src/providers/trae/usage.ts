/**
 * Trae CN usage and daily check-in.
 *
 * Two distinct concerns live here:
 *
 *   - **Usage** (read-only): `web_user_ent_usage` reports the account's total,
 *     consumed and remaining credits plus a per-source breakdown (老用户福利 /
 *     每月登录赠送 / 签到奖励 …). All of it is derived from read-only POSTs that
 *     consume no credits.
 *   - **Check-in**: `checkin_credits/status` reports today's state and
 *     `checkin_credits/claim` performs the daily claim. The claim is what the
 *     CodeBuddy-style button drives.
 *
 * Ported from dingminhua/dsh-connect-trae (MIT) `usage.ts` (read endpoints) and
 * extended with the claim action, which the reference project did not implement.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { proxiedFetch } from '../../http.js'
import type { ProviderUsage, UsageWindow } from '../common.js'
import { TRAE_PAY_BASE, traeHeaders } from './protocol.js'
import { traeIdentityFor } from './identity.js'
import { gatewaysFor } from './region.js'
import type { TraeEdition } from './identity.js'

/** Usage endpoints (all POST, all read-only). */
const TRAE_USAGE_PATH = '/trae/api/v2/pay/web_user_ent_usage'
const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'

/** `available_endpoint` marker for the Work credit pool (0 = general). */
const TRAE_ENDPOINT_WORK = 1

const USAGE_TIMEOUT_MS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Real timer, injectable so tests never wait on the retry backoff. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** One credit source (a pack) from the entitlement list. */
export interface TraeCreditPack {
  /** Human label from the API, e.g. 老用户福利 / 每月登录赠送 / 签到奖励. */
  label: string
  /** Credits granted by this pack. */
  limit: number
  /** Credits already consumed from it. */
  consumed: number
  /** Credits still available. */
  remaining: number
  /** True for the Work pool (`available_endpoint === 1`). */
  work: boolean
  expiresAt?: number
}

/** The parsed usage snapshot. */
export interface TraeUsageSnapshot {
  total: number
  consumed: number
  available: number
  /** Remaining across Work-pool packs. */
  workAvailable: number
  /** Remaining across general packs. */
  generalAvailable: number
  packs: TraeCreditPack[]
}

/** Check-in state as reported by the status endpoint. */
export interface TraeCheckinStatus {
  checkedIn: boolean
  /** Credits this check-in is worth. */
  credits: number
  enabled: boolean
}

function parsePack(raw: unknown): TraeCreditPack | undefined {
  if (!isRecord(raw)) return undefined
  const base = isRecord(raw.entitlement_base_info) ? raw.entitlement_base_info : {}
  const extra = isRecord(base.product_extra) ? base.product_extra : {}
  const packageExtra = isRecord(extra.package_extra) ? extra.package_extra : {}
  const quota = isRecord(packageExtra.quota) ? packageExtra.quota : {}
  const usage = isRecord(raw.usage) ? raw.usage : {}
  const limit = numberValue(quota.credits_limit) ?? 0
  // `usage.credits_amount` is the CONSUMED amount for this pack.
  const consumed = numberValue(usage.credits_amount) ?? 0
  const label = typeof raw.display_desc === 'string' ? raw.display_desc : ''
  const endpoint = numberValue(base.available_endpoint)
  return {
    label,
    limit,
    consumed,
    remaining: Math.max(0, limit - consumed),
    work: endpoint === TRAE_ENDPOINT_WORK,
    ...numberValue(base.end_time) === undefined ? {} : { expiresAt: numberValue(base.end_time)! },
  }
}

/** Parse a `web_user_ent_usage` body into a snapshot. */
export function parseTraeUsage(payload: unknown): TraeUsageSnapshot | undefined {
  if (!isRecord(payload)) return undefined
  const summary = isRecord(payload.usage_summary) ? payload.usage_summary : {}
  const total = numberValue(summary.total_amount) ?? 0
  const consumed = numberValue(summary.consumed_amount) ?? 0
  const rawPacks = Array.isArray(payload.user_entitlement_pack_list)
    ? payload.user_entitlement_pack_list
    : []
  const packs: TraeCreditPack[] = []
  for (const raw of rawPacks) {
    const pack = parsePack(raw)
    if (pack !== undefined) packs.push(pack)
  }
  if (total === 0 && packs.length === 0) return undefined
  let workAvailable = 0
  let generalAvailable = 0
  for (const pack of packs) {
    if (pack.work) workAvailable += pack.remaining
    else generalAvailable += pack.remaining
  }
  return { total, consumed, available: Math.max(0, total - consumed), workAvailable, generalAvailable, packs }
}

/**
 * Convert a snapshot into the shared `ProviderUsage` shape: a credit pool
 * (remaining/limit) plus one window per credit source, so the Settings card
 * and the composer pill render Trae like every other subscription.
 */
export function traeUsageToProviderUsage(snapshot: TraeUsageSnapshot): ProviderUsage {
  const windows: UsageWindow[] = [
    {
      kind: 'other',
      scope: 'credits',
      usedPercent: snapshot.total > 0 ? Math.min(100, Math.max(0, (snapshot.consumed / snapshot.total) * 100)) : 0,
      remaining: snapshot.available,
      limit: snapshot.total,
    },
  ]
  for (const pack of snapshot.packs) {
    if (pack.limit <= 0) continue
    windows.push({
      kind: 'other',
      scope: pack.label === '' ? (pack.work ? 'Work' : 'General') : pack.label,
      usedPercent: Math.min(100, Math.max(0, (pack.consumed / pack.limit) * 100)),
      remaining: pack.remaining,
      limit: pack.limit,
      ...pack.expiresAt === undefined
      ? {}
      : { resetsAt: pack.expiresAt < 10_000_000_000 ? pack.expiresAt * 1000 : pack.expiresAt },
    })
  }
  return {
    supported: true,
    windows,
    remaining: snapshot.available,
    limit: snapshot.total,
    plan: 'Trae 积分',
  }
}

async function postJson(
  accessToken: string,
  userId: string,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetchFn: typeof proxiedFetch,
  /**
   * Which install's device identity to send. The pay endpoints are CN-only
   * today, so this defaults there; it exists so the international editions can
   * pass their own without another signature change.
   */
  edition: TraeEdition = 'cn',
): Promise<unknown> {
  const response = await fetchFn(`${gatewaysFor({ edition }).pay}${path}`, {
    method: 'POST',
    headers: {
      ...traeHeaders(accessToken, userId, await traeIdentityFor(edition, userId)),
      Accept: 'application/json',
      // The pay endpoints are the web dashboard's own; they expect its Origin.
      Origin: 'https://www.trae.cn',
      Referer: 'https://www.trae.cn/',
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(USAGE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Trae endpoint ${path} returned HTTP ${response.status}`)
  return await response.json() as unknown
}

/** Read the account's credit snapshot (read-only; consumes no credits). */
export async function fetchTraeUsage(
  accessToken: string,
  userId: string,
  signal?: AbortSignal,
  fetchFn: typeof proxiedFetch = proxiedFetch,
  /** Which edition's pay base to use; the read is region-scoped. */
  edition: TraeEdition = 'cn',
): Promise<ProviderUsage> {
  try {
    const payload = await postJson(accessToken, userId, TRAE_USAGE_PATH, { require_usage: true }, signal, fetchFn, edition)
    const snapshot = parseTraeUsage(payload)
    if (snapshot === undefined) return { supported: false }
    return traeUsageToProviderUsage(snapshot)
  } catch {
    return { supported: false }
  }
}

/** Read today's check-in state. */
export async function fetchTraeCheckinStatus(
  accessToken: string,
  userId: string,
  signal?: AbortSignal,
  fetchFn: typeof proxiedFetch = proxiedFetch,
): Promise<TraeCheckinStatus> {
  const payload = await postJson(accessToken, userId, TRAE_CHECKIN_STATUS_PATH, {}, signal, fetchFn)
  const record = isRecord(payload) ? payload : {}
  return {
    checkedIn: record.checked_in === true,
    credits: numberValue(record.credits) ?? 0,
    enabled: record.enable !== false,
  }
}

/** Treat an "already claimed" answer as success rather than a failure. */
function alreadyClaimed(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const message = `${typeof payload.message === 'string' ? payload.message : ''} ${typeof payload.msg === 'string' ? payload.msg : ''}`
  return payload.checked_in === true || /already|已签|重复/.test(message)
}

/**
 * Whether the upstream refused the claim *transiently*.
 *
 * Trae answers `当前签到人数过多` (and the equivalent `too many` / `busy` /
 * `频繁` wordings) when its claim queue is saturated. The web client simply lets
 * the user press again, and the claim is idempotent server-side, so this hub
 * retries with backoff instead of reporting a dead end.
 */
function transientClaimRefusal(message: string, code: number | undefined): boolean {
  if (/人数过多|过多|稍后|稍候|稍后再试|频繁|忙|too\s*many|busy|try\s*again|rate\s*limit/i.test(message)) return true
  // A 429-shaped business code is a rate limit even when the text is opaque.
  return code === 429 || code === 10001 || code === 10002
}

/** The claim outcome for one attempt. */
interface TraeClaimAttempt {
  /** Parsed payload, when the endpoint answered JSON. */
  payload: unknown
  /** Business code from the payload, when present. */
  code: number | undefined
  /** Business message from the payload, when present. */
  message: string
  /** Whether reading today's status before the claim said it was already done. */
  alreadyDone: boolean
  /** Credits the pre-claim status reported, when it was already done. */
  doneCredits: number
}

/** One claim attempt: read the status, then post the claim. */
async function attemptClaim(
  accessToken: string,
  userId: string,
  signal: AbortSignal | undefined,
  fetchFn: typeof proxiedFetch,
): Promise<TraeClaimAttempt> {
  // Probe first so an already-completed day does not error upstream.
  const status = await fetchTraeCheckinStatus(accessToken, userId, signal, fetchFn).catch(() => undefined)
  if (status?.checkedIn === true) {
    return { payload: undefined, code: 0, message: '今日已签到', alreadyDone: true, doneCredits: status.credits }
  }
  const payload = await postJson(accessToken, userId, TRAE_CHECKIN_CLAIM_PATH, {}, signal, fetchFn)
  const record = isRecord(payload) ? payload : {}
  const message = typeof record.message === 'string' && record.message !== ''
    ? record.message
    : typeof record.msg === 'string' && record.msg !== ''
      ? record.msg
      : ''
  return {
    payload,
    code: numberValue(record.code),
    message,
    alreadyDone: false,
    doneCredits: 0,
  }
}

/** Attempts and backoff for a saturated claim queue. */
const TRAE_CLAIM_MAX_ATTEMPTS = 4
const TRAE_CLAIM_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000]

/**
 * Claim today's check-in credits.
 *
 * Two upstream behaviours are absorbed rather than surfaced as failures:
 * a day that is already claimed counts as success (matching the CodeBuddy
 * surface), and the transient `当前签到人数过多` refusal is retried with
 * backoff — re-reading the status between attempts, so a claim that actually
 * landed on a saturated response is still reported as the success it is.
 */
export async function claimTraeCheckin(
  accessToken: string,
  userId: string,
  signal?: AbortSignal,
  fetchFn: typeof proxiedFetch = proxiedFetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ ok: boolean; message: string; credits?: number; attempts: number }> {
  let attempts = 0
  try {
    for (;;) {
      attempts += 1
      const attempt = await attemptClaim(accessToken, userId, signal, fetchFn)

      if (attempt.alreadyDone) {
        return {
          ok: true,
          message: '今日已签到',
          ...attempt.doneCredits > 0 ? { credits: attempt.doneCredits } : {},
          attempts,
        }
      }
      if (alreadyClaimed(attempt.payload)) {
        const record = isRecord(attempt.payload) ? attempt.payload : {}
        const credits = numberValue(record.credits)
        return { ok: true, message: '今日已签到', ...credits === undefined ? {} : { credits }, attempts }
      }

      const failed = attempt.code !== undefined && attempt.code !== 0
      const transient = transientClaimRefusal(attempt.message, attempt.code)
      if (!failed || !transient) {
        if (failed) {
          return {
            ok: false,
            message: attempt.message === '' ? `签到失败（code ${String(attempt.code)}）` : attempt.message,
            attempts,
          }
        }
        const record = isRecord(attempt.payload) ? attempt.payload : {}
        const credits = numberValue(record.credits) ?? numberValue(isRecord(record.data) ? record.data.credits : undefined)
        return {
          ok: true,
          message: credits === undefined ? '签到成功' : `签到成功，获得 ${String(credits)} 积分`,
          ...credits === undefined ? {} : { credits },
          attempts,
        }
      }

      if (attempts >= TRAE_CLAIM_MAX_ATTEMPTS) {
        return {
          ok: false,
          message: `${attempt.message === '' ? '签到失败' : attempt.message}（已重试 ${String(attempts)} 次，签到本身是幂等的，稍后可再试或直接在 Trae 客户端签到）`,
          attempts,
        }
      }
      // Wait before retrying, but never outlive the caller's own cancellation.
      const delay = TRAE_CLAIM_RETRY_DELAYS_MS[attempts - 1] ?? TRAE_CLAIM_RETRY_DELAYS_MS[TRAE_CLAIM_RETRY_DELAYS_MS.length - 1] ?? 5_000
      await sleep(delay)
      if (signal?.aborted === true) {
        return { ok: false, message: '签到已取消', attempts }
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), attempts }
  }
}

// ---------------------------------------------------------------------------
// Check-in scheduling state — the same shape and cadence CodeBuddy uses, so the
// auto check-in runs at a random time before 08:00 and catches up on next start.
// ---------------------------------------------------------------------------

export interface TraeCheckinState {
  lastDate?: string
  lastTime?: number
  lastMessage?: string
  scheduledDate?: string
  scheduledTime?: number
}

export interface TraeCheckinStatusView {
  lastDate?: string
  lastTime?: number
  lastMessage?: string
  scheduledDate?: string
  scheduledTime?: number
  checkedInToday: boolean
}

export function localDateString(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Random target between 06:00:00 and 07:55:00 on the given date. */
export function generateMorningTargetTime(date: Date): number {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6, 0, 0, 0)
  return target.getTime() + Math.floor(Math.random() * 115 * 60 * 1000)
}

export function traeCheckinStatePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'trae-checkin.json')
}

export async function readTraeCheckinState(): Promise<TraeCheckinState> {
  try {
    const raw = JSON.parse(await readFile(traeCheckinStatePath(), 'utf8')) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return {}
    const state: TraeCheckinState = {}
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

export async function writeTraeCheckinState(state: TraeCheckinState): Promise<void> {
  const path = traeCheckinStatePath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' })
  try { await chmod(tmp, 0o600) } catch { /* windows */ }
  await rename(tmp, path)
}

/** Record a successful manual claim and plan tomorrow's automatic run. */
export async function recordTraeCheckin(message: string, now = new Date()): Promise<void> {
  const todayStr = localDateString(now)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const previous = await readTraeCheckinState()
  await writeTraeCheckinState({
    ...previous,
    lastDate: todayStr,
    lastTime: now.getTime(),
    lastMessage: message,
    scheduledDate: localDateString(tomorrow),
    scheduledTime: generateMorningTargetTime(tomorrow),
  })
}

/** Today's check-in view, refreshing the planned morning target as days roll. */
export async function getTraeCheckinStatusView(now = new Date()): Promise<TraeCheckinStatusView> {
  const todayStr = localDateString(now)
  const state = await readTraeCheckinState()
  if (state.lastDate === todayStr) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = localDateString(tomorrow)
    if (state.scheduledDate !== tomorrowStr || state.scheduledTime === undefined) {
      state.scheduledDate = tomorrowStr
      state.scheduledTime = generateMorningTargetTime(tomorrow)
      await writeTraeCheckinState(state)
    }
  } else if (state.scheduledDate !== todayStr || state.scheduledTime === undefined) {
    state.scheduledDate = todayStr
    state.scheduledTime = generateMorningTargetTime(now)
    await writeTraeCheckinState(state)
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

/**
 * Run the daily check-in once per day per account, at a random time before
 * 08:00. A run missed because DSH was not running catches up on next start.
 */
export async function autoCheckinTrae(
  accounts: readonly { accessToken: string; userId: string }[],
  fetchFn: typeof proxiedFetch = proxiedFetch,
  now = new Date(),
): Promise<void> {
  if (accounts.length === 0) return
  const todayStr = localDateString(now)
  let state = await readTraeCheckinState()

  if (state.lastDate === todayStr) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = localDateString(tomorrow)
    if (state.scheduledDate !== tomorrowStr || state.scheduledTime === undefined) {
      state.scheduledDate = tomorrowStr
      state.scheduledTime = generateMorningTargetTime(tomorrow)
      await writeTraeCheckinState(state)
    }
    return
  }
  if (state.scheduledDate !== todayStr || state.scheduledTime === undefined) {
    state.scheduledDate = todayStr
    state.scheduledTime = generateMorningTargetTime(now)
    await writeTraeCheckinState(state)
  }
  if (now.getTime() < state.scheduledTime) return

  let anyOk = false
  let lastMessage = ''
  for (const account of accounts) {
    const result = await claimTraeCheckin(account.accessToken, account.userId, undefined, fetchFn)
    if (result.ok) {
      anyOk = true
      lastMessage = result.message
    }
  }
  if (anyOk) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    await writeTraeCheckinState({
      lastDate: todayStr,
      lastTime: now.getTime(),
      lastMessage,
      scheduledDate: localDateString(tomorrow),
      scheduledTime: generateMorningTargetTime(tomorrow),
    })
  }
}

/**
 * Cline (ClinePass) usage: the account's rate-limit windows.
 *
 * The gateway publishes quota as percentage windows rather than a credit pool:
 * `GET /users/me/plan/usage-limits` returns an array of
 * `{ type: '5-hour' | 'weekly' | 'monthly', percentUsed, resetsAt }`.
 *
 * Ported from GooDAnDReaDY/dsh-clinebot (MIT) `lib/cline-client.js`.
 */

import { proxiedFetch } from '../../http.js'
import type { ProviderUsage, UsageWindow } from '../common.js'
import type { FetchFn } from '../common.js'

/** Usage-limits endpoint, relative to the gateway base. */
export const CLINE_USAGE_PATH = '/users/me/plan/usage-limits'

/** Plan endpoint (subscription identity), relative to the gateway base. */
export const CLINE_PLAN_PATH = '/users/me/plan'

const TIMEOUT_MS = 20_000

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

/** Map the wire window type onto the harness's window kinds. */
function windowKind(type: string): UsageWindow['kind'] {
  if (type === '5-hour') return 'session'
  if (type === 'weekly') return 'weekly'
  return 'other'
}

/** Human scope label for one window type. */
function windowScope(type: string): string {
  if (type === '5-hour') return '5小时'
  if (type === 'weekly') return '每周'
  if (type === 'monthly') return '每月'
  return type
}

/**
 * Parse the usage-limits payload. The envelope varies (`{data:{limits}}` or
 * `{limits}`), so both are read.
 */
export function parseClineUsage(payload: unknown, plan?: string): ProviderUsage {
  if (!isRecord(payload)) return { supported: false }
  const data = isRecord(payload.data) ? payload.data : undefined
  const raw = Array.isArray(payload.limits) ? payload.limits : Array.isArray(data?.limits) ? data.limits : []
  const windows: UsageWindow[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const type = typeof entry.type === 'string' ? entry.type : ''
    if (type === '') continue
    const used = numberValue(entry.percentUsed)
    if (used === undefined) continue
    const reset = numberValue(entry.resetsAt)
    windows.push({
      kind: windowKind(type),
      scope: windowScope(type),
      usedPercent: Math.min(100, Math.max(0, used)),
      ...reset === undefined ? {} : { resetsAt: reset },
    })
  }
  if (windows.length === 0) return { supported: false }
  // The 5-hour window is the binding constraint, so it drives the compact pill.
  const session = windows.find(window => window.kind === 'session') ?? windows[0]!
  return {
    supported: true,
    windows,
    // Quota is reported as consumption, so "remaining" is the complement.
    remaining: Math.max(0, Math.round((100 - session.usedPercent) * 10) / 10),
    limit: 100,
    ...plan === undefined || plan === '' ? {} : { plan },
  }
}

/** Read the account's plan label, when the endpoint answers one. */
export function parseClinePlan(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const data = isRecord(payload.data) ? payload.data : undefined
  const plan = isRecord(data?.plan) ? data.plan : isRecord(payload.plan) ? payload.plan : data ?? payload
  const name = plan.displayName ?? plan.title ?? plan.name
  if (typeof name !== 'string' || name === '') return undefined
  const cents = numberValue(plan.pricePerSeatCents) ?? numberValue(plan.priceInCents)
  return cents === undefined ? name : `${name} ($${(cents / 100).toFixed(2)}/mo)`
}

async function getJson(
  baseUrl: string,
  path: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn,
): Promise<unknown> {
  const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`cline ${path} returned HTTP ${response.status}`)
  return await response.json() as unknown
}

/**
 * Read the account's quota windows. The plan lookup is best-effort: a missing
 * plan must not hide the windows.
 */
export async function fetchClineUsage(
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
  fetchFn: FetchFn = proxiedFetch,
): Promise<ProviderUsage> {
  const [limits, plan] = await Promise.all([
    getJson(baseUrl, CLINE_USAGE_PATH, apiKey, signal, fetchFn).catch(() => undefined),
    getJson(baseUrl, CLINE_PLAN_PATH, apiKey, signal, fetchFn).catch(() => undefined),
  ])
  if (limits === undefined) return { supported: false }
  return parseClineUsage(limits, parseClinePlan(plan))
}

/**
 * CodeBuddy quota meter: personal `get-user-resource` and enterprise
 * `get-enterprise-user-usage`. Ported from shatyuka/dsh-llm-codebuddy.
 */

import { CODEBUDDY_ENDPOINT, CODEBUDDY_IDE_VERSION } from './constants.js'
import { proxiedFetch } from '../../http.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
import type { FetchFn, ProviderUsage, UsageWindow } from '../common.js'

function meterHeaders(identity: CodeBuddyIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `CodeBuddyIDE/${CODEBUDDY_IDE_VERSION} CodeBuddy/${CODEBUDDY_IDE_VERSION}`,
    Authorization: `Bearer ${identity.accessToken}`,
    'X-Domain': identity.domain,
    'X-User-Id': identity.uid,
  }
  if (identity.enterpriseId !== undefined) {
    headers['X-Enterprise-Id'] = identity.enterpriseId
    headers['X-Tenant-Id'] = identity.enterpriseId
  }
  return headers
}

function number(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function string(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function pointer(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function todayRange(): { begin: string; end: string } {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(midnight)
  endOfDay.setHours(23, 59, 59, 0)
  return { begin: formatLocal(midnight), end: formatLocal(endOfDay) }
}

function packageLabel(resource: unknown, index: number): string {
  const named = string(resource, 'PackageName')
    ?? string(resource, 'ResourceName')
    ?? string(resource, 'ProductName')
    ?? string(resource, 'Alias')
  if (named !== undefined) return named
  const code = string(resource, 'PackageCode') ?? string(resource, 'ResourceId')
  if (code !== undefined && !/^TCACA_/i.test(code)) return code
  return `credits-${index + 1}`
}

function personalWindows(accounts: unknown[]): { windows: UsageWindow[]; remaining: number; limit: number } {
  let remaining = 0
  let limit = 0
  const windows = accounts.map((resource, index): UsageWindow => {
    const cap = number(resource, 'CycleCapacitySizePrecise') ?? 0
    const left = number(resource, 'CycleCapacityRemainPrecise') ?? 0
    const used = Math.max(cap - left, 0)
    remaining += Math.max(left, 0)
    limit += Math.max(cap, 0)
    const reset = string(resource, 'CycleEndTime')
    const resetsAt = reset === undefined ? undefined : Date.parse(reset.replace(' ', 'T'))
    return {
      kind: 'weekly',
      scope: packageLabel(resource, index),
      usedPercent: cap > 0 ? Math.min(100, Math.max(0, (used / cap) * 100)) : 0,
      remaining: left,
      limit: cap,
      ...resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {},
    }
  })
  return { windows, remaining, limit }
}

export function parseMeterUsage(raw: unknown): ProviderUsage | undefined {
  const accountsRoots: readonly (readonly string[])[] = [
    ['data', 'Response', 'Data', 'Accounts'],
    ['data', 'data', 'Response', 'Data', 'Accounts'],
    ['Response', 'Data', 'Accounts'],
  ]
  for (const path of accountsRoots) {
    const candidate = pointer(raw, path)
    if (Array.isArray(candidate)) {
      const parsed = personalWindows(candidate)
      return {
        supported: true,
        windows: parsed.windows,
        remaining: parsed.remaining,
        limit: parsed.limit,
      }
    }
  }
  const data = pointer(raw, ['data', 'data']) ?? pointer(raw, ['data']) ?? raw
  const limit = number(data, 'limitNum')
  if (limit === undefined) return undefined
  const used = number(data, 'credit') ?? 0
  const left = Math.max(limit - used, 0)
  const reset = string(data, 'cycleResetTime')
  const resetsAt = reset === undefined ? undefined : Date.parse(reset)
  return {
    supported: true,
    remaining: left,
    limit,
    windows: [{
      kind: 'weekly',
      scope: 'enterprise',
      usedPercent: limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0,
      remaining: left,
      limit,
      ...resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {},
    }],
  }
}

async function postMeter(
  identity: CodeBuddyIdentity,
  path: string,
  body: string,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<ProviderUsage | undefined> {
  let response: Response
  try {
    response = await fetchFn(`${CODEBUDDY_ENDPOINT}${path}`, {
      method: 'POST',
      headers: meterHeaders(identity),
      body,
      ...signal === undefined ? {} : { signal },
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    return undefined
  }
  const envelope = raw as { code?: number }
  if (typeof envelope === 'object' && envelope !== null && envelope.code !== undefined && envelope.code !== 0) {
    return undefined
  }
  return parseMeterUsage(raw)
}

export async function fetchCodeBuddyMeter(
  identity: CodeBuddyIdentity,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  if (identity.enterpriseId !== undefined) {
    return await postMeter(identity, '/v2/billing/meter/get-enterprise-user-usage', '{}', fetchFn, signal)
      ?? { supported: false }
  }
  const { begin, end } = todayRange()
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    SlicePeriodStartTime: begin,
    SlicePeriodEndTime: end,
  })
  return await postMeter(identity, '/v2/billing/meter/get-user-resource', body, fetchFn, signal)
    ?? { supported: false }
}

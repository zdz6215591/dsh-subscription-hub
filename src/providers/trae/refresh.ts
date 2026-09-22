/**
 * Trae credential refresh: exchange a refresh token for a fresh access token.
 *
 * The import path reads the desktop app's own `storage.json`, and the plugin
 * used to justify never refreshing by claiming "the desktop app owns the token's
 * lifetime and re-reading `storage.json` picks up whatever it last persisted".
 * That is false: only a manual import re-reads the file. Once the imported token
 * aged out, chat, credits and check-in all failed with upstream auth errors,
 * never self-healed, and the Settings card still said "signed in".
 *
 * The grant is the one the official client runs. It is the ONE Trae contract
 * that forks by edition rather than by region: the CN desktop app, the SOLO CN
 * app and the international desktop app all post to the `/cloudide/...` path
 * with the shared client id, while TRAE SOLO international was verified on the
 * newer `/trae/api/v3/oauth/` path with its own client id and a DeviceInfo body.
 * Every request hangs off the credential's OWN host, never a hardcoded base.
 *
 * Ported from dingminhua/dsh-connect-trae (MIT) `src/refresh.ts`.
 *
 * @module dsh-subscription-hub/providers/trae/refresh
 */

import { hostname } from 'node:os'
import type { TraeSession } from '../../auth/store.js'
import { proxiedFetch } from '../../http.js'
import type { TraeEdition } from './identity.js'

/** The verified refresh contract for one edition. */
interface TraeRefreshContract {
  /** Path appended to the credential's own host. */
  path: string
  /** The client id the official app sends. */
  clientId: string
  /** Whether the official client sends a `DeviceInfo` object in the body. */
  deviceInfo: boolean
}

/**
 * Per-edition refresh contract.
 *
 * `sg` shares the CN contract because the international DESKTOP app does; only
 * `solo-sg` diverges. Keeping the table keyed by edition (rather than assuming
 * one shape) is what lets the international editions be added without touching
 * this flow again.
 */
export const TRAE_REFRESH_CONTRACT: Readonly<Record<TraeEdition, TraeRefreshContract>> = Object.freeze({
  cn: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  solo: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
})

/** How long a token endpoint may take before the refresh is abandoned. */
const TRAE_REFRESH_TIMEOUT_MS = 30_000

/**
 * A refresh failure that means the credential is permanently dead.
 *
 * Raised for a definitive `4xx` answer from the token endpoint, so the shared
 * token manager can remove the account and the card can ask for a new import.
 * A network failure is NOT this: it stays transient and is retried.
 */
export class TraeRefreshRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'TraeRefreshRejected'
  }
}

/** The token endpoint's answer, normalized. */
export interface TraeRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresAtMs: number
}

/** Normalize the credential's host, rejecting an unusable one. */
function refreshHost(host: string | undefined): string {
  const value = (host ?? '').trim()
  if (value === '') throw new Error('Trae refresh host is missing')
  return value.replace(/\/+$/, '')
}

/**
 * Parse the token endpoint's payload.
 *
 * Both spellings the editions use are accepted: the CN/SOLO shape returns the
 * token under `Result`, while some responses wrap it one level shallower.
 * @param payload - the decoded response body.
 * @returns the normalized outcome, or undefined when the token is absent.
 */
export function parseTraeRefreshPayload(payload: unknown): TraeRefreshOutcome | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const outer = payload as Record<string, unknown>
  const result = typeof outer.Result === 'object' && outer.Result !== null
    ? outer.Result as Record<string, unknown>
    : outer
  const accessToken = typeof result.Token === 'string'
    ? result.Token
    : typeof result.token === 'string' ? result.token : ''
  if (accessToken === '') return undefined
  const rawExpiry = result.TokenExpireAt ?? result.tokenExpireAt ?? result.expiresAt
  const expiresAtMs = typeof rawExpiry === 'number'
    ? rawExpiry
    : typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN
  const refreshToken = typeof result.RefreshToken === 'string' && result.RefreshToken !== ''
    ? result.RefreshToken
    : typeof result.refresh_token === 'string' && result.refresh_token !== '' ? result.refresh_token : undefined
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    // A response with no readable expiry takes a conservative default rather
    // than "never": a token treated as eternal is the bug this flow fixes.
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 30 * 60_000,
  }
}

/**
 * Exchange a refresh token for a fresh access token.
 * @param session - the stored session, whose `host` and `edition` select the contract.
 * @param signal - optional cancellation.
 * @param fetchFn - injectable fetcher for tests.
 * @returns the refreshed session, preserving every other field.
 * @throws {TraeRefreshRejected} when the token endpoint refuses the grant.
 */
export async function refreshTraeSession(
  session: TraeSession,
  signal?: AbortSignal,
  fetchFn: typeof proxiedFetch = proxiedFetch,
): Promise<TraeSession> {
  const edition: TraeEdition = session.edition === 'solo' ? 'solo' : 'cn'
  const contract = TRAE_REFRESH_CONTRACT[edition]
  if (contract === undefined) throw new Error(`Trae ${edition} refresh contract is not verified`)
  const refreshToken = session.refreshToken
  if (refreshToken === undefined || refreshToken === '') {
    // Nothing to exchange: the credential is dead as far as this flow is
    // concerned, and saying so lets the account be surfaced instead of silently
    // failing every request.
    throw new TraeRefreshRejected('Trae refresh token is missing', 401)
  }
  const body: Record<string, unknown> = {
    ClientID: contract.clientId,
    ClientSecret: '-',
    RefreshToken: refreshToken,
    UserID: session.userId ?? '',
  }
  const response = await fetchFn(`${refreshHost(session.host)}${contract.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(TRAE_REFRESH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const message = `Trae token refresh failed (http ${String(response.status)})${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`
    // 4xx is the endpoint's own verdict on the grant; 5xx and 429 are the
    // service's, and must stay transient.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new TraeRefreshRejected(message, response.status)
    }
    throw new Error(message)
  }
  const payload: unknown = await response.json().catch(() => undefined)
  const outcome = parseTraeRefreshPayload(payload)
  if (outcome === undefined) {
    throw new Error('Trae token refresh returned no token')
  }
  return {
    ...session,
    accessToken: outcome.accessToken,
    refreshToken: outcome.refreshToken ?? session.refreshToken,
    expiresAt: outcome.expiresAtMs,
  }
}

/**
 * Whether a refresh failure means the stored credential is permanently dead.
 * @param error - the failure raised by {@link refreshTraeSession}.
 * @returns whether the account should be removed and a re-import requested.
 */
export function isTraePermanentRefreshError(error: unknown): boolean {
  return error instanceof TraeRefreshRejected
}

/** The DeviceInfo the SOLO international body carries, when one is needed. */
export function traeDeviceInfo(deviceId: string, machineId: string): Record<string, unknown> {
  return {
    DeviceID: deviceId,
    MachineID: machineId,
    PlatformCode: 'TRAE',
    DeviceType: 'PC',
    DeviceName: hostname(),
  }
}
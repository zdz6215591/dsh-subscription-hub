/**
 * Kiro provider surface: the API-key route into Kiro's subscription.
 *
 * Phase 1 (this file) covers the `ksk_…` API key only: paste the key, Kiro names
 * the profile it belongs to (`GetProfile` in us-east-1, then eu-central-1, as
 * `kiro-cli` does), and that profile's region becomes the conversation host.
 *
 * Not covered yet, and deliberately rather than accidentally:
 *   - browser sign-ins (Google/GitHub yes, AWS Builder ID / IAM Identity Center
 *     no) and the token refresh they need;
 *   - reading a local `kiro-cli` or Kiro IDE sign-in;
 *   - Kiro's own web search;
 *   - image downscaling for an image over Kiro's 5 MiB base64 limit (an
 *     oversized image is refused by Kiro and surfaces as its own error).
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { KiroSession } from '../../auth/store.js'
import { discoverKiroProfile, discoverKiroProfileForToken, regionOfProfileArn, KIRO_KEY_PREFIX } from './protocol.js'
import { refreshKiroTokens } from './login.js'
import type { KiroSignInResult } from './login.js'

export { KiroAdapter } from './adapter.js'
export {
  KIRO_AUTH_SERVICE,
  KIRO_BUILDER_ID_START,
  KIRO_CALLBACK_PORTS,
  KIRO_PORTAL,
  KIRO_SCOPES,
  KIRO_SIGNIN_TIMEOUT_MS,
  kiroCliDatabasePath,
  readKiroCliSignIn,
  readKiroIdeSignIn,
  refreshKiroTokens,
  startKiroSignIn,
} from './login.js'
export type { KiroSignIn, KiroSignInResult, LocalKiroSignIn } from './login.js'
export type { KiroAdapterOptions } from './adapter.js'
export {
  KIRO_CHAT_PATH,
  KIRO_DEFAULT_REGION,
  KIRO_KEY_PREFIX,
  KIRO_KEY_REGIONS,
  KIRO_STREAM_CONTENT_TYPE,
  discoverKiroProfile,
  discoverKiroProfileForToken,
  kiroAuthHeaders,
  kiroControlCall,
  kiroManagement,
  kiroRuntime,
  kiroSdkHeaders,
  regionOfProfileArn,
} from './protocol.js'
export { decodeEventStream, exceptionText, parseFrameHeaders } from './eventstream.js'
export type { EventStreamFrame } from './eventstream.js'
export { fetchKiroModels, findKiroModel, parseKiroModels, toKiroModelInfo, writeKiroRosterDiagnostic, KIRO_ROSTER_DIAGNOSTIC_FILE } from './catalog.js'
export type { KiroRosterDiagnostic } from './catalog.js'
export type { KiroModel } from './catalog.js'
export {
  clearKiroUnsupported,
  kiroUnsupportedPath,
  readKiroUnsupported,
  recordKiroUnsupported,
  UNSUPPORTED_TTL_MS,
} from './unsupported.js'
export { fetchKiroUsage, kiroPlanName, kiroUsageToProviderUsage, parseKiroUsage } from './usage.js'
export type { KiroAllowance, KiroUsageSnapshot } from './usage.js'
export {
  buildKiroRequest,
  classifyKiroFailure,
  kiroInputSchema,
  kiroToolId,
  kiroToolName,
  kiroToolNameMap,
} from './translate.js'
export type { KiroRequestBody } from './translate.js'

/**
 * A Kiro API key never refreshes: the runtime has no token endpoint for one, and
 * a key either works until it is revoked or never did.
 *
 * @param session - the stored session.
 * @returns the same session.
 */
export async function refreshKiro(session: KiroSession): Promise<KiroSession> {
  // An API key has no refresh grant: it either works until revoked or never did.
  if (session.method === undefined || session.method === 'apikey') return session
  const renewed = await refreshKiroTokens(session)
  return { ...session, ...renewed }
}

/** A pasted key never becomes permanently invalid from a refresh attempt. */
export function isKiroPermanentRefreshError(_error: unknown): boolean {
  return false
}

/**
 * Validate a pasted API key before it reaches the store.
 *
 * Kiro keys are `ksk_…`. The shape is checked because a wrong paste (a session
 * token, a profile ARN, a whole `Authorization:` header) otherwise fails on the
 * first *chat* with a 403 that reads like a dead subscription.
 *
 * @param value - raw paste.
 * @param label - diagnostic prefix naming the route.
 * @returns the trimmed key.
 * @throws {LlmError} when the paste cannot be a Kiro API key.
 */
export function assertUsableKiroKey(value: string, label: string): string {
  const key = value.trim()
  if (key === '') throw new LlmError(`${label}: Kiro API key is empty`, 'INVALID_CREDENTIAL')
  if (/\s/.test(key)) {
    throw new LlmError(`${label}: that looks like a request header, not a bare API key (it contains whitespace)`, 'INVALID_CREDENTIAL')
  }
  if (!key.startsWith(KIRO_KEY_PREFIX)) {
    throw new LlmError(`${label}: that does not look like a Kiro API key (expected ksk_…)`, 'INVALID_CREDENTIAL')
  }
  if (!/^ksk_[A-Za-z0-9._-]{8,}$/.test(key)) {
    throw new LlmError(`${label}: that does not look like a Kiro API key (expected ksk_… )`, 'INVALID_CREDENTIAL')
  }
  return key
}

/**
 * Build a session from a pasted key, asking Kiro which profile it belongs to.
 *
 * The lookup is what makes the region right: a key minted in eu-central-1 is
 * refused on us-east-1. A key Kiro names no profile for is still accepted, in
 * us-east-1 and with no profile — exactly how `kiro-cli` proceeds — because
 * refusing it here would reject a key that works.
 *
 * @param apiKey - validated key.
 * @param account - account label; also the roster cache key.
 * @param fetchFn - fetch to use for the lookup.
 * @returns the stored session.
 */
export async function sessionFromKiroKey(
  apiKey: string,
  account: string,
  fetchFn: typeof fetch = fetch,
): Promise<KiroSession> {
  const profileArn = await discoverKiroProfile(fetchFn, apiKey)
  return {
    accessToken: apiKey,
    refreshToken: apiKey,
    // A static key: far-future so the shared token manager never tries a refresh.
    expiresAt: Date.now() + 3650 * 24 * 60 * 60 * 1000,
    account,
    method: 'apikey',
    region: regionOfProfileArn(profileArn),
    ...profileArn === '' ? {} : { profileArn },
  }
}

/**
 * Mask a key for display, keeping enough to recognize it.
 * @param value - raw key.
 * @returns the masked label.
 */
export function maskKiroKey(value: string): string {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 12) return `${key.slice(0, 4)}…${key.slice(-2)}`
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

/**
 * Build a session from a finished browser sign-in.
 *
 * The profile is looked up with the new token when the sign-in did not name one:
 * its ARN is what selects the runtime region, and a sign-in that skips this
 * fails on the first chat with a 403 from the wrong host.
 *
 * @param result - the finished sign-in.
 * @param account - account label for the card.
 * @param fetchFn - fetch for the profile lookup.
 * @returns the session to store.
 */
export async function sessionFromKiroSignIn(
  result: KiroSignInResult,
  account: string,
  fetchFn: typeof fetch = fetch,
): Promise<KiroSession> {
  const profileArn = result.profileArn ?? await discoverKiroProfileForToken(fetchFn, result.accessToken)
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    account,
    method: result.method,
    loginProvider: result.loginProvider,
    region: regionOfProfileArn(profileArn, result.region),
    ...profileArn === '' ? {} : { profileArn },
    ...result.clientId === undefined ? {} : { clientId: result.clientId },
    ...result.clientSecret === undefined ? {} : { clientSecret: result.clientSecret },
  }
}
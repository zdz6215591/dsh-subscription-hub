/**
 * Antigravity (agy) OAuth and API constants.
 *
 * The client id/secret below are the public Google consumer-OAuth credentials
 * shipped inside the Antigravity desktop product and its `agy` CLI; they are
 * embedded in many public tools (see NOTICE.md). They are not secrets owned by
 * this project.
 */

import { proxiedFetch } from '../../http.js'

export const AGY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

export const AGY_CLIENT_SECRET = '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'

/**
 * Effective OAuth client credentials: AGY_CLIENT_ID / AGY_CLIENT_SECRET env
 * overrides win when set (BYO OAuth app escape hatch, mirrors pi-antigravity);
 * otherwise the embedded public Antigravity credentials are used.
 */
export function resolveAgyClientCredentials(overrideClientId?: string): { clientId: string; clientSecret: string } {
  if (overrideClientId) {
    if (overrideClientId === AGY_CLIENT_ID) {
      return { clientId: AGY_CLIENT_ID, clientSecret: AGY_CLIENT_SECRET }
    }
    return {
      clientId: overrideClientId,
      clientSecret: process.env.AGY_CLIENT_SECRET || AGY_CLIENT_SECRET,
    }
  }
  return {
    clientId: process.env.AGY_CLIENT_ID || AGY_CLIENT_ID,
    clientSecret: process.env.AGY_CLIENT_SECRET || AGY_CLIENT_SECRET,
  }
}

/** Required scopes. `openid` must NOT be added: it routes Google into the hanging
 * `firstparty/nativeapp` consent for this client (verified by OmniRoute). */
export const AGY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

/** Default loopback callback used by the standalone CLI listener (fixed port, like opencode). */
export const AGY_DEFAULT_REDIRECT_URI = 'http://localhost:51121/oauth-callback'

/**
 * Antigravity API endpoints. The daily runtime host (no .sandbox suffix) is the
 * live endpoint for consumer OAuth accounts — cloudcode-pa.googleapis.com
 * answers RESOURCE_EXHAUSTED for them (verified by live probe), while the
 * daily host answers 200. Order matters: first reachable non-429/403 wins.
 */
export const AGY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
export const AGY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
export const AGY_ENDPOINT_DAILY_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const AGY_ENDPOINT_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com'

/** Runtime/bootstrap endpoint fallback order (daily first, mirroring OmniRoute). */
export const AGY_ENDPOINT_FALLBACKS: readonly string[] = [
  AGY_ENDPOINT_DAILY,
  AGY_ENDPOINT_PROD,
  AGY_ENDPOINT_DAILY_SANDBOX,
  AGY_ENDPOINT_AUTOPUSH,
]

/**
 * Statuses that mean "this ENDPOINT is not usable for this account"; skip to the next.
 *
 * `429` is deliberately NOT here. A quota answer is the ACCOUNT's state, not the
 * host's: measured on one account, the daily canary answers
 * `400 FAILED_PRECONDITION "User location is not supported for the API use"`
 * while production answers `429 RESOURCE_EXHAUSTED` for the same request. Skipping
 * 429 used to hide that, and the caller was left reporting the canary's location
 * rejection as if the account were region-locked.
 */
export const AGY_ENDPOINT_SKIP_STATUSES = new Set([403])

/** Bodies that mean "wrong Code Assist host for this account", not a request fault. */
const AGY_WRONG_HOST_BODY = /api key is invalid|API_KEY_INVALID|request had invalid authentication credentials/i

/**
 * Bodies a host answers when it does not serve this account's location.
 *
 * This is host-specific in practice — the daily canary refuses a request that
 * production then answers (429/200) — so it is a reason to try the next host, not
 * a verdict on the account.
 */
const AGY_LOCATION_BODY = /UNSUPPORTED_LOCATION|User location is not supported|FAILED_PRECONDITION/i

/** Daily host often answers 400 "API key is invalid" for consumer accounts that actually live on prod. */
export async function isAgyUnusableEndpoint(response: Response): Promise<boolean> {
  if (AGY_ENDPOINT_SKIP_STATUSES.has(response.status)) return true
  if (response.status !== 400) return false
  try {
    const text = await response.clone().text()
    return AGY_WRONG_HOST_BODY.test(text) || AGY_LOCATION_BODY.test(text)
  } catch {
    return false
  }
}

/**
 * Try each runtime endpoint in order, skipping the ones that do not serve this
 * account (403, a wrong-host 400, a location refusal).
 *
 * Returns the first other response, so a quota `429` — or a 2xx — ends the walk
 * with the account's REAL answer. Only when every endpoint refuses does it return
 * the first refusal, and it prefers one that is not a location refusal, because
 * "location not supported" from the canary is the least informative thing that can
 * be said about a request production accepted.
 */
export async function fetchAgyFirstOk(
  urlPath: string,
  init: RequestInit,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<Response> {
  let firstSkipped: Response | null = null
  let firstLocationRefusal: Response | null = null
  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(`${baseEndpoint}${urlPath}`, init)
      if (await isAgyUnusableEndpoint(response)) {
        const text = await response.clone().text().catch(() => '')
        if (AGY_LOCATION_BODY.test(text)) firstLocationRefusal ??= response
        else firstSkipped ??= response
        continue
      }
      return response
    } catch {
      // network error — try the next endpoint
    }
  }
  if (firstSkipped !== null) return firstSkipped
  if (firstLocationRefusal !== null) return firstLocationRefusal
  throw new Error('all agy endpoints failed')
}

/**
 * Antigravity client identity presented on every call.
 *
 * The product REFUSES an unrecognised client (`This version of Antigravity is no
 * longer supported`) and answers it inside a normal 200, so the rejection looks
 * like the model talking. The reference project moved this to the **CLI family**
 * (`antigravity/cli/<version> (aidev_client; <os>; <arch)`) — the identity whose
 * catalogue also carries the newest models — instead of the desktop build string
 * this route was written with.
 *
 * Two overrides exist because the accepted identity is the vendor's to change:
 * `agyUserAgent` / `DSH_AGY_USER_AGENT` replaces the whole string, and
 * `agyVersion` / `DSH_AGY_VERSION` only the version inside the CLI default.
 */
export const AGY_VERSION_FALLBACK = '1.3.4'

/** Build the CLI-family User-Agent for one version. */
export function agyCliUserAgent(version = currentAgyVersion()): string {
  return `antigravity/cli/${version} (aidev_client; ${process.platform}; ${process.arch})`
}

/** A whole User-Agent set by config, which wins over everything else. */
let configuredUserAgent: string | undefined
/** A version set by config, which wins over the environment and the fallback. */
let configuredVersion: string | undefined

/**
 * Set the client identity to present to Antigravity.
 *
 * @param options - a whole User-Agent, a version, or neither (both reset).
 */
export function setAgyIdentity(options: { userAgent?: string; version?: string } = {}): void {
  const ua = options.userAgent?.trim()
  configuredUserAgent = ua === undefined || ua === '' ? undefined : ua
  const version = options.version?.trim()
  configuredVersion = version === undefined || version === '' ? undefined : version
}

/** The version the default CLI User-Agent is built with right now. */
export function currentAgyVersion(): string {
  if (configuredVersion !== undefined) return configuredVersion
  const fromEnv = process.env.DSH_AGY_VERSION?.trim()
  return fromEnv === undefined || fromEnv === '' ? AGY_VERSION_FALLBACK : fromEnv
}

/** The User-Agent every call uses right now. */
export function currentAgyUserAgent(): string {
  if (configuredUserAgent !== undefined) return configuredUserAgent
  const fromEnv = process.env.DSH_AGY_USER_AGENT?.trim()
  return fromEnv === undefined || fromEnv === '' ? agyCliUserAgent() : fromEnv
}

/** User-Agent for bootstrap calls (loadCodeAssist/onboardUser). */
export function getAgyBootstrapUserAgent(version?: string): string {
  return version === undefined ? currentAgyUserAgent() : agyCliUserAgent(version)
}

/** User-Agent for generate calls. */
export function getAgyGenerateUserAgent(version?: string): string {
  return version === undefined ? currentAgyUserAgent() : agyCliUserAgent(version)
}
/** Client-Metadata payload for bootstrap calls — ideType only (backend enum
 * validation rejects freely-added platform/pluginType; AGENTS.md invariant). */
export function getAgyBootstrapClientMetadata(): string {
  return '{"ideType":"ANTIGRAVITY"}'
}

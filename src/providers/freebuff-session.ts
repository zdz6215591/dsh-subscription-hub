/**
 * Freebuff login: turn pasted browser material into a stored session, and keep
 * that session alive.
 *
 * ## There is no discovery path — paste is the only way in
 *
 * Freebuff publishes no OAuth client, so nothing here can drive a login. The
 * reference gets its credential three ways and this plugin can use NONE of them:
 *
 *   - a **browser extension** that reads the page's cookies
 *     (`ref-freebuff2api/browser-extension/`);
 *   - a **WebView2 login window**, whose cookie capture works only because the
 *     cookie manager is an OS-level component the page's JS cannot reach
 *     (`ref-freebuff2api/src/login_window_windows.rs:1-20`, `:76-90`) — not
 *     available to a Node plugin, and Windows-only even there;
 *   - **curl / HAR / cookie paste** (`ref-freebuff2api/src/import.rs:1-4`).
 *
 * So this module implements the third, which is the one a user can always do:
 * copy the `authorization` header or the cookie string out of DevTools. There is
 * consequently no `freebuffImportFailureMessage`-style helper — there is no
 * discovery to fail, and inventing one would tell the user to look for something
 * that does not exist.
 *
 * ## What a paste may contain
 *
 * {@link parseFreebuffPaste} follows the reference's sniffing order
 * (`ref-freebuff2api/src/import.rs:308-350`): a curl command, then a HAR
 * document, then a cookie string carrying the session-token marker, then a bare
 * `Bearer <token>`, then a bare token. The credential is then VALIDATED against
 * the balance endpoint before anything is stored, so a paste that the upstream
 * does not honour fails here with the upstream's own answer rather than at the
 * first chat request.
 *
 * ## Keeping it alive: the 45 s heartbeat, without a timer
 *
 * The reference schedules `x-freebuff-heartbeat: 1` every 45 s on a background
 * loop (`ref-freebuff2api/src/session.rs:7,21-22`, `:262-272`) because a web
 * session is dropped when it goes quiet. A plugin must not own a background
 * timer, so the same effect is produced through the shared token manager: the
 * validation TTL IS the heartbeat interval, and the manager's preempt window
 * makes the next request re-validate — which is where the heartbeat flag rides
 * (`ref-freebuff2api/src/upstream.rs:183-193`). No timer, no polling when idle.
 *
 * @module dsh-subscription-hub/providers/freebuff-session
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../http.js'
import type { FreebuffSession } from '../auth/store.js'
import type { FreebuffCredential } from './freebuff/client.js'
import {
  freebuffCredentialKind,
  freebuffSessionHeaders,
  freebuffSessionUrl,
  freebuffSessionUnauthenticated,
  FREEBUFF_SESSION_COOKIE,
  FREEBUFF_WEB_AUTH_SESSION_PATH,
  FREEBUFF_WEB_BASE,
} from './freebuff/client.js'

/**
 * How long one successful validation is trusted.
 *
 * Equal to the reference's heartbeat interval on purpose (`src/session.rs:21`):
 * a request that arrives after this TTL re-validates, which is what stands in
 * for the reference's 45 s background heartbeat. See the module doc.
 */
export const FREEBUFF_VALIDATION_TTL_MS = 45_000

/** The reference's heartbeat cadence, exported so the wiring can name it (`src/session.rs:21`). */
export const FREEBUFF_HEARTBEAT_INTERVAL_MS = 45_000

/** Bound on one validation call. */
const VALIDATION_TIMEOUT_MS = 15_000

/** The parsed credential a paste yielded. */
export interface FreebuffParsedCredential {
  /** `bearer` for a token the desktop protocol takes, `cookie` for a browser session. */
  kind: 'bearer' | 'cookie'
  /** The Bearer token, or the session-token value of a cookie string. */
  token: string
  /** The cookie header to send, for a `cookie` credential. */
  cookie?: string
}

/** What a successful validation read back. */
export interface FreebuffIdentity {
  token: string
  cookie?: string
  /** Display identity (email or name), when the endpoint disclosed one. */
  account?: string
  /** Plan label: `subscription.tierId`, else `freebucks.planId`, else `accessTier`. */
  plan?: string
}

/** The NextAuth cookies the reference keeps when it trims a pasted cookie string (`src/import.rs:352-378`). */
const KEPT_COOKIE_NAMES = [
  FREEBUFF_SESSION_COOKIE,
  '__Host-next-auth.csrf-token',
  '__Secure-next-auth.callback-url',
]

/**
 * Trim a pasted cookie string down to the cookies the session actually needs.
 *
 * Ported from the reference (`src/import.rs:352-378`): it keeps the session
 * token, the CSRF token and the callback URL, in that order, and drops whatever
 * else the browser happened to have. Keeping the whole header would be more
 * faithful to the browser, but the reference's smaller set is what it validated
 * against live, and a trimmed header is also less to leak.
 * @param text - any text containing cookie pairs.
 * @returns the trimmed cookie string, or undefined when no session token was found.
 */
export function freebuffTrimCookieString(text: string): string | undefined {
  const found: string[] = []
  for (const name of KEPT_COOKIE_NAMES) {
    const pattern = new RegExp(`(?:^|[;\\s"'])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;\\s"']+)`)
    const match = pattern.exec(text)
    if (match?.[1] !== undefined) found.push(`${name}=${match[1]}`)
  }
  return found.length === 0 ? undefined : found.join('; ')
}

/** The session-token VALUE inside a cookie string. */
export function freebuffSessionTokenOf(cookie: string): string | undefined {
  const pattern = new RegExp(`${FREEBUFF_SESSION_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;\\s"']+)`)
  const match = pattern.exec(cookie)
  return match?.[1]
}

/** The `authorization: Bearer <token>` value in a header list, curl command or HAR document. */
function freebuffBearerIn(text: string): string | undefined {
  const match = /(?:^|[^a-z])authorization["'\s]*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{16,})/i.exec(text)
  return match?.[1]
}

/** The `cookie: <value>` header in a header list, curl command or HAR document. */
function freebuffCookieHeaderIn(text: string): string | undefined {
  const match = /(?:^|[^a-z])cookie["'\s]*:\s*([^"'\r\n]+)/i.exec(text)
  return match?.[1]
}

/** Pull one credential out of a HAR document, when the text is one. */
function freebuffFromHar(text: string): string | undefined {
  if (!text.trimStart().startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const log = (parsed as { log?: { entries?: unknown } }).log
  const entries = log?.entries
  if (!Array.isArray(entries)) return undefined
  for (const entry of entries) {
    const headers = (entry as { request?: { headers?: unknown } })?.request?.headers
    if (!Array.isArray(headers)) continue
    for (const header of headers) {
      const name = String((header as { name?: unknown })?.name ?? '').toLowerCase()
      const value = (header as { value?: unknown })?.value
      if (typeof value !== 'string') continue
      if (name === 'authorization') {
        const token = /^Bearer\s+(.+)$/i.exec(value.trim())?.[1]
        if (token !== undefined) return token.trim()
      }
      if (name === 'cookie' && /session-token/i.test(value)) return value.trim()
    }
  }
  return undefined
}

/**
 * Parse pasted login material into one credential.
 *
 * Order of specificity (the reference's own, `src/import.rs:308-350`):
 * a HAR document, a curl command, a cookie string, a bare `Bearer <token>`, then
 * a bare token. A cookie paste wins over a bearer-looking string because the
 * session-token marker is checked first — the same discriminator the reference's
 * credential classifier uses (`src/import.rs:176-183`).
 * @param input - the raw pasted text.
 * @returns the credential it named.
 * @throws {LlmError} `MISSING_CREDENTIAL` when nothing usable was pasted.
 */
export function parseFreebuffPaste(input: string): FreebuffParsedCredential {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new LlmError(
      'Freebuff: paste the credential first — either the `authorization: Bearer …` header value '
      + 'from a freebuff.com request, or the full Cookie string (it must contain '
      + `\`${FREEBUFF_SESSION_COOKIE}=\`).`,
      'MISSING_CREDENTIAL',
    )
  }
  const fromHar = freebuffFromHar(trimmed)
  const candidate = fromHar ?? trimmed
  // A cookie string, whether it was pasted whole or carried in a `cookie:` header.
  const cookieSource = /session-token/i.test(candidate)
    ? freebuffCookieHeaderIn(candidate) ?? candidate
    : undefined
  if (cookieSource !== undefined) {
    const cookie = freebuffTrimCookieString(cookieSource)
    const token = cookie === undefined ? undefined : freebuffSessionTokenOf(cookie)
    if (cookie !== undefined && token !== undefined) return { kind: 'cookie', token, cookie }
  }
  const bearer = freebuffBearerIn(candidate) ?? (candidate.startsWith('Bearer ') ? candidate.slice(7).trim() : undefined)
  if (bearer !== undefined && bearer !== '') return { kind: 'bearer', token: bearer }
  if (/^\S{16,}$/.test(candidate)) return { kind: 'bearer', token: candidate }
  throw new LlmError(
    'Freebuff: could not find a credential in that text. Paste the bare Bearer token, or the full Cookie '
    + `string from freebuff.com (it must contain \`${FREEBUFF_SESSION_COOKIE}=\`).`,
    'MISSING_CREDENTIAL',
  )
}

/** The credential fields a stored session carries. */
export function freebuffCredentialOf(session: FreebuffSession): FreebuffCredential {
  return {
    accessToken: session.accessToken,
    ...session.cookie === undefined ? {} : { cookie: session.cookie },
  }
}

/**
 * Validate a credential against the balance endpoint and read back what it says
 * about the account.
 *
 * This is the ONLY credential-validating call either protocol offers, and both
 * wires answer it: a cookie credential is refused with a 401
 * (`src/api.rs:5618`) and a Bearer credential with the desktop session GET.
 *
 * The desktop call carries `x-freebuff-heartbeat: 1`, which is how the keepalive
 * reaches the upstream (`src/upstream.rs:183-193`).
 * @param credential - the credential to validate.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the identity to store.
 * @throws {LlmError} `MISSING_CREDENTIAL` for an empty credential, `AUTH` when the
 *   upstream refuses it, `TRANSPORT`/`SERVER` when nothing answered.
 */
export async function validateFreebuffCredential(
  credential: FreebuffCredential,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
): Promise<FreebuffIdentity> {
  const kind = freebuffCredentialKind(credential)
  if (kind === undefined) {
    throw new LlmError(
      'Freebuff: the credential carries neither a Bearer token nor a cookie string.',
      'MISSING_CREDENTIAL',
    )
  }
  const wire = kind === 'cookie' ? 'web' : 'chat-completions'
  const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS)
  const perSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetchFn(freebuffSessionUrl(wire), {
      method: 'GET',
      headers: freebuffSessionHeaders(credential, wire, { heartbeat: true }),
      signal: perSignal,
    })
  } catch (error) {
    throw new LlmError(
      `Freebuff: could not reach ${freebuffSessionUrl(wire)} to validate the credential.`,
      'TRANSPORT',
      { cause: error },
    )
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    // A 401 is the reference's own "this credential is dead" signal: its pool
    // cools a deterministic failure immediately (`src/web_pool.rs:268-275`), and
    // a refresh that returns AUTH is what deletes the stored session.
    const auth = response.status === 401 || response.status === 403
    throw new LlmError(
      `Freebuff credential check failed (HTTP ${String(response.status)})${text === '' ? '' : `: ${text.slice(0, 200)}`}`
      + (auth ? ' — the browser session is no longer valid; paste a current token or cookie string.' : ''),
      auth ? 'AUTH' : 'SERVER',
      { status: response.status },
    )
  }
  const payload = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  if (payload === undefined) {
    throw new LlmError(
      `Freebuff credential check answered unparseable JSON: ${text.slice(0, 200)}`,
      'MALFORMED_RESPONSE',
    )
  }
  // An authenticated answer always carries `accessTier` or `freebucks`
  // (`src/api.rs:5618-5621`); anything else is a refusal wearing a 200.
  if (freebuffSessionUnauthenticated(payload)) {
    throw new LlmError(
      'Freebuff did not recognise the credential: its balance answer carried no access tier and no credits. '
      + 'Paste a current Bearer token or cookie string from a signed-in freebuff.com session.',
      'AUTH',
    )
  }
  const record = payload as Record<string, unknown>
  const freebucks = typeof record.freebucks === 'object' && record.freebucks !== null
    ? record.freebucks as Record<string, unknown>
    : undefined
  const subscription = typeof record.subscription === 'object' && record.subscription !== null
    ? record.subscription as Record<string, unknown>
    : undefined
  const plan = firstString(
    subscription?.tierId,
    freebucks?.planId,
    record.accessTier,
    record.access_tier,
  )
  const account = kind === 'cookie' ? await freebuffDisplayIdentity(credential, fetchFn, perSignal) : undefined
  return {
    token: credential.accessToken,
    ...credential.cookie === undefined ? {} : { cookie: credential.cookie },
    ...account === undefined ? {} : { account },
    ...plan === undefined ? {} : { plan },
  }
}

/**
 * Best-effort display name for a cookie credential.
 *
 * `/api/auth/session` answers **HTTP 200 with `{}`** for a credential that is not
 * signed in (`src/api.rs:5606-5616`) — so the body is checked for a real `user`
 * subject and nothing is inferred from the status. A failure here is NOT a
 * validation failure: the balance call already proved the credential works, and
 * the account row can be keyed off the credential hash.
 * @param credential - the credential to ask about.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - the shared cancellation signal.
 * @returns the display identity, or undefined.
 */
async function freebuffDisplayIdentity(
  credential: FreebuffCredential,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(`${FREEBUFF_WEB_BASE}${FREEBUFF_WEB_AUTH_SESSION_PATH}`, {
      method: 'GET',
      headers: freebuffSessionHeaders(credential, 'web'),
      signal,
    })
    if (!response.ok) return undefined
    const payload = await response.json() as unknown
    if (typeof payload !== 'object' || payload === null) return undefined
    const user = (payload as { user?: unknown }).user
    if (typeof user !== 'object' || user === null) return undefined
    const fields = user as Record<string, unknown>
    return firstString(fields.email, fields.name, fields.id)
  } catch {
    return undefined
  }
}

/** First non-empty string among the candidates. */
function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Build the session to store from a validated credential.
 * @param credential - the parsed credential.
 * @param identity - what the validation read back.
 * @returns the session.
 * @throws {LlmError} `MALFORMED_RESPONSE` when a cookie credential validated
 *   without a cookie string surviving: every web request sends the header, so a
 *   session without one would fail on its first call.
 */
export function freebuffSessionOf(
  credential: FreebuffParsedCredential,
  identity: FreebuffIdentity,
): FreebuffSession {
  if (credential.kind === 'cookie' && identity.cookie === undefined) {
    throw new LlmError(
      'Freebuff validated the cookie credential but no cookie header survived parsing; '
      + `paste the full freebuff.com Cookie string (it must contain \`${FREEBUFF_SESSION_COOKIE}=\`).`,
      'MALFORMED_RESPONSE',
    )
  }
  return {
    // One secret held twice, like the JoyCode route: it is what a request sends
    // AND the durable secret a re-validation carries (see `FreebuffSession`).
    accessToken: identity.token,
    refreshToken: identity.token,
    expiresAt: Date.now() + FREEBUFF_VALIDATION_TTL_MS,
    ...identity.cookie === undefined ? {} : { cookie: identity.cookie },
    ...identity.account === undefined ? {} : { account: identity.account },
    ...identity.plan === undefined ? {} : { plan: identity.plan },
  }
}

/**
 * Build a session from pasted login material.
 * @param input - the raw pasted text.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the session to persist.
 * @throws {LlmError} `MISSING_CREDENTIAL` for unusable input, `AUTH` when the
 *   upstream refuses the credential.
 */
export async function freebuffSessionFromPaste(
  input: string,
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
): Promise<FreebuffSession> {
  const credential = parseFreebuffPaste(input)
  const identity = await validateFreebuffCredential(
    { accessToken: credential.token, ...credential.cookie === undefined ? {} : { cookie: credential.cookie } },
    fetchFn ?? proxiedFetch,
    signal,
  )
  return freebuffSessionOf(credential, identity)
}

/**
 * Re-validate a stored session: the shared token manager's "refresh".
 *
 * There is no grant to exchange, so a refresh means asking the balance endpoint
 * about the credential already held. That re-validates it, extends the window,
 * and (for a Bearer credential) sends the heartbeat flag — which is the whole of
 * this route's keepalive (see the module doc).
 * @param session - the stored session.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the session to store.
 * @throws {LlmError} `AUTH` when the credential is refused (permanent: only a
 *   fresh paste can replace it).
 */
export async function refreshFreebuffSession(
  session: FreebuffSession,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
): Promise<FreebuffSession> {
  const identity = await validateFreebuffCredential(freebuffCredentialOf(session), fetchFn, signal)
  const account = identity.account ?? session.account
  const plan = identity.plan ?? session.plan
  return {
    ...session,
    accessToken: identity.token,
    refreshToken: identity.token,
    expiresAt: Date.now() + FREEBUFF_VALIDATION_TTL_MS,
    ...(identity.cookie ?? session.cookie) === undefined ? {} : { cookie: identity.cookie ?? session.cookie },
    ...account === undefined ? {} : { account },
    ...plan === undefined ? {} : { plan },
  }
}

/**
 * Whether a failed re-validation is terminal for this credential.
 *
 * A refusal (`AUTH`) means the browser session is gone and nothing this plugin
 * can do revives it — the user pastes a current token or cookie string. A
 * transport failure says nothing about the credential, so it is retried.
 * @param error - the thrown value.
 * @returns true when a fresh paste is the only remedy.
 */
export function isFreebuffPermanentRefreshError(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'AUTH'
}

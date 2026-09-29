/**
 * Freebuff login: turn a Bearer credential into a stored session, and keep that
 * session alive.
 *
 * ## Which credentials this route accepts, and where they come from
 *
 * ONE shape: a Bearer token. Two ways to get one, both real:
 *
 *   - **the official CLI's login** (`~/.config/manicode/credentials.json` →
 *     `default.authToken`), imported by `freebuff-cli.ts`;
 *   - **a pasted `authorization: Bearer …` value** — {@link parseFreebuffPaste}
 *     reads it out of a bare token, the header text, a curl command, or a HAR
 *     document.
 *
 * A browser-session COOKIE is NOT accepted. It can only ride Freebuff's web
 * protocol, which takes one flat prompt string with no `tools` field
 * (`ref-freebuff2api/src/web_protocol.rs:380-388`), so a turn through it would
 * lose every harness tool without saying so. A cookie paste therefore fails with
 * the reason spelled out ({@link freebuffCookieRefusal}) instead of being
 * accepted and quietly degraded.
 *
 * ## What a paste may contain
 *
 * {@link parseFreebuffPaste} follows the reference's sniffing order for the
 * Bearer half (`ref-freebuff2api/src/import.rs:308-350`): a HAR document, then a
 * curl command, then a bare `Bearer <token>`, then a bare token. The credential
 * is then VALIDATED against the session endpoint before anything is stored, so a
 * paste the upstream does not honour fails here with the upstream's own answer
 * rather than at the first chat request.
 *
 * ## Keeping it alive: the 45 s heartbeat, without a timer
 *
 * The reference schedules `x-freebuff-heartbeat: 1` every 45 s on a background
 * loop (`ref-freebuff2api/src/session.rs:7,21-22`, `:262-272`) because a desktop
 * session is dropped when it goes quiet — and the CLI sends the same flag on its
 * session GET (`CV`, the `H==="GET"` branch), for the instance it currently
 * holds. A plugin must not own a background timer, so the same effect is
 * produced through the shared token manager: the validation TTL IS the heartbeat
 * interval, and the manager's preempt window makes the next request re-validate —
 * which is where the heartbeat flag rides ({@link validateFreebuffCredential}).
 * The read speaks for the claim the adapter holds when there is one
 * ({@link freebuffReadInstanceId}), which is what makes it a real heartbeat for
 * that claim rather than a balance read under a made-up instance. No timer, no
 * polling when idle.
 *
 * @module dsh-subscription-hub/providers/freebuff-session
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../http.js'
import type { FreebuffSession } from '../auth/store.js'
import type { FreebuffCredential } from './freebuff/client.js'
import {
  freebuffAssertDesktopCredential,
  freebuffCredentialKind,
  freebuffCookieRefusal,
  freebuffSessionHeaders,
  freebuffSessionUrl,
  freebuffSessionUnauthenticated,
} from './freebuff/client.js'
import { freebuffReadInstanceId } from './freebuff/claim.js'

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

/** What a successful validation read back. */
export interface FreebuffIdentity {
  token: string
  /** Display identity (email or name), when the caller or the endpoint supplied one. */
  account?: string
  /** Plan label: `subscription.tierId`, else `freebucks.planId`, else `accessTier`. */
  plan?: string
}

/** The `authorization: Bearer <token>` value in a header list, curl command or HAR document. */
function freebuffBearerIn(text: string): string | undefined {
  const match = /(?:^|[^a-z])authorization["'\s]*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{16,})/i.exec(text)
  return match?.[1]
}

/**
 * Pull a Bearer token out of a HAR document, when the text is one.
 *
 * Only the `authorization` header is read. The reference's HAR importer also
 * collects a session cookie (`src/import.rs:308-350`), and that half is
 * deliberately NOT ported: this route does not accept cookie credentials.
 * @param text - the candidate document.
 * @returns the token, or undefined.
 */
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
      if (name !== 'authorization' || typeof value !== 'string') continue
      const token = /^Bearer\s+(.+)$/i.exec(value.trim())?.[1]
      if (token !== undefined) return token.trim()
    }
  }
  return undefined
}

/**
 * Parse pasted login material into one Bearer credential.
 *
 * A cookie paste is REFUSED with the reason, not accepted: see the module doc
 * for why that wire is not implemented here.
 * @param input - the raw pasted text.
 * @returns the Bearer token.
 * @throws {LlmError} `MISSING_CREDENTIAL` when nothing usable was pasted,
 *   `UNSUPPORTED` when what was pasted is a cookie string.
 */
export function parseFreebuffPaste(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new LlmError(
      'Freebuff: paste the credential first — the `authorization: Bearer …` header value from a Freebuff CLI '
      + 'request, or the bare token. Cookie strings are not accepted on this route.',
      'MISSING_CREDENTIAL',
    )
  }
  // The cookie check comes first and is a REFUSAL rather than a fallback: a
  // cookie string also contains token-looking material, so letting the Bearer
  // rules run over it would happily extract the session-token value and send it
  // as a Bearer — which is the credential shape the upstream answers with a
  // ban-shaped 403.
  if (/session-token/i.test(trimmed)) throw freebuffCookieRefusal()
  const fromHar = freebuffFromHar(trimmed)
  const candidate = fromHar ?? trimmed
  const bearer = freebuffBearerIn(candidate)
    ?? (candidate.startsWith('Bearer ') ? candidate.slice(7).trim() : undefined)
  if (bearer !== undefined && bearer !== '') {
    if (/session-token/i.test(bearer)) throw freebuffCookieRefusal()
    return bearer
  }
  if (/^\S{16,}$/.test(candidate)) return candidate
  throw new LlmError(
    'Freebuff: could not find a Bearer token in that text. Paste the bare token, or the '
    + '`authorization: Bearer …` header value from a Freebuff CLI request. '
    + '(Cookie strings are not accepted on this route.)',
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
 * Validate a credential against the session endpoint and read back what it says
 * about the account.
 *
 * This is the ONE credentialed read either protocol offers, and it is the quota
 * read too: live 2026-09-28, `GET https://www.codebuff.com/api/v1/freebuff/session`
 * with the CLI's own header set answered 200 for a free CLI credential with
 * `accessTier`, `freebucks{balance, daily{limit,spent,remaining,resetAt}}` and a
 * per-model `prices` map. No cookie is involved.
 *
 * The call carries `x-freebuff-heartbeat: 1` and
 * `x-freebuff-include-unused-rate-limits: 1`, which is how the keepalive reaches
 * the upstream and why the answer carries the per-model rows at all
 * (`ref-freebuff2api/src/upstream.rs:183-193`, CLI `CV`'s GET branch).
 * @param credential - the credential to validate.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @param options - `account` supplies a display name the endpoint does not return
 *   (the CLI import knows the email, the endpoint does not).
 * @returns the identity to store.
 * @throws {LlmError} `MISSING_CREDENTIAL` for an empty credential, `AUTH` when the
 *   upstream refuses it, `TRANSPORT`/`SERVER` when nothing answered.
 */
export async function validateFreebuffCredential(
  credential: FreebuffCredential,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
  options: { account?: string } = {},
): Promise<FreebuffIdentity> {
  freebuffAssertDesktopCredential(credential)
  if (freebuffCredentialKind(credential) !== 'bearer') throw freebuffCookieRefusal()
  const url = freebuffSessionUrl()
  const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS)
  const perSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: freebuffSessionHeaders({
        credential,
        method: 'GET',
        // The live claim's instance when there is one, so this read IS the
        // heartbeat that keeps that claim alive (the CLI heartbeats the instance
        // it holds); otherwise a fresh, throwaway id, which the endpoint answers
        // as an ordinary balance read (`status:"none"`).
        instanceId: freebuffReadInstanceId(credential.accessToken),
      }),
      signal: perSignal,
    })
  } catch (error) {
    throw new LlmError(`Freebuff: could not reach ${url} to validate the credential.`, 'TRANSPORT', { cause: error })
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    // A 401/403 is the reference's own "this credential is dead" signal: its pool
    // cools a deterministic failure immediately (`src/web_pool.rs:268-275`), and a
    // refresh that returns AUTH is what deletes the stored session.
    const auth = response.status === 401 || response.status === 403
    throw new LlmError(
      `Freebuff credential check failed (HTTP ${String(response.status)})${text === '' ? '' : `: ${text.slice(0, 200)}`}`
      + (auth
        ? ' — the credential is no longer valid; import the CLI login again (`freebuff` → log in) or paste a current token.'
        : ''),
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
  // An authenticated answer always carries `accessTier` or `freebucks`; anything
  // else is a refusal wearing a 200.
  if (freebuffSessionUnauthenticated(payload)) {
    throw new LlmError(
      'Freebuff did not recognise the credential: its balance answer carried no access tier and no credits. '
      + 'Import the Freebuff CLI login again, or paste a current Bearer token.',
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
  const account = options.account ?? firstString(record.email, record.account)
  return {
    token: credential.accessToken,
    ...account === undefined ? {} : { account },
    ...plan === undefined ? {} : { plan },
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
 * @param credential - the Bearer token.
 * @param identity - what the validation read back.
 * @returns the session.
 */
export function freebuffSessionOf(credential: string, identity: FreebuffIdentity): FreebuffSession {
  return {
    // One secret held twice, like the JoyCode route: it is what a request sends
    // AND the durable secret a re-validation carries (see `FreebuffSession`).
    accessToken: identity.token,
    refreshToken: identity.token,
    expiresAt: Date.now() + FREEBUFF_VALIDATION_TTL_MS,
    ...identity.account === undefined ? {} : { account: identity.account },
    ...identity.plan === undefined ? {} : { plan: identity.plan },
  }
}

/**
 * Build a session from a Bearer token, validating it first.
 *
 * The one entry point the CLI import, the browser login and the paste path all
 * share, so every credential this route stores has been checked against the
 * upstream exactly once with the upstream's own answer.
 * @param accessToken - the Bearer token.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @param options - `account` supplies a display name the endpoint does not return.
 * @returns the session to persist.
 * @throws {LlmError} as {@link validateFreebuffCredential}.
 */
export async function freebuffSessionFromBearer(
  accessToken: string,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
  options: { account?: string } = {},
): Promise<FreebuffSession> {
  const identity = await validateFreebuffCredential({ accessToken: accessToken.trim() }, fetchFn, signal, options)
  return freebuffSessionOf(accessToken.trim(), identity)
}

/**
 * Build a session from pasted login material.
 * @param input - the raw pasted text.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the session to persist.
 * @throws {LlmError} `MISSING_CREDENTIAL` for unusable input, `UNSUPPORTED` for a
 *   cookie paste, `AUTH` when the upstream refuses the token.
 */
export async function freebuffSessionFromPaste(
  input: string,
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
): Promise<FreebuffSession> {
  const token = parseFreebuffPaste(input)
  return await freebuffSessionFromBearer(token, fetchFn ?? proxiedFetch, signal)
}

/**
 * Re-validate a stored session: the shared token manager's "refresh".
 *
 * There is no grant to exchange, so a refresh means asking the session endpoint
 * about the credential already held. That re-validates it, extends the window,
 * and sends the heartbeat flag — which is the whole of this route's keepalive
 * (see the module doc).
 * @param session - the stored session.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the session to store.
 * @throws {LlmError} `AUTH` when the credential is refused (permanent: only a
 *   fresh import/login can replace it).
 */
export async function refreshFreebuffSession(
  session: FreebuffSession,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
): Promise<FreebuffSession> {
  const identity = await validateFreebuffCredential(freebuffCredentialOf(session), fetchFn, signal, {
    ...session.account === undefined ? {} : { account: session.account },
  })
  const account = identity.account ?? session.account
  const plan = identity.plan ?? session.plan
  return {
    ...session,
    accessToken: identity.token,
    refreshToken: identity.token,
    expiresAt: Date.now() + FREEBUFF_VALIDATION_TTL_MS,
    ...account === undefined ? {} : { account },
    ...plan === undefined ? {} : { plan },
  }
}

/**
 * Whether a failed re-validation is terminal for this credential.
 *
 * A refusal (`AUTH`) means the token is gone and nothing this plugin can do
 * revives it — the user imports the CLI login or pastes a current token. A
 * transport failure says nothing about the credential, so it is retried.
 * @param error - the thrown value.
 * @returns true when a fresh credential is the only remedy.
 */
export function isFreebuffPermanentRefreshError(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'AUTH'
}

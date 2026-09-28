/**
 * JoyCode login: turn a pasted ptKey (or the credential the IDE stored) into a
 * stored session.
 *
 * JoyCode has no OAuth client this plugin can drive — sign-in happens in the
 * JoyCode IDE (QR scan or browser OAuth), and the durable result is a `ptKey`
 * plus the account's numeric user id. So this module owns two ways to get one:
 *
 *   1. **Import from the local IDE** — read the credential the IDE already
 *      stored (`state.vscdb`), which is what a desktop user has.
 *   2. **Paste a ptKey** — the only way in when the IDE is elsewhere (a remote
 *      box, a container, a machine without JoyCode installed).
 *
 * Both funnel through `userInfo`, so nothing is persisted until the upstream has
 * actually accepted the credential — and that call is also where a ROTATED ptKey
 * comes back, which is why the session stores whatever the upstream just handed
 * over rather than the string it was given.
 *
 * @module dsh-subscription-hub/providers/joycode-session
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { JoyCodeCredential, JoyCodeEndpoint } from './joycode/client.js'
import { JOYCODE_ENDPOINTS, joyCodeEnvelope, joyCodeHeaders, joyCodeUrl, parseJoyCodeEnvelope } from './joycode/client.js'
import type { JoyCodeStoredCredential } from './joycode/credentials.js'
import { joyCodeExtensionVersion, joyCodeStateDbCandidates, readJoyCodeStateDb } from './joycode/credentials.js'
import type { JoyCodeSession } from '../auth/store.js'

/**
 * How long one successful validation is trusted before this route re-validates.
 *
 * The reference keeps ptKeys warm with an hourly pass over its accounts; mapping
 * that onto the shared token manager's `expiresAt` gives the same effect through
 * the code path every request already takes (a refresh ahead of the call), and
 * it is what makes a rotated ptKey land in the store instead of stranding the
 * session on the old one.
 */
export const JOYCODE_VALIDATION_TTL_MS = 60 * 60_000

/** What `userInfo` tells us about a credential. */
export interface JoyCodeIdentity {
  /** The ptKey to use from now on (the upstream may have rotated it). */
  ptKey: string
  /** Numeric user id. */
  userId: string
  /** Display name, when the upstream reported one. */
  account?: string
}

/**
 * Validate a credential against `userInfo` and read back its identity.
 *
 * The endpoint is the only credential-validating call this API has: a `code` of
 * 0 means "valid", anything else is a refusal, and `data.ptKey` (when present)
 * supersedes the key that was sent.
 * @param credential - the credential to validate.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the identity to store.
 * @throws {LlmError} `AUTH` when the upstream refuses the credential, `TRANSPORT`
 *   when nothing answered.
 */
export async function validateJoyCodeCredential(
  credential: JoyCodeCredential,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<JoyCodeIdentity> {
  const endpoint: JoyCodeEndpoint = 'userInfo'
  const url = joyCodeUrl(credential, endpoint)
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: joyCodeHeaders(credential),
      body: JSON.stringify(joyCodeEnvelope(credential)),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw new LlmError(
      `JoyCode: could not reach ${JOYCODE_ENDPOINTS[endpoint].path} to validate the credential.`,
      'TRANSPORT',
      { cause: error },
    )
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new LlmError(
      `JoyCode credential check failed (HTTP ${String(response.status)})${text === '' ? '' : `: ${text.slice(0, 200)}`}`,
      response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
      { status: response.status },
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new LlmError(`JoyCode credential check answered unparseable JSON: ${text.slice(0, 200)}`, 'MALFORMED_RESPONSE')
  }
  const envelope = parseJoyCodeEnvelope(payload)
  if (envelope?.code !== undefined && envelope.code !== 0) {
    throw new LlmError(
      `JoyCode refused the credential (code ${String(envelope.code)}${envelope.msg === undefined ? '' : `: ${envelope.msg}`}). `
      + 'Sign in again in the JoyCode IDE, or paste a current ptKey.',
      'AUTH',
    )
  }
  const data = typeof envelope?.data === 'object' && envelope.data !== null
    ? envelope.data as Record<string, unknown>
    : {}
  const rotated = typeof data.ptKey === 'string' && data.ptKey !== '' ? data.ptKey : credential.ptKey
  const account = firstString(data.realName, data.nickName, data.userName, data.name, data.email)
  const userId = firstString(data.userId, data.userID, data.uid) ?? credential.userId
  return { ptKey: rotated, userId, ...account === undefined ? {} : { account } }
}

/**
 * Build the session to store from a validated credential.
 * @param credential - the credential fields.
 * @param identity - what `userInfo` answered.
 * @param clientVersion - the IDE version to present, when one was read.
 * @param account - display name from the imported document, when it had one.
 * @returns the session.
 */
export function joyCodeSessionOf(
  credential: JoyCodeCredential,
  identity: JoyCodeIdentity,
  clientVersion?: string,
  account?: string,
): JoyCodeSession {
  const name = identity.account ?? account
  return {
    // One ptKey, held twice: it is what a request sends AND the durable secret a
    // re-validation carries (see the session's own doc comment).
    accessToken: identity.ptKey,
    refreshToken: identity.ptKey,
    expiresAt: Date.now() + JOYCODE_VALIDATION_TTL_MS,
    userId: identity.userId,
    ...name === undefined ? {} : { account: name },
    ...credential.colorBaseUrl === undefined ? {} : { colorBaseUrl: credential.colorBaseUrl },
    ...credential.masterBaseUrl === undefined ? {} : { masterBaseUrl: credential.masterBaseUrl },
    ...credential.tenant === undefined ? {} : { tenant: credential.tenant },
    ...credential.loginType === undefined ? {} : { loginType: credential.loginType },
    ...credential.orgFullName === undefined ? {} : { orgFullName: credential.orgFullName },
    ...credential.anthropicPtKey === undefined ? {} : { anthropicPtKey: credential.anthropicPtKey },
    ...clientVersion === undefined ? {} : { clientVersion },
  }
}

/** The credential fields one stored session carries (for the wire). */
export function joyCodeCredentialOf(session: JoyCodeSession): JoyCodeCredential {
  return {
    ptKey: session.accessToken,
    userId: session.userId,
    ...session.colorBaseUrl === undefined ? {} : { colorBaseUrl: session.colorBaseUrl },
    ...session.masterBaseUrl === undefined ? {} : { masterBaseUrl: session.masterBaseUrl },
    ...session.tenant === undefined ? {} : { tenant: session.tenant },
    ...session.loginType === undefined ? {} : { loginType: session.loginType },
    ...session.orgFullName === undefined ? {} : { orgFullName: session.orgFullName },
    ...session.anthropicPtKey === undefined ? {} : { anthropicPtKey: session.anthropicPtKey },
    ...session.clientVersion === undefined ? {} : { clientVersion: session.clientVersion },
  }
}

/**
 * Parse pasted login material into credential fields.
 *
 * Accepts, in this order of specificity:
 *   - the IDE's own JSON document (`{"joyCoderUser:{ptKey,userId,…}}`) — what a
 *     user gets by copying the value out of `state.vscdb`;
 *   - labelled lines (`ptKey: …` / `userId: …`, either or both on one line);
 *   - two bare tokens separated by whitespace or `:` — ptKey first, then the
 *     numeric user id, which is the order the IDE's own login page shows them.
 *
 * The user id is required: every request carries it in the envelope, and a
 * ptKey without one cannot be used. A bare ptKey is still accepted as a paste
 * when the ID surface (see `parseJoyCodePaste`) is not in play.
 * @param input - the raw pasted text.
 * @returns the credential fields it named.
 * @throws {LlmError} `MISSING_CREDENTIAL` when nothing usable was pasted.
 */
export function parseJoyCodePaste(input: string): JoyCodeCredential {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new LlmError(
      'JoyCode: paste the ptKey (and the numeric user id) from the JoyCode IDE, or import the locally signed-in IDE.',
      'MISSING_CREDENTIAL',
    )
  }
  if (trimmed.startsWith('{')) {
    const document = (() => {
      try {
        return JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        return undefined
      }
    })()
    const nested = document === undefined
      ? undefined
      : (typeof document.joyCoderUser === 'object' && document.joyCoderUser !== null
          ? document.joyCoderUser as Record<string, unknown>
          : document)
    const ptKey = firstString(nested?.ptKey, nested?.pt_key, nested?.key)
    const userId = firstString(nested?.userId, nested?.user_id, nested?.uid)
    if (ptKey !== undefined && userId !== undefined) {
      const colorBaseUrl = firstString(nested?.colorBaseUrl, nested?.color_base_url)
      const masterBaseUrl = firstString(nested?.masterBaseUrl, nested?.master_base_url)
      const tenant = firstString(nested?.tenant)
      const loginType = firstString(nested?.loginType, nested?.login_type)
      const orgFullName = firstString(nested?.orgFullName, nested?.org_full_name)
      return {
        ptKey,
        userId,
        ...colorBaseUrl === undefined ? {} : { colorBaseUrl },
        ...masterBaseUrl === undefined ? {} : { masterBaseUrl },
        ...tenant === undefined ? {} : { tenant },
        ...loginType === undefined ? {} : { loginType },
        ...orgFullName === undefined ? {} : { orgFullName },
      }
    }
  }
  const labelled = /(?:pt[_-]?key)\s*[:=]\s*([^\s,;]+)/i.exec(trimmed)
  const labelledId = /(?:user[_-]?id|uid)\s*[:=]\s*([^\s,;]+)/i.exec(trimmed)
  if (labelled?.[1] !== undefined && labelledId?.[1] !== undefined) {
    return { ptKey: labelled[1], userId: labelledId[1] }
  }
  const pair = /^(\S+)[\s:]+(\S+)$/.exec(trimmed)
  if (pair?.[1] !== undefined && pair[2] !== undefined) {
    // ptKey first, then the user id — the order the IDE shows them in. A pair
    // whose second token is not numeric is still taken at face value: the
    // upstream is the authority on whether the id is usable, and refusing to
    // parse it here would hide the real answer.
    return { ptKey: pair[1], userId: pair[2] }
  }
  throw new LlmError(
    'JoyCode: paste the ptKey TOGETHER with the numeric user id (e.g. "ptkey: <key> userid: <id>"), '
    + 'or import the credential from a locally signed-in JoyCode IDE.',
    'MISSING_CREDENTIAL',
  )
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
export async function joyCodeSessionFromPaste(
  input: string,
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
): Promise<JoyCodeSession> {
  const credential = parseJoyCodePaste(input)
  const identity = await validateJoyCodeCredential(credential, fetchFn ?? fetch, signal)
  // The pasted copy came from somewhere without the local IDE, so there is no
  // installed version to claim: the protocol constant stands.
  return joyCodeSessionOf(credential, identity)
}

/** Outcome of reading the local IDE credential. */
export interface JoyCodeImportResult {
  session?: JoyCodeSession
  /** Path the credential was read from, when one was found. */
  path?: string
  /**
   * Every path that was probed, whether or not it existed. Reported so a
   * "nothing found" answer says WHERE this machine looked instead of leaving the
   * user to guess.
   */
  probed: string[]
}

/**
 * Import the credential a locally signed-in JoyCode IDE stored.
 *
 * With no `path` the platform's own candidates are probed in order (the env
 * override, the container mount, then the per-OS app-data location). A database
 * that exists but holds no JoyCode login is reported as an empty result rather
 * than an error: "the IDE is not signed in" is a normal state, and the UI tells
 * the user to sign in there or paste a ptKey instead.
 * @param options - optional explicit path, fetcher, cancellation and clock.
 * @returns the session when one was imported, plus what was probed.
 * @throws {LlmError} `SERVER` when a database exists but cannot be read.
 */
export async function importJoyCodeIde(options: {
  path?: string
  fetchFn?: typeof fetch
  signal?: AbortSignal
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
} = {}): Promise<JoyCodeImportResult> {
  const probed = options.path !== undefined ? [options.path] : joyCodeStateDbCandidates(options.platform, options.home, options.env)
  let stored: JoyCodeStoredCredential | undefined
  let foundPath: string | undefined
  for (const path of probed) {
    const read = await readJoyCodeStateDb(path)
    if (read !== undefined) {
      stored = read
      foundPath = path
      break
    }
  }
  if (stored === undefined) return { probed }
  const clientVersion = await joyCodeExtensionVersion(options.platform, options.home, options.env)
  const identity = await validateJoyCodeCredential(stored, options.fetchFn ?? fetch, options.signal)
  return {
    session: joyCodeSessionOf(stored, identity, clientVersion, stored.account),
    path: foundPath ?? '',
    probed,
  }
}

/**
 * Re-validate a stored session: the shared token manager's "refresh".
 *
 * There is no grant to exchange here, so a refresh means calling `userInfo` with
 * the ptKey already held. That re-validates it, extends the window, and picks up
 * a ROTATED key when the upstream hands one back — which is what keeps a session
 * alive without the user touching it, exactly as the reference's hourly pass does.
 * @param session - the stored session.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @returns the session to store.
 * @throws {LlmError} `AUTH` when the credential is refused (permanent: only a
 *   fresh sign-in in the IDE can replace it).
 */
export async function refreshJoyCodeSession(
  session: JoyCodeSession,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<JoyCodeSession> {
  const identity = await validateJoyCodeCredential(joyCodeCredentialOf(session), fetchFn, signal)
  const account = identity.account ?? session.account
  return {
    ...session,
    accessToken: identity.ptKey,
    refreshToken: identity.ptKey,
    expiresAt: Date.now() + JOYCODE_VALIDATION_TTL_MS,
    userId: identity.userId,
    ...account === undefined ? {} : { account },
  }
}

/**
 * Whether a failed re-validation is terminal for this credential.
 *
 * A refusal (`AUTH`) means the ptKey is no longer honoured and nothing this
 * plugin can do will revive it — the user signs in again in the IDE (or pastes a
 * current key). A transport failure says nothing about the credential, so it is
 * retried.
 * @param error - the thrown value.
 * @returns true when a re-login is the only remedy.
 */
export function isJoyCodePermanentRefreshError(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'AUTH'
}

/**
 * The message shown when no local JoyCode credential could be read.
 *
 * It names every path that was probed, because the two reasons this happens —
 * "JoyCode is not installed here" and "it is installed but not signed in" — look
 * identical otherwise, and the fix differs.
 * @param probed - the paths this machine tried.
 * @returns the diagnostic line.
 */
export function joyCodeImportFailureMessage(probed: readonly string[]): string {
  return '未在本机找到已登录的 JoyCode 凭据。请先在 JoyCode 客户端登录，或改用“粘贴 ptKey”。'
    + `已检查：${probed.join('；')}`
}

/**
 * The error thrown when the import button finds nothing.
 * @param probed - the paths this machine tried.
 * @returns the error to throw.
 */
export function joyCodeNotSignedInError(probed: readonly string[]): LlmError {
  return new LlmError(
    'JoyCode: no signed-in local credential was found. Sign in inside the JoyCode IDE and import again, '
    + 'or paste the ptKey and user id directly. '
    + `Probed: ${probed.join('; ')}`,
    'MISSING_CREDENTIAL',
  )
}

/** First non-empty string among the given candidates. */
function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

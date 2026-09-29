/**
 * Freebuff CLI: read the credential the official CLI already stored, and run the
 * CLI's own browser login so a machine without it can get the same credential.
 *
 * ## Where the CLI keeps its login
 *
 * The CLI's own launcher resolves its config directory as
 * `configDirOverride || path.join(os.homedir(), '.config', 'manicode')`
 * (`%APPDATA%\npm\node_modules\freebuff\launcher.js:293-296`). That is the
 * `.config` convention on EVERY platform, Windows included — the launcher does
 * not consult `%APPDATA%` for it, so `C:\Users\<name>\.config\manicode` is where
 * a Windows install's login lives, and a check for a Windows-style path would
 * look in the wrong place. The credential file itself is `credentials.json`
 * beside the binary (`launcher.js:305` for the sibling metadata path, and the
 * CLI's own `_t() = join(R0(), "credentials.json")`).
 *
 * Its schema is the CLI's zod object, verbatim: a `default` entry plus any other
 * profiles, each `{id?, name?, email, authToken, fingerprintId?, fingerprintHash?,
 * credits?}` (`o8A`/`oO$`, with `oO$ = object({default: …}).catchall(unknown)`).
 * The entry imported is `default`, and when the file holds more than one the
 * caller is told so ({@link parseFreebuffCliCredentials}).
 *
 * ## The login is a POLLING flow, not a callback one
 *
 * `freebuff login` does not run an OAuth authorization-code flow with a local
 * redirect. From the shipped binary (`oAH`, `aAH`, the auth client, and the
 * `plain_command` path that prints it):
 *
 *   1. `POST {freebuff.com}/api/auth/cli/code` with `{fingerprintId}` →
 *      `{loginUrl, fingerprintHash, expiresAt}`;
 *   2. the CLI prints "Open this URL in your browser to log in:" and the URL
 *      (the modal path opens it with the system browser);
 *   3. it POLLS `GET {freebuff.com}/api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=…`
 *      every 5 s (timeout 300 s) until the answer's `user` is an object, which is
 *      the credential.
 *
 * So there is no port to bind and no certificate to impersonate: the flow is
 * replicable by any process that can make two HTTPS requests.
 *
 * The one local secret is the `fingerprintId`, and it is generated CLIENT-side:
 * the CLI's enhanced branch hashes machine facts (`n9L`: system/cpu/os/runtime/
 * network/machineId → `"enhanced-" + base64url(sha256(JSON))`) and its fallback
 * is `codebuff-cli-<8 base64url chars>` (`t9L`). The server does not pin the
 * algorithm — the CLI itself ships two — so {@link freebuffCliFingerprintId}
 * generates the fallback's shape, and a machine that wants the enhanced one can
 * import the credential the CLI already made instead.
 *
 * @module dsh-subscription-hub/providers/freebuff-cli
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../http.js'
import type { FreebuffSession } from '../auth/store.js'
import type { FreebuffCliProbe } from './freebuff/client.js'
import {
  freebuffCliCodeUrl,
  freebuffCliStatusUrl,
  freebuffInstanceId,
} from './freebuff/client.js'
import { freebuffSessionFromBearer } from './freebuff-session.js'

/**
 * The config directory the CLI uses, relative to the home directory:
 * `path.join(os.homedir(), '.config', 'manicode')` (`launcher.js:296`).
 */
export const FREEBUFF_CLI_CONFIG_PARTS: readonly string[] = ['.config', 'manicode']

/** The credential file inside that directory (`_t()` in the CLI). */
export const FREEBUFF_CLI_CREDENTIALS_FILE = 'credentials.json'

/** How often the login poll asks (the CLI's own `intervalMs = 5000`). */
export const FREEBUFF_CLI_LOGIN_POLL_MS = 5_000

/** How long the login poll keeps asking (the CLI's own `timeoutMs = 300000`). */
export const FREEBUFF_CLI_LOGIN_TIMEOUT_MS = 300_000

/** Bound on one credential/validation request. */
const CLI_REQUEST_TIMEOUT_MS = 15_000

/**
 * Every path the CLI's credential may be at, in probe order.
 *
 * `MANICODE_CONFIG_DIR` comes first because it is the documented escape hatch a
 * user can set for a non-default install; the platform-native location the
 * launcher computes comes next. Both are real candidates to REPORT when neither
 * exists — the point of returning a list rather than one string is that the
 * failure message can name exactly what was looked for.
 * @param home - the home directory to resolve against (injectable for tests).
 * @param env - the environment to read (injectable for tests).
 * @returns absolute candidate paths.
 */
export function freebuffCliCredentialPaths(
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const paths: string[] = []
  const override = env.MANICODE_CONFIG_DIR?.trim()
  if (override !== undefined && override !== '') paths.push(join(override, FREEBUFF_CLI_CREDENTIALS_FILE))
  paths.push(join(home, ...FREEBUFF_CLI_CONFIG_PARTS, FREEBUFF_CLI_CREDENTIALS_FILE))
  return [...new Set(paths)]
}

/** One credential entry, in the CLI's own schema (`o8A`). */
export interface FreebuffCliCredential {
  /** The account id, when the file carries one. */
  id?: string
  /** Display name, when the file carries one. */
  name?: string
  /** The account's email — the identity this route keys on. */
  email: string
  /** The Bearer this route authenticates with. */
  authToken: string
  /** The CLI's login fingerprint, kept for the account row. */
  fingerprintId?: string
  /** The CLI's login fingerprint hash. */
  fingerprintHash?: string
  /** Credited Freebucks, when the file carries them. */
  credits?: number
}

/** What a credential file yielded. */
export interface FreebuffCliParse {
  /** The `default` entry. */
  entry: FreebuffCliCredential
  /** Every profile name in the file, so the caller can say what it picked from. */
  profiles: string[]
}

/**
 * Parse a CLI credential file and pick the `default` entry.
 *
 * A missing `default` is not a parse failure — the file may hold only named
 * profiles — so it is reported as no-entry rather than as a malformed file, and
 * the caller's message lists the profiles it did find.
 * @param text - the file's contents.
 * @returns the picked entry and the profile names, or undefined when there is no
 *   usable `default` entry.
 */
export function parseFreebuffCliCredentials(text: string): FreebuffCliParse | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const profiles = Object.keys(record)
  const entry = record.default
  if (typeof entry !== 'object' || entry === null) return undefined
  const fields = entry as Record<string, unknown>
  const authToken = nonEmptyString(fields.authToken)
  const email = nonEmptyString(fields.email)
  const id = nonEmptyString(fields.id)
  const name = nonEmptyString(fields.name)
  const fingerprintId = nonEmptyString(fields.fingerprintId)
  const fingerprintHash = nonEmptyString(fields.fingerprintHash)
  const credits = typeof fields.credits === 'number' && Number.isFinite(fields.credits) ? fields.credits : undefined
  // Both authToken and email are required by the CLI's own schema; a file missing
  // either is not a credential this route can use, and saying so beats a
  // half-filled session.
  if (authToken === undefined || email === undefined) return undefined
  return {
    entry: {
      email,
      authToken,
      ...id === undefined ? {} : { id },
      ...name === undefined ? {} : { name },
      ...fingerprintId === undefined ? {} : { fingerprintId },
      ...fingerprintHash === undefined ? {} : { fingerprintHash },
      ...credits === undefined ? {} : { credits },
    },
    profiles,
  }
}

/**
 * What to tell the user when no CLI credential could be imported.
 *
 * It names every probed path — the whole point of probing a list — and the two
 * ways to get a credential this route accepts, so the reader does not have to
 * guess where the plugin looked.
 * @param probed - the paths that were checked, in order.
 * @param detail - what was wrong with the files that existed, when anything did.
 * @returns the message for the card.
 */
export function freebuffCliFailureMessage(probed: readonly string[], detail?: string): string {
  const where = probed.length === 0 ? '(no candidate path)' : probed.join(', ')
  return 'Freebuff: no CLI login found. Looked for the official CLI\'s credential at '
    + `${where}${detail === undefined ? '' : ` — ${detail}`}. `
    + 'Run `freebuff` and log in, then import again; or use 「Sign in」 for the CLI\'s browser login, '
    + 'or 「Manual input」 to paste an `authorization: Bearer …` value.'
}

/**
 * Import the official CLI's login as a session.
 *
 * Reads the first candidate path that yields a usable `default` entry, then
 * VALIDATES the token against the desktop session endpoint before storing
 * anything — the same call the balance read uses, so a credential that the
 * upstream will not honour fails here with the upstream's own answer rather than
 * at the first chat request.
 *
 * Every other profile in the file is left alone: `default` is the CLI's own
 * active login, and importing a second profile is a deliberate choice the card
 * does not offer yet.
 * @param fetchFn - injectable fetcher for tests.
 * @param signal - optional cancellation.
 * @param options - `homeDir`/`env` override discovery (tests), `onWarn` for advisories.
 * @returns the session to persist.
 * @throws {LlmError} `MISSING_CREDENTIAL` when nothing was found, `AUTH` when the
 *   upstream refuses the token, `TRANSPORT`/`SERVER` when nothing answered.
 */
export async function importFreebuffCliCredential(
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
  options: {
    homeDir?: string
    env?: Record<string, string | undefined>
    onWarn?: (message: string) => void
  } = {},
): Promise<FreebuffSession> {
  const probed = freebuffCliCredentialPaths(options.homeDir, options.env)
  let malformed: string | undefined
  for (const path of probed) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code
      // A missing file is the ordinary "CLI not installed / not logged in" case.
      // Anything else (permissions, a directory) is worth naming, because the
      // user's remedy is different from "run freebuff and log in".
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        malformed = `${path} could not be read (${code ?? 'unknown error'})`
      }
      continue
    }
    const parsed = parseFreebuffCliCredentials(text)
    if (parsed === undefined) {
      malformed = malformed ?? `${path} has no usable \`default\` entry (or is not JSON)`
      continue
    }
    if (parsed.profiles.length > 1) {
      options.onWarn?.(
        `freebuff: ${path} holds ${String(parsed.profiles.length)} profiles `
        + `(${parsed.profiles.join(', ')}); imported \`default\` only`,
      )
    }
    const session = await freebuffSessionFromBearer(parsed.entry.authToken, fetchFn, signal, {
      account: parsed.entry.email,
    })
    return session
  }
  throw new LlmError(freebuffCliFailureMessage(probed, malformed), 'MISSING_CREDENTIAL')
}

/**
 * A fresh login fingerprint, in the CLI's own fallback shape.
 *
 * `t9L() = "codebuff-cli-" + randomBytes(6).toString("base64url").substring(0, 8)`
 * — ported exactly, randomness included, because the value's only job is to be a
 * stable, distinct handle for one login attempt. The enhanced branch (`n9L`) is
 * NOT reproduced: it hashes MAC addresses and machine ids, which is a device
 * fingerprint a plugin should not fabricate, and the CLI itself treats the
 * fallback as a valid login (`o9L` falls back to it).
 * @param random - injectable randomness for tests.
 * @returns the fingerprint id to send.
 */
export function freebuffCliFingerprintId(random: () => Buffer = () => randomBytes(6)): string {
  return `codebuff-cli-${random().toString('base64url').slice(0, 8)}`
}

/** A running browser-login attempt. */
export interface FreebuffCliLogin {
  /** The URL to open in a browser. */
  authorizeUrl: string
  /** The fingerprint/hash/expiry this attempt polls with. */
  probe: FreebuffCliProbe
  /** Resolves with the session once the browser has signed in. */
  session: Promise<FreebuffSession>
  /** Stop polling and reject the pending login (user cancelled). */
  close(): void
}

/**
 * Start the CLI's browser login and poll for its credential.
 *
 * The two calls and the cadence are the CLI's own (`oAH` then `aAH`: 5 s
 * interval, 300 s timeout, success when `data.user` is an object). The returned
 * session is validated like an import, so a login that yields a token the
 * upstream refuses does not get stored.
 * @param options - fetch, cancellation, discovery/validation overrides.
 * @returns the attempt handle.
 * @throws {LlmError} `SERVER` when the code request is refused or answers nothing
 *   usable, `TRANSPORT` when it cannot be reached.
 */
export async function startFreebuffCliLogin(options: {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  pollMs?: number
  timeoutMs?: number
  fingerprintId?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
} = {}): Promise<FreebuffCliLogin> {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const fingerprintId = options.fingerprintId ?? freebuffCliFingerprintId()
  const timeoutMs = options.timeoutMs ?? FREEBUFF_CLI_LOGIN_TIMEOUT_MS
  const pollMs = options.pollMs ?? FREEBUFF_CLI_LOGIN_POLL_MS
  const now = options.now ?? ((): number => Date.now())
  const sleep = options.sleep ?? ((ms: number): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, ms) }))

  let cancelled = false
  let wake: (() => void) | undefined
  const controller = new AbortController()
  const onAbort = (): void => { close() }
  const close = (): void => {
    cancelled = true
    controller.abort()
    wake?.()
  }
  if (options.signal?.aborted === true) throw new Error('login cancelled')
  options.signal?.addEventListener('abort', onAbort, { once: true })

  const probe = await freebuffCliLoginCode(fetchFn, fingerprintId, controller.signal)
  const session = (async (): Promise<FreebuffSession> => {
    const started = now()
    for (;;) {
      if (cancelled) throw new Error('login cancelled')
      if (now() - started >= timeoutMs) {
        throw new LlmError(
          `Freebuff: the CLI login was not completed within ${String(Math.round(timeoutMs / 1000))} s. `
          + 'Open the login URL again to restart it.',
          'AUTH',
        )
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        const timer = setTimeout(resolve, pollMs)
        void timer
      })
      if (cancelled) throw new Error('login cancelled')
      const user = await freebuffCliLoginStatus(fetchFn, fingerprintId, probe, controller.signal)
      if (user === undefined) continue
      if (user.authToken === undefined) {
        throw new LlmError(
          'Freebuff: the login status answer carried a user but no authToken; '
          + 'the login page may have finished without issuing a CLI credential.',
          'MALFORMED_RESPONSE',
        )
      }
      return await freebuffSessionFromBearer(user.authToken, fetchFn, controller.signal, {
        ...user.email === undefined ? {} : { account: user.email },
      })
    }
  })()
  // A rejected promise nobody awaits yet would crash the process.
  session.catch(() => {})

  return {
    authorizeUrl: probe.loginUrl,
    probe,
    session,
    close,
  }
}

/**
 * Ask for one login URL (`loginCode`).
 * @param fetchFn - the fetcher.
 * @param fingerprintId - this attempt's fingerprint.
 * @param signal - cancellation.
 * @returns what the upstream answered.
 * @throws {LlmError} `SERVER` on a refusal, `TRANSPORT` when unreachable,
 *   `MALFORMED_RESPONSE` when the answer carried no usable URL.
 */
async function freebuffCliLoginCode(
  fetchFn: typeof fetch,
  fingerprintId: string,
  signal: AbortSignal,
): Promise<FreebuffCliProbe> {
  const url = freebuffCliCodeUrl()
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprintId }),
      signal: withTimeout(signal),
    })
  } catch (error) {
    throw new LlmError(`Freebuff: could not reach ${url} to start the CLI login.`, 'TRANSPORT', { cause: error })
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new LlmError(
      `Freebuff: the CLI login URL request failed (HTTP ${String(response.status)})`
      + `${text.trim() === '' ? '' : `: ${text.slice(0, 200)}`}`,
      'SERVER',
      { status: response.status },
    )
  }
  const payload = parseJson(text)
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const loginUrl = nonEmptyString(record.loginUrl)
  const fingerprintHash = nonEmptyString(record.fingerprintHash)
  const expiresAt = nonEmptyString(record.expiresAt)
  if (loginUrl === undefined || fingerprintHash === undefined) {
    throw new LlmError(
      `Freebuff: the CLI login answer carried no loginUrl/fingerprintHash: ${text.slice(0, 200)}`,
      'MALFORMED_RESPONSE',
    )
  }
  return {
    loginUrl,
    fingerprintId,
    fingerprintHash,
    ...expiresAt === undefined ? {} : { expiresAt },
  }
}

/** What one status poll yielded. */
interface FreebuffCliUser {
  authToken?: string
  email?: string
}

/**
 * One poll of the login status (`loginStatus`).
 *
 * The CLI treats a non-401 refusal as "keep polling" (`aAH` logs it and sleeps),
 * and only an answer with a `user` OBJECT counts as success — a 200 with `{}` is
 * still "not yet", which is why the body's shape decides and not the status.
 * @param fetchFn - the fetcher.
 * @param fingerprintId - this attempt's fingerprint.
 * @param probe - the hash/expiry the code call issued.
 * @param signal - cancellation.
 * @returns the user, or undefined while the browser has not finished.
 */
async function freebuffCliLoginStatus(
  fetchFn: typeof fetch,
  fingerprintId: string,
  probe: FreebuffCliProbe,
  signal: AbortSignal,
): Promise<FreebuffCliUser | undefined> {
  let response: Response
  try {
    response = await fetchFn(freebuffCliStatusUrl(probe), { method: 'GET', signal: withTimeout(signal) })
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  }
  if (!response.ok) return undefined
  const payload = parseJson(await response.text().catch(() => ''))
  if (typeof payload !== 'object' || payload === null) return undefined
  const user = (payload as Record<string, unknown>).user
  if (typeof user !== 'object' || user === null) return undefined
  const fields = user as Record<string, unknown>
  const authToken = nonEmptyString(fields.authToken)
  const email = nonEmptyString(fields.email)
  return {
    ...authToken === undefined ? {} : { authToken },
    ...email === undefined ? {} : { email },
  }
  // `fingerprintId` is deliberately unused: the attempt already knows its own, so
  // reading it back would only create a second source of truth.
}

/** The instance id a credential will speak for (re-exported for diagnostics). */
export function freebuffCliInstanceId(accessToken: string): string {
  return freebuffInstanceId(accessToken)
}

/** Combine a caller's cancellation with this module's own request bound. */
function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(CLI_REQUEST_TIMEOUT_MS)])
}

/** Parse JSON without throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

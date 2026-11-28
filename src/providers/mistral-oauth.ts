/**
 * Zero-dependency sign-in for Mistral, reverse-engineered from the vendor CLI.
 *
 * Captured through a local interception proxy (drive `vibe --setup` → Launch
 * browser → Mistral AI) with the request and response recorded verbatim:
 *
 *   POST https://console.mistral.ai/api/vibe/sign-in
 *        content-type: application/json
 *        {"code_challenge":"<S256 base64url>","code_challenge_method":"S256"}
 *   200  {"process_id":"…","sign_in_url":"https://console.mistral.ai/codestral/cli/authenticate?process_id=…&complete_token=…",
 *         "poll_url":"https://console.mistral.ai/api/vibe/sign-in/poll/<handle>","expires_at":"…"}
 *
 *   GET  <poll_url>  → 200 {"status":"pending"}      (20 bytes, ~1/s)
 *
 * So the flow is standard PKCE: this route owns the verifier, the browser owns the
 * approval, and the poll hands back whatever the page provisioned. Two details cost
 * a round of probing and are worth recording: the payload fields are at the TOP
 * level (nesting them under `payload` answers 422 with those two fields "missing"),
 * and the poll body is a status object, not the credential on the first call.
 *
 * Completion is unknown until somebody completes a real sign-in, so the terminal
 * body is read defensively: a key-shaped field is adopted as-is, a `code` is
 * reported (its exchange needs a `code_verifier` the CLI keeps private), and the
 * field names — never the values — are written to a diagnostic so the mapping can
 * be finished from evidence rather than guessed.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { FetchFn } from '../providers/common.js'

/** Sign-in origin (the console, not the inference API). */
export const MISTRAL_CONSOLE_BASE = 'https://console.mistral.ai'
/** Where a sign-in starts. */
export const MISTRAL_SIGN_IN_PATH = '/api/vibe/sign-in'

/** A PKCE pair: the browser sees the challenge, this route keeps the verifier. */
export interface PkcePair {
  verifier: string
  challenge: string
}

/**
 * Create a PKCE verifier and its S256 challenge.
 *
 * RFC 7636: 43–128 characters from the unreserved set; the challenge is the
 * base64url of the SHA-256 digest without padding.
 *
 * @returns the pair.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** A sign-in that has been started and is waiting for the browser. */
export interface StartedSignIn {
  processId: string
  signInUrl: string
  pollUrl: string
  expiresAt: number
  /** Kept for a `code` exchange; never sent to the browser. */
  verifier: string
  /**
   * The `csrftoken` cookie the console set when the sign-in started.
   *
   * The console is CSRF-protected: a later call without it answers
   * `401 {"detail":null}` even when its own token is valid. The vendor CLI keeps a
   * cookie jar for this; this route carries the value forward by hand.
   */
  csrf?: string
}

/**
 * Read the start response.
 *
 * @param payload - parsed body.
 * @param verifier - the verifier that produced the challenge.
 * @returns the started sign-in.
 * @throws {Error} when a required field is missing.
 */
export function parseStartedSignIn(payload: unknown, verifier: string): StartedSignIn {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const processId = typeof body.process_id === 'string' ? body.process_id : ''
  const signInUrl = typeof body.sign_in_url === 'string' ? body.sign_in_url : ''
  const pollUrl = typeof body.poll_url === 'string' ? body.poll_url : ''
  if (processId === '' || signInUrl === '' || pollUrl === '') {
    throw new Error('mistral: the sign-in endpoint did not return a process id, a URL and a poll URL')
  }
  const expires = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
  return {
    processId,
    signInUrl,
    pollUrl,
    expiresAt: Number.isFinite(expires) ? expires : Date.now() + 10 * 60_000,
    verifier,
  }
}

/**
 * Ask Mistral to start a browser sign-in.
 *
 * @param fetchFn - fetch to use.
 * @param options - cancellation.
 * @returns the started sign-in, with the URL the user must open.
 */
export async function startMistralSignIn(
  fetchFn: FetchFn,
  options: { signal?: AbortSignal } = {},
): Promise<StartedSignIn> {
  const pkce = createPkcePair()
  const response = await fetchFn(`${MISTRAL_CONSOLE_BASE}${MISTRAL_SIGN_IN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: '*/*', ...attributionHeaders() },
    body: JSON.stringify({ code_challenge: pkce.challenge, code_challenge_method: 'S256' }),
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  if (!response.ok) {
    throw new Error(`mistral: sign-in start failed (HTTP ${response.status})`)
  }
  const started = parseStartedSignIn(await response.json(), pkce.verifier)
  // Keep the cookie the console just set: the exchange needs it, and this route has
  // no cookie jar.
  const cookieHeader = response.headers.get('set-cookie') ?? ''
  const csrf = /csrftoken=([^;]+)/.exec(cookieHeader)?.[1]
  return csrf === undefined ? started : { ...started, csrf }
}

/** What one poll said. */
export type PollResult =
  | { kind: 'pending' }
  | { kind: 'ready'; key?: string; exchangeToken?: string; code?: string; fields: string[] }
  | { kind: 'failed'; reason: string }

/**
 * Classify a poll body.
 *
 * `{"status":"pending"}` is the measured shape while the browser is still open. A
 * terminal answer is whatever the page provisioned: the first key-shaped string is
 * adopted as the credential; otherwise a `code` is reported, because exchanging it
 * needs the CLI's own client registration.
 *
 * @param payload - parsed body.
 * @returns the classification.
 */
export function classifyPollPayload(payload: unknown): PollResult {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const fields = Object.keys(body)
  const status = typeof body.status === 'string' ? body.status.toLowerCase() : ''
  if (status === 'pending' || status === 'waiting' || status === '') {
    // An empty body keeps the caller polling rather than declaring failure.
    if (status === '') return { kind: 'pending' }
    return { kind: 'pending' }
  }
  if (status === 'failed' || status === 'error' || status === 'expired' || status === 'denied') {
    const reason = typeof body.error === 'string' ? body.error : status
    return { kind: 'failed', reason }
  }
  // The response struct the CLI itself uses lists `api_key` and `exchange_token`
  // side by side, so both are matched BY NAME. A 32-character opaque token merely
  // LOOKING like a key is how an `exchange_token` was once stored as one, which left
  // an account listed with no models: the inference API answers 401 to it.
  const directKey = [body.api_key, body.apiKey].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  if (directKey !== undefined) return { kind: 'ready', key: directKey, fields }
  const exchangeEntry = Object.entries(body).find(([name, value]) => (
    /^(exchange_token|exchangeToken)$/.test(name) && typeof value === 'string' && value !== ''
  ))
  if (exchangeEntry !== undefined) return { kind: 'ready', exchangeToken: exchangeEntry[1] as string, fields }
  const codeEntry = Object.entries(body).find(([name, value]) => /^code$/i.test(name) && typeof value === 'string' && value !== '')
  if (codeEntry !== undefined) return { kind: 'ready', code: codeEntry[1] as string, fields }
  return { kind: 'failed', reason: `unrecognised completion (fields: ${fields.join(', ') || 'none'})` }
}

/**
 * Where the sign-in diagnostic is written (field names only, never values).
 * @returns the path.
 */
export function mistralSignInDiagnosticPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'mistral-signin-diagnostic.json')
}

/**
 * Record what a terminal poll looked like, so an unmapped completion can be
 * finished from evidence.
 *
 * @param info - what to record: field names, status and whether a value looked like a key.
 */
export async function writeSignInDiagnostic(info: {
  fields: string[]
  status?: string
  adopted: 'key' | 'code' | 'none'
}): Promise<void> {
  const path = mistralSignInDiagnosticPath()
  try {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify({ at: new Date().toISOString(), ...info }, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  } catch {
    // A diagnostic that cannot be written must never fail a sign-in.
  }
}

/**
 * Poll until the browser approves, the attempt expires, or the caller cancels.
 *
 * @param fetchFn - fetch to use.
 * @param started - the sign-in returned by {@link startMistralSignIn}.
 * @param options - pacing and cancellation.
 * @returns the classification that ended the loop.
 */
export async function pollMistralSignIn(
  fetchFn: FetchFn,
  started: StartedSignIn,
  options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PollResult> {
  const intervalMs = options.intervalMs ?? 1_500
  const timeoutMs = options.timeoutMs ?? Math.max(started.expiresAt - Date.now(), 60_000)
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let response: Response
    try {
      response = await fetchFn(started.pollUrl, {
        headers: { accept: '*/*', ...attributionHeaders() },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      await sleep(intervalMs)
      continue
    }
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) return { kind: 'failed', reason: `poll answered ${response.status}` }
      await sleep(intervalMs)
      continue
    }
    const result = classifyPollPayload(await response.json().catch(() => ({})))
    if (result.kind !== 'pending') return result
    await sleep(intervalMs)
  }
  return { kind: 'failed', reason: 'timed out waiting for the browser' }
}

/** Where an approved sign-in is exchanged for the account's API key. */
export const MISTRAL_EXCHANGE_PATH = '/api/vibe/sign-in/exchange'

/**
 * Exchange the poll's `exchange_token` for the account's API key.
 *
 * The CLI's own response struct lists `api_key` and `exchange_token` side by side,
 * so a poll can end either way. Measured on the real endpoint: a request WITHOUT a
 * token body answers `401 {"detail":null}`, while one carrying `exchange_token` is
 * accepted far enough to be rate limited (`429`), which places the token in the body.
 *
 * @param fetchFn - fetch to use.
 * @param exchangeToken - the token the poll returned.
 * @param options - cancellation.
 * @returns the API key.
 */
export async function exchangeMistralSignIn(
  fetchFn: FetchFn,
  exchangeToken: string,
  options: { signal?: AbortSignal; csrf?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...attributionHeaders(),
  }
  // The console is CSRF-protected: its start answer sets `csrftoken`, and a later
  // call without it answers `401 {"detail":null}`. The vendor CLI keeps a cookie
  // jar; this route carries the value forward by hand.
  if (options.csrf !== undefined) {
    headers.cookie = `csrftoken=${options.csrf}`
    headers['x-csrftoken'] = options.csrf
  }
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  // A 429 here is the console's RATE LIMIT, not a bad token: the same request with
  // the token in the body answers 429 while one without it answers 401, so the shape
  // is right and waiting is the correct reaction. The exchange token lives ten
  // minutes, which this backoff stays well inside.
  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(`${MISTRAL_CONSOLE_BASE}${MISTRAL_EXCHANGE_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ exchange_token: exchangeToken }),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (response.status === 429 && attempt < 3) {
      await sleep(2_000 * (attempt + 1))
      continue
    }
    if (!response.ok) throw new Error(`mistral: exchanging the sign-in failed (HTTP ${response.status})`)
    const payload: unknown = await response.json().catch(() => ({}))
    const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    const key = [body.api_key, body.apiKey, body.key].find((value): value is string => typeof value === 'string' && value !== '')
    if (key === undefined) throw new Error('mistral: the exchange answered without an API key')
    return key
  }
}

/**
 * Check a credential against the inference API before storing it.
 *
 * A token that is not an API key answers `401 {"detail":"Invalid API Key"}` here —
 * the exact state that left an account listed with no models in the picker.
 *
 * @param fetchFn - fetch to use.
 * @param key - the candidate credential.
 * @returns whether `/v1/models` accepted it.
 */
export async function verifyMistralKey(fetchFn: FetchFn, key: string): Promise<boolean> {
  try {
    const response = await fetchFn('https://api.mistral.ai/v1/models', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...attributionHeaders() },
    })
    return response.ok
  } catch {
    return false
  }
}
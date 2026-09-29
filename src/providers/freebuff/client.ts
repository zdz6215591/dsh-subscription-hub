/**
 * Freebuff (codebuff.com) wire surface: credentials, URLs, headers, the
 * desktop request/run bootstrap, error classification.
 *
 * ## ONE wire, ONE credential shape
 *
 * This route speaks the DESKTOP protocol only: `POST
 * {www.codebuff.com}/api/v1/chat/completions` with `authorization: Bearer
 * <token>` and an OpenAI-chat body (`ref-freebuff2api/src/upstream.rs:127-136`,
 * `:281-315`). Its SSE is already OpenAI chat-completions format
 * (`src/protocol/openai_sse.rs:1-9`), so the hub's own `streamChatCompletions`
 * translator reads it directly.
 *
 * The other upstream Freebuff has — `POST https://freebuff.com/api/chat/stream`,
 * addressed by a browser session COOKIE — is NOT implemented here and its
 * code is gone. It takes one flat prompt string with no `tools` field
 * (`ref-freebuff2api/src/web_protocol.rs:380-388`), so it can never carry the
 * harness's tools: live-verified 2026-09-28, a `tools` array bolted onto that
 * body is ignored and the model reports only Freebuff's own server-side agents
 * as its tool set. Offering it would be offering a chat that silently loses
 * every local capability, so a cookie credential is REFUSED by name
 * ({@link freebuffCookieRefusal}) rather than accepted and degraded.
 *
 * ## The credential is the CLI's, and the run bootstrap is mandatory
 *
 * The authoritative client is the official Freebuff CLI, and this module's
 * request shapes are transcribed from its shipped binary
 * (`~/.config/manicode/freebuff.exe`, bun-compiled JS). Two things it does that
 * a plain OpenAI call to the same URL does not:
 *
 *  1. **A session admission, then an agent run, before any chat.**
 *     `POST /api/v1/freebuff/session/admission` (the CLI's own POST target —
 *     `pJA(H)`, `H==="POST"?pLA:"/api/v1/freebuff/session"`) admits the
 *     instance, and `POST /api/v1/agent-runs {action:"START", agentId,
 *     ancestorRunIds}` (`qDA`) yields the `runId` the chat body must carry.
 *     Without it the upstream answers `400 No runId found in request body`, and
 *     the run's AGENT is what free mode validates, so the agent must be the
 *     model-specific `base2-free-*` id ({@link freebuffAgentFor}).
 *  2. **A CLI-shaped identity.** Free mode accepts requests that look like the
 *     CLI's: the instance id is `cli:<uuid>` (`wr()`), and when it carries that
 *     prefix the metadata also declares `freebuff_multi_session:"1"` and
 *     `surface:"cli"` (`OJA(H)`, `QP`). The session call carries the CLI's
 *     header set (`CV`): `x-fb-timezone`, `x-freebuff-first-tab-discount`,
 *     `x-freebuff-multi-session`, `x-freebuff-purchase-continuity`,
 *     `x-freebuff-desktop-attempt-id` (POST/DELETE), `x-freebuff-instance-id`,
 *     `x-freebuff-heartbeat` + `x-freebuff-include-unused-rate-limits` (GET) and
 *     `x-freebuff-model` + `x-freebuff-wallet-spend-limit` (POST).
 *
 *     That instance id is an ATTEMPT, not an account identity: it is one session
 *     start, and the upstream retires it for good once the attempt is over — see
 *     `./claim.js` for the live bytes and the CLI's own lifecycle. It must
 *     therefore be minted per claim (never derived from the credential) and
 *     rotated when the upstream says the claim is gone
 *     ({@link freebuffAdmissionVerdict}).
 *
 * Live 2026-09-28, a free account behind a REAL CLI credential still answers
 * `403 free_mode_cli_required` ("Calling the API directly is not supported and
 * may get your account banned") to this route's chat call, so free mode remains
 * gated to the CLI's own channel — see `src/providers/freebuff.ts` for the
 * recorded bytes. The shapes above are what the gate is checked against, and
 * the quota read does work with this credential ({@link FREEBUFF_SESSION_PATH}).
 *
 * ## Errors are TEXT first, status second
 *
 * codebuff answers refusals inside an HTTP 200 body — as a bare text code
 * (`free_mode_invalid_agent_model`, `waiting_room_queued`) or as an
 * `{"error":{...}}` envelope — so classifying on the status alone misses them
 * (`ref-freebuff2api/src/errors.rs:1-10`). {@link freebuffTextError} implements
 * that rule table, and {@link freebuffBodyRefusal} is how a refusal that arrived
 * in a 200 gets thrown with the upstream's OWN words instead of becoming an
 * empty stream.
 *
 * @module dsh-subscription-hub/providers/freebuff/client
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { httpLlmError } from '../common.js'
import type { RateLimitResetReader } from '../rate-limit.js'
import { freebuffEffortFor } from './catalog.js'

/** The desktop/Bearer origin. `codebuff.com` normalizes to `www.codebuff.com` (`src/upstream.rs:113-118`). */
export const FREEBUFF_API_BASE = 'https://www.codebuff.com'
/**
 * The login/identity origin (`NEXT_PUBLIC_FREEBUFF_APP_URL`, default
 * `https://freebuff.com`). The CLI's WebSocket-free auth API lives HERE, not on
 * the chat host: in free mode `A6 = fZ` (the freebuff app URL), while every
 * session/run/chat call uses `w9() = NEXT_PUBLIC_CODEBUFF_APP_URL`.
 */
export const FREEBUFF_LOGIN_BASE = 'https://freebuff.com'

/** Desktop chat completions (`src/upstream.rs:306`). */
export const FREEBUFF_CHAT_PATH = '/api/v1/chat/completions'
/**
 * The desktop session endpoint for READ/DELETE — `GET` answers the balance,
 * `DELETE` ends the session (`src/upstream.rs:4-6`, CLI `pJA`).
 */
export const FREEBUFF_SESSION_PATH = '/api/v1/freebuff/session'
/**
 * The session ADMISSION endpoint: what the CLI POSTs to open an hour
 * (`pLA = "/api/v1/freebuff/session/admission"`). The legacy
 * `POST /api/v1/freebuff/session` still answers the reference gateway, but the
 * CLI — the client free mode is written for — uses this one.
 */
export const FREEBUFF_SESSION_ADMISSION_PATH = '/api/v1/freebuff/session/admission'
/**
 * The desktop agent-run bootstrap (`src/upstream.rs:218-250`; CLI `qDA`). Its
 * `runId` is what the chat body's `codebuff_metadata.run_id` must carry, and the
 * agent the run is started for is what free mode validates against the model.
 */
export const FREEBUFF_AGENT_RUNS_PATH = '/api/v1/agent-runs'
/** `loginCode` — a login URL for one fingerprint (CLI auth client). */
export const FREEBUFF_CLI_CODE_PATH = '/api/auth/cli/code'
/** `loginStatus` — the poll that hands back the credential (CLI auth client). */
export const FREEBUFF_CLI_STATUS_PATH = '/api/auth/cli/status'
/** `logout`. */
export const FREEBUFF_CLI_LOGOUT_PATH = '/api/auth/cli/logout'

/**
 * The `User-Agent` the desktop protocol presents (`src/upstream.rs:21`).
 *
 * It is not decoration: it announces the OpenAI-compatible SDK the desktop
 * client uses, and the reference sends it on every Bearer request.
 */
export const FREEBUFF_CLIENT_USER_AGENT = 'ai-sdk/openai-compatible/1.0.25/codebuff'

/**
 * The marker that identifies a browser-session cookie rather than a token.
 *
 * Kept ONLY so a credential in that shape can be recognised and refused
 * ({@link freebuffCookieRefusal}) — the cookie wire is not implemented.
 */
export const FREEBUFF_SESSION_COOKIE = '__Secure-next-auth.session-token'

/**
 * The CLI's own header set, name for name: `bLA`/`uLA`/`kLA`/`dLA`/`iLA`/
 * `cLA`/`lLA`/`nLA`/`QJA`/`NJA`/`i2` and `kJA()`'s timezone header.
 */
export const FREEBUFF_TIMEZONE_HEADER = 'x-fb-timezone'
export const FREEBUFF_MODEL_HEADER = 'x-freebuff-model'
export const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id'
export const FREEBUFF_MULTI_SESSION_HEADER = 'x-freebuff-multi-session'
export const FREEBUFF_INCLUDE_UNUSED_HEADER = 'x-freebuff-include-unused-rate-limits'
export const FREEBUFF_HEARTBEAT_HEADER = 'x-freebuff-heartbeat'
export const FREEBUFF_COMPACT_SESSION_HEADER = 'x-freebuff-compact-session'
export const FREEBUFF_PURCHASE_CONTINUITY_HEADER = 'x-freebuff-purchase-continuity'
export const FREEBUFF_DESKTOP_ATTEMPT_HEADER = 'x-freebuff-desktop-attempt-id'
export const FREEBUFF_FIRST_TAB_DISCOUNT_HEADER = 'x-freebuff-first-tab-discount'
export const FREEBUFF_WALLET_SPEND_LIMIT_HEADER = 'x-freebuff-wallet-spend-limit'
export const FREEBUFF_TAKEOVER_HEADER = 'x-freebuff-takeover-instance-id'
export const FREEBUFF_ACTING_USER_HEADER = 'x-freebuff-acting-user-id'

/**
 * The prefix the CLI puts on its instance id (`ZJA = "cli:"`, `wr()`).
 *
 * Load-bearing, not cosmetic: the metadata builder tests for it and adds
 * `freebuff_multi_session` + `surface` only when it is present
 * (`OJA(H) = {freebuff_instance_id:H, ...(QP(H) ? {freebuff_multi_session:"1",
 * surface:"cli"} : {})}`).
 */
export const FREEBUFF_CLI_INSTANCE_PREFIX = 'cli:'

/**
 * The root free agent the reference starts its runs for
 * (`ref-freebuff2api/src/models.rs:16`).
 *
 * It is only a fallback here: the CLI starts a MODEL-SPECIFIC free agent
 * ({@link freebuffAgentFor}), and free mode validates that pair.
 */
export const FREEBUFF_ROOT_AGENT = 'base2-free'

/**
 * How long the free tier's single request slot is held before the upstream
 * answers `concurrency_busy` (`src/semaphore.rs:27-33`: free slots = 1, acquire
 * timeout = 2 s). Reported as the retry delay so the retry plugin waits exactly
 * as long as the reference's own acquire would.
 */
export const FREEBUFF_CONCURRENCY_BUSY_RETRY_MS = 2_000

/** The reference's backoff hint for its queue keyword (`src/errors.rs:22`). */
export const FREEBUFF_QUEUE_RETRY_MS = 15_000

/** The reference's backoff hint for its rate-limit keyword (`src/errors.rs:20`). */
export const FREEBUFF_RATE_LIMIT_RETRY_MS = 60_000

/**
 * The credential fields one request needs.
 *
 * `accessToken` is the Bearer (the CLI's `authToken`). `cookie` is NOT a way in:
 * it is carried only so a credential stored by an older build — or a cookie
 * string someone pastes — is RECOGNISED and refused with a reason
 * ({@link freebuffCookieRefusal}), instead of having its session-token value
 * replayed as a Bearer, which is what the upstream answers
 * `free_mode_cli_required` to.
 */
export interface FreebuffCredential {
  /** The Bearer token. */
  accessToken: string
  /** A leftover cookie credential, detected so it can be refused. */
  cookie?: string
}

/** Whether a string is a cookie string rather than a bearer token. */
export function isFreebuffCookieString(value: string): boolean {
  // The reference's own discriminator, verbatim: `token.contains("session-token")`
  // (`src/import.rs:176-183`). Case-insensitive here because a header copy can
  // arrive either way, and the marker it tests is a cookie NAME.
  return /session-token/i.test(value)
}

/**
 * Which of the two credential shapes this session holds.
 *
 * Only `bearer` is usable; `cookie` exists so the caller can say WHY it is not.
 * @param credential - the stored credential fields.
 * @returns the shape, or undefined when the credential holds neither secret.
 */
export function freebuffCredentialKind(credential: FreebuffCredential): 'bearer' | 'cookie' | undefined {
  const token = credential.accessToken?.trim() ?? ''
  const cookie = credential.cookie?.trim() ?? ''
  if (isFreebuffCookieString(cookie) || isFreebuffCookieString(token)) return 'cookie'
  if (token !== '') return 'bearer'
  return undefined
}

/**
 * Assert a credential can ride this route's wire, and say why when it cannot.
 *
 * Called before any request is shaped, so a refused credential costs nothing.
 * @param credential - the stored credential fields.
 * @throws {LlmError} `UNSUPPORTED` for a cookie credential, `MISSING_CREDENTIAL`
 *   when the credential holds no secret at all.
 */
export function freebuffAssertDesktopCredential(credential: FreebuffCredential): void {
  const kind = freebuffCredentialKind(credential)
  if (kind === 'cookie') throw freebuffCookieRefusal()
  if (kind === undefined) {
    throw new LlmError(
      'Freebuff: the stored credential carries no Bearer token. Import the Freebuff CLI\'s login '
      + '(~/.config/manicode/credentials.json) or paste the `authorization: Bearer …` value from a CLI request.',
      'MISSING_CREDENTIAL',
    )
  }
}

/**
 * The refusal a cookie credential receives.
 *
 * The web wire is not implemented on this route, and it is not implemented
 * because it cannot do the job: it takes one flat prompt string with no `tools`
 * field (`src/web_protocol.rs:380-388`), so every harness tool — file
 * read/write, shell, glob/grep — simply would not exist for the model, which
 * then reports Freebuff's own server-side agents as its whole tool set
 * (live-verified 2026-09-28, quoted in `freebuff.ts`'s module doc).
 *
 * Replaying a cookie's session-token value as a Bearer is the other wrong turn
 * this message closes: the upstream answers that with
 * `403 free_mode_cli_required`, whose own text warns it "may get your account
 * banned".
 * @returns the error to throw, before any request is made.
 */
export function freebuffCookieRefusal(): LlmError {
  return new LlmError(
    'Freebuff: cookie credentials are no longer accepted on this route. A freebuff.com session cookie can only ride '
    + 'the web protocol (POST https://freebuff.com/api/chat/stream), which takes ONE flat prompt string with no '
    + '`tools` field — so the model would receive none of your tools and would answer as a plain chat assistant. '
    + 'Use 「Import from Freebuff CLI」 for the credential the official CLI already stored '
    + '(`~/.config/manicode/credentials.json`), or 「Sign in」, or paste the `authorization: Bearer …` value from a '
    + 'CLI request.',
    'UNSUPPORTED',
  )
}

/** The chat URL (`src/upstream.rs:306`). */
export function freebuffChatUrl(): string {
  return `${FREEBUFF_API_BASE}${FREEBUFF_CHAT_PATH}`
}

/** The session READ URL — the balance/quota endpoint (`src/upstream.rs:138-152`). */
export function freebuffSessionUrl(): string {
  return `${FREEBUFF_API_BASE}${FREEBUFF_SESSION_PATH}`
}

/** The session ADMISSION URL the CLI POSTs to (`pJA`). */
export function freebuffSessionAdmissionUrl(): string {
  return `${FREEBUFF_API_BASE}${FREEBUFF_SESSION_ADMISSION_PATH}`
}

/**
 * Where an attempt is RELEASED.
 *
 * The CLI builds this as `pJA(H) + "/attempt"` and only for a `cli:`-prefixed
 * instance (`CV`: `E = H==="DELETE" && D ? `${pJA(H)}/attempt` : pJA(H)`), so a
 * `DELETE` from here ends the ATTEMPT the caller names — not the account's other
 * session. Live 2026-09-29 it answered
 * `200 {"status":"ended","desktopAttemptId":"<uuid>","refundReceiptId":"…",
 * "freebucksRefundPending":true}`, and the freed slot admitted a fresh attempt
 * immediately after.
 */
export const FREEBUFF_SESSION_ATTEMPT_PATH = `${FREEBUFF_SESSION_PATH}/attempt`

/** The attempt-release URL (`${pJA("DELETE")}/attempt`). */
export function freebuffSessionAttemptUrl(): string {
  return `${FREEBUFF_API_BASE}${FREEBUFF_SESSION_ATTEMPT_PATH}`
}

/** The agent-run bootstrap URL (`src/upstream.rs:229`; CLI `qDA`). */
export function freebuffRunUrl(): string {
  return `${FREEBUFF_API_BASE}${FREEBUFF_AGENT_RUNS_PATH}`
}

/** The `loginCode` URL. */
export function freebuffCliCodeUrl(): string {
  return `${FREEBUFF_LOGIN_BASE}${FREEBUFF_CLI_CODE_PATH}`
}

/**
 * The `loginStatus` URL, with the CLI's own query set.
 *
 * Order and spelling are the CLI's (`loginStatus(f)`) — the fingerprint plus the
 * `expiresAt` the code call issued.
 * @param probe - the attempt's fingerprint and expiry.
 * @returns the URL to poll.
 */
export function freebuffCliStatusUrl(probe: FreebuffCliProbe): string {
  const query = new URLSearchParams({
    fingerprintId: probe.fingerprintId,
    fingerprintHash: probe.fingerprintHash,
    ...probe.expiresAt === undefined ? {} : { expiresAt: probe.expiresAt },
  })
  return `${FREEBUFF_LOGIN_BASE}${FREEBUFF_CLI_STATUS_PATH}?${query.toString()}`
}

/** What `POST /api/auth/cli/code` answers, plus the attempt it belongs to. */
export interface FreebuffCliProbe {
  /** The URL the user opens to sign in. */
  loginUrl: string
  /** The attempt's fingerprint — the poll's `fingerprintId` query. */
  fingerprintId: string
  /** The one-time hash the status poll must present. */
  fingerprintHash: string
  /** When the code expires, as the upstream stated it. */
  expiresAt?: string
}

/**
 * The `cli:` prefix's payload, or undefined when the id was not the CLI's shape
 * (`QP(H) = H.startsWith("cli:") ? H.slice(4) : undefined`).
 * @param instanceId - the instance id.
 * @returns the bare uuid, or undefined.
 */
export function freebuffInstanceUuid(instanceId: string): string | undefined {
  return instanceId.startsWith(FREEBUFF_CLI_INSTANCE_PREFIX)
    ? instanceId.slice(FREEBUFF_CLI_INSTANCE_PREFIX.length)
    : undefined
}

/**
 * The free agent a model must be run under.
 *
 * Free mode validates the RUN's agent against the model, so getting this wrong
 * is the difference between a working turn and `403 free_mode_invalid_agent_model`
 * — which is exactly what the earlier probe hit by starting every run for the
 * generic `base2-free` (`ref-freebuff2api/src/models.rs:16`) while asking for
 * `z-ai/glm-5.3-flash`.
 *
 * The table is the CLI's own `rl$` map, read out of the shipped binary, pairing
 * each free orchestrator agent with the model it serves
 * (`rl$[HV] = "base2-free-space-bunny-alpha"` for `HV = "stealth/space-bunny-alpha"`,
 * and `n3H(H) = rl$[H] ?? "base2-free"` is the CLI's fallback).
 * @param model - the wire model id.
 * @returns the agent id to start the run for.
 */
export function freebuffAgentFor(model: string): string {
  return FREEBUFF_MODEL_AGENTS[model] ?? FREEBUFF_ROOT_AGENT
}

/** The CLI's model → free-orchestrator-agent table (`rl$`). */
const FREEBUFF_MODEL_AGENTS: Record<string, string> = {
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'mimo/mimo-v2.6-pro': 'base2-free-mimo-2-6-pro',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'openai/gpt-5.6-luna': 'base2-free-luna',
  'openai/gpt-6-luna': 'base2-free-luna-6',
  'openai/gpt-5.6-luna-es': 'base2-free-luna-es',
  'upstage/solar-pro4': 'base2-free-solar-pro4',
  'upstage/solar-mini4': 'base2-free-solar-mini4',
  'stealth/space-bunny-alpha': 'base2-free-space-bunny-alpha',
  'stealth/ox-alpha': 'base2-free-ox-alpha',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'deepseek/deepseek-v4.1-flash': 'base2-free-deepseek-v4-1-flash',
  'z-ai/glm-5.2': 'base2-free-glm',
  'z-ai/glm-5.3-flash': 'base2-free-glm-5-3-flash',
  'z-ai/glm-5.3': 'base2-free-glm-5-3',
  'crof/kimi-k3-eco': 'base2-free-kimi-k3-eco',
  'anthropic/claude-fable-5': 'base2-free-fable',
  'google/gemini-3.8-flash': 'base2-free-gemini-3-8-flash',
  'meta/muse-spark-1.2-contributor': 'base2-free-muse-spark',
  'meta/muse-spark-1.3-contributor': 'base2-free-muse-spark-1-3',
}

/** The `Authorization` + JSON headers every desktop call carries. */
function freebuffAuthHeaders(credential: FreebuffCredential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    'content-type': 'application/json',
  }
}

/**
 * Headers for one chat request (`src/upstream.rs:127-136`).
 *
 * The desktop path sends `authorization` + the OpenAI-compatible SDK UA and
 * nothing else: its instance id rides in the body's `codebuff_metadata` instead
 * (`src/upstream.rs:300-302`).
 * @param credential - the credential fields.
 * @returns the header set.
 */
export function freebuffChatHeaders(credential: FreebuffCredential): Record<string, string> {
  return {
    ...freebuffAuthHeaders(credential),
    'user-agent': FREEBUFF_CLIENT_USER_AGENT,
  }
}

/** What {@link freebuffSessionHeaders} needs to shape one CLI session call. */
export interface FreebuffSessionRequest {
  /** The credential to present. */
  credential: FreebuffCredential
  /** `GET` reads/keeps the session alive, `POST` admits one, `DELETE` ends it. */
  method: 'GET' | 'POST' | 'DELETE'
  /** The instance this request speaks for. */
  instanceId: string
  /** The model, on a POST — the session is bound to one. */
  model?: string
  /**
   * Whether multi-session mode is on. The CLI defaults it from the instance id's
   * shape (`I = $.multiSession ?? Boolean(QP(instanceId))`), which for a
   * `cli:`-prefixed id is true.
   */
  multiSession?: boolean
  /** A short read that skips `rateLimitsByModel` (`$.compact`). */
  compact?: boolean
  /** The instance to take the single slot over from (`$.takeoverInstanceId`). */
  takeoverInstanceId?: string
  /** Wallet spend consent; the CLI sends `0` when there is none. */
  walletSpendLimit?: number
  /** The first-tab discount experiment flag, when the caller tracks it. */
  firstTabDiscount?: boolean
  /** Override the timezone, for tests. */
  timezone?: string
}

/**
 * Headers for one session call, transcribed from the CLI's `CV`.
 *
 * The logic is ported branch for branch because each branch is a header the
 * server can key on:
 *
 *   - every call carries `authorization`, the timezone (`kJA()`), and
 *     `x-freebuff-first-tab-discount`;
 *   - with multi-session on: `x-freebuff-multi-session` and
 *     `x-freebuff-purchase-continuity`, plus `x-freebuff-desktop-attempt-id` on
 *     anything but a GET;
 *   - on a GET it adds `x-freebuff-heartbeat: 1`, and
 *     `x-freebuff-include-unused-rate-limits: 1` unless the read is `compact`
 *     (which is the flag that makes the balance answer carry
 *     `rateLimitsByModel`);
 *   - the instance header goes on anything but a POST (a POST's instance is
 *     carried by `x-freebuff-desktop-attempt-id` plus `x-freebuff-instance-id`
 *     being a NEW id);
 *   - a POST adds the model and the wallet limit, and the takeover header when a
 *     slot is being taken over.
 * @param request - the call being shaped.
 * @returns the header set.
 */
export function freebuffSessionHeaders(request: FreebuffSessionRequest): Record<string, string> {
  const uuid = freebuffInstanceUuid(request.instanceId)
  const multiSession = request.multiSession ?? uuid !== undefined
  const headers: Record<string, string> = {
    ...freebuffAuthHeaders(request.credential),
    [FREEBUFF_TIMEZONE_HEADER]: request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    [FREEBUFF_FIRST_TAB_DISCOUNT_HEADER]: request.firstTabDiscount === true ? '1' : '0',
  }
  if (multiSession) {
    headers[FREEBUFF_MULTI_SESSION_HEADER] = '1'
    headers[FREEBUFF_PURCHASE_CONTINUITY_HEADER] = '1'
    if (uuid !== undefined && request.method !== 'GET') headers[FREEBUFF_DESKTOP_ATTEMPT_HEADER] = uuid
    if (request.method === 'GET') {
      headers[FREEBUFF_HEARTBEAT_HEADER] = '1'
      if (request.compact !== true) headers[FREEBUFF_INCLUDE_UNUSED_HEADER] = '1'
    }
  }
  if (multiSession || request.method !== 'POST') headers[FREEBUFF_INSTANCE_HEADER] = request.instanceId
  if (request.method === 'GET' && request.compact === true) headers[FREEBUFF_COMPACT_SESSION_HEADER] = '1'
  if (request.method === 'POST') {
    if (request.takeoverInstanceId !== undefined) {
      headers[FREEBUFF_TAKEOVER_HEADER] = request.takeoverInstanceId
    }
    if (request.model !== undefined) headers[FREEBUFF_MODEL_HEADER] = request.model
    headers[FREEBUFF_WALLET_SPEND_LIMIT_HEADER] = String(request.walletSpendLimit ?? 0)
  }
  return headers
}

/**
 * The body of one agent-run START (CLI `qDA`; `src/upstream.rs:224-228`).
 *
 * `ancestorRunIds` is what makes the upstream's run a ROOT run: this route
 * starts one run per turn and has no parent to point at
 * (`src/api.rs:3385-3394` does the same).
 * @param agentId - the free agent the model runs under ({@link freebuffAgentFor}).
 * @param ancestors - parent run ids, empty for a root run.
 * @returns the JSON body.
 */
export function freebuffRunBody(agentId: string, ancestors: readonly string[] = []): Record<string, unknown> {
  return { action: 'START', agentId, ancestorRunIds: [...ancestors] }
}

/** Headers for one agent-run call (CLI `qDA`: bearer + acting user). */
export function freebuffRunHeaders(credential: FreebuffCredential, userId?: string): Record<string, string> {
  return {
    ...freebuffAuthHeaders(credential),
    ...userId === undefined ? {} : { [FREEBUFF_ACTING_USER_HEADER]: userId },
  }
}

/**
 * Read the `runId` out of a START answer.
 *
 * Both spellings are live: the reference's own struct accepts `runId` and
 * `run_id` (`src/upstream.rs:86-97`).
 * @param payload - the parsed body.
 * @returns the run id, or undefined when the body carried none.
 */
export function parseFreebuffRunId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const value = record.runId ?? record.run_id
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Everything {@link freebuffChatBody} needs to shape one desktop request. */
export interface FreebuffChatBodyInput {
  model: string
  messages: readonly Record<string, unknown>[]
  tools?: readonly Record<string, unknown>[]
  maxTokens?: number
  /** The level the caller asked for, before the ladder rule is applied. */
  reasoningEffort?: string
  /**
   * The instance the chat speaks for — the one the ADMISSION accepted.
   *
   * It is passed in rather than derived: the attempt id is per claim
   * (`./claim.js`), and the chat body's `freebuff_instance_id` has to be the
   * very attempt the run was started for, not a value recomputed from the
   * credential.
   */
  instanceId: string
  /**
   * The run id `POST /api/v1/agent-runs` handed back.
   *
   * REQUIRED: the upstream refuses a body without one (`400 No runId found in
   * request body`, reproduced live), and the run is also what carries the agent
   * free mode validates against the model.
   */
  runId: string
}

/**
 * The `reasoning_effort` patch for a model, or an empty object.
 *
 * This is the reference's rule (`src/router.rs:199-213`) reduced to a body
 * patch: a value from the ladder is sent unchanged, an out-of-range level clamps
 * to the ladder's `last` (`max`/`xhigh`/`high`) or `first` (everything else),
 * and NO ladder means the field is REMOVED — i.e. no key at all, which is what
 * the empty object produces.
 * @param model - the wire model id.
 * @param requested - the level the caller asked for.
 * @returns the fields to merge into the body.
 */
export function freebuffEffortBodyField(model: string, requested?: string): Record<string, unknown> {
  const level = freebuffEffortFor(model, requested)
  return level === undefined ? {} : { reasoning_effort: level }
}

/**
 * The desktop (OpenAI-shaped) request body.
 *
 * The reference forwards its inbound body and MERGES a `codebuff_metadata`
 * object into it (`src/upstream.rs:288-304`); the CLI builds the same object
 * through its provider options (`OXH`):
 *
 *     codebuff_metadata: {...extraCodebuffMetadata, run_id, client_id,
 *                        ...(costMode && {cost_mode: costMode})}
 *
 * with, in free mode, `extraCodebuffMetadata = {...OJA(instanceId),
 * ...(effort ? {freebuff_reasoning_effort: effort} : {})}` and
 * `OJA(H) = {freebuff_instance_id:H, ...(cli:-prefixed ? {freebuff_multi_session:"1",
 * surface:"cli"} : {})}`.
 *
 * So this body carries, besides the OpenAI fields the caller supplied: the
 * instance id with its `cli:` prefix, the two fields that prefix turns on, the
 * run id, a fresh client id, `cost_mode: "free"`, and the clamped reasoning
 * level — the last one under the CLI's own free-mode key
 * (`freebuff_reasoning_effort`) as well as the top-level `reasoning_effort` the
 * reference's router sets, because the two clients spell it differently.
 * @param input - the request fields.
 * @returns the JSON body to send.
 */
export function freebuffChatBody(input: FreebuffChatBodyInput): Record<string, unknown> {
  const instance = input.instanceId
  const level = freebuffEffortFor(input.model, input.reasoningEffort)
  return {
    model: input.model,
    messages: [...input.messages],
    ...input.tools === undefined || input.tools.length === 0 ? {} : { tools: [...input.tools] },
    ...input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens },
    ...freebuffEffortBodyField(input.model, input.reasoningEffort),
    stream: true,
    codebuff_metadata: {
      freebuff_instance_id: instance,
      ...freebuffInstanceUuid(instance) === undefined ? {} : {
        freebuff_multi_session: '1',
        surface: 'cli',
      },
      ...level === undefined ? {} : { freebuff_reasoning_effort: level },
      run_id: input.runId,
      client_id: freebuffClientSessionId(),
      cost_mode: 'free',
    },
  }
}

/** An opaque per-request client session id, shaped like the reference's (`src/upstream.rs:296-299`). */
function freebuffClientSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** The upstream error envelope kinds this route reads. */
export interface FreebuffErrorEnvelope {
  /** The upstream's own words for the refusal. */
  message: string
  /** The upstream's machine-readable code, when the envelope carried one. */
  code?: string
}

/**
 * Read an error envelope out of a parsed body or an SSE event object.
 *
 * Three shapes are in the wild and all three are real:
 *   - codebuff's bare text code inside a 200 body (`src/errors.rs:1-10`);
 *   - `{"error":{"message":…,"type":…,"code":…}}` — the shape the reference's own
 *     gateway emits for `concurrency_busy` (`src/api.rs:1087`);
 *   - `{"type":"error","error":{…}}` — its Anthropic-shaped variant
 *     (`src/api.rs:3532`).
 * The message search order (`message`, then `detail`, then `error_description`,
 * then a bare `error`) is the reference's own (`src/errors.rs:217-228`).
 * @param value - a parsed body, or one SSE event object.
 * @returns the envelope, or undefined when the value is not one.
 */
export function freebuffErrorEnvelope(value: unknown): FreebuffErrorEnvelope | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const error = record.error
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') {
    const message = error.trim()
    return message === '' ? undefined : { message }
  }
  if (typeof error !== 'object') return undefined
  const inner = error as Record<string, unknown>
  const message = freebuffFirstString(inner.message, inner.detail, inner.error_description, inner.type)
  if (message === undefined) return undefined
  const code = freebuffFirstString(inner.code, record.code)
  return { message, ...code === undefined ? {} : { code } }
}

/** First non-empty string among the candidates. */
function freebuffFirstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * The reference's text-rule classification, as an `LlmError`.
 *
 * Rules and their order are `src/errors.rs:157-178` — waiting room, then rate
 * limit, then model-not-available, then auth, then bad request — and the status
 * is only the FALLBACK (`src/errors.rs:180-191`), because a 200 body can carry
 * any of them.
 *
 * Three mappings deserve their own line:
 *   - `queue` alone is a waiting room only on a 429/503 (`src/errors.rs:158-162`);
 *   - the model-unavailable words become `HTTP_404`, not `SERVER`: the reference's
 *     own status table maps 404 to "model unavailable" (`src/errors.rs:186`) and
 *     this is a non-retryable, wrong-model condition, so a 4xx-family code is what
 *     keeps the retry plugin from hammering a model upstream has withdrawn;
 *   - `free_mode_cli_required` becomes `UNSUPPORTED` with the upstream's warning
 *     quoted: it is not a retryable state and not this credential's fault — free
 *     mode is gated to the CLI's own channel — so the user must be told that
 *     plainly rather than have the retry plugin hammer a refusal that will never
 *     stop refusing.
 * @param status - the HTTP status (0 for a transport failure).
 * @param body - the raw body, or an SSE fragment.
 * @param label - diagnostic prefix.
 * @returns the classified error, or undefined when no text rule matched.
 */
export function freebuffTextError(status: number, body: string, label: string): LlmError | undefined {
  const lowered = body.toLowerCase()
  const has = (...needles: readonly string[]): boolean => needles.some(needle => lowered.includes(needle))
  const shown = body.slice(0, 300)
  const message = `${label} refused the call (HTTP ${String(status)})${shown.trim() === '' ? '' : `: ${shown}`}`
  // Free mode's channel gate comes first: its own text says the account is at
  // risk, so nothing else may be reported over it.
  if (has('free_mode_cli_required', 'free_mode_device_required')) {
    return new LlmError(
      `${message} — Freebuff gates free mode to its official CLI's own channel: a direct API call with a valid free `
      + 'credential is refused, and the upstream warns that calling the API directly "may get your account banned". '
      + 'Use the `freebuff` CLI itself for free-tier turns, or a paid/other credential on this route.',
      'UNSUPPORTED',
      { status },
    )
  }
  // The free tier's single request slot (`src/semaphore.rs:27-33`) is the most
  // specific refusal of the lot, so it is tested before the generic rate-limit
  // words its own text happens to contain.
  if (has('concurrency_busy')) {
    return new LlmError(message, 'RATE_LIMIT', {
      status,
      providerRetryAfterMs: FREEBUFF_CONCURRENCY_BUSY_RETRY_MS,
    })
  }
  if (has('purchase_capacity', 'premium_slot_taken', 'purchase_in_use')) {
    return new LlmError(
      `${message} — another desktop session holds this account's only free slot. The Freebuff CLI resolves this by `
      + 'offering to take the session over; end the other session there (`/end-session`) or wait for it to expire, '
      + 'then try again.',
      'HTTP_409',
      { status },
    )
  }
  if (has('waiting_room', 'waiting room', '排队') || ((status === 429 || status === 503) && has('queue'))) {
    return new LlmError(message, 'RATE_LIMIT', { status, providerRetryAfterMs: FREEBUFF_QUEUE_RETRY_MS })
  }
  if (has('rate limit', 'rate_limit', 'too many requests', '限流')) {
    return new LlmError(message, 'RATE_LIMIT', { status, providerRetryAfterMs: FREEBUFF_RATE_LIMIT_RETRY_MS })
  }
  if (has('invalid_agent_model', 'free_mode_invalid', 'model not available', 'only available for',
    'model_not_found', 'no such model')) {
    return new LlmError(message, 'HTTP_404', { status })
  }
  if (has('unauthorized', 'invalid token', 'session expired', 'token expired', 'authentication')) {
    return new LlmError(message, 'AUTH', { status })
  }
  if (has('invalid_request', 'bad request') || /missing\b.{0,80}?required/is.test(lowered)) {
    return new LlmError(message, 'HTTP_400', { status })
  }
  return undefined
}

/**
 * What a session/admission answer means for the ATTEMPT it was sent for.
 *
 * The upstream answers the same endpoint with a `status` word rather than an
 * error code, and the CLI drives a state machine off exactly this vocabulary
 * (`CV`'s 409 list: `model_locked`, `model_unavailable`, `premium_slot_taken`,
 * `purchase_claim_released`, `purchase_in_use`, `purchase_capacity`,
 * `first_tab_discount_changed`, `consent_required`; its 429 list:
 * `rate_limited`, `spend_limited`, `ip_capped`; its `hc$` switch also names
 * `active`, `ended`, `none`, `superseded`, `takeover_prompt`, `country_blocked`,
 * `banned`). The classification below is that state machine, reduced to what a
 * non-interactive route can act on:
 *
 *   - `active` — the claim is live; the attempt may chat;
 *   - `retired` — the attempt is DEAD FOR GOOD and must be replaced:
 *     `purchase_claim_released` (the claim was released: live 2026-09-29 the
 *     account's slot read `"premium":0` with `desktopPurchases:[]` while the
 *     attempt kept being refused, so this is about the attempt, not about
 *     capacity) and `admission_attempt_closed` (an attempt that a `DELETE
 *     /attempt` cancelled: its own words are «This session start was cancelled
 *     before it finished. Start again to open a new session.»). The CLI's answer
 *     to `purchase_claim_released` is the same conclusion — it marks the
 *     instance stale (`Q=!0`), tells the user «This session was released. Choose
 *     a model to start a new session.» and mints `J=wr()` on the next start;
 *   - `no-claim` — `none`/`ended`/`superseded`: no session exists for this
 *     attempt at all, so it is worth replacing too (the CLI's own effect re-mints
 *     whenever a session is not active, e.g. `x3A`/`C3A` for a stale legacy
 *     instance);
 *   - `slot-held` — `purchase_capacity`/`premium_slot_taken`/`purchase_in_use`:
 *     ANOTHER session (the CLI's, or an earlier process's) holds the account's
 *     single free slot. Minting a new attempt cannot help — live 2026-09-29 a
 *     fresh attempt while another claim was live answered
 *     `409 {"status":"purchase_capacity","currentInstanceId":"cli:<the holder>",
 *     "concurrency":"slot-bound","slotLimit":1}`. The CLI resolves this with a
 *     "take over?" prompt, which a plugin must not do unattended, so the holder
 *     is NAMED and the remedy is spelled out instead;
 *   - `wait` — the waiting room and the 429 family;
 *   - `refused` — everything else, reported with the upstream's own words.
 */
export type FreebuffAdmissionVerdict = 'active' | 'retired' | 'no-claim' | 'slot-held' | 'wait' | 'refused'

/** The `status` words the upstream uses for an attempt that is over. */
const FREEBUFF_RETIRED_STATUSES = ['purchase_claim_released', 'admission_attempt_closed']
/** The `status` words for "no session for this attempt". */
const FREEBUFF_NO_CLAIM_STATUSES = ['none', 'ended', 'superseded']
/** The `status` words for "somebody else holds the slot". */
const FREEBUFF_SLOT_HELD_STATUSES = ['purchase_capacity', 'premium_slot_taken', 'purchase_in_use']

/** How one session/admission answer reads. */
export interface FreebuffSessionReading {
  /** The upstream's own status word (its `error` field when there is no `status`). */
  status: string
  /** What it means for the attempt. */
  verdict: FreebuffAdmissionVerdict
  /** The error to throw, or undefined when the verdict is `active`. */
  error?: LlmError
}

/** Options for {@link freebuffSessionStatus}. */
export interface FreebuffSessionStatusOptions {
  /** The raw body, so a non-JSON answer is still quoted in the message. */
  body?: string
  /** The attempt the answer was requested for (`cli:<uuid>`). */
  attempt?: string
  /** The FRESH attempt already tried after `attempt` was retired. */
  freshAttemptTried?: string
}

/** A qualified holder, read out of the admission's `desktopPurchases` (`wJA`'s record shape). */
function freebuffHeldPurchase(payload: unknown): { model?: string; instanceId?: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const purchases = (payload as Record<string, unknown>).desktopPurchases
  if (!Array.isArray(purchases) || purchases.length === 0) return undefined
  const first = purchases[0]
  if (typeof first !== 'object' || first === null) return undefined
  const record = first as Record<string, unknown>
  const model = freebuffFirstString(record.model)
  const instanceId = freebuffFirstString(record.holderInstanceId, record.instanceId, (payload as Record<string, unknown>).currentInstanceId)
  return model === undefined && instanceId === undefined ? undefined : { ...model === undefined ? {} : { model }, ...instanceId === undefined ? {} : { instanceId } }
}

/**
 * Read a session/admission answer: its verdict, and the error to throw.
 *
 * The vocabulary is {@link FreebuffAdmissionVerdict}'s; each status carries the
 * remedy in the user's own terms — what to do in the CLI — because a bare
 * `HTTP 409` told the reader nothing about a state the upstream distinguishes by
 * name (that is exactly how the release defect was reported).
 * @param payload - the parsed answer body (undefined when it was not JSON).
 * @param httpStatus - the HTTP status it arrived with.
 * @param label - diagnostic prefix.
 * @param options - the raw body and the attempts involved.
 * @returns the verdict and error.
 */
export function freebuffSessionStatus(
  payload: unknown,
  httpStatus: number,
  label: string,
  options: FreebuffSessionStatusOptions = {},
): FreebuffSessionReading {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const status = freebuffFirstString(record.status, record.error) ?? ''
  const text = options.body ?? JSON.stringify(payload) ?? ''
  const shown = text.trim() === '' ? '' : `: ${text.slice(0, 300)}`
  const attemptClause = options.attempt === undefined ? '' : ` for attempt ${options.attempt}`
  /** The sentence that explains a status the route did NOT mint fresh for. */
  const retried = options.freshAttemptTried !== undefined

  if (status === 'active') return { status, verdict: 'active' }

  if (status.startsWith('queued') || status.includes('waiting_room')) {
    return {
      status,
      verdict: 'wait',
      error: new LlmError(
        `${label} is in the waiting room (${status})${record.position === undefined ? '' : ` at position ${String(record.position)}`}`,
        'RATE_LIMIT',
        { status: httpStatus, providerRetryAfterMs: FREEBUFF_QUEUE_RETRY_MS },
      ),
    }
  }

  if (FREEBUFF_RETIRED_STATUSES.includes(status)) {
    const closed = status === 'admission_attempt_closed'
    const upstream = freebuffFirstString(record.message)
    const release = closed
      ? `the upstream CANCELLED that session start (admission_attempt_closed`
        + `${upstream === undefined ? '' : `: "${upstream}"`}), and a cancelled attempt id is refused for good`
      : 'the upstream RELEASED that session start (purchase_claim_released), and a released attempt id is refused for good'
    return {
      status,
      verdict: 'retired',
      error: new LlmError(
        `${label} refused attempt ${options.attempt ?? '(this attempt)'}${shown} — ${release}. `
        + (retried
          ? `This route already opened a NEW attempt (${String(options.freshAttemptTried)}) and the upstream refused that one too, `
            + 'so nothing local is stale: the account itself has no open session to claim right now. '
          : '')
        + 'The Freebuff CLI answers this state by starting a NEW session: run `freebuff`, then pick a model in the picker '
        + '(its own words: "This session was released. Choose a model to start a new session."), and if the CLI refuses '
        + 'too, run `/end-session` there first so the account is left with no open session.',
        'HTTP_409',
        { status: httpStatus },
      ),
    }
  }

  if (FREEBUFF_SLOT_HELD_STATUSES.includes(status)) {
    const held = freebuffHeldPurchase(payload)
    const holder = held?.instanceId ?? freebuffFirstString(record.currentInstanceId)
    const holderModel = held?.model
    const slotLimit = record.slotLimit
    const holderClause = holder === undefined
      ? ''
      : ` (holder instance ${holder}${holderModel === undefined ? '' : `, model ${holderModel}`}`
        + `${slotLimit === undefined ? '' : `, slotLimit ${String(slotLimit)}`})`
    return {
      status,
      verdict: 'slot-held',
      error: new LlmError(
        `${label} refused${attemptClause}${shown} — another desktop session holds this account's only free slot`
        + `${holderClause}. `
        + (holderModel === undefined
          ? 'End that session in the Freebuff CLI (`/end-session`) or wait for it to expire, then try again.'
          : `If you meant to continue it, ask this route for ${holderModel}; otherwise end it in the Freebuff CLI `
            + '(`/end-session`) or wait for it to expire, then try again.'),
        'HTTP_409',
        { status: httpStatus },
      ),
    }
  }

  if (status === 'model_locked') {
    const requested = freebuffFirstString(record.requestedModel)
    const current = freebuffFirstString(record.currentModel)
    return {
      status,
      verdict: 'refused',
      error: new LlmError(
        `${label} refused${attemptClause}${shown} — this account is already in an active session`
        + `${current === undefined ? '' : ` on ${current}`}, and the admission binds a session to one model. `
        + (current === undefined || requested === undefined
          ? 'End it in the Freebuff CLI (`/end-session`), then try again.'
          : `Ended your previous session on ${current} and switched to ${requested} is what the CLI does; here, run `
            + '`/end-session` in the CLI, then pick the model again. (Sessions end on their own after 1 hour.)'),
        'HTTP_404',
        { status: httpStatus },
      ),
    }
  }

  if (status === 'model_unavailable') {
    const requested = freebuffFirstString(record.requestedModel, record.currentModel)
    const available = freebuffFirstString(record.availableHours, record.message)
    return {
      status,
      verdict: 'refused',
      error: new LlmError(
        `${label} refused${attemptClause}${shown} — ${requested === undefined ? 'this model' : requested} is not available to this account right now`
        + `${available === undefined ? '' : `: ${available}`}`
        + `${record.withdrawn === true ? ' (the upstream has WITHDRAWN it)' : ''}. Pick another free model on this route.`,
        'HTTP_404',
        { status: httpStatus },
      ),
    }
  }

  if (status === 'first_tab_discount_changed' || status === 'consent_required') {
    const walletSpend = (() => {
      const consent = record.walletConsent
      if (typeof consent !== 'object' || consent === null) return undefined
      const value = (consent as Record<string, unknown>).walletSpend
      // The CLI interpolates this field, so it is a number as often as a string
      // (`FH.walletConsent.walletSpend`).
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    })()
    return {
      status,
      verdict: 'refused',
      error: new LlmError(
        `${label} refused${attemptClause}${shown} — `
        + (status === 'first_tab_discount_changed'
          ? 'the first-tab discount changed, so the upstream wants the model chosen again (its words: "Your first-tab '
            + 'discount changed. Review the model menu and choose again. No Freebucks were charged."). This route sends '
            + 'the discount flag as 0, so re-pick the model here, or choose it in the CLI.'
          : 'the upstream wants the wallet spend confirmed'
            + `${walletSpend === undefined ? '' : ` (${walletSpend} Freebucks)`}`
            + '. This route spends nothing (x-freebuff-wallet-spend-limit: 0), so confirm it in the Freebuff CLI instead.'),
        'HTTP_409',
        { status: httpStatus },
      ),
    }
  }

  if (status === 'rate_limited' || status === 'spend_limited' || status === 'ip_capped') {
    const daily = (() => {
      const freebucks = record.freebucks
      if (typeof freebucks !== 'object' || freebucks === null) return undefined
      const day = (freebucks as Record<string, unknown>).daily
      if (typeof day !== 'object' || day === null) return undefined
      return freebuffFirstString((day as Record<string, unknown>).resetAt)
    })()
    const state = status === 'spend_limited'
      ? `the free tier's Freebucks are spent for today${daily === undefined ? '' : ` (they reset at ${daily})`}`
      : status === 'ip_capped'
        ? `this network address (VPN/proxy) is over its daily free allowance of Freebucks${daily === undefined ? '' : ` (they reset at ${daily})`}`
        : `the account is rate-limited${daily === undefined ? '' : ` (the credit window resets at ${daily})`}`
    return {
      status,
      verdict: 'wait',
      error: new LlmError(
        `${label} refused${attemptClause}${shown} — ${state}. Wait for the window to reset, then try again.`,
        'RATE_LIMIT',
        { status: httpStatus, providerRetryAfterMs: FREEBUFF_RATE_LIMIT_RETRY_MS },
      ),
    }
  }

  if (status === 'banned' || status === 'country_blocked') {
    const reason = freebuffFirstString(record.countryBlockReason, record.message, record.reason)
    return {
      status,
      verdict: 'refused',
      error: new LlmError(
        `${label} refused${attemptClause}${shown} — the upstream reports this account as ${status}`
        + `${reason === undefined ? '' : ` (${reason})`}. The CLI disables its session for this state; free mode is not `
        + 'available from this network until the upstream lifts it. No retry here will change that.',
        'UNSUPPORTED',
        { status: httpStatus },
      ),
    }
  }

  if (FREEBUFF_NO_CLAIM_STATUSES.includes(status)) {
    return {
      status,
      verdict: 'no-claim',
      error: new LlmError(
        `${label} answered status "${status}"${attemptClause}${shown} — there is no session for that attempt `
        + (retried
          ? `(a fresh attempt, ${String(options.freshAttemptTried)}, was refused the same way, so the account has no `
            + 'session to open right now)'
          : '')
        + '. Start a session in the Freebuff CLI (`freebuff`, then pick a model), then try again.',
        'HTTP_409',
        { status: httpStatus },
      ),
    }
  }

  const textRule = freebuffTextError(httpStatus, text, label)
  if (textRule !== undefined) return { status, verdict: 'refused', error: textRule }
  const message = freebuffFirstString(record.message, record.error)
  return {
    status,
    verdict: 'refused',
    error: new LlmError(
      `${label} did not answer an active session (HTTP ${String(httpStatus)}`
      + `${status === '' ? '' : `, status="${status}"`})${attemptClause}`
      + `${message === undefined ? shown : `: ${message}`}`,
      freebuffStatusErrorCode(httpStatus, status !== ''),
      { status: httpStatus },
    ),
  }
}

/**
 * The error code for a status this table did not recognize.
 *
 * A session STATE that arrived with a 2xx is a conflict, not a transport
 * failure — the upstream answers 200 with a `status` it wants the client to act
 * on, and the CLI's `hc$` schedules no retry for any of those — so those land on
 * `HTTP_409`. Everything else keeps the hub's own status→code mapping
 * (`httpLlmError`, `src/providers/common.ts:127-134`), so an unrecognized status
 * does not turn a 502 into "wrong model" or a 401 into a conflict.
 * @param httpStatus - the HTTP status the answer arrived with.
 * @param stateShaped - whether the body carried a session status word.
 * @returns the `LlmError` code.
 */
function freebuffStatusErrorCode(httpStatus: number, stateShaped: boolean): string {
  if (httpStatus < 400) return stateShaped ? 'HTTP_409' : 'MALFORMED_RESPONSE'
  if (httpStatus === 401 || httpStatus === 403) return 'AUTH'
  if (httpStatus === 429) return 'RATE_LIMIT'
  if (httpStatus === 408 || httpStatus === 504) return 'TIMEOUT'
  if (httpStatus >= 500) return 'SERVER'
  return `HTTP_${String(httpStatus)}`
}

/**
 * Classify a session/admission answer, as the error to throw.
 *
 * The error half of {@link freebuffSessionStatus}, which is the single table for
 * this vocabulary.
 * @param payload - the parsed answer body.
 * @param httpStatus - the HTTP status it arrived with.
 * @param label - diagnostic prefix.
 * @returns the error to throw, or undefined when the session is active.
 */
export function freebuffSessionStatusError(
  payload: unknown,
  httpStatus: number,
  label: string,
): LlmError | undefined {
  return freebuffSessionStatus(payload, httpStatus, label).error
}

/** The retry hint this route's own text rules disclose, as an epoch instant. */
const freebuffRateLimitReset: RateLimitResetReader = (_response, body, now) => {
  const lowered = body.toLowerCase()
  if (lowered.includes('concurrency_busy')) return now + FREEBUFF_CONCURRENCY_BUSY_RETRY_MS
  if (lowered.includes('waiting_room') || lowered.includes('waiting room') || lowered.includes('排队')) {
    return now + FREEBUFF_QUEUE_RETRY_MS
  }
  if (lowered.includes('rate limit') || lowered.includes('rate_limit') || lowered.includes('too many requests')) {
    return now + FREEBUFF_RATE_LIMIT_RETRY_MS
  }
  return undefined
}

/**
 * Classify a failed Freebuff response.
 *
 * Text rules first, then the hub's shared status classifier — with this route's
 * own reader supplying the retry instant on a 429, so `concurrency_busy` asks
 * the retry plugin to wait the reference's 2 s acquire window instead of a
 * default backoff (`src/semaphore.rs:33`).
 *
 * The `Response` is rebuilt from the body the caller already read, which is the
 * pattern the Cline route uses for the same reason (`src/providers/cline/adapter.ts`)
 * — `httpLlmError` needs a `Response` to read `retry-after` and to name the
 * status in its message.
 * @param status - the HTTP status.
 * @param headers - the response headers (for `retry-after`).
 * @param body - the body text.
 * @param label - diagnostic prefix.
 * @param onWarn - sink for a 429 that disclosed nothing this reader recognizes.
 * @returns the classified error.
 */
export async function freebuffResponseError(
  status: number,
  headers: Headers,
  body: string,
  label: string,
  onWarn?: (message: string) => void,
): Promise<LlmError> {
  const textRule = freebuffTextError(status, body, label)
  if (textRule !== undefined) return textRule
  return await httpLlmError(new Response(body, { status, headers }), label, {
    rateLimitReset: freebuffRateLimitReset,
    ...onWarn === undefined ? {} : { onWarn },
  })
}

/**
 * The refusal a NON-stream 200 body carries, if it carries one.
 *
 * This upstream answers a refused call with HTTP 200 and a JSON body — one bare
 * object, no SSE framing at all — and a 200 body handed to a stream parser
 * produces zero events, which surfaces as "the stream ended before a finish
 * chunk": a message about the wrong thing entirely. The decision is made once,
 * on the opening bytes, and every later byte is passed through untouched.
 *
 * A body whose opening is an SSE frame carrying real content (`data: {"choices":…}`)
 * is NOT a refusal: only an envelope, a bare known text code, or nothing.
 * @param head - the opening bytes of the response body.
 * @param status - the status the body arrived with.
 * @param label - diagnostic prefix.
 * @returns the error to throw, or undefined when the body is not a refusal.
 */
export function freebuffBodyRefusal(head: string, status: number, label: string): LlmError | undefined {
  const trimmed = head.trim()
  if (trimmed === '') return undefined
  const scan = freebuffHeadScan(trimmed)
  // A real stream frame is content, not a refusal — see {@link freebuffHeadScan}.
  if (scan?.kind === 'frame') return undefined
  if (scan?.kind === 'envelope') {
    const envelope = scan.envelope
    // The upstream's own words are the message; the classification then follows
    // the same text rules, so `concurrency_busy` still lands on RATE_LIMIT.
    return freebuffTextError(status, JSON.stringify(envelope), label)
      ?? new LlmError(
        `${label} refused the call (HTTP ${String(status)})`
        + `${envelope.code === undefined ? '' : ` [${envelope.code}]`}: ${envelope.message}`,
        `HTTP_${String(status)}`,
        { status },
      )
  }
  return freebuffTextError(status, trimmed, label)
}

/** What a body's opening bytes turned out to be. */
type FreebuffHeadScan =
  | { kind: 'envelope', envelope: FreebuffErrorEnvelope }
  | { kind: 'frame' }
  | undefined

/**
 * Classify a body's OPENING BYTES as an error envelope, a real stream frame, or
 * neither.
 *
 * The frame case has to be distinguished, and that is the whole point of this
 * function: `{"object":"chat.completion.chunk","choices":[…]}` carries none of
 * the envelope keys, and running the bare text rules over model OUTPUT would let
 * the first token of an answer ("unauthorized", "rate limit") be read as a
 * refusal.
 * @param text - the opening bytes.
 * @returns the scan result.
 */
function freebuffHeadScan(text: string): FreebuffHeadScan {
  let sawFrame = false
  const candidates: readonly string[] = text.trimStart().startsWith('{')
    ? [text]
    : text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('data:') ? trimmed.slice('data:'.length).trim() : ''
    }).filter(line => line !== '' && line !== '[DONE]')
  for (const candidate of candidates) {
    const parsed = tryJson(candidate)
    if (parsed === undefined) continue
    const envelope = freebuffErrorEnvelope(parsed)
    if (envelope !== undefined) return { kind: 'envelope', envelope }
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      // `object`/`choices`/`usage` are this protocol's chunk fields.
      if (record.choices !== undefined || record.usage !== undefined || record.object !== undefined) {
        sawFrame = true
      }
    }
  }
  return sawFrame ? { kind: 'frame' } : undefined
}

/**
 * Wrap an upstream body stream so a refusal delivered inside a 200 CANNOT reach
 * the SSE translator.
 * @param stream - the upstream body stream.
 * @param options - the status the body arrived with, the diagnostic label, and the activity pulse.
 * @returns a stream that errors with the refusal instead of yielding empty content.
 */
export function freebuffGuardStream(
  stream: ReadableStream<Uint8Array>,
  options: { label: string, status: number, onActivity?: () => void },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let decided = false
  let buffered = ''
  const decide = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    decided = true
    const scan = freebuffHeadScan(buffered)
    const refusal = scan?.kind === 'frame'
      ? undefined
      : freebuffBodyRefusal(buffered, options.status, options.label)
    if (refusal !== undefined) {
      controller.error(refusal)
      return
    }
    if (buffered !== '') controller.enqueue(encoder.encode(buffered))
    buffered = ''
  }
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      options.onActivity?.()
      if (decided) {
        controller.enqueue(chunk)
        return
      }
      buffered += decoder.decode(chunk, { stream: true })
      if (!freebuffDecidable(buffered)) return
      decide(controller)
    },
    flush(controller) {
      if (!decided && buffered !== '') decide(controller)
    },
  }))
}

/**
 * Whether the opening bytes are enough to tell a refusal from a stream.
 *
 * Three cases end the wait: a complete SSE event (which is what a real stream
 * starts with), a closed JSON object (a bare JSON body is all there is), and
 * enough plain text that it cannot be the start of JSON. Anything shorter waits
 * for the next chunk rather than guessing, because a guess here either eats
 * content or passes a refusal through.
 * @param buffer - the bytes received so far.
 * @returns true once a decision can be made.
 */
function freebuffDecidable(buffer: string): boolean {
  if (freebuffEventBoundary(buffer) !== -1) return true
  const trimmed = buffer.trimStart()
  if (trimmed.startsWith('{')) return freebuffJsonClosed(trimmed)
  return trimmed.trimEnd().length >= 64
}

/** The offset just past the first SSE event boundary, or -1. */
function freebuffEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4
  if (crlf === -1) return lf + 2
  return Math.min(lf + 2, crlf + 4)
}

/** Whether the first JSON object in `text` is complete. */
function freebuffJsonClosed(text: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return true
    }
  }
  return false
}

/** Parse JSON without throwing. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Whether a body is an in-band session refusal.
 *
 * `src/api.rs:5618-5621` is the source: an authenticated answer always carries
 * `accessTier` or `freebucks` — so a body with neither is a refusal, not an
 * empty account (`ref-freebuff2api/src/api.rs:5618`; live 2026-09-28, the
 * desktop session GET answered exactly this shape).
 * @param payload - the parsed body.
 * @returns true when the body proves the credential was not honoured.
 */
export function freebuffSessionUnauthenticated(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return true
  const record = payload as Record<string, unknown>
  const tier = record.accessTier ?? record.access_tier
  return (tier === undefined || tier === null) && record.freebucks === undefined
}

/**
 * Where the reference tops up its model roster from (`src/models.rs:566`).
 *
 * It is a public TypeScript constant file in the upstream client's repository,
 * NOT a credentialed API: neither protocol exposes a model-list endpoint.
 */
export const FREEBUFF_UPSTREAM_MODELS_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts'

/**
 * Extract the model ids upstream declares, per agent.
 *
 * The reference's parser (`src/models.rs:793-812`) matches `'agent': [ … ]` (with
 * or without a `new Set(`) and takes every quoted string inside the brackets,
 * skipping entries that are constant REFERENCES (which it cannot resolve). This
 * keeps that shape and adds one guard: only ids containing `/` are accepted,
 * because a bare `'file-picker'`-style value is an agent name, not a model, and
 * offering an agent name as a model id is worse than offering nothing.
 * @param source - the fetched document's text.
 * @returns the declared model ids, deduplicated, in file order.
 */
export function parseFreebuffUpstreamModels(source: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const block = /'([^']+)':\s*(?:new\s+Set\(\s*)?\[([^\]]*)\]/g
  for (const match of source.matchAll(block)) {
    const body = match[2] ?? ''
    for (const quoted of body.matchAll(/'([^']+)'/g)) {
      const id = quoted[1]?.trim() ?? ''
      if (!id.includes('/') || seen.has(id)) continue
      seen.add(id)
      found.push(id)
    }
  }
  return found
}

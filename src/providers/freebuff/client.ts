/**
 * Freebuff (freebuff.com / codebuff.com) wire surface: credentials, URLs,
 * headers, request-body shaping, error classification — and the translator for
 * the ONE protocol here that is not OpenAI-shaped.
 *
 * ## Two upstreams behind one credential
 *
 * Freebuff ships no OAuth client this plugin can drive; the credential is a
 * browser session, and the reference gateway carries it in one of two shapes
 * (`src/import.rs:176-183` classifies them by the `session-token` marker):
 *
 *   - **Bearer token** — the DESKTOP protocol, `POST {api}/api/v1/chat/completions`
 *     with `authorization: Bearer <token>` and an OpenAI-chat body
 *     (`src/upstream.rs:127-136`, `:281-315`). Its SSE is already
 *     OpenAI chat-completions format (`src/protocol/openai_sse.rs:1-9`), so the
 *     hub's own `streamChatCompletions` translator reads it.
 *   - **Cookie string** — the WEB protocol, `POST https://freebuff.com/api/chat/stream`
 *     with the whole cookie header (`src/web_protocol.rs:4-12`, `:346-365`).
 *     Its 11 event types are NOT OpenAI-shaped (`src/web_protocol.rs:84-162`), so
 *     {@link freebuffWebToChatCompletions} converts them BEFORE the same
 *     translator sees them — the reference does the same conversion in its
 *     `StreamEncoder` (`src/web_protocol.rs:775-930`) and its own comment says why
 *     the raw events cannot be passed through.
 *
 * Which one a request uses is decided by the credential, not per call: the
 * reference prefers the desktop path and reaches for the web bridge only when no
 * usable Bearer credential exists (`src/api.rs:2664-2685`).
 *
 * ## Tools ride ONE of the two wires — and it is not the cookie one
 *
 * The DESKTOP body forwards the caller's `tools` array untouched and accepts
 * assistant `tool_calls` plus `role:"tool"` results: the reference passes the
 * whole inbound body through and rewrites only `model` and `codebuff_metadata`
 * (`src/api.rs:2707-2708`), which is what {@link freebuffChatBody} reproduces.
 *
 * The WEB body has NO tools field and no tool-turn encoding at all. It is
 * `{threadId, content, model, reasoningEffort, gravity, images, attachments}`
 * (`src/web_protocol.rs:380-388`) — one flat prompt string, rendered by
 * {@link freebuffWebPrompt} from `src/web_threads.rs:176-254`. The reference's
 * README advertises 工具调用映射, but that mapping runs DOWNSTREAM ONLY: an
 * upstream `agent_tool` event (Freebuff's OWN server-side agents) becomes an
 * OpenAI `tool_calls` delta for the gateway's generic clients
 * (`src/web_protocol.rs:811-828`, `:885-898`; arguments hardcoded `{}` because
 * upstream never streams them). Nothing carries a CLIENT tool schema upstream:
 * the reference's web bridge never forwards an inbound `tools` array and never
 * reads one (`src/api.rs:1118` calls `chat_stream_raw(thread_id, content, None,
 * Vec::new(), Vec::new())`).
 *
 * Live-verified 2026-09-28 against the real upstream with a cookie credential:
 * a `tools` array bolted onto a web body is IGNORED. Asked to call a declared
 * `read_file`, the model reasoned "I don't have a read_file tool. My available
 * tools are: 1. spawn_agents 2. gravity_index 3. render_ui 4. suggest_followups
 * 5. researcher_web 6. thinker_gemini 7. context_pruner" and answered in prose —
 * the exact shape of this route's reported defect (the harness's local tools
 * vanish and the assistant reports only Freebuff's own server-side tools). So a
 * tool-declaring turn is REFUSED on this wire rather than quietly downgraded to
 * a tool-less chat: {@link freebuffWebToolRefusal}.
 *
 * ## Upstream-only tool calls are DROPPED, not relayed
 *
 * The web translator therefore does NOT surface an upstream `agent_tool` event as
 * a harness tool call, even though that is exactly what the reference does with it
 * (`src/web_protocol.rs:811-828` maps `toolCallId` to a stable `tool_calls` index,
 * `:885-898` emits the delta, `arguments` hardcoded `{}` because upstream never
 * streams them). Live 2026-09-28 on the real upstream, one turn carried FOUR of
 * them — `tool-call` blocks named `web_search`, each `arguments:"{}"`, under
 * `finish_reason: tool_calls`. Re-checks while making this change (same cookie
 * credential, the zero-cost model) saw THIRTEEN in one turn — nine `web_search`
 * plus four `read_url` — and TWENTY-SIX in the next, so four was nowhere near a
 * ceiling: an upstream-only tool call on this wire is normal, not an edge case.
 *
 * Those calls are FREEBUFF's OWN server-side tools. The upstream already ran them;
 * nothing in the exchange asks this client to run anything. The reference relays
 * them because of WHO ITS CONSUMER IS: its own clients asked for an OpenAI
 * `tool_calls` delta so their generic loops could see — and decide what to do
 * about — the upstream's internal activity. DSH is a different consumer, and
 * there the faithful mapping is the harm: DSH sees a tool call it has no handler
 * for, tries to execute it, and the turn breaks. The mismatch is worse here than
 * in general, because this route declares NO tools to anyone (the body has no
 * `tools` field) and refuses a tool-declaring turn up front
 * ({@link freebuffWebToolRefusal}) — an upstream-only tool call is therefore the
 * ONLY way a tool call could ever reach DSH from this wire, and it is always one
 * the harness cannot run.
 *
 * So the call is dropped ({@link freebuffWebToChatCompletions}), recorded ONCE
 * per stream through the translator's `onWarn` so the user can see that upstream
 * used its own tools. Answer text around it still streams, and an upstream
 * `tool_calls` finish becomes a normal completion: the harness must never be left
 * dangling, waiting for a tool result nobody is going to send.
 *
 * ## Errors are TEXT first, status second
 *
 * codebuff answers refusals inside an HTTP 200 body — as a bare text code
 * (`free_mode_invalid_agent_model`, `waiting_room_queued`) or as an
 * `{"error":{...}}` envelope — so classifying on the status alone misses them
 * (`src/errors.rs:1-10`). {@link freebuffTextError} implements that rule table,
 * and {@link freebuffBodyRefusal} is how a refusal that arrived in a 200 gets
 * thrown with the upstream's OWN words instead of becoming an empty stream.
 *
 * @module dsh-subscription-hub/providers/freebuff/client
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { httpLlmError } from '../common.js'
import type { RateLimitResetReader } from '../rate-limit.js'
import { freebuffEffortFor } from './catalog.js'

/** The desktop/Bearer origin. `codebuff.com` normalizes to `www.codebuff.com` (`src/upstream.rs:113-118`). */
export const FREEBUFF_API_BASE = 'https://www.codebuff.com'
/** The web/Cookie origin (`src/web_protocol.rs:21`). */
export const FREEBUFF_WEB_BASE = 'https://freebuff.com'

/** Desktop chat completions (`src/upstream.rs:306`). */
export const FREEBUFF_CHAT_PATH = '/api/v1/chat/completions'
/** The desktop session endpoint: create (POST), status (GET), end (DELETE) — `src/upstream.rs:4-6`. */
export const FREEBUFF_SESSION_PATH = '/api/v1/freebuff/session'
/**
 * The desktop agent-run bootstrap. The reference injects a `run_id` it got from
 * here into every chat body (`src/upstream.rs:218-250`, `:294`); this route does
 * NOT perform that bootstrap (see {@link freebuffChatBody}).
 */
export const FREEBUFF_AGENT_RUNS_PATH = '/api/v1/agent-runs'
/** Web chat stream (`src/web_protocol.rs:4`). */
export const FREEBUFF_WEB_CHAT_PATH = '/api/chat/stream'
/** The web quota/session endpoint (`src/web_protocol.rs:6`). */
export const FREEBUFF_WEB_SESSION_PATH = '/api/web/freebuff-session'
/** Web identity endpoint — `user{id,email,name}`, and 200 + `{}` when not signed in (`src/api.rs:5606-5616`). */
export const FREEBUFF_WEB_AUTH_SESSION_PATH = '/api/auth/session'

/**
 * The `User-Agent` the desktop protocol presents (`src/upstream.rs:21`).
 *
 * It is not decoration: it announces the OpenAI-compatible SDK the desktop
 * client uses, and the reference sends it on every Bearer request.
 */
export const FREEBUFF_CLIENT_USER_AGENT = 'ai-sdk/openai-compatible/1.0.25/codebuff'

/** The desktop browser UA the web protocol's fingerprint claims (`src/upstream.rs:20`). */
export const FREEBUFF_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

/** The NextAuth session cookie whose value identifies the browser session. */
export const FREEBUFF_SESSION_COOKIE = '__Secure-next-auth.session-token'

/** Desktop headers this route must present for the session/usage read (`src/upstream.rs:22-29`). */
export const FREEBUFF_SESSION_HEADER = 'x-freebuff-model'
export const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id'
export const FREEBUFF_MULTI_SESSION_HEADER = 'x-freebuff-multi-session'
export const FREEBUFF_INCLUDE_UNUSED_HEADER = 'x-freebuff-include-unused-rate-limits'
export const FREEBUFF_HEARTBEAT_HEADER = 'x-freebuff-heartbeat'

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

/** Which upstream a credential must ride. */
export type FreebuffWire = 'chat-completions' | 'web'

/** The credential fields one request needs. */
export interface FreebuffCredential {
  /** The Bearer token, or the session-token value of a pasted cookie string. */
  accessToken: string
  /** The full `cookie:` header, when the credential came from a browser session. */
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
 * The COOKIE is the stronger signal and is checked first: a credential carrying
 * the session-token cookie is a captured browser session, and the web endpoint is
 * the only one it can reach — its `accessToken` field merely mirrors the
 * session-token VALUE, which is an opaque string that says nothing about the
 * wire by itself. A credential whose only secret is a `Bearer`-shaped token is
 * the desktop shape (`src/import.rs:176-183` classifies exactly this way, by the
 * `session-token` marker).
 *
 * The reference prefers the desktop path over its web bridge when both exist
 * (`src/api.rs:2664-2685`), but that preference is about a POOL holding separate
 * Bearer accounts and separate web cookies — not about one credential. No paste
 * shape produces both, and if one ever did, the cookie is what was actually
 * captured.
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
 * The upstream a credential must ride.
 * @param credential - the stored credential fields.
 * @returns `web` for a cookie credential, `chat-completions` for a Bearer one.
 * @throws {LlmError} `MISSING_CREDENTIAL` when the credential holds no secret.
 */
export function freebuffWireFor(credential: FreebuffCredential): FreebuffWire {
  const kind = freebuffCredentialKind(credential)
  if (kind === undefined) {
    throw new LlmError(
      'Freebuff: the stored credential carries neither a Bearer token nor a freebuff.com cookie. '
      + 'Paste one of the two again in Settings → Subscriptions.',
      'MISSING_CREDENTIAL',
    )
  }
  return kind === 'cookie' ? 'web' : 'chat-completions'
}

/** The chat URL for a wire (`src/upstream.rs:306`, `src/web_protocol.rs:389`). */
export function freebuffChatUrl(wire: FreebuffWire): string {
  return wire === 'web' ? `${FREEBUFF_WEB_BASE}${FREEBUFF_WEB_CHAT_PATH}` : `${FREEBUFF_API_BASE}${FREEBUFF_CHAT_PATH}`
}

/**
 * The session/quota URL for a wire.
 *
 * Both protocols answer the same balance JSON, in different spellings
 * (`src/upstream.rs:4-11` for the desktop shape, `src/web_protocol.rs:6` for the
 * web one) — see `usage.ts`.
 */
export function freebuffSessionUrl(wire: FreebuffWire): string {
  return wire === 'web' ? `${FREEBUFF_WEB_BASE}${FREEBUFF_WEB_SESSION_PATH}` : `${FREEBUFF_API_BASE}${FREEBUFF_SESSION_PATH}`
}

/** FNV-1a 64, the reference's zero-dependency stable hash (`src/web_protocol.rs:23-33`). */
function fnv1a64(value: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * 0x0000_0100_0000_01b3n) & 0xffff_ffff_ffff_ffffn
  }
  return hash
}

/**
 * The seed for a credential's derived fingerprint: the session-token VALUE, or
 * the whole cookie when the marker is absent (`src/web_protocol.rs:35-47`).
 * @param cookie - the cookie header, or a bearer token.
 * @returns the seed string (never leaves this machine).
 */
function freebuffFingerprintSeed(cookie: string): string {
  const parts = cookie.split(';').map(part => part.trim())
  const marker = parts.find(part => part.startsWith(`${FREEBUFF_SESSION_COOKIE}=`))
  return marker === undefined ? cookie : marker.slice(FREEBUFF_SESSION_COOKIE.length + 1)
}

/**
 * The `x-freebuff-instance-id` a credential presents.
 *
 * The reference derives it per credential instead of hardcoding the value it
 * captured, with the note that a MISSING instance header is one of the most
 * easily fingerprinted differences from the real client
 * (`src/web_protocol.rs:49-65`). Same account → same id, different accounts →
 * different ids, computed locally from the session token.
 * @param credential - the credential (cookie or bearer).
 * @returns a UUID-shaped instance id.
 */
export function freebuffInstanceId(credential: string): string {
  const seed = freebuffFingerprintSeed(credential)
  const a = fnv1a64(seed).toString(16).padStart(16, '0')
  const b = fnv1a64(`${seed}#instance`).toString(16).padStart(16, '0')
  const hex = `${a}${b}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * The web protocol's `gravity` fingerprint (`src/web_protocol.rs:215-263`).
 *
 * The reference replaced hardcoded capture values with per-account derived ones
 * for a stated reason: every account sharing one fingerprint is itself a
 * detectable signature. The field shapes and the derivation seeds are ported as
 * found; the values are deterministic per credential, which is what makes them
 * testable.
 * @param credential - the cookie or bearer token.
 * @returns the `gravity` object the web body carries.
 */
export function freebuffGravity(credential: string): Record<string, unknown> {
  const seed = freebuffFingerprintSeed(credential)
  const v = fnv1a64(seed)
  const v2 = fnv1a64(`${seed}#client-ctx`)
  const hex16 = (value: bigint): string => (value & 0xffff_ffff_ffff_ffffn).toString(16).padStart(16, '0')
  const rotateLeft = (value: bigint, bits: bigint): bigint =>
    ((value << bits) | (value >> (64n - bits))) & 0xffff_ffff_ffff_ffffn
  const rotateRight = (value: bigint, bits: bigint): bigint =>
    ((value >> bits) | (value << (64n - bits))) & 0xffff_ffff_ffff_ffffn
  const pick = (salt: number, low: number, high: number): number =>
    low + Number(fnv1a64(`${seed}#${String(salt)}`) % BigInt(high - low + 1))
  const devicePixelRatios = [1, 1.25, 1.5, 2]
  const deviceMemories = [8, 16, 16, 32, 32]
  const hardwareConcurrency = [4, 8, 12, 16, 24]
  return {
    user_data: {
      // `{:016x}` of the FNV and of its rotations, exactly as the reference
      // formats them (`src/web_protocol.rs:224-229`): the width is a MINIMUM
      // there, so a u64 prints all sixteen digits.
      visitor_id: `gruid_${hex16(v)}${hex16(rotateLeft(v, 21n))}`,
      session_id: `gr_sess_${hex16(rotateRight(v, 13n))}${hex16(v ^ 0x9e37_79b9_7f4a_7c15n)}`,
      client_user_agent: FREEBUFF_DESKTOP_USER_AGENT,
    },
    event_source_url: `${FREEBUFF_WEB_BASE}/chat`,
    client_context: {
      timezone: 'Asia/Shanghai',
      screen: { width: pick(1, 1366, 2560), height: pick(2, 768, 1440), color_depth: 24, pixel_depth: 24 },
      viewport: { width: pick(3, 1024, 1600), height: pick(4, 720, 1000) },
      device_pixel_ratio: devicePixelRatios[Number(v2 % 4n)] ?? 1,
      platform: 'Windows',
      device_memory: deviceMemories[Number(v % 5n)] ?? 16,
      hardware_concurrency: hardwareConcurrency[Number(v2 % 5n)] ?? 8,
      max_touch_points: null,
      connection: { effective_type: '4g', downlink: 8.3, rtt: 250, save_data: false },
      font: 'Arial',
      webgl: null,
      fonts: ['Arial', 'Segoe UI', 'Consolas'],
      audio_fingerprint: '0',
      navigator_ext: { languages: ['zh-CN', 'zh'], webdriver: false, pdf_viewer: true, cookies_enabled: true },
      math_fingerprint: '0',
    },
  }
}

/**
 * Headers for one chat request.
 *
 * Differences that are load-bearing:
 *   - the desktop path sends `authorization` + the OpenAI-compatible SDK UA and
 *     NOTHING else (`src/upstream.rs:127-136`); its instance id rides in the
 *     body's `codebuff_metadata` instead (`src/upstream.rs:300-302`);
 *   - the web path sends the cookie header plus `origin`/`referer`/`accept` and
 *     the instance header, because the upstream page always sends those and
 *     their absence is a fingerprint (`src/web_protocol.rs:346-365`).
 * @param credential - the credential fields.
 * @param wire - which upstream this request rides.
 * @returns the header set.
 */
export function freebuffChatHeaders(credential: FreebuffCredential, wire: FreebuffWire): Record<string, string> {
  if (wire === 'web') return freebuffWebHeaders(credential.cookie ?? credential.accessToken)
  return {
    authorization: `Bearer ${credential.accessToken}`,
    'content-type': 'application/json',
    'user-agent': FREEBUFF_CLIENT_USER_AGENT,
  }
}

/** The web protocol's common header set (`src/web_protocol.rs:346-365`). */
function freebuffWebHeaders(cookie: string, options: { json?: boolean } = {}): Record<string, string> {
  return {
    cookie,
    origin: FREEBUFF_WEB_BASE,
    referer: `${FREEBUFF_WEB_BASE}/chat`,
    accept: '*/*',
    [FREEBUFF_INSTANCE_HEADER]: freebuffInstanceId(cookie),
    ...options.json === true ? { 'content-type': 'application/json' } : {},
  }
}

/**
 * Headers for the balance/session read.
 *
 * The desktop read needs three headers beyond auth: the instance id it is
 * querying, `x-freebuff-multi-session: 1`, and — this one is easy to miss —
 * `x-freebuff-include-unused-rate-limits: 1`, without which the response omits
 * the per-model `rateLimitsByModel` rows entirely (`src/upstream.rs:138-152`).
 *
 * The instance id is DERIVED from the credential here rather than kept in a
 * store: the reference persists one per account, and a deterministic derivation
 * gives the same stability (same account → same value, forever) with nothing to
 * persist. `options.instanceId` overrides it for a caller that does keep one.
 * @param credential - the credential fields.
 * @param wire - which upstream this read uses.
 * @param options - `heartbeat` adds the keepalive flag (see `freebuff-session.ts`).
 * @returns the header set.
 */
export function freebuffSessionHeaders(
  credential: FreebuffCredential,
  wire: FreebuffWire,
  options: { heartbeat?: boolean, instanceId?: string } = {},
): Record<string, string> {
  if (wire === 'web') return freebuffWebHeaders(credential.cookie ?? credential.accessToken)
  const instance = options.instanceId ?? freebuffInstanceId(credential.accessToken)
  return {
    authorization: `Bearer ${credential.accessToken}`,
    'content-type': 'application/json',
    'user-agent': FREEBUFF_CLIENT_USER_AGENT,
    [FREEBUFF_MULTI_SESSION_HEADER]: '1',
    [FREEBUFF_INCLUDE_UNUSED_HEADER]: '1',
    [FREEBUFF_INSTANCE_HEADER]: instance,
    // The keepalive is a request-level flag on this SAME GET, not a separate
    // endpoint (`src/upstream.rs:183-193`, `src/session.rs:7`).
    ...options.heartbeat === true ? { [FREEBUFF_HEARTBEAT_HEADER]: '1' } : {},
  }
}

/** Everything {@link freebuffChatBody} needs to shape one desktop request. */
export interface FreebuffChatBodyInput {
  model: string
  messages: readonly Record<string, unknown>[]
  tools?: readonly Record<string, unknown>[]
  maxTokens?: number
  /** The level the caller asked for, before the ladder rule is applied. */
  reasoningEffort?: string
  /** The credential, so the body's instance id matches the account. */
  credential: string
  /**
   * The run id the reference would have obtained from `POST /api/v1/agent-runs`.
   *
   * Absent for this route: it does not run that bootstrap (see the module doc).
   * The field is injected when a caller HAS one, so the omission is explicit
   * rather than silently dropped.
   */
  runId?: string
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
 * object into it, adding `run_id`, `cost_mode: "free"`, a fresh `client_id` and
 * the instance id (`src/upstream.rs:288-304`). This builds the same shape from
 * what the hub has: `cost_mode` and `client_id` are produced here, the instance
 * id is derived from the credential, and `run_id` is injected only when the
 * caller supplies one — the agent-run bootstrap (`src/upstream.rs:218-250`) is
 * NOT performed by this route, so claiming a run id would be an invented value.
 * @param input - the request fields.
 * @returns the JSON body to send.
 */
export function freebuffChatBody(input: FreebuffChatBodyInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: [...input.messages],
    ...input.tools === undefined || input.tools.length === 0 ? {} : { tools: [...input.tools] },
    ...input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens },
    ...freebuffEffortBodyField(input.model, input.reasoningEffort),
    stream: true,
    codebuff_metadata: {
      cost_mode: 'free',
      client_id: freebuffClientSessionId(),
      freebuff_instance_id: freebuffInstanceId(input.credential),
      ...input.runId === undefined ? {} : { run_id: input.runId },
    },
  }
}

/** An opaque per-request client session id, shaped like the reference's (`src/upstream.rs:296-299`). */
function freebuffClientSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Everything {@link freebuffWebBody} needs. */
export interface FreebuffWebBodyInput {
  model: string
  /** The last user message's text: the web protocol takes ONE string, not a message array. */
  content: string
  credential: string
  reasoningEffort?: string
  /** An upstream thread to continue, when one is known. */
  threadId?: string
}

/**
 * The web (cookie) request body — an entirely different shape from the desktop
 * one (`src/web_protocol.rs:380-388`): a single `content` string rather than a
 * message array, `camelCase` keys, and a `gravity` fingerprint.
 *
 * There is deliberately no `tools` key here, and there must not be one: the wire
 * has no channel for caller-declared tools (see the module doc, and the live
 * check recorded there that upstream ignores one bolted on anyway). Tool usage on
 * this wire is upstream-side — Freebuff runs its OWN tools and the calls it emits
 * for them are dropped with a one-per-stream warning, never forwarded as harness
 * tool calls (module doc). A caller that declares tools is refused before this
 * body is built ({@link freebuffWebToolRefusal}).
 *
 * The effort rides as `reasoningEffort` because that is the web protocol's own
 * spelling of the field. The reference's bridge sends `null` there
 * (`src/api.rs:1118` passes `None`), so forwarding the clamped level is an
 * EXTENSION of the reference rather than a ported behaviour — chosen because
 * dropping a level the user explicitly picked, silently, is the failure the
 * whole ladder mechanism exists to prevent.
 * @param input - the request fields.
 * @returns the JSON body to send.
 */
export function freebuffWebBody(input: FreebuffWebBodyInput): Record<string, unknown> {
  const level = freebuffEffortFor(input.model, input.reasoningEffort)
  return {
    threadId: input.threadId ?? null,
    content: input.content,
    model: input.model,
    reasoningEffort: level ?? null,
    gravity: freebuffGravity(input.credential),
    images: [],
    attachments: [],
  }
}

/**
 * The refusal a caller that declares tools receives on the web wire.
 *
 * Failing here is the whole point: the alternative is what this route used to do
 * — send the flattened prompt WITHOUT the schemas, and let the model answer as a
 * plain chat assistant whose "available tools" are Freebuff's own server-side
 * agents. That silent downgrade is indistinguishable, from the session, from a
 * model that simply chose not to call a tool, and it costs the user every local
 * capability (file read/write, shell, glob/grep) without saying so.
 *
 * The message names the wire fact (no `tools` field), the observed upstream
 * behaviour, and the only tool-carrying alternative, so the reader can act.
 * @param toolCount - how many tool schemas the refused turn declared.
 * @returns the error to throw, before any upstream call is made.
 */
export function freebuffWebToolRefusal(toolCount: number): LlmError {
  return new LlmError(
    `Freebuff (web protocol) cannot carry tools: ${String(toolCount)} tool schema(s) were declared, but this wire `
    + 'takes one flat prompt string with no `tools` field (ref-freebuff2api/src/web_protocol.rs:380-388), so the '
    + 'model would receive none of them and would answer as a plain chat assistant with no file, shell or search '
    + 'tools — verified against the live upstream on 2026-09-28: a `tools` array added to the web body is ignored '
    + 'and the model reports only its own server-side tools. Tool-carrying turns need the desktop/Bearer protocol '
    + '(src/upstream.rs:281-315), which a freebuff.com cookie cannot ride (src/api.rs:1809-1813 keeps web cookies '
    + 'out of the Bearer pool; live 2026-09-28 the desktop wire\'s free mode answers HTTP 403 '
    + '`free_mode_cli_required` to direct API callers anyway). Use another route for tool-using turns.',
    'UNSUPPORTED',
  )
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
 * One event's text payload, VERBATIM.
 *
 * Deliberately not trimmed: a delta's leading or trailing space is part of the
 * answer — the reference pushes `text` straight through (`src/web_protocol.rs:879-884`),
 * and trimming " world" to "world" glues words together in the rendered reply.
 * @param value - the raw field.
 * @returns the text, or undefined when the field was absent or empty.
 */
function freebuffTextOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The reference's text-rule classification, as an `LlmError`.
 *
 * Rules and their order are `src/errors.rs:157-178` — waiting room, then rate
 * limit, then model-not-available, then auth, then bad request — and the status
 * is only the FALLBACK (`src/errors.rs:180-191`), because a 200 body can carry
 * any of them.
 *
 * Two mappings deserve their own line:
 *   - `queue` alone is a waiting room only on a 429/503 (`src/errors.rs:158-162`);
 *   - the model-unavailable words become `HTTP_404`, not `SERVER`: the reference's
 *     own status table maps 404 to "model unavailable" (`src/errors.rs:186`) and
 *     this is a non-retryable, wrong-model condition, so a 4xx-family code is what
 *     keeps the retry plugin from hammering a model upstream has withdrawn.
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
  // The free tier's single request slot (`src/semaphore.rs:27-33`) is the most
  // specific refusal of the lot, so it is tested before the generic rate-limit
  // words its own text happens to contain.
  if (has('concurrency_busy')) {
    return new LlmError(message, 'RATE_LIMIT', {
      status,
      providerRetryAfterMs: FREEBUFF_CONCURRENCY_BUSY_RETRY_MS,
    })
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
 * The reference feeds a 200 body straight into its SSE parser, and a refused
 * call then produces zero events — which is how a gateway policy refusal gets
 * reported as "the stream ended early" (`src/joycode`'s twin bug is documented
 * for the sibling route; here the evidence is the same shape of body). The
 * `{"error": …}` envelope is also what the web protocol can deliver in-band, so
 * this sniffs the OPENING of a body before any parser sees it.
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
 * refusal. The reference's own sibling guard tests for `choices`/`type` before
 * classifying a body for exactly this reason.
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
      // `object`/`choices`/`usage` are the desktop protocol's chunk fields and
      // `type` is the web protocol's event tag (`src/web_protocol.rs:84-95`).
      // Testing for `type` matters as much as the other three: without it, a WEB
      // event whose model output happens to contain the words "rate limit" would
      // be read as a refusal and end a healthy turn.
      if (record.choices !== undefined || record.usage !== undefined
        || record.object !== undefined || record.type !== undefined) {
        sawFrame = true
      }
    }
  }
  return sawFrame ? { kind: 'frame' } : undefined
}

/**
 * Wrap an upstream body stream so a refusal delivered inside a 200 CANNOT reach
 * the SSE translator.
 *
 * This upstream answers a refused call with HTTP 200 and a JSON body — one bare
 * object, no SSE framing at all — and a 200 body handed to a stream parser
 * produces zero events, which surfaces as "the stream ended before a finish
 * chunk": a message about the wrong thing entirely. The decision is made once,
 * on the opening bytes, and every later byte is passed through untouched.
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
 * Whether a body is the web protocol's in-band session refusal.
 *
 * `src/api.rs:5618-5621` is the source: `/api/web/freebuff-session` answers 401
 * for a bad credential, and an authenticated answer always carries `accessTier`
 * or `freebucks` — so a body with neither is a refusal, not an empty account.
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
 * One message as the web prompt flattener needs it.
 *
 * `role` is a hub message role, plus ONE route-local addition: `tool-call`, the
 * assistant's half of a tool exchange. The web wire has no `tool_calls` field, so
 * an assistant turn that called a tool can only survive as a labelled text part —
 * see {@link freebuffWebPrompt}.
 */
export interface FreebuffPromptMessage {
  role: string
  /** The message's own text, already extracted from its content blocks. */
  text: string
}

/** The role labels the flattener prefixes (`src/web_threads.rs:240-245`). */
const FREEBUFF_PROMPT_LABELS: Record<string, string> = {
  assistant: '[助手]',
  tool: '[工具结果]',
  // NOT in the reference: the reference's web bridge never has to render a
  // client tool call, because its own clients cannot pass tools through this
  // wire (module doc) and `flatten_messages` therefore only ever sees text
  // (`src/web_threads.rs:181-200` drops every non-text content part, assistant
  // `tool_calls` included). This route renders the call instead of dropping it,
  // so the `[工具结果]` that follows keeps its antecedent — the body is the
  // reference's own `{name}: {label}` rendering of a tool
  // (`src/web_protocol.rs:991`), with the call's arguments in the label slot.
  'tool-call': '[工具调用]',
}

/**
 * Flatten a conversation into the single `content` string the web protocol
 * takes.
 *
 * The web endpoint accepts ONE string, not a message array, so a conversation
 * has to be rendered into text. The rendering is the reference's own
 * (`src/web_threads.rs:172-254`) and it is specific enough to be worth following
 * exactly rather than reinventing:
 *
 *   - `system`/`developer` messages are pulled out (the FIRST one only) and
 *     prefixed `[系统指令]`;
 *   - a conversation of exactly ONE non-system message is sent VERBATIM — no
 *     role labels, no joining, because the common case is a client sending just
 *     the current user turn;
 *   - anything longer is labelled per message: `[用户]`, `[助手]`, `[工具结果]`
 *     (everything unrecognized counts as user), joined with a blank line;
 *   - an empty last user message yields `undefined`, which the caller must treat
 *     as a bad request rather than sending an empty prompt.
 *
 * One label is an extension beyond the reference and is marked where it is
 * defined: a `tool-call` part, which keeps an assistant's tool call in the
 * transcript instead of dropping it ({@link FREEBUFF_PROMPT_LABELS}). The
 * `[工具结果]` side is a straight port — the reference labels tool results in
 * exactly this text form (`src/web_threads.rs:242`) precisely because the wire
 * has nowhere else to put them.
 * @param messages - the conversation, in order.
 * @returns the flattened prompt, or undefined when there is nothing to send.
 */
export function freebuffWebPrompt(messages: readonly FreebuffPromptMessage[]): string | undefined {
  const text = (message: FreebuffPromptMessage): string | undefined => {
    const trimmed = message.text.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const lastUser = [...messages].reverse().find(message => message.role === 'user')
  if (lastUser === undefined || text(lastUser) === undefined) return undefined
  const systems: string[] = []
  const rest: FreebuffPromptMessage[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const body = text(message)
      if (body !== undefined) systems.push(body)
      continue
    }
    rest.push(message)
  }
  const parts: string[] = []
  const first = systems[0]
  if (first !== undefined) parts.push(`[系统指令]\n${first}`)
  if (rest.length === 1) {
    const only = rest[0]
    const body = only === undefined ? undefined : text(only)
    if (body !== undefined) parts.push(body)
  } else {
    for (const message of rest) {
      const body = text(message)
      if (body === undefined) continue
      const label = FREEBUFF_PROMPT_LABELS[message.role] ?? '[用户]'
      parts.push(`${label}\n${body}`)
    }
  }
  const prompt = parts.join('\n\n')
  return prompt.trim() === '' ? undefined : prompt
}

/**
 * Where the reference tops up its model roster from (`src/models.rs:566`).
 *
 * It is a public TypeScript constant file in the upstream client's repository,
 * NOT a credentialed API: there is no model-list endpoint on either protocol this
 * route can read.
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

/**
 * One OpenAI chat-completions chunk, as the hub's translator reads it.
 *
 * The shape is the reference's own (`src/web_protocol.rs:906-924`), including
 * the `object` field and `index: 0`: it is what makes the converted web stream
 * indistinguishable from the desktop protocol's SSE.
 */
function freebuffChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/** The web protocol's event `type` values this translator acts on (`src/web_protocol.rs:95-162`). */
export const FREEBUFF_WEB_EVENT_TYPES: readonly string[] = [
  'meta',
  'title',
  'reasoning_delta',
  'delta',
  'suggestions',
  'agent_start',
  'agent_tool',
  'agent_tool_done',
  'agent_delta',
  'agent_finish',
  'button',
  'done',
]

/** Options for {@link freebuffWebToChatCompletions}. */
export interface FreebuffWebTranslatorOptions {
  /** Diagnostic prefix for an in-band refusal. */
  label: string
  /** Called on every received byte, to keep the idle watchdog fed. */
  onActivity?: () => void
  /** Called when an event names the upstream thread, for a caller that reuses it. */
  onThread?: (threadId: string) => void
  /**
   * Called ONCE per stream when upstream fires a tool call of its OWN, which this
   * translator drops (module doc). Never called per event: one turn can carry
   * several such calls, and they are the same fact about the same turn.
   */
  onWarn?: (message: string) => void
}

/**
 * Translate the web protocol's SSE into OpenAI chat-completions SSE.
 *
 * This is the ONE parser this route owns. The reference does exactly this
 * conversion in `StreamEncoder::encode_block` (`src/web_protocol.rs:843-930`) and
 * its event→chunk mapping is ported here field for field, with ONE deliberate
 * exception:
 *
 *   - `delta.text` → `delta.content`;
 *   - `agent_delta.text` → `delta.content` TOO, not dropped: the reference's
 *     comment records that tool-produced prose arrives on this event
 *     (`src/web_protocol.rs:880-883`), so treating it as a private channel loses
 *     the model's answer;
 *   - `reasoning_delta.text` → `delta.reasoning_content`, emitted BEFORE the
 *     content chunks of the same event block (`src/web_protocol.rs:906-918`);
 *   - `agent_tool` → NOTHING on the wire. It is a call Freebuff ran on its own
 *     side, and the harness cannot run it — the whole case is in the module doc,
 *     and the warning it raises is the only trace it leaves;
 *   - `done` → a terminal chunk whose `finish_reason` is ALWAYS `stop`, then the
 *     `[DONE]` sentinel (`src/web_protocol.rs:830-841`, `:925-928`). The
 *     reference finishes `tool_calls` when any tool fired; that reason is what
 *     tells a client to go run something and come back, which is precisely the
 *     dangling state this route must not create (module doc);
 *   - `meta`/`title` → the thread id, and nothing on the wire;
 *   - `suggestions`, `button`, `agent_start`, `agent_finish`, `agent_tool_done`
 *     and unknown types → ignored, like the reference's `_ => {}` arm.
 *
 * Two further divergences, both because the hub's translator has no channel they
 * would fit in:
 *   - an in-band `{"error": …}` envelope ERRORS the stream with the upstream's
 *     own words. The reference merely records it in a side slot
 *     (`src/web_protocol.rs:859-874`) because its own bridge forwards raw events;
 *   - an upstream EOF WITHOUT `done` still emits the terminal chunk, which the
 *     reference also does (`src/web_protocol.rs:454-461`) — that one is a port.
 * @param stream - the upstream body stream.
 * @param options - label, activity pulse, thread sink, dropped-tool warning sink.
 * @returns a stream carrying OpenAI chat-completions SSE.
 */
export function freebuffWebToChatCompletions(
  stream: ReadableStream<Uint8Array>,
  options: FreebuffWebTranslatorOptions,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state: FreebuffWebState = { buffer: '', finished: false, droppedUpstreamTool: false }
  // The finish is ALWAYS a normal completion, even when upstream said
  // `tool_calls`: see the module doc for why that reason must not reach DSH here.
  const finishChunk = (): string => freebuffChunk({}, 'stop') + 'data: [DONE]\n\n'
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      options.onActivity?.()
      state.buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const boundary = freebuffEventBoundary(state.buffer)
        if (boundary === -1) break
        const block = state.buffer.slice(0, boundary)
        state.buffer = state.buffer.slice(boundary)
        const translated = freebuffTranslateEventBlock(block, state, options)
        if (translated.error !== undefined) {
          controller.error(translated.error)
          return
        }
        if (translated.text !== '') controller.enqueue(encoder.encode(translated.text))
        if (translated.done) state.finished = true
      }
    },
    flush(controller) {
      // An upstream that ends without `done` still owes the caller a terminal
      // chunk, or the hub's translator reports a truncated stream
      // (`src/web_protocol.rs:454-461`).
      if (!state.finished) controller.enqueue(encoder.encode(finishChunk()))
    },
  }))
}

/** Translator state for ONE upstream stream. */
interface FreebuffWebState {
  /** Bytes received but not yet a complete SSE event block. */
  buffer: string
  /** Whether the upstream's own `done` event was seen. */
  finished: boolean
  /** Whether the dropped-upstream-tool warning was already emitted. */
  droppedUpstreamTool: boolean
}

/** The offset just past the first SSE event boundary, or -1. */
function freebuffEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4
  if (crlf === -1) return lf + 2
  return Math.min(lf + 2, crlf + 4)
}

/** One event block → OpenAI chunk text (plus an error, when one is in band). */
function freebuffTranslateEventBlock(
  block: string,
  state: FreebuffWebState,
  options: FreebuffWebTranslatorOptions,
): { text: string, done: boolean, error?: LlmError } {
  const reasoning: string[] = []
  const content: string[] = []
  let done = false
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice('data:'.length).trim()
    if (payload === '' || payload === '[DONE]') continue
    const value = tryJson(payload)
    if (value === undefined) continue
    const envelope = freebuffErrorEnvelope(value)
    if (envelope !== undefined) {
      const refusal = freebuffTextError(200, JSON.stringify(envelope), options.label)
        ?? new LlmError(
          `${options.label} refused the call in-band: ${envelope.message}`,
          'HTTP_200',
        )
      return { text: '', done: false, error: refusal }
    }
    if (typeof value !== 'object' || value === null) continue
    const event = value as Record<string, unknown>
    const type = typeof event.type === 'string' ? event.type : ''
    switch (type) {
      case 'reasoning_delta': {
        const text = freebuffTextOf(event.text)
        if (text !== undefined) reasoning.push(text)
        break
      }
      case 'delta': {
        const text = freebuffTextOf(event.text)
        if (text !== undefined) content.push(text)
        break
      }
      case 'agent_delta': {
        const text = freebuffTextOf(event.text)
        if (text !== undefined) content.push(text)
        break
      }
      case 'agent_tool': {
        // Freebuff's OWN server-side tool call: the upstream already ran it, and
        // nothing here asks this client to run anything. Faithfully translated
        // (the reference's `tool_slot`/`encode_block`, `src/web_protocol.rs:811-828`,
        // `:885-898`), it becomes a harness `tool-call` block for a tool this
        // route never declared and the harness has no handler for — which breaks
        // the turn. Dropped instead, and reported ONCE per stream: the module doc
        // carries the live evidence (four `web_search` calls in one turn,
        // `arguments:"{}"`, `finish_reason: tool_calls`) and why the reference's
        // mapping serves a different consumer.
        const name = freebuffFirstString(event.toolName)
        if (name === undefined) break
        if (!state.droppedUpstreamTool) {
          state.droppedUpstreamTool = true
          options.onWarn?.(
            `freebuff: upstream ran its own tool "${name}"; this route does not forward upstream-only tool calls`,
          )
        }
        break
      }
      case 'meta':
      case 'title': {
        const threadId = freebuffFirstString(event.threadId)
        if (threadId !== undefined) options.onThread?.(threadId)
        break
      }
      case 'done':
        done = true
        break
      default:
        // Every other event type is deliberately dropped, matching the
        // reference's catch-all arm (`src/web_protocol.rs:903`).
        break
    }
  }
  let text = ''
  for (const value of reasoning) text += freebuffChunk({ reasoning_content: value }, null)
  for (const value of content) text += freebuffChunk({ content: value }, null)
  // Never `tool_calls`, whatever upstream's own finish reason was: the harness
  // must not be told to wait for a tool result on this wire (module doc).
  if (done) text += freebuffChunk({}, 'stop') + 'data: [DONE]\n\n'
  return { text, done }
}

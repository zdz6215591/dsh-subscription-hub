/**
 * JoyCode (京东) HTTP client surface: URL construction, headers, request
 * envelope, credential validation and error classification.
 *
 * Protocol taken from the reference implementation
 * (`ref-joycode2api/pkg/joycode/client.go`), which reverse-engineered it from
 * JoyCode 2.7.5 / joycoder-editor 3.8.57 and `ref-switch-dev`, the second
 * reference that ported the same protocol.
 *
 * ## Two URL shapes, chosen by the credential
 *
 * - **Gateway** (what a logged-in IDE credential carries): the request goes to
 *   `{colorBaseUrl}/api?appid=joycode_ide&functionId=…&t=…&sign=…`, where the
 *   signature is HMAC-SHA256 over `joycode_ide&<functionId>&<t>` with a key
 *   published in the IDE bundle. Routing is by `functionId`, so the v2 path does
 *   NOT appear in the URL.
 * - **Direct**: `{masterBaseUrl|default}{v2Path}` with no signature — what a
 *   hand-entered ptKey uses when the credential named no gateway.
 *
 * @module dsh-subscription-hub/providers/joycode/client
 */

import { createHmac } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Product identity every JoyCode request presents. */
export const JOYCODE_CLIENT_VERSION = '2.7.5'

/**
 * The `User-Agent` this route presents, for one client version.
 *
 * The version rides in the UA as well as the body: the gateway's gray-release
 * gate reads it, which is why the second reference reads the installed
 * extension's version instead of hardcoding this one.
 * @param version - the client version to claim.
 * @returns the user-agent string.
 */
export function joyCodeUserAgent(version: string): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) '
    + `JoyCode/${version} Chrome/133.0.0.0 Electron/35.2.0 Safari/537.36`
}

/** The UA for a credential, using the version it carries when it carries one. */
function userAgentFor(credential: JoyCodeCredential): string {
  return joyCodeUserAgent(credential.clientVersion ?? JOYCODE_CLIENT_VERSION)
}

/** Direct API origin, used when the credential names no gateway. */
export const JOYCODE_API_BASE = 'https://joycode-api.jd.com'
/** Product identity pinged by `whoami`-style diagnostics. */
export const JOYCODE_COLOR_BASE = 'https://api-ai.jd.com'

/** The gateway's published app id, path and HMAC key. */
const GATEWAY_APP_ID = 'joycode_ide'
const GATEWAY_PATH = '/api'
const GATEWAY_HMAC_KEY = '0691a3f0b37b4a85aeb63ad0fc7db3ed'

/** Default `loginType` per path (the two paths disagree upstream). */
export const JOYCODE_LOGIN_TYPE = 'N_PIN_PC'
export const JOYCODE_ANTHROPIC_LOGIN_TYPE = 'PIN_JD_CLOUD'

/** Default `tenant` per path. */
export const JOYCODE_TENANT = 'JOYCODE'
export const JOYCODE_ANTHROPIC_TENANT = 'JD'

/** The Claude path's `max_tokens` ceiling; the reference clamps here. */
export const JOYCODE_ANTHROPIC_MAX_TOKENS = 32_768

/** What the credential must carry to reach the API. */
export interface JoyCodeCredential {
  /** The `ptKey` request header — the whole credential. */
  ptKey: string
  /**
   * Numeric JoyCode user id, carried in the request envelope.
   *
   * Absent until `userInfo` has been read: the browser/QR login hands back only
   * a `ptKey`, and the id comes from that call. A credential without one can
   * still be validated — it just cannot send a request yet.
   */
  userId?: string
  /** Gateway origin from the credential; when present, requests are signed. */
  colorBaseUrl?: string
  /** Direct API origin override from the credential. */
  masterBaseUrl?: string
  /** Tenant override (`JOYCODE` / `JD` by default, per path). */
  tenant?: string
  /** `loginType` override (`N_PIN_PC` / `PIN_JD_CLOUD` by default, per path). */
  loginType?: string
  /** Organization display name, when the account has one. */
  orgFullName?: string
  /** Separate Anthropic-path ptKey, when the IDE stored one. */
  anthropicPtKey?: string
  /**
   * The JoyCode client version to present.
   *
   * Absent means the protocol constant. An imported credential carries the
   * INSTALLED extension's version instead, because the gateway's gray-release
   * gate trusts that one (see `credentials.ts`).
   */
  clientVersion?: string
}

/** The endpoints this route calls, with the `functionId` gateway routing needs. */
export const JOYCODE_ENDPOINTS = {
  chat: { functionId: 'chat_completions', path: '/api/saas/openai/v2/chat/completions' },
  responses: { functionId: 'responses_completions', path: '/api/saas/openai/v1/responses' },
  anthropic: { functionId: 'anthropic_completions', path: '/api/saas/anthropic/v1/messages' },
  models: { functionId: 'joycode_modelList', path: '/api/saas/models/v2/modelList' },
  userInfo: { functionId: 'joycode_userInfo', path: '/api/saas/user/v2/userInfo' },
} as const

/** One callable endpoint of {@link JOYCODE_ENDPOINTS}. */
export type JoyCodeEndpoint = keyof typeof JOYCODE_ENDPOINTS

/**
 * The gateway signature and query for one call.
 *
 * The canonical string is the parameters' values in key order
 * (`appid`, `functionId`, `t`) joined with `&`, HMAC-SHA256'd with the IDE's key
 * and hex-encoded. The timestamp is milliseconds — the upstream rejects a
 * seconds value as stale.
 * @param functionId - the gateway function being called.
 * @param now - injectable clock, for tests.
 * @returns the query string and the signature.
 */
export function joyCodeGatewaySign(functionId: string, now: number = Date.now()): { query: string, sign: string } {
  const timestamp = String(now)
  const sign = createHmac('sha256', GATEWAY_HMAC_KEY)
    .update(`${GATEWAY_APP_ID}&${functionId}&${timestamp}`)
    .digest('hex')
  return { query: `appid=${GATEWAY_APP_ID}&functionId=${functionId}&t=${timestamp}`, sign }
}

/**
 * The URL one request goes to.
 *
 * A credential that carries `colorBaseUrl` gets the SIGNED gateway form (routing
 * by `functionId`); anything else gets the direct v2 path on `masterBaseUrl`,
 * falling back to the public origin.
 * @param credential - the account's credential.
 * @param endpoint - which callable to address.
 * @param now - injectable clock, for tests.
 * @returns the absolute request URL.
 */
export function joyCodeUrl(credential: JoyCodeCredential, endpoint: JoyCodeEndpoint, now?: number): string {
  const { functionId, path } = JOYCODE_ENDPOINTS[endpoint]
  const gateway = credential.colorBaseUrl?.trim()
  if (gateway !== undefined && gateway !== '') {
    const parsed = safeUrl(gateway)
    if (parsed !== undefined) {
      const basePath = parsed.pathname.replace(/\/+$/, '')
      const { query, sign } = joyCodeGatewaySign(functionId, now)
      return `${parsed.origin}${basePath}${GATEWAY_PATH}?${query}&sign=${sign}`
    }
  }
  const base = credential.masterBaseUrl?.trim()
  return `${(base === undefined || base === '' ? JOYCODE_API_BASE : base).replace(/\/+$/, '')}${path}`
}

function safeUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value)
    return parsed.host === '' ? undefined : parsed
  } catch {
    return undefined
  }
}

/**
 * Request headers for one call.
 *
 * `Accept-Encoding: identity` on a STREAM is load-bearing: gzip is buffered by
 * the upstream until a block completes, which turns a live SSE stream into one
 * late dump (the reference says the same for its own gzip reader).
 * @param credential - the account's credential.
 * @param options - which path, and whether this call streams.
 * @returns the header set.
 */
export function joyCodeHeaders(
  credential: JoyCodeCredential,
  options: { anthropic?: boolean, stream?: boolean } = {},
): Record<string, string> {
  const anthropic = options.anthropic === true
  const ptKey = anthropic && credential.anthropicPtKey !== undefined && credential.anthropicPtKey !== ''
    ? credential.anthropicPtKey
    : credential.ptKey
  const loginType = credential.loginType !== undefined && credential.loginType !== ''
    ? credential.loginType
    : anthropic ? JOYCODE_ANTHROPIC_LOGIN_TYPE : JOYCODE_LOGIN_TYPE
  return {
    'content-type': anthropic ? 'application/json; charset=utf-8' : 'application/json; charset=UTF-8',
    'source-type': 'joycoder-ide',
    ptkey: ptKey,
    logintype: loginType,
    'user-agent': userAgentFor(credential),
    accept: '*/*',
    'accept-encoding': options.stream === true ? 'identity' : 'gzip, deflate',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

/**
 * The product envelope every JoyCode body carries, merged UNDER the request body.
 *
 * The two paths disagree on defaults (`JOYCODE` vs `JD`, `N_PIN_PC` vs
 * `PIN_JD_CLOUD`), so the caller says which it is; a credential that carries its
 * own tenant/loginType overrides both.
 * @param credential - the account's credential.
 * @param options - which path, and whether `stream` is forced into the envelope.
 * @returns the envelope fields.
 */
export function joyCodeEnvelope(
  credential: JoyCodeCredential,
  options: { anthropic?: boolean } = {},
): Record<string, unknown> {
  const anthropic = options.anthropic === true
  const tenant = credential.tenant !== undefined && credential.tenant !== ''
    ? credential.tenant
    : anthropic ? JOYCODE_ANTHROPIC_TENANT : JOYCODE_TENANT
  return {
    tenant,
    orgFullName: credential.orgFullName ?? '',
    userId: credential.userId ?? '',
    client: 'JoyCode',
    clientVersion: credential.clientVersion ?? JOYCODE_CLIENT_VERSION,
    language: 'UNKNOWN',
  }
}

/** The `{ code, msg, data }` envelope JoyCode answers with. */
export interface JoyCodeEnvelope {
  code?: number
  msg?: string
  data?: unknown
}

/** Parse a JoyCode JSON body, keeping the business `code`/`msg` when present. */
export function parseJoyCodeEnvelope(payload: unknown): JoyCodeEnvelope | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : undefined
  const msg = typeof record.msg === 'string' ? record.msg : undefined
  return { ...code === undefined ? {} : { code }, ...msg === undefined ? {} : { msg }, data: record.data }
}

/** Upstream business codes this route can name, so a failure is diagnosable. */
const BUSINESS_CODES: Readonly<Record<string, string>> = {
  // A Claude label sent without its `-hq` internal id.
  '6002': 'this Claude model needs its "-hq" internal id (see providers/joycode/catalog.ts)',
  // A GPT-family model sent to the chat path instead of the Responses path.
  '1032': 'the GPT family is served by the Responses path, not chat completions',
}

/**
 * The gray-release gate's refusal wording.
 *
 * JoyCode rolls model access out in waves and answers an account outside the
 * wave with a policy string rather than a status: the second reference treats
 * `COLOR_FORWARD_EXCEPTION` and `AI_GRAY_ACCESS_DENIED` as "this account cannot
 * be served right now" and switches chains on it. Named here because the raw
 * string looks like a server fault, which would send a reader hunting for a bug
 * that does not exist.
 */
const GRAY_GATE = /(AI_GRAY_ACCESS_DENIED|COLOR_FORWARD_EXCEPTION)/i

/**
 * Whether a body carries the gray-release refusal.
 * @param body - the raw response body, or a business `msg`.
 * @returns true when the upstream named its gray gate.
 */
export function isJoyCodeGrayRefusal(body: string): boolean {
  return GRAY_GATE.test(body)
}

/** The error for a gray-release refusal, which is a policy answer, not a fault. */
function grayRefusal(label: string, body: string): LlmError {
  return new LlmError(
    `${label}: the JoyCode gray-release gate refused this account or client version `
    + `(${body.slice(0, 200).trim()}). The model is being rolled out in waves; retry later or sign in with an account already in the wave.`,
    'SERVER',
  )
}

/**
 * Classify a failed JoyCode response.
 *
 * The upstream reports most business failures as a 200 with `{code, msg}`, but a
 * rejected request also arrives as a non-2xx whose body CARRIES that envelope —
 * so the envelope is quoted when present and the status is mapped otherwise. The
 * two known codes are named rather than left as raw numbers, because both mean
 * "wrong model id / wrong path for this model", which is a bug in this route
 * rather than something the user can act on.
 * @param status - HTTP status.
 * @param body - the raw response body.
 * @param label - diagnostic prefix.
 * @returns the classified error.
 */
export function joyCodeHttpError(status: number, body: string, label: string): LlmError {
  const shown = body.slice(0, 400)
  if (isJoyCodeGrayRefusal(shown)) return grayRefusal(label, shown)
  const envelope = businessCodeIn(body)
  const hint = envelope?.code === undefined ? undefined : BUSINESS_CODES[String(envelope.code)]
  const details = [
    envelope?.code === undefined ? '' : `code ${String(envelope.code)}${envelope.msg === undefined ? '' : `: ${envelope.msg}`}`,
    hint ?? '',
    envelope === undefined ? shown : '',
  ].filter(part => part !== '').join(' · ')
  const message = `${label} error (HTTP ${String(status)})${details === '' ? '' : `: ${details}`}`
  if (status === 401 || status === 403) return new LlmError(message, 'AUTH', { status })
  if (status === 429) return new LlmError(message, 'RATE_LIMIT', { status })
  if (status === 408 || status === 504) return new LlmError(message, 'TIMEOUT', { status })
  if (status >= 500) return new LlmError(message, 'SERVER', { status })
  return new LlmError(message, `HTTP_${String(status)}`, { status })
}

/** The business `code` inside a body that may or may not be an envelope. */
function businessCodeIn(body: string): { code?: number, msg?: string } | undefined {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const envelope = parseJoyCodeEnvelope(parsed)
    if (envelope === undefined || envelope.code === undefined) return undefined
    return { code: envelope.code, ...envelope.msg === undefined ? {} : { msg: envelope.msg } }
  } catch {
    return undefined
  }
}

/**
 * Classify a JoyCode BUSINESS error delivered inside a 200 response.
 * @param payload - the parsed body.
 * @param label - diagnostic prefix.
 * @returns the error to throw, or undefined when the envelope reports success.
 */
export function joyCodeBusinessError(payload: unknown, label: string): LlmError | undefined {
  const envelope = parseJoyCodeEnvelope(payload)
  if (envelope?.code === undefined || envelope.code === 0) return undefined
  const detail = `${envelope.msg ?? ''} ${JSON.stringify(envelope.data ?? '')}`
  if (isJoyCodeGrayRefusal(detail)) return grayRefusal(label, detail)
  const hint = BUSINESS_CODES[String(envelope.code)]
  const message = `${label} refused the call (code ${String(envelope.code)}${envelope.msg === undefined ? '' : `: ${envelope.msg}`})`
    + (hint === undefined ? '' : ` — ${hint}`)
  // A credential the upstream no longer honours is reported as such: JoyCode
  // answers an expired ptKey with a code, not a 401, so the mapping has to run
  // on the body's wording rather than the status alone.
  const authWording = /(未登录|登录已过期|token|ptkey|认证|authorization)/i.test(envelope.msg ?? '')
  return new LlmError(message, authWording ? 'AUTH' : 'SERVER')
}

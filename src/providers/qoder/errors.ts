/**
 * Harness error classification for the Qoder transport.
 *
 * Ported from `masknull/dsh-qoder-connect` `src/qoder/errors.ts` (MIT), with its
 * provider-private `QoderLlmError` replaced by the harness's own {@link LlmError}
 * and its code vocabulary remapped onto the hub's stable set:
 *
 * | condition                                    | code                     |
 * | -------------------------------------------- | ------------------------ |
 * | 401/403/429 carrying the queue answer (10605) | `RATE_LIMIT`             |
 * | body names a documented QUOTA result code     | `QUOTA`                  |
 * | body names a documented request code, 401/403 | `UNSUPPORTED`            |
 * | body carries terminal quota wording          | `QUOTA`                  |
 * | body carries context-overflow wording        | `CONTEXT_WINDOW_EXCEEDED`|
 * | HTTP 429                                     | `RATE_LIMIT`             |
 * | HTTP 401 / 403                               | `AUTH`                   |
 * | HTTP 408 / 504                               | `TIMEOUT`                |
 * | HTTP 5xx                                     | `SERVER`                 |
 * | HTTP 400 / 404 / 405 / 406 / 413 / 415 / 422 | `UNSUPPORTED`            |
 * | any other HTTP status                        | `HTTP_<status>`          |
 * | no HTTP status (transport/DNS/TLS)           | `TRANSPORT`              |
 *
 * The three body-driven rows above are the difference between a healthy account
 * and a "your token was revoked" report: Qoder throttles a saturated model queue
 * and an exhausted daily counter with 401/403 statuses, so the body has to
 * outrank the status (queue: `src/qoder/errors.ts:16-84`, quota codes:
 * `src/qoder/errors.ts:85-94` and `src/qoder/codes.ts:29-59` in the reference).
 *
 * Two reference codes have no hub equivalent and are folded in deliberately:
 * `MALFORMED_RESPONSE` (a broken or truncated stream is a transport failure
 * here, so retry policy treats it as repeatable) and `INVALID_REQUEST`
 * (split into `UNSUPPORTED` for the request-shape rejections and `HTTP_<status>`
 * for the rest). `ABORTED`, `MISSING_CREDENTIAL` and `EMPTY_RESPONSE` are the
 * hub's own withdrawn-request/missing-login/empty-completion codes and are kept
 * as-is.
 *
 * The reference's `QoderLlmError` carried no extra behaviour over `LlmError`;
 * it existed only to own the code constants, which are exported here instead.
 *
 * @module dsh-subscription-hub/providers/qoder/errors
 */

import {
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import { qoderResultCode } from './codes.js'

/** Code for a request the caller cancelled. */
export const QODER_ABORTED_CODE = 'ABORTED'
/** Code for a provider payload or stream that could not be decoded. */
export const QODER_PROTOCOL_ERROR_CODE = 'TRANSPORT'
/** Code for a logged-out account (no PAT stored). */
export const QODER_MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'
/** Code for content or a request control this provider/model cannot serve. */
export const QODER_UNSUPPORTED_CODE = 'UNSUPPORTED'
/** Code for a provider endpoint that could not be reached at all. */
export const QODER_TRANSPORT_CODE = 'TRANSPORT'

/**
 * Build a Qoder transport failure.
 * @param message - human-readable failure summary.
 * @param code - the stable code to route on.
 * @param options - optional cause and serializable provider facts.
 * @returns the classified error.
 */
export function qoderError(message: string, code: string, options?: LlmErrorOptions): LlmError {
  return new LlmError(message, code, options)
}

/**
 * The subset of a failed response {@link qoderHttpError} classifies.
 *
 * Deliberately not a `Response`: Qoder also answers a rejected chat inside a
 * HTTP 200 SSE envelope, where the only facts available are the envelope's own
 * status, its body text, and the response headers that carried it.
 */
export interface QoderErrorResponse {
  /** HTTP-equivalent status the upstream reported. */
  status: number
  /** Response headers, when the failure arrived on a real HTTP response. */
  headers?: Pick<Headers, 'get'> | undefined
  /** Response body text, when it could be read; used for wording classification. */
  body?: string | undefined
}

/**
 * The markers Qoder puts in a rejection body when the model queue is saturated.
 *
 * Ported verbatim from the reference's `qoder/errors.ts:17-22` (commit
 * 631be5c). A queued request is answered with 401/403, so these markers — not
 * the status — are what identify the condition.
 */
const QODER_QUEUE_BODY_MARKERS: readonly RegExp[] = [
  /"code"\s*:\s*"?10605"?/u,
  /"isQueued"\s*:\s*true/u,
  /"queueCount"/u,
  /"serviceAvailable"\s*:\s*false/u,
] as const

/** What a queue-shaped rejection body reports about the pending entry. */
export interface QoderQueueSignal {
  /** Milliseconds the upstream asked us to wait before asking again. */
  retryAfterMs?: number
  /** Queue class the entry belongs to, used as a poll filter. */
  queueType?: string
}

/**
 * Read Qoder's queue answer out of a rejection body.
 *
 * Reference `qoder/errors.ts:36-48`. Bodies are often JSON nested inside the SSE
 * envelope, so every inner quote arrives escaped (`\"retryAfterSeconds\":30`);
 * the backslash removal is what makes one match cover both depths, and no marker
 * depends on a backslash.
 * @param body - the rejection body, or the message that embeds it.
 * @returns the queue signal, or undefined when the body is not a queue answer.
 */
export function qoderQueueSignal(body: string | undefined): QoderQueueSignal | undefined {
  if (body === undefined || body === '') return undefined
  const text = body.replace(/\\/gu, '')
  if (!QODER_QUEUE_BODY_MARKERS.some(marker => marker.test(text))) return undefined
  const match = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(text)
  const queueType = /"queueType"\s*:\s*"([^"]+)"/u.exec(text)
  return {
    ...match === null ? {} : { retryAfterMs: Number(match[1]) * 1000 },
    ...queueType === null ? {} : { queueType: queueType[1] },
  }
}

/**
 * Replace the 401/403 digits in a message with a neutral word.
 *
 * Reference `qoder/errors.ts:50-59`: a throttle or quota answer keeps the
 * upstream's 401/403 STATUS for diagnostics, and a downstream classifier that
 * tests the message text for those digits ahead of the provider's code would
 * read the account as revoked again — which is the very report this mapping
 * exists to stop.
 * @param message - the message to neutralize.
 * @param replacement - the neutral word substituted for the digits.
 * @returns the message with no bare 401/403 left in it.
 */
function deauthorizeDigits(message: string, replacement = 'throttled'): string {
  return message.replace(/\b(?:401|403)\b/gu, replacement)
}

/**
 * Classify a non-2xx Qoder response.
 *
 * Quota and context-overflow wording are read from the body BEFORE the status
 * mapping, unlike the hub's shared `httpLlmError`, which checks them after
 * `AUTH`. Nothing negotiable rides on that difference: Qoder's exhausted-credit
 * refusal arrives as a 403 inside a 200 SSE envelope whose body is the only
 * place the real reason appears, and classifying it `AUTH` (as the reference
 * did) tells the user to log in again when the fix is to wait or upgrade. Qoder
 * also has no rolling request window for the 429-means-window rule to protect —
 * its quota is a credit pool — so wording wins on every status here.
 *
 * Two body shapes are read before the wording, in the reference's order
 * (`qoder/errors.ts:70-102`): the queue answer (a 401/403/429 carrying
 * `10605` / `isQueued` / `queueCount` is a throttle, and its own
 * `retryAfterSeconds` is the wait to report) and a documented result code
 * (`110`-family → `QUOTA`, `406`-family on a 401/403 → a request refusal).
 * @param message - human-readable failure summary.
 * @param response - the status, headers and body of the failure.
 * @returns the classified error, carrying status, request id and any retry hint.
 */
export function qoderHttpError(message: string, response: QoderErrorResponse): LlmError {
  const { status } = response
  const detail = response.body ?? ''
  // The SSE-envelope path embeds the body in the message, so the body is never
  // the only place to look (reference `qoder/errors.ts:73`).
  const signalText = detail.length > 0 ? detail : message
  const headerRetryAfterMs = retryAfterMs(response.headers?.get('retry-after') ?? null)
  const requestId = qoderRequestId(response.headers)

  const queue = status === 401 || status === 403 || status === 429
    ? qoderQueueSignal(signalText)
    : undefined
  if (queue !== undefined) {
    const providerRetryAfterMs = queue.retryAfterMs ?? headerRetryAfterMs
    return new LlmError(deauthorizeDigits(message), 'RATE_LIMIT', {
      status,
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
    })
  }

  const code = isQuotaExceededError(detail)
    ? QUOTA_EXCEEDED_CODE
    : isContextWindowExceededError(detail)
      ? CONTEXT_WINDOW_EXCEEDED_CODE
      : status === 429
        ? 'RATE_LIMIT'
        : status === 401 || status === 403
          ? 'AUTH'
          : status === 408 || status === 504
            ? 'TIMEOUT'
            : status >= 500 && status <= 599
              ? 'SERVER'
              : status === 400 || status === 404 || status === 405 || status === 406
                || status === 413 || status === 415 || status === 422
                ? QODER_UNSUPPORTED_CODE
                : status >= 400 && status <= 499
                  ? `HTTP_${String(status)}`
                  : QODER_TRANSPORT_CODE
  // A documented quota code is the only sign of an exhausted daily counter
  // behind a 403. Only documented codes count, so a body that mirrors its HTTP
  // status in `code` keeps routing by that status (reference
  // `qoder/errors.ts:85-94`; the daily counter is `403 {"code":"110",…}`,
  // commit 01f15b6). No retry hint: a spent daily window is not a
  // "try again in N seconds" answer and the host never retries QUOTA anyway.
  const documented = qoderResultCode(signalText)
  if (documented?.family === 'quota') {
    return new LlmError(deauthorizeDigits(message, 'limited'), QUOTA_EXCEEDED_CODE, {
      status,
      ...requestId === undefined ? {} : { requestId },
    })
  }
  // Qoder can name a request/policy code while answering 401/403; that is a
  // request failure, not a dead credential. The hub's vocabulary folds the
  // reference's `INVALID_REQUEST` into `UNSUPPORTED` (see the table above).
  if (documented?.family === 'request' && code === 'AUTH') {
    return new LlmError(deauthorizeDigits(message, 'rejected'), QODER_UNSUPPORTED_CODE, {
      status,
      ...requestId === undefined ? {} : { requestId },
    })
  }
  return new LlmError(message, code, {
    status,
    ...headerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: headerRetryAfterMs },
    ...requestId === undefined ? {} : { requestId },
  })
}

/**
 * Read the provider's own request id off a response, in the three spellings
 * Qoder's gateway and its CDN front use.
 * @param headers - the response headers, when available.
 * @returns the branded request id, or undefined when none was sent.
 */
export function qoderRequestId(headers?: Pick<Headers, 'get'>): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers?.get('x-request-id')
    ?? headers?.get('request-id')
    ?? headers?.get('x-amzn-requestid')
  const normalized = value?.trim()
  return normalized ? ProviderRequestId(normalized) : undefined
}

/**
 * Codes that keep an upstream 401/403 status without being credential
 * rejections.
 *
 * Reference `qoder/errors.ts:130-135`: the queue answer and a spent usage window
 * both carry 401/403 and neither is fixable by a fresh job token, so healing
 * them wastes the exchange and the retry — three exchanges and ~4s per chat
 * while the account was healthy (commit 631be5c), and one per chat for a daily
 * counter that resets by itself (commit 01f15b6).
 */
const QODER_NON_AUTH_STATUS_CODES: readonly string[] = [
  'RATE_LIMIT',
  QUOTA_EXCEEDED_CODE,
  'ACCOUNT_QUOTA',
]

/**
 * Whether this failure is an upstream authorization rejection worth one
 * re-auth retry.
 *
 * The job token the transport signs requests with is cached in memory; an
 * upstream that invalidates it mid-lifetime (gateway rotation or a fault
 * window) answers HTTP 401/403 before any payload is produced. That state is
 * distinguishable from a genuinely revoked PAT only by trying a fresh
 * exchange, so callers clear their credential cache and retry once before
 * reporting `AUTH` to the user. A code in {@link QODER_NON_AUTH_STATUS_CODES} is
 * never a candidate, even when its status is 401/403.
 * @param error - the caught value.
 * @returns whether the error is an `AUTH`/401/403 rejection.
 */
export function isQoderAuthRejection(error: unknown): error is LlmError {
  if (!(error instanceof LlmError)) return false
  if (QODER_NON_AUTH_STATUS_CODES.includes(error.code)) return false
  return error.code === 'AUTH' || error.failure.status === 401 || error.failure.status === 403
}

/**
 * Parse a `retry-after` header into a delay the retry policy can wait out.
 * @param value - the raw header value, or null when absent.
 * @param nowMs - the instant to measure an HTTP-date against.
 * @returns the delay in milliseconds, or undefined when absent/unusable/past.
 */
export function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1000
    return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
  }
  const retryAt = Date.parse(normalized)
  if (Number.isNaN(retryAt)) return undefined
  const delayMs = retryAt - nowMs
  return delayMs > 0 ? delayMs : undefined
}

/**
 * How long before a stored job token's expiry a refresh should start.
 *
 * Two minutes, matching this hub's other routes. Deliberately NOT the reference's
 * five-minute auth-cache buffer: that buffer guards an in-memory exchange, while
 * this one decides when the durable session is rewritten.
 */
export const QODER_PREEMPT_MS = 2 * 60_000

/**
 * Whether a refresh failure means the stored PAT is permanently dead.
 *
 * A user-minted PAT has no expiry the hub can observe, so the only permanent
 * verdict is the upstream REFUSING it: a 401/403, `AUTH`, or a missing/empty
 * credential. A transport failure, a timeout, a rate limit and a 5xx must all
 * stay transient — the same distinction every other route in this hub draws, and
 * the one whose absence used to delete working accounts.
 * @param error - the failure raised by a refresh attempt.
 * @returns whether the account should be removed and a new PAT requested.
 */
export function isQoderPermanentRefreshError(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  if (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL') return true
  return isQoderAuthRejection(error)
}

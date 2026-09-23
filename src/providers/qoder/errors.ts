/**
 * Harness error classification for the Qoder transport.
 *
 * Ported from `masknull/dsh-qoder-connect` `src/qoder/errors.ts` (MIT), with its
 * provider-private `QoderLlmError` replaced by the harness's own {@link LlmError}
 * and its code vocabulary remapped onto the hub's stable set:
 *
 * | condition                                    | code                     |
 * | -------------------------------------------- | ------------------------ |
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
 * @param message - human-readable failure summary.
 * @param response - the status, headers and body of the failure.
 * @returns the classified error, carrying status, request id and any retry hint.
 */
export function qoderHttpError(message: string, response: QoderErrorResponse): LlmError {
  const { status } = response
  const detail = response.body ?? ''
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
  const providerRetryAfterMs = retryAfterMs(response.headers?.get('retry-after') ?? null)
  const requestId = qoderRequestId(response.headers)
  return new LlmError(message, code, {
    status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
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
 * Whether this failure is an upstream authorization rejection worth one
 * re-auth retry.
 *
 * The job token the transport signs requests with is cached in memory; an
 * upstream that invalidates it mid-lifetime (gateway rotation or a fault
 * window) answers HTTP 401/403 before any payload is produced. That state is
 * distinguishable from a genuinely revoked PAT only by trying a fresh
 * exchange, so callers clear their credential cache and retry once before
 * reporting `AUTH` to the user.
 * @param error - the caught value.
 * @returns whether the error is an `AUTH`/401/403 rejection.
 */
export function isQoderAuthRejection(error: unknown): error is LlmError {
  return error instanceof LlmError
    && (error.code === 'AUTH' || error.failure.status === 401 || error.failure.status === 403)
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

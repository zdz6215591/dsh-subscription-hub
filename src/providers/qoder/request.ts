/**
 * Internal request lifecycle primitives for the Qoder transport.
 *
 * Three concerns live here, all of them shared by every non-streaming call:
 * bounded body reads (a provider that answers with 3 MB of HTML must not become
 * a memory event), one-shaped error classification for both signed and unsigned
 * requests, and {@link SingleFlight}, which is what keeps the job-token
 * exchange, the catalog sweep and the quota poll from each minting their own
 * credential.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect`
 * `src/qoder/transport/request.ts` (MIT), with `MALFORMED_RESPONSE` folded into
 * `TRANSPORT` and the injected fetcher named `fetchFn` to match the hub's
 * convention.
 *
 * @module dsh-subscription-hub/providers/qoder/request
 */

import { createHash } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { qoderError, qoderHttpError, qoderRequestId, QODER_ABORTED_CODE, QODER_PROTOCOL_ERROR_CODE, QODER_TRANSPORT_CODE } from './errors.js'
import type { QoderErrorResponse } from './errors.js'
import { logParsedResponse, redactLogPayload } from './logging.js'
import type { QoderLogger } from './logging.js'
import { defaultUserAgent, qoderClientType } from './cosy.js'
import { proxiedFetch } from '../../http.js'

/** Default deadline for one metadata (non-streaming) request. */
export const defaultMetadataTimeoutMs = 15_000
/** Default deadline for a model request's response headers. */
export const defaultResponseHeaderTimeoutMs = 60_000
/** Largest JSON body accepted from a successful metadata request. */
export const defaultMaxJsonBytes = 2 * 1024 * 1024
/** Largest error body read for diagnostics. */
export const defaultMaxErrorBytes = 16 * 1024
const metadataRetryBaseDelayMs = 200
const maxProviderRetryDelayMs = 10_000

/**
 * Hash a credential into a cache key that never holds the credential itself.
 * @param value - the secret to key on.
 * @returns the SHA-256 hex digest.
 */
export function opaqueCredentialKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function retryableMetadataError(error: unknown): error is LlmError {
  return error instanceof LlmError
    && ['RATE_LIMIT', 'SERVER', 'TIMEOUT', QODER_TRANSPORT_CODE].includes(error.code)
}

function readProviderRetryAfterMs(error: LlmError): number | undefined {
  return error.failure.providerRetryAfterMs
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run one idempotent metadata read, retrying once after a transient failure.
 *
 * Only rate limits, server failures, timeouts and transport failures retry; a
 * provider-supplied `retry-after` is honored up to a ceiling, because a metadata
 * sweep that obeys an hour-long hint would stall the settings card.
 * @param signal - caller cancellation.
 * @param operation - the read to perform.
 * @returns the read's result, or its error after at most one retry.
 */
export async function retryMetadataRead<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!retryableMetadataError(error) || signal.aborted) throw error
    const providerDelay = readProviderRetryAfterMs(error)
    const delayMs = providerDelay === undefined
      ? metadataRetryBaseDelayMs + Math.floor(Math.random() * 41)
      : Math.min(providerDelay, maxProviderRetryDelayMs)
    await abortableDelay(delayMs, signal)
    return operation()
  }
}

/**
 * Combine a caller signal with a deadline.
 * @param signal - the caller's signal, when it supplied one.
 * @param timeoutMs - the deadline in milliseconds.
 * @returns both the deadline signal alone (so it can be told apart) and the combined one.
 */
export function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timeoutSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return {
    timeoutSignal,
    signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
  }
}

/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 * @param response - the response to read.
 * @param maxBytes - the ceiling, checked against both `content-length` and the actual stream.
 * @param label - diagnostic prefix naming the operation.
 * @returns the decoded body text.
 * @throws LlmError `TRANSPORT` when the body exceeds the ceiling.
 */
export async function readLimitedText(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw qoderError(`${label} exceeded its response size limit.`, QODER_PROTOCOL_ERROR_CODE)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        throw qoderError(`${label} exceeded its response size limit.`, QODER_PROTOCOL_ERROR_CODE)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

interface Flight<T> {
  controller: AbortController
  promise: Promise<T>
  settled: boolean
  waiters: number
}

/**
 * Share one in-flight operation among concurrent callers, keyed by string.
 *
 * The shared work runs under its OWN signal and is cancelled only when the last
 * waiter leaves, so one departing caller (a cancelled poll, a settings panel
 * closing) cannot cancel the request another caller is still waiting on. The
 * error a caller receives when IT cancels is supplied by that caller, not by the
 * shared work, which has no idea who was waiting.
 */
export class SingleFlight<T> {
  private readonly flights = new Map<string, Flight<T>>()

  /**
   * Run, or join, the operation for one key.
   * @param key - the sharing key.
   * @param signal - this caller's cancellation.
   * @param start - starts the shared work; receives the shared signal.
   * @param abortedError - builds the error this caller sees when it cancels.
   * @returns the shared result.
   */
  run(
    key: string,
    signal: AbortSignal | undefined,
    start: (signal: AbortSignal) => Promise<T>,
    abortedError: () => Error,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortedError())

    let flight = this.flights.get(key)
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {} as Flight<T>
      created.controller = controller
      created.settled = false
      created.waiters = 0
      created.promise = start(controller.signal).finally(() => {
        created.settled = true
        if (this.flights.get(key) === created) this.flights.delete(key)
      })
      flight = created
      this.flights.set(key, created)
    }

    flight.waiters++
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const finish = (callback: () => void): void => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', onAbort)
        flight.waiters--
        if (flight.waiters === 0 && !flight.settled) {
          if (this.flights.get(key) === flight) this.flights.delete(key)
          flight.controller.abort('all callers aborted')
        }
        callback()
      }
      const onAbort = (): void => finish(() => reject(abortedError()))
      signal?.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      )
    })
  }
}

/** One unsigned OpenAPI request (PAT exchange, userinfo, quota, plan, status). */
export interface OpenApiJsonRequestOptions {
  url: string
  method?: 'GET' | 'POST' | undefined
  token?: string | undefined
  machineId?: string | undefined
  body?: unknown
  headers?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  logger?: QoderLogger | undefined
  operation: string
  logCategory?: string | undefined
  userAgent?: string | undefined
}

/**
 * Perform one unsigned OpenAPI request and parse its JSON body.
 *
 * These routes authenticate with a plain `Bearer <job token>` and the two plain
 * `cosy-version` / `cosy-clienttype` headers — no COSY signature, no `/algo`.
 * @param fetchFn - the fetcher to use (defaults to the hub's proxy-aware fetch).
 * @param options - the request.
 * @returns the parsed body.
 * @throws LlmError `TRANSPORT` for a network failure or unparseable body,
 *   `TIMEOUT` when the deadline fired, `ABORTED` when the caller cancelled, and
 *   the status-mapped code for a non-2xx answer.
 */
export async function openApiJsonRequest<T>(
  fetchFn: typeof fetch,
  options: OpenApiJsonRequestOptions,
): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET')
  const timeoutMs = options.timeoutMs ?? defaultMetadataTimeoutMs
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = options.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([options.signal, timeoutSignal])
  const startedAt = performance.now()

  options.logger?.debug?.(`[Qoder ${options.operation}] Requesting`, { url: options.url, method })

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': options.userAgent ?? defaultUserAgent,
      'cosy-version': '1.0.1',
      'cosy-clienttype': qoderClientType,
      ...options.headers,
    }
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`
    }
    if (options.machineId) {
      headers['Cosy-MachineToken'] = options.machineId
      headers['Cosy-MachineType'] = 'host'
    }
    let bodyText: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      bodyText = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    }

    const response = await fetchFn(options.url, {
      method,
      headers,
      // Under exactOptionalPropertyTypes RequestInit forbids an explicit
      // `body: undefined`; omit the property when there is no payload.
      ...bodyText === undefined ? {} : { body: bodyText },
      signal: requestSignal,
    })

    options.logger?.debug?.(`[Qoder ${options.operation}] Request completed`, {
      status: response.status,
      statusText: response.statusText,
      durationMs: Math.round(performance.now() - startedAt),
      ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
    })

    const text = await readLimitedText(
      response,
      response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
      `Qoder ${options.operation} response`,
    )

    if (!response.ok) {
      options.logger?.error?.(`[Qoder ${options.operation}] Request failed`, redactLogPayload(text))
      throw qoderHttpError(
        `Failed to execute Qoder ${options.operation} with status ${response.status}.`,
        failureOf(response, text),
      )
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      options.logger?.error?.(`[Qoder ${options.operation}] Invalid JSON response`, redactLogPayload(text))
      throw qoderError(`Failed to parse Qoder ${options.operation} JSON response`, QODER_PROTOCOL_ERROR_CODE)
    }

    if (options.logCategory) {
      logParsedResponse(options.logger, options.logCategory, data)
    }

    return data as T
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    if (options.signal?.aborted) {
      throw qoderError(`Qoder ${options.operation} request was aborted.`, QODER_ABORTED_CODE)
    }
    if (timeoutSignal.aborted) {
      throw qoderError(`Qoder ${options.operation} request timed out.`, 'TIMEOUT')
    }
    throw qoderError(`Qoder ${options.operation} network request failed.`, QODER_TRANSPORT_CODE, { cause: error })
  }
}

/** Describe a failed response for {@link qoderHttpError}. */
function failureOf(response: Response, body: string): QoderErrorResponse {
  return { status: response.status, headers: response.headers, ...body.length === 0 ? {} : { body } }
}

/**
 * The fetcher every Qoder function uses when the caller injects none.
 * Re-exported so the whole provider directory has one HTTP seam to reason about.
 */
export const qoderDefaultFetch: typeof fetch = proxiedFetch

/**
 * Qoder chat request encoding, timeout lifecycle, and SSE streaming.
 *
 * Three things this module owns that a naive `fetch` + parse would not:
 *
 *  - the body is WAF-encoded (`Encode=1`) and COSY-signed over THOSE bytes, so
 *    the signature, the body length and the body hash all describe the encoded
 *    payload the gateway receives;
 *  - the response-header timeout and the stream-idle timeout are separate,
 *    because "the gateway never answered" and "the gateway stopped producing"
 *    are different failures with different retry value;
 *  - the gateway answers a REJECTED chat with HTTP 200 and an SSE whose first
 *    envelope carries the failure, so the stream parser (not this module) is
 *    what turns that into an error.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect`
 * `src/qoder/transport/chat.ts` (MIT); the injected fetcher is named `fetchFn`.
 *
 * @module dsh-subscription-hub/providers/qoder/chat
 */

import { attributionHeaders, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { QoderCatalogModel } from './catalog.js'
import { qoderError, qoderHttpError, qoderRequestId, QODER_ABORTED_CODE, QODER_TRANSPORT_CODE } from './errors.js'
import type { QoderRegion } from './region.js'
import { getQoderChatUrl } from './region.js'
import { redactLogValue } from './logging.js'
import type { QoderLogger } from './logging.js'
import { buildAuthHeaders } from './cosy.js'
import type { CosyCredentials } from './cosy.js'
import { qoderEncodeBody } from './encoding.js'
import { buildQoderRequestBody } from './serialize.js'
import { parseQoderSse } from './sse.js'
import type { QoderWireMessage } from './wire-types.js'

/** Everything {@link streamQoderChat} needs besides the request itself. */
export interface QoderChatDependencies {
  /** Fetcher to use. */
  fetchFn: typeof fetch
  /** Diagnostic sink. */
  logger?: QoderLogger | undefined
  /** Which deployment to stream from. */
  region: QoderRegion
  /** Deadline for the response headers alone. */
  responseHeaderTimeoutMs: number
  /** Maximum silence tolerated while the body streams. */
  streamIdleTimeoutMs: number
}

function aborted(message: string): Error {
  return qoderError(message, QODER_ABORTED_CODE)
}

/**
 * Stream one chat as harness chunks.
 *
 * @param options - the harness request.
 * @param model - the resolved catalog entry, when known.
 * @param credentials - the account identity and job token to sign with.
 * @param messages - already-translated wire messages.
 * @param dependencies - fetcher, region and both timeouts.
 * @returns the chunk stream.
 * @throws LlmError `ABORTED` for caller cancellation, `TIMEOUT` for either
 *   timeout, `TRANSPORT` for a network failure, and the status-mapped code for
 *   an HTTP rejection.
 */
export async function* streamQoderChat(
  options: GenerateOptions,
  model: QoderCatalogModel | undefined,
  credentials: CosyCredentials,
  messages: QoderWireMessage[],
  dependencies: QoderChatDependencies,
): AsyncGenerator<StreamChunk> {
  const request = await buildQoderRequestBody(options, credentials.userID, messages, model)
  const encodedBody = qoderEncodeBody(JSON.stringify(request))
  const encodedBytes = Buffer.from(encodedBody, 'utf8')
  const chatUrl = getQoderChatUrl(dependencies.region)
  const requestController = new AbortController()
  let headerTimedOut = false
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let chunkCount = 0
  let reqId: ReturnType<typeof qoderRequestId> | undefined
  const startedAt = performance.now()
  let lastActivityAt = startedAt
  const onCallerAbort = (): void => requestController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const headerTimer = setTimeout(() => {
    headerTimedOut = true
    requestController.abort('response header timeout')
  }, dependencies.responseHeaderTimeoutMs)
  const resetIdleTimer = (): void => {
    lastActivityAt = performance.now()
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      requestController.abort('stream idle timeout')
    }, dependencies.streamIdleTimeoutMs)
  }

  try {
    const response = await dependencies.fetchFn(chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'cache-control': 'no-cache',
        'accept-encoding': 'identity',
        'x-model-key': options.model || 'cmodel',
        'x-model-source': model?.source || 'system',
        ...attributionHeaders(),
        ...buildAuthHeaders(encodedBytes, chatUrl, credentials),
      },
      body: encodedBytes,
      signal: requestController.signal,
    })
    clearTimeout(headerTimer)
    reqId = qoderRequestId(response.headers)
    dependencies.logger?.debug?.('[Qoder Stream] Response headers received', {
      region: dependencies.region,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...reqId === undefined ? {} : { requestId: reqId },
    })
    resetIdleTimer()
    if (!response.ok) {
      throw qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, {
        status: response.status,
        headers: response.headers,
      })
    }
    if (!response.body) {
      throw qoderError('Qoder response contains no readable body stream.', EMPTY_RESPONSE_CODE)
    }

    let firstChunkDurationMs: number | undefined
    let tokenUsage: TokenUsage | undefined
    let finishReason: string | undefined
    const streamStartedAt = performance.now()

    for await (const chunk of parseQoderSse(response.body, { onActivity: resetIdleTimer })) {
      chunkCount++
      if (firstChunkDurationMs === undefined) {
        firstChunkDurationMs = Math.round(performance.now() - startedAt)
        dependencies.logger?.debug?.('[Qoder Stream] First chunk received', {
          durationMs: firstChunkDurationMs,
          ...reqId === undefined ? {} : { requestId: reqId },
        })
      }
      if (chunk.type === 'usage') {
        tokenUsage = chunk.usage
      }
      if (chunk.type === 'finish') {
        finishReason = chunk.reason.kind
      }
      yield chunk
    }

    dependencies.logger?.debug?.('[Qoder Stream] Stream completed', {
      durationMs: Math.round(performance.now() - startedAt),
      streamDurationMs: Math.round(performance.now() - streamStartedAt),
      chunkCount,
      ...finishReason === undefined ? {} : { finishReason },
      ...tokenUsage === undefined ? {} : { usage: tokenUsage },
      ...reqId === undefined ? {} : { requestId: reqId },
    })
  } catch (error: unknown) {
    if (options.signal?.aborted) throw aborted('Request was aborted.')
    const elapsedMs = Math.round(performance.now() - startedAt)
    if (headerTimedOut) {
      const failure = qoderError('Qoder model request exceeded its response header timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        phase: 'header',
        elapsedMs,
        timeoutMs: dependencies.responseHeaderTimeoutMs,
      })
      throw failure
    }
    if (idleTimedOut) {
      const failure = qoderError('Qoder model stream exceeded its idle timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        phase: 'stream-idle',
        chunkCount,
        idleDurationMs: Math.round(performance.now() - lastActivityAt),
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      throw failure
    }
    if (error instanceof LlmError) {
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(error), {
        chunkCount,
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      throw error
    }
    const failure = qoderError('Qoder transport request failed.', QODER_TRANSPORT_CODE, { cause: error })
    dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
      chunkCount,
      elapsedMs,
      ...reqId === undefined ? {} : { requestId: reqId },
      cause: redactLogValue(error),
    })
    throw failure
  } finally {
    clearTimeout(headerTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onCallerAbort)
    requestController.abort('request complete')
  }
}

/**
 * Cline (ClinePass) adapter: an OpenAI-compatible chat transport with per-model
 * upstream-channel pinning.
 *
 * The gateway is OpenAI-shaped (SSE `data: {json}` frames, `[DONE]` terminal,
 * no named events), but it fans a model out across several backing providers.
 * The `pin` half of this adapter makes that choice the user's, per model, and
 * fails over between pinned channels before the first token.
 *
 * Non-obvious contract points carried over from the reference:
 *   - A 200 body that is really an error object must THROW, so a refused pin
 *     still fails over instead of surfacing as an empty answer.
 *   - `AUTH` and quota failures abort the whole chain: every candidate would
 *     fail identically.
 *   - Failover happens ONLY before the first yielded chunk. Once content has
 *     reached the caller, that stream is the answer.
 *   - `off` is not a valid `reasoning_effort`; the gateway rejects it with 400.
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '../../compat.js'
import type { ClineSession } from '../../auth/store.js'
import type { ProviderId } from '../../auth/store.js'
import { proxiedFetch } from '../../http.js'
import { AccountTokenManager } from '../accounts.js'
import { effortDisplayName, httpLlmError, idleWatchdog, mapFetchFailure } from '../common.js'
import type { FetchFn, ModelEntry } from '../common.js'
import type { PoolAdapter } from '../pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, subscriptionRetryPolicy } from '../rate-limit.js'
import type { RateLimitWait } from '../rate-limit.js'
import { resolveImages, withToolResultImages } from '../../translate/resolved.js'
import type { TranslatableBlock, TranslatableMessage } from '../../translate/resolved.js'
import {
  CLINE_BASE_URL,
  CLINE_EFFORTS,
  clineModel,
  discoverClineModels,
  toClineModelInfo,
} from './catalog.js'
import type { ClineModel } from './catalog.js'
import {
  buildAttempts,
  classifyUpstreamError,
  injectPrefs,
  parseRouting,
} from './pins.js'
import type { ClinePinStore } from './pins.js'

export const CLINE_PREEMPT_MS = 24 * 60 * 60 * 1000

/** Catalog cache lifetime. */
const CATALOG_TTL_MS = 5 * 60_000

/** Cline's retry shape: a busy gateway recovers in place. */
const CLINE_RETRY = Object.freeze({
  maxRetries: 60,
  initialDelayMs: 800,
  maxDelayMs: 300_000,
  jitterRatio: 0.1,
})

/** One SSE frame's decoded payload, or a terminal marker. */
interface ClineFrame {
  done: boolean
  payload?: Record<string, unknown>
}

/**
 * Split an SSE byte stream into decoded JSON frames.
 * Cline is line-oriented (`data: {json}\n\n`) and uses `[DONE]` as the terminal
 * marker; `event:` fields are not used, and unparseable frames are skipped.
 * When the server answers a 200 with raw JSON error lines (missing `data:`),
 * those are yielded as error frames to trigger clean failover.
 */
async function *clineFrames(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncIterable<ClineFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      onChunk?.()
      buffer += decoder.decode(next.value, { stream: true })
      for (;;) {
        const match = /\r?\n/.exec(buffer)
        if (match === null || match.index === undefined) break
        const line = buffer.slice(0, match.index).trim()
        buffer = buffer.slice(match.index + match[0].length)
        if (!line.startsWith('data:')) {
          // Detect bare JSON error objects sent on text/event-stream connections
          if (line.startsWith('{"error') || line.startsWith('{"message')) {
            try {
              yield { done: false, payload: JSON.parse(line) as Record<string, unknown> }
              return
            } catch { /* not JSON */ }
          }
          continue
        }
        const data = line.slice(5).trim()
        if (data === '') continue
        if (data === '[DONE]') {
          yield { done: true }
          return
        }
        try {
          yield { done: false, payload: JSON.parse(data) as Record<string, unknown> }
        } catch { /* an unparseable frame carries no output */ }
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data === '[DONE]') yield { done: true }
      else if (data !== '') {
        try {
          yield { done: false, payload: JSON.parse(data) as Record<string, unknown> }
        } catch { /* ignore */ }
      }
    } else if (tail.startsWith('{"error') || tail.startsWith('{"message')) {
      try {
        yield { done: false, payload: JSON.parse(tail) as Record<string, unknown> }
      } catch { /* ignore */ }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Read one delta's text across the gateway's tolerated spellings. */
function deltaText(delta: Record<string, unknown>): string {
  const content = delta.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'object' && part !== null ? (part as Record<string, unknown>).text : undefined))
      .filter((text): text is string => typeof text === 'string')
      .join('')
  }
  return ''
}

/**
 * Read one delta's reasoning across all three spellings the gateway uses:
 * `reasoning` (Vercel AI Gateway), `reasoning_content` (DeepSeek-native), and a
 * `reasoning_details` array.
 */
function deltaReasoning(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning === 'string' && delta.reasoning !== '') return delta.reasoning
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') return delta.reasoning_content
  const details = delta.reasoning_details
  if (!Array.isArray(details)) return ''
  return details
    .map(entry => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).text : undefined))
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .join('')
}

/** One accumulating tool call, keyed by the wire's own `index`. */
interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

/** Read a delta's `tool_calls` into the accumulator, preserving identity. */
function accumulateToolCalls(
  delta: Record<string, unknown>,
  into: Map<number, ToolCallAccumulator>,
): boolean {
  const calls = delta.tool_calls
  if (!Array.isArray(calls)) return false
  let saw = false
  for (const raw of calls) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const index = typeof record.index === 'number' ? record.index : into.size
    const current = into.get(index) ?? { id: '', name: '', arguments: '' }
    const fn = typeof record.function === 'object' && record.function !== null
      ? record.function as Record<string, unknown>
      : {}
    into.set(index, {
      // A later empty value must never clear an id/name already seen.
      id: typeof record.id === 'string' && record.id !== '' ? record.id : current.id,
      name: typeof fn.name === 'string' && fn.name !== '' ? fn.name : current.name,
      arguments: current.arguments + (typeof fn.arguments === 'string' ? fn.arguments : ''),
    })
    saw = true
  }
  return saw
}

/** Whether a frame is really an error payload sent with a 200 status. */
function frameError(payload: Record<string, unknown>): string | undefined {
  const error = payload.error
  if (typeof error === 'string' && error !== '') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message !== '') return message
    return JSON.stringify(error)
  }
  // A body with neither choices nor usage is an error envelope in disguise.
  if (payload.choices === undefined && payload.usage === undefined && typeof payload.message === 'string') {
    return payload.message
  }
  return undefined
}

function usageOf(payload: Record<string, unknown>): TokenUsage | undefined {
  const usage = typeof payload.usage === 'object' && payload.usage !== null
    ? payload.usage as Record<string, unknown>
    : undefined
  if (usage === undefined) return undefined
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  // Cline reports cached tokens inside the prompt count; the harness wants
  // disjoint buckets, so the cached portion is subtracted from the input.
  const details = typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details !== null
    ? usage.prompt_tokens_details as Record<string, unknown>
    : undefined
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const completionDetails = typeof usage.completion_tokens_details === 'object' && usage.completion_tokens_details !== null
    ? usage.completion_tokens_details as Record<string, unknown>
    : undefined
  const reasoning = typeof completionDetails?.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : 0
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

/** Wrap a wire model id list into harness model-info entries. */
function toInfos(ids: readonly string[], provider: string): LlmModelInfo[] {
  return ids.map(id => toClineModelInfo(clineModel(id), provider))
}

/** Adapter dependencies. */
export interface ClineAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<ClineSession>
  pins: ClinePinStore
  defaultBaseUrl?: string
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
  defaultEffortOf?: (model: string) => string | undefined
}

/** Cline provider adapter. */
export class ClineAdapter extends LlmAdapter {
  private readonly catalogs = new Map<string, { at: number; ids: string[] }>()
  private readonly fetchFn: FetchFn

  constructor(private readonly options: ClineAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cline' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(CLINE_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `cline: "${provider}"`)
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.catalogs.clear()
    else this.catalogs.delete(account)
  }

  private baseUrl(session: ClineSession): string {
    const configured = session.baseUrl
    if (typeof configured === 'string' && configured !== '') return configured.replace(/\/+$/, '')
    return (this.options.defaultBaseUrl ?? CLINE_BASE_URL).replace(/\/+$/, '')
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    const catalog = clineModel(model)
    // All seven levels are offered gateway-wide (the reference does the same):
    // the vendor restricts some models, but a per-model list is not published,
    // so hiding levels would hide ones that do work.
    const efforts = catalog.reasoning
      ? CLINE_EFFORTS.map(effort => ({ id: ReasoningEffortId(effort), name: effortDisplayName(effort) }))
      : []
    const override = this.options.defaultEffortOf?.(model)
    const defaultEffort = override !== undefined && efforts.some(effort => effort.id === ReasoningEffortId(override))
      ? ReasoningEffortId(override)
      : undefined
    return {
      provider,
      id: model,
      name: configured?.name ?? catalog.name,
      inputModalities: configured?.inputModalities ?? [...catalog.input],
      context: { contextWindow: configured?.contextWindow ?? catalog.contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? catalog.maxTokens,
      ...efforts.length === 0 ? {} : { reasoning: { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } } },
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.resolveOwnModel(provider, model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const own = await this.listOwnModels(provider)
    const extra = await this.options.pool?.()?.modelsForProvider(provider as ProviderId) ?? []
    const seen = new Set(own.map(model => model.id))
    return [...own, ...extra.filter(model => !seen.has(model.id))]
  }

  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account === undefined) {
      const accounts = (await this.options.tokens.list()).map(entry => entry.key)
      if (accounts.length === 0) return []
      const cached = this.catalogs.get(accounts[0]!)
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return toInfos(cached.ids, provider)
      try {
        return await this.listOwnModels(provider, accounts[0], signal)
      } catch {
        return toInfos([], provider)
      }
    }
    if (!this.options.discovery) {
      return this.options.models.map(model => toClineModelInfo({
        ...clineModel(model.id),
        name: model.name ?? clineModel(model.id).name,
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      }, provider))
    }
    const cached = this.catalogs.get(account)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return toInfos(cached.ids, provider)
    try {
      const session = await this.options.tokens.session(account)
      const models = await discoverClineModels(session.accessToken, this.baseUrl(session), signal, this.fetchFn)
      const ids = models.map(model => model.id)
      if (ids.length > 0) this.catalogs.set(account, { at: Date.now(), ids })
      if (ids.length === 0) return toInfos([], provider)
      return toInfos(ids, provider)
    } catch (error) {
      if (cached !== undefined) return toInfos(cached.ids, provider)
      this.options.onWarn?.(`cline catalog failed (${error instanceof Error ? error.message : String(error)})`)
      return toInfos([], provider)
    }
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCore(options)
  }

  /**
   * Attempt every pinned candidate in order, yielding the first that produces
   * content. Failover happens only before the first yielded chunk.
   */
  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const pin = await this.options.pins.pin(options.model)
    const meta = this.options.pins.metaOf(options.model)
    const attempts = buildAttempts(pin)
    const messages = await this.toWireMessages(options)
    let lastError: unknown

    for (const attempt of attempts) {
      if (options.signal?.aborted) {
        throw new LlmError('cline request aborted by caller', 'ABORTED', { cause: options.signal.reason })
      }
      // Each attempt gets its own watchdog with the full streamIdleTimeoutMs,
      // so a timeout on candidate A does not abort candidate B or inherit elapsed time.
      const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
      try {
        const session = await this.options.tokens.session(account)
        const body = injectPrefs({
          model: options.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...options.tools === undefined || options.tools.length === 0 ? {} : {
            tools: options.tools.map(tool => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          },
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
          ...options.stop === undefined ? {} : { stop: options.stop },
          ...options.reasoningEffort === undefined || String(options.reasoningEffort) === 'off'
            ? {}
            : { reasoning_effort: String(options.reasoningEffort) },
        }, meta, attempt)

        let response: Response
        try {
          response = await this.fetchFn(`${this.baseUrl(session)}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${session.accessToken}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: JSON.stringify(body),
            signal: watchdog.signal,
          })
        } catch (error) {
          lastError = mapFetchFailure('cline', error, watchdog, options.signal)
          if (options.signal?.aborted) throw lastError
          continue
        }
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          const detail = raw.slice(0, 400)
          this.options.pins.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(detail), detail, 0)
          // An unpinned attempt that fails carries the gateway's own latest
          // provider list; merging it repairs a stale allow-list without a probe.
          if (attempt.upstream === null) this.options.pins.learnAvailableProviders(options.model, detail)
          lastError = await httpLlmError(new Response(raw, { status: response.status, headers: response.headers }), 'cline')
          const code = (lastError as LlmError).code
          // An auth or quota failure is not a pinning problem: every candidate
          // would fail the same way, so the chain stops here.
          if (code === 'INVALID_CREDENTIAL' || code === 'QUOTA_EXCEEDED') throw lastError
          continue
        }
        if (response.body === null) {
          lastError = new LlmError('cline returned no response body', 'EMPTY_RESPONSE')
          continue
        }
        // The gateway answers some streaming failures with HTTP 200 plus a
        // non-SSE body (a plain JSON error, or an HTML page), which would
        // otherwise be parsed as an empty stream and lose the failover. Peek at
        // the content type and reject anything that is not an event stream so
        // the next pinned channel gets its turn.
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().includes('event-stream')) {
          const raw = await response.text().catch(() => '')
          const detail = raw.slice(0, 400)
          this.options.pins.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(detail), detail, 0)
          if (attempt.upstream === null) this.options.pins.learnAvailableProviders(options.model, detail)
          lastError = new LlmError(
            detail === '' ? `cline answered HTTP 200 with ${contentType || 'no content type'}` : detail,
            'PROVIDER_HTTP_ERROR',
          )
          continue
        }

        let yielded = false
        const toolCalls = new Map<number, ToolCallAccumulator>()
        let nextIndex = 0
        let openBlock: { index: number; type: 'text' | 'reasoning'; text: string } | null = null
        let sawToolCalls = false
        let usage: TokenUsage | undefined
        let finishReason = 'stop'
        let streamFailure: LlmError | undefined
        const startedAt = Date.now()

        // Accumulate each open block's text so `block-end` can carry it, which is
        // the harness contract the official translators implement. Emitting an
        // empty payload here drops the block's content for assemblies that read
        // the block off `block-end` rather than replaying deltas.
        const closeOpen = (): StreamChunk | undefined => {
          if (openBlock === null) return undefined
          const { index: blockIndex, type, text } = openBlock
          openBlock = null
          return { type: 'block-end', index: blockIndex, block: { type, text } }
        }

        const chunks: StreamChunk[] = []
        try {
          for await (const frame of clineFrames(response.body, () => watchdog.pulse())) {
            watchdog.pulse()
            if (frame.done) break
            const payload = frame.payload ?? {}
            const error = frameError(payload)
            if (error !== undefined) {
              // An error frame BEFORE any content is still a routing failure, so
              // it must fail over rather than end the turn. Once content has been
              // yielded the stream is the answer and the error is fatal.
              if (!yielded) {
                this.options.pins.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(error), error, 0)
                if (attempt.upstream === null) this.options.pins.learnAvailableProviders(options.model, error)
              }
              throw new LlmError(error, 'PROVIDER_HTTP_ERROR')
            }
            const routing = parseRouting(payload)
            this.options.pins.learnRouting(options.model, routing)
            const observed = usageOf(payload)
            if (observed !== undefined) usage = observed
            const choices = Array.isArray(payload.choices) ? payload.choices : []
            const first = typeof choices[0] === 'object' && choices[0] !== null
              ? choices[0] as Record<string, unknown>
              : undefined
            if (first === undefined) continue
            if (typeof first.finish_reason === 'string' && first.finish_reason !== '') finishReason = first.finish_reason
            const delta = typeof first.delta === 'object' && first.delta !== null
              ? first.delta as Record<string, unknown>
              : undefined
            if (delta === undefined) continue
            if (accumulateToolCalls(delta, toolCalls)) sawToolCalls = true
            const reasoning = deltaReasoning(delta)
            if (reasoning !== '') {
              if (openBlock === null || openBlock.type !== 'reasoning') {
                const closing = closeOpen()
                if (closing !== undefined) chunks.push(closing)
                openBlock = { index: nextIndex++, type: 'reasoning', text: '' }
                chunks.push({ type: 'block-start', index: openBlock.index, blockType: 'reasoning' })
              }
              openBlock.text += reasoning
              chunks.push({ type: 'reasoning-delta', index: openBlock.index, text: reasoning })
            }
            const text = deltaText(delta)
            if (text !== '') {
              if (openBlock === null || openBlock.type !== 'text') {
                const closing = closeOpen()
                if (closing !== undefined) chunks.push(closing)
                openBlock = { index: nextIndex++, type: 'text', text: '' }
                chunks.push({ type: 'block-start', index: openBlock.index, blockType: 'text' })
              }
              openBlock.text += text
              chunks.push({ type: 'text-delta', index: openBlock.index, text })
            }
            // Flush what this frame produced so the caller sees it immediately.
            for (const chunk of chunks) {
              yielded = true
              yield chunk
            }
            chunks.length = 0
          }
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error)
          this.options.pins.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(note), note, Date.now() - startedAt)
          streamFailure = error instanceof LlmError
            ? error
            : mapFetchFailure('cline', error, watchdog, options.signal)
        }

        // A stream that already delivered content is the answer: its failure is
        // the caller's, not a reason to silently ask another channel.
        const hasDeliveredContent = yielded || sawToolCalls || toolCalls.size > 0
        if (hasDeliveredContent) {
          const closing = closeOpen()
          if (closing !== undefined) yield closing
          for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
            if (call.name === '') continue
            const blockIndex = nextIndex++
            yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
            yield {
              type: 'block-end',
              index: blockIndex,
              block: {
                type: 'tool-call',
                id: ToolCallId(call.id === '' ? `cline_${String(blockIndex)}` : call.id),
                name: call.name,
                arguments: call.arguments === '' ? '{}' : call.arguments,
              },
            }
          }
          yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }
          yield {
            type: 'finish',
            reason: (sawToolCalls || toolCalls.size > 0) ? { kind: 'tool-calls' } : finishReasonToKind(finishReason),
          }
          return
        }

        if (streamFailure !== undefined) {
          // A missing credential is fatal for the same reason an auth failure is.
          if (streamFailure.code === 'INVALID_CREDENTIAL' || streamFailure.code === 'QUOTA_EXCEEDED') throw streamFailure
          lastError = streamFailure
          continue
        }
        // A healthy 200 that produced nothing is still a failure, so the next
        // pinned channel gets its turn.
        this.options.pins.learnUpstream(options.model, attempt.upstream, 'bad', 'empty stream', Date.now() - startedAt)
        lastError = new LlmError('cline returned an empty stream', 'EMPTY_RESPONSE')
        continue
      } finally {
        watchdog.stop()
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError(
          lastError === undefined
            ? 'no pinned upstream could serve the request'
            : `cline: ${String(lastError)}`,
          'UPSTREAM',
        )
  }

  /** Convert harness messages to the OpenAI-shaped wire history. */
  private async toWireMessages(options: GenerateOptions): Promise<Record<string, unknown>[]> {
    const attachments = this.options.resolveAttachments?.()
    const resolved = await resolveImages(options.messages, attachments, options.signal)
    const messages: Record<string, unknown>[] = []
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system })

    // Find valid paired tool calls so neither orphaned nor empty tool calls/results are emitted
    const paired = new Set<string>()
    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const message of resolved) {
      for (const block of message.content) {
        if (message.role === 'assistant' && block.type === 'tool-call' && block.name && block.name.trim() !== '' && block.id && block.id.trim() !== '') {
          callIds.add(block.id)
        }
        if (block.type === 'tool-result' && block.toolCallId && block.toolCallId.trim() !== '') {
          resultIds.add(block.toolCallId)
        }
      }
    }
    for (const id of callIds) {
      if (resultIds.has(id)) paired.add(id)
    }

    for (const message of withToolResultImages(resolved) as readonly TranslatableMessage[]) {
      if (message.role === 'system') continue
      if (message.role === 'assistant') {
        const text = message.content
          .filter((block): block is Extract<TranslatableBlock, { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('')
        const reasoning = message.content
          .filter((block): block is Extract<TranslatableBlock, { type: 'reasoning' }> => block.type === 'reasoning')
          .map(block => block.text)
          .join('')
        const toolCalls = message.content
          .filter((block): block is Extract<TranslatableBlock, { type: 'tool-call' }> =>
            block.type === 'tool-call' && typeof block.name === 'string' && block.name.trim() !== '' && typeof block.id === 'string' && block.id.trim() !== '' && paired.has(block.id))
          .map(block => ({
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: block.arguments },
          }))
        if (text === '' && toolCalls.length === 0) continue
        messages.push({
          role: 'assistant',
          content: text,
          ...reasoning === '' ? {} : { reasoning_content: reasoning },
          ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
        })
        continue
      }
      const parts: Record<string, unknown>[] = []
      const texts: string[] = []
      const toolResults: Record<string, unknown>[] = []
      for (const block of message.content) {
        if (block.type === 'text') texts.push(block.text)
        else if (block.type === 'image' && 'dataBase64' in block) {
          parts.push({ type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` } })
        } else if (block.type === 'tool-result') {
          if (!block.toolCallId || block.toolCallId.trim() === '' || !paired.has(block.toolCallId)) continue
          const text = block.content
            .map(part => (part.type === 'text' ? part.text : ''))
            .filter(Boolean)
            .join('')
          toolResults.push({
            role: 'tool',
            tool_call_id: String(block.toolCallId),
            content: text === '' ? '(no output)' : text,
          })
        }
      }
      if (parts.length > 0) {
        messages.push({ role: 'user', content: [...texts.length === 0 ? [] : [{ type: 'text', text: texts.join('') }], ...parts] })
      } else if (texts.length > 0) {
        messages.push({ role: 'user', content: texts.join('') })
      }
      messages.push(...toolResults)
    }
    return messages
  }
}

/** Map an OpenAI finish reason onto the harness's finish kinds. */
function finishReasonToKind(reason: string): { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' } {
  if (reason === 'tool_calls' || reason === 'tool-calls') return { kind: 'tool-calls' }
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens' || reason === 'max_output_tokens') {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

export type { ClineModel }

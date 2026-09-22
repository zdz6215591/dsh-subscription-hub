/**
 * Trae CN LLM adapter: the `llm_utils_chat` transport.
 *
 * Model output streams as named SSE events, not OpenAI chunks, so this adapter
 * translates directly into the harness `StreamChunk` protocol (no loopback
 * shim: the reference project only needed one because it drove pi-ai).
 *
 * Tool calls: Trae emits `output.tool_calls[]` with the function under
 * `function_call`. The harness executes tools locally and replays results on the
 * next turn, where the assistant call is re-serialized back into that same
 * shape.
 */

import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '../../compat.js'
import type { TraeChannel } from './credentials.js'
import type { ProviderId, TraeSession } from '../../auth/store.js'
import { proxiedFetch } from '../../http.js'
import { AccountTokenManager } from '../accounts.js'
import { httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning } from '../common.js'
import type { FetchFn, ModelEntry } from '../common.js'
import type { PoolAdapter } from '../pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, subscriptionRetryPolicy } from '../rate-limit.js'
import type { RateLimitWait } from '../rate-limit.js'
import { TRAE_CLIENT_VERSION } from './protocol.js'
import {
  TRAE_CHAT_BASE,
  TRAE_CHAT_PATH,
  TraeSseDecoder,
  buildTraeChatBody,
  decodeTraeEvent,
  normalizeTraeToolCalls,
  traeEndpoint,
  traeHeaders,
} from './protocol.js'
import type { TraeMessage } from './protocol.js'
import { traeIdentityFor } from './identity.js'
import { gatewaysFor } from './region.js'
import { fetchTraeModels, mergeTraeModels, toTraeModelInfo } from './catalog.js'
import type { TraeModel } from './catalog.js'

export const TRAE_PREEMPT_MS = 5 * 60_000

/** Catalog cache lifetime. */
const CATALOG_TTL_MS = 5 * 60_000

/** Per-model reasoning-effort display names. */
const EFFORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
})

/** Trae's fixed per-request retry shape (a busy gateway recovers in place). */
const TRAE_RETRY = Object.freeze({
  maxRetries: 60,
  initialDelayMs: 800,
  maxDelayMs: 300_000,
  jitterRatio: 0.1,
})

/** The credential identity one adapter instance serves. */
export interface TraeAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<TraeSession>
  channel: TraeChannel
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
  defaultEffortOf?: (model: string) => string | undefined
}

/** Flatten one harness content block to text (images are not sent to Trae). */
function blockText(block: ContentBlock): string {
  return block.type === 'text' || block.type === 'reasoning' ? block.text : ''
}

/** Collect the ids of tool calls that have a matching result in this history. */
function pairedToolCalls(messages: readonly Message[]): Set<string> {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call' && block.name && block.name.trim() !== '' && block.id && block.id.trim() !== '') {
        callIds.add(block.id)
      }
      if (block.type === 'tool-result' && block.toolCallId && block.toolCallId.trim() !== '') {
        resultIds.add(block.toolCallId)
      }
    }
  }
  return new Set([...callIds].filter(id => resultIds.has(id)))
}

function isToolResultMessage(message: Message): boolean {
  if (message.role !== 'user') return false
  const kind: string | undefined = message.source?.kind
  if (kind !== undefined) return kind === 'tool'
  return message.content?.[0]?.type === 'tool-result'
}

/**
 * Convert harness messages into Trae's envelope.
 *
 * Two normalizations the upstream requires: the system prompt travels as a
 * `system` message (Trae rejects OpenAI's `developer` role), and only tool
 * calls with a paired result are replayed (an unanswered call is rejected).
 */
export function toTraeMessages(messages: readonly Message[], system?: string): TraeMessage[] {
  const out: TraeMessage[] = []
  const paired = pairedToolCalls(messages)
  if (system !== undefined && system !== '') out.push({ role: 'system', text: system })
  for (const message of messages) {
    if (message.role === 'system') {
      const text = message.content.map(blockText).filter(Boolean).join('\n')
      if (text !== '') out.push({ role: 'system', text })
      continue
    }
    if (message.role === 'user' && !isToolResultMessage(message)) {
      const text = message.content.map(blockText).filter(Boolean).join('\n')
      if (text !== '') out.push({ role: 'user', text })
      continue
    }
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      const toolCalls = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
          block.type === 'tool-call' && typeof block.name === 'string' && block.name.trim() !== '' && typeof block.id === 'string' && block.id.trim() !== '' && paired.has(block.id))
        .map(block => ({ id: block.id, name: block.name, arguments: block.arguments }))
      if (text === '' && toolCalls.length === 0) continue
      out.push({
        role: 'assistant',
        text,
        ...toolCalls.length === 0 ? {} : { toolCalls },
      })
      continue
    }
    if (isToolResultMessage(message)) {
      for (const block of message.content) {
        if (block.type !== 'tool-result' || !block.toolCallId || block.toolCallId.trim() === '' || !paired.has(block.toolCallId)) continue
        const text = block.content
          .map(part => (part.type === 'text' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
        out.push({
          role: 'tool',
          text: text === '' ? '(no output)' : text,
          toolCallId: String(block.toolCallId),
        })
      }
    }
  }
  return out
}

/** One Trae provider adapter (one channel of the `trae` provider route). */
export class TraeAdapter extends LlmAdapter {
  private readonly catalogs = new Map<string, { at: number; models: TraeModel[] }>()
  /** The resolved wire entry for each model id, so the call replays its function. */
  private readonly resolved = new Map<string, TraeModel>()
  private readonly fetchFn: FetchFn

  constructor(private readonly options: TraeAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Trae' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(TRAE_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `trae: "${provider}"`)
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) {
      this.catalogs.clear()
      this.resolved.clear()
    } else {
      this.catalogs.delete(account)
    }
  }

  private catalogFor(model: string): TraeModel | undefined {
    for (const entry of this.resolved.values()) {
      if (entry.id === model) return entry
    }
    return undefined
  }

  private effortsOf(model: string): readonly string[] | undefined {
    return this.catalogFor(model)?.efforts
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    if (this.resolved.size === 0) {
      // Warm the catalog so a resolve before discovery still learns the wire
      // function and the advertised effort levels. Failures are non-fatal.
      try {
        const accounts = (await this.options.tokens.list()).map(entry => entry.key)
        if (accounts.length > 0) await this.listOwnModels(provider, accounts[0])
      } catch { /* best-effort warm */ }
    }
    const entry = this.catalogFor(model)
    const efforts = this.effortsOf(model)
    const reasoning = efforts === undefined || efforts.length === 0
      ? undefined
      : {
          efforts: efforts.map(effort => ({
            id: ReasoningEffortId(effort),
            name: EFFORT_NAMES[effort] ?? effort,
          })),
        }
    const override = this.options.defaultEffortOf?.(model)
    const merged = mergeReasoning(override, reasoning)
    return {
      provider,
      id: model,
      name: entry?.name ?? configured?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: entry?.contextWindow ?? configured?.contextWindow ?? 200_000 },
      defaultMaxTokens: entry?.maxTokens ?? configured?.maxTokens ?? 32_000,
      ...merged === undefined ? {} : { reasoning: merged },
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
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
        return cached.models.map(model => toTraeModelInfo(model, provider))
      }
      try {
        return await this.listOwnModels(provider, accounts[0], signal)
      } catch {
        return mergeTraeModels([]).map(model => toTraeModelInfo(model, provider))
      }
    }
    if (!this.options.discovery) {
      return this.options.models.map(model => toTraeModelInfo({
        id: model.id,
        name: model.name ?? model.id,
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        functionName: 'solo_work_remote',
      }, provider))
    }
    const cached = this.catalogs.get(account)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.models.map(model => toTraeModelInfo(model, provider))
    }
    try {
      const credential = await this.options.tokens.session(account)
      const discovered = await fetchTraeModels(
        credential.accessToken,
        credential.userId ?? '',
        this.options.channel,
        signal,
        this.fetchFn,
      )
      const models = mergeTraeModels(discovered)
      if (models.length > 0) {
        this.catalogs.set(account, { at: Date.now(), models })
        for (const model of models) this.resolved.set(model.id, model)
      }
      return models.map(model => toTraeModelInfo(model, provider))
    } catch (error) {
      if (cached !== undefined) return cached.models.map(model => toTraeModelInfo(model, provider))
      this.options.onWarn?.(`trae catalog failed (${error instanceof Error ? error.message : String(error)})`)
      return mergeTraeModels([]).map(model => toTraeModelInfo(model, provider))
    }
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCore(options)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    const fetchFn = this.fetchFn
    try {
      const credential = await this.options.tokens.session(account)
      if (this.resolved.size === 0) {
        // A session restored from disk may call a model before any discovery
        // ran; learn the wire function first so the call routes correctly.
        try {
          const accounts = (await this.options.tokens.list()).map(entry => entry.key)
          if (accounts.length > 0) await this.listOwnModels(options.provider, accounts[0])
        } catch { /* best-effort warm */ }
      }
      const entry = this.catalogFor(options.model)
      const wireModel = entry?.wireConfigName ?? entry?.id ?? options.model
      const body = buildTraeChatBody({
        model: wireModel,
        functionName: entry?.functionName ?? 'solo_work_remote',
        messages: toTraeMessages(options.messages, options.system),
        ...options.tools === undefined ? {} : {
          tools: options.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
      })

      let response: Response
      try {
        response = await fetchFn(traeEndpoint(gatewaysFor(credential).chat, TRAE_CHAT_PATH), {
          method: 'POST',
          headers: traeHeaders(
            credential.accessToken,
            credential.userId ?? '',
            await traeIdentityFor(credential.edition, credential.userId ?? credential.account ?? ''),
          ),
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (error) {
        throw mapFetchFailure('trae', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'trae chat')
      if (response.body === null) throw new LlmError('trae chat returned no response body', 'EMPTY_RESPONSE')

      const decoder = new TextDecoder()
      const sse = new TraeSseDecoder()
      let nextIndex = 0
      let sawToolCalls = false
      let finished = false
      let upstreamError: LlmError | undefined
      let usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number } | undefined
      /** Accumulated tool calls by index, emitted as one block each on finish. */
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

      // Accumulate each open block's text so `block-end` can carry it, which is
      // the harness contract the official translators implement. Emitting an
      // empty payload here drops the block's content for assemblies that read
      // the block off `block-end` rather than replaying deltas.
      let openBlock: { index: number; kind: 'text' | 'reasoning'; text: string } | null = null

      const closeOpen = (): StreamChunk | undefined => {
        if (openBlock === null) return undefined
        const { index: blockIndex, kind, text } = openBlock
        openBlock = null
        return { type: 'block-end', index: blockIndex, block: { type: kind, text } }
      }

      const emit = (event: ReturnType<typeof decodeTraeEvent>): StreamChunk[] => {
        const chunks: StreamChunk[] = []
        if (event.type === 'ignore' || event.type === 'queue') return chunks
        if (event.type === 'error') {
          // Defer: a usable answer may still precede the terminal event. The
          // failure is raised once the stream settles.
          upstreamError = new LlmError(`Trae upstream error: ${event.message}`, 'PROVIDER_HTTP_ERROR')
          return chunks
        }
        if (event.type === 'usage') {
          usage = {
            inputTokens: event.inputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            ...event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens },
          }
          return chunks
        }
        if (event.type === 'delta') {
          for (const call of normalizeTraeToolCalls(event.toolCalls)) {
            sawToolCalls = true
            const current = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' }
            const callId = (call.id && call.id.trim() !== '') ? call.id : current.id
            const callName = (call.name && call.name.trim() !== '') ? call.name : current.name
            toolCalls.set(call.index, {
              id: callId,
              name: callName,
              arguments: current.arguments + (call.arguments ?? ''),
            })
          }
          if (event.reasoning !== undefined && event.reasoning !== '') {
            if (openBlock === null || openBlock.kind !== 'reasoning') {
              const closing = closeOpen()
              if (closing !== undefined) chunks.push(closing)
              openBlock = { index: nextIndex++, kind: 'reasoning', text: '' }
              chunks.push({ type: 'block-start', index: openBlock.index, blockType: 'reasoning' })
            }
            openBlock.text += event.reasoning
            chunks.push({ type: 'reasoning-delta', index: openBlock.index, text: event.reasoning })
          }
          if (event.text !== '') {
            if (openBlock === null || openBlock.kind !== 'text') {
              const closing = closeOpen()
              if (closing !== undefined) chunks.push(closing)
              openBlock = { index: nextIndex++, kind: 'text', text: '' }
              chunks.push({ type: 'block-start', index: openBlock.index, blockType: 'text' })
            }
            openBlock.text += event.text
            chunks.push({ type: 'text-delta', index: openBlock.index, text: event.text })
          }
          return chunks
        }
        // done
        finished = true
        return chunks
      }

      try {
        const reader = response.body.getReader()
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            for (const event of sse.push(decoder.decode(next.value, { stream: true }))) {
              for (const chunk of emit(decodeTraeEvent(event))) yield chunk
            }
          }
          for (const event of sse.finish()) {
            for (const chunk of emit(decodeTraeEvent(event))) yield chunk
          }
        } finally {
          reader.releaseLock()
        }
      } catch (error) {
        throw mapFetchFailure('trae', error, watchdog, options.signal)
      }

      const closing = closeOpen()
      if (closing !== undefined) yield closing

      if (upstreamError !== undefined && !sawToolCalls && toolCalls.size === 0) throw upstreamError

      // Tool calls each become their own block, after any text/reasoning.
      for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        // Skip tool calls with empty names or ids: never emit unknown tool ""!
        if (!call.name || call.name.trim() === '') continue
        const callId = call.id && call.id.trim() !== '' ? call.id : `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const callIndex = nextIndex++
        yield { type: 'block-start', index: callIndex, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: callIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(callId),
            name: call.name.trim(),
            arguments: call.arguments === '' ? '{}' : call.arguments,
          },
        }
      }

      yield {
        type: 'usage',
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          ...usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
        },
      }
      const yieldedToolCalls = [...toolCalls.values()].some(c => c.name && c.name.trim() !== '')
      yield {
        type: 'finish',
        reason: yieldedToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' },
      }
    } finally {
      watchdog.stop()
    }
  }
}

export { TRAE_CLIENT_VERSION }

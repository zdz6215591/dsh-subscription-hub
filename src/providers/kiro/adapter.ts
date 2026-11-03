/**
 * Kiro adapter: the AWS-Q event-stream transport behind an `LlmAdapter`.
 *
 * Everything route-specific lives in the sibling modules — the body build and
 * the reply decoding in `translate.ts`, the frame format in `eventstream.ts`,
 * the roster and the credit allowance in `catalog.ts`/`usage.ts` — so this file
 * is the same shape as every other route here: resolve a session, POST, decode,
 * yield chunks.
 *
 * Two Kiro facts shape the error path:
 *   - a failure can arrive as an HTTP status BEFORE the stream or as an
 *     exception frame INSIDE it, and both carry the same wording, so both go
 *     through the same classifier (`classifyKiroFailure`);
 *   - Kiro answers 403 for a token it considers dead, and a key that is simply
 *     wrong looks identical here. There is no refresh to attempt for an API key,
 *     so a 403 is reported as a credential failure instead of being retried.
 */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { KiroSession, ProviderId } from '../../auth/store.js'
import { resolveImages } from '../../translate/resolved.js'
import { proxiedFetch } from '../../http.js'
import { AccountTokenManager } from '../accounts.js'
import { httpLlmError, idleWatchdog, mapFetchFailure } from '../common.js'
import type { FetchFn, ModelEntry, ModelListNotFetched } from '../common.js'
import type { PoolAdapter } from '../pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, subscriptionRetryPolicy } from '../rate-limit.js'
import type { RateLimitWait } from '../rate-limit.js'
import { findKiroModel, fetchKiroModels, toKiroModelInfo } from './catalog.js'
import type { KiroModel } from './catalog.js'
import { decodeEventStream } from './eventstream.js'
import {
  KIRO_CHAT_PATH,
  KIRO_DEFAULT_REGION,
  KIRO_STREAM_CONTENT_TYPE,
  kiroAuthHeaders,
  kiroRuntime,
  kiroSdkHeaders,
} from './protocol.js'
import { buildKiroRequest, classifyKiroFailure, kiroToolNameMap, readKiroReply, toStreamChunks } from './translate.js'

/** Retry ladder: a Kiro blip is worth one more attempt. */
const KIRO_RETRY = Object.freeze({ maxRetries: 2, initialDelayMs: 700, maxDelayMs: 5_000, jitterRatio: 0.1 })

/** How long a probed roster is trusted before discovery asks again. */
const CATALOG_TTL_MS = 30 * 60_000

/** Adapter dependencies. */
export interface KiroAdapterOptions {
  /** Validated `models.kiro` entries (the operator's overrides). */
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<KiroSession>
  /** Ask Kiro for the live roster instead of trusting configured entries only. */
  discovery: boolean
  pool?: () => PoolAdapter | undefined
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  rateLimit?: RateLimitWait
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Kiro provider adapter. */
export class KiroAdapter extends LlmAdapter {
  private readonly rosters = new Map<string, { at: number; models: KiroModel[] }>()
  private readonly notFetched = new Map<string, ModelListNotFetched>()
  private readonly fetchFn: FetchFn

  constructor(private readonly options: KiroAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kiro' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(KIRO_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `kiro: "${provider}"`)
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) {
      this.rosters.clear()
      this.notFetched.clear()
    } else {
      this.rosters.delete(account)
    }
  }

  /**
   * Why this route's roster is empty, when the read failed rather than Kiro
   * listing nothing.
   * @param provider - the registered route.
   * @returns the recorded reason.
   */
  notFetchedReason(provider: string): ModelListNotFetched | undefined {
    return this.notFetched.get(provider)
  }

  /** Configured rows, as a roster, for a route with discovery off. */
  private configuredRoster(): KiroModel[] {
    return this.options.models.map(entry => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      ...entry.maxTokens === undefined ? {} : { maxOutputTokens: entry.maxTokens },
      supportsImages: entry.inputModalities?.includes('image') ?? false,
    }))
  }

  /** The roster this account was last read with, if any. */
  private cachedRoster(account?: string): KiroModel[] | undefined {
    if (account !== undefined) return this.rosters.get(account)?.models
    for (const entry of this.rosters.values()) return entry.models
    return undefined
  }

  async listOwnModels(provider: string, account?: string): Promise<readonly LlmModelInfo[]> {
    if (!this.options.discovery) return this.configuredRoster().map(model => toKiroModelInfo(model, provider))
    const key = account ?? (await this.options.tokens.list())[0]?.key
    if (key === undefined) return this.configuredRoster().map(model => toKiroModelInfo(model, provider))
    const cached = this.rosters.get(key)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.models.map(model => toKiroModelInfo(model, provider))
    }
    try {
      const session = await this.options.tokens.session(key)
      const models = await fetchKiroModels(this.fetchFn, {
        region: session.region ?? KIRO_DEFAULT_REGION,
        token: session.accessToken,
        ...session.method === undefined ? {} : { method: session.method },
        ...session.profileArn === undefined ? {} : { profileArn: session.profileArn },
      })
      if (models.length === 0) {
        this.reportNotFetched(provider, {
          what: 'Kiro listed no models',
          detail: 'ListAvailableModels answered with an empty roster',
        })
        return this.configuredRoster().map(model => toKiroModelInfo(model, provider))
      }
      this.rosters.set(key, { at: Date.now(), models })
      this.notFetched.delete(provider)
      return models.map(model => toKiroModelInfo(model, provider))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.reportNotFetched(provider, { what: 'Kiro returned no model roster', detail })
      return (cached?.models ?? this.configuredRoster()).map(model => toKiroModelInfo(model, provider))
    }
  }

  private reportNotFetched(provider: string, reason: ModelListNotFetched): void {
    this.notFetched.set(provider, reason)
    this.options.onWarn?.(`${reason.what} (${reason.detail})`)
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    const known = findKiroModel(this.cachedRoster() ?? this.configuredRoster(), model)
    const contextWindow = configured?.contextWindow ?? known?.contextWindow
    const maxTokens = configured?.maxTokens ?? known?.maxOutputTokens
    return {
      provider,
      id: model,
      name: configured?.name ?? known?.name ?? model,
      inputModalities: configured?.inputModalities ?? (known?.supportsImages === true ? ['text', 'image'] : ['text']),
      // Omitted when Kiro stated no limit: an absent fact stays absent.
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens },
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

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCore(options)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const session = await this.options.tokens.session(account)
      const region = session.region ?? KIRO_DEFAULT_REGION
      const profileArn = session.profileArn ?? ''
      // Images arrive attachment-backed; Kiro wants inline base64, so they are
      // resolved before the body is built.
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), options.signal)
      const body = buildKiroRequest(options, messages, options.model, profileArn)
      const headers: Record<string, string> = {
        ...kiroAuthHeaders(session.accessToken),
        ...kiroSdkHeaders(crypto.randomUUID()),
        ...attributionHeaders(),
        'Content-Type': 'application/json',
        Accept: KIRO_STREAM_CONTENT_TYPE,
        'x-amzn-codewhisperer-optout': 'true',
        'x-amzn-kiro-agent-mode': 'vibe',
      }
      let response: Response
      try {
        response = await this.fetchFn(`${kiroRuntime(region)}${KIRO_CHAT_PATH}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (error) {
        throw mapFetchFailure('kiro', error, watchdog, options.signal)
      }
      if (!response.ok) throw await this.kiroHttpError(response)
      if (response.body === null) throw new LlmError('kiro returned an empty stream', 'EMPTY_RESPONSE')

      const contextWindow = (await this.resolveOwnModel('kiro', options.model)).context?.contextWindow ?? 0
      const wantsThinking = options.reasoningEffort !== undefined && String(options.reasoningEffort) !== 'off'
      const frames = decodeEventStream(response.body)
      const events = readKiroReply(frames, contextWindow, wantsThinking)
      yield* toStreamChunks(events, kiroToolNameMap(options.tools))
    } finally {
      watchdog.stop()
    }
  }

  /**
   * Turn a non-2xx answer into the harness error.
   *
   * Kiro's wording decides the code (too-long input, exhausted credits,
   * throttling, no capacity), because the same failure arrives with different
   * statuses depending on where it happened.
   */
  private async kiroHttpError(response: Response): Promise<LlmError> {
    const text = await response.clone().text().catch(() => '')
    let message = text.trim()
    try {
      const parsed = JSON.parse(text) as { message?: string; reason?: string }
      if (typeof parsed.message === 'string' && parsed.message !== '') {
        message = parsed.reason === undefined ? parsed.message : `${parsed.message} (${parsed.reason})`
      }
    } catch {
      // Not JSON: the raw text is the message.
    }
    const mapped = classifyKiroFailure(message)
    if (mapped !== 'UPSTREAM_ERROR') {
      return new LlmError(`kiro: ${message}`, mapped)
    }
    if (response.status === 401 || response.status === 403) {
      // An API key has no refresh: a rejected one is a credential problem.
      return new LlmError(`kiro: Kiro rejected the API key (${response.status}): ${message.slice(0, 200)}`, 'INVALID_CREDENTIAL')
    }
    return await httpLlmError(response, 'kiro')
  }
}

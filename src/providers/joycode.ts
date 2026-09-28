/**
 * JoyCode (京东) subscription route.
 *
 * JoyCode is an IDE-first product whose API is a private protocol; this adapter
 * speaks it directly over HTTP, with no local JoyCode process involved (which is
 * what makes the route usable on a server).
 *
 * ## Three endpoints behind one route
 *
 * {@link joyCodePathFor} decides where a model is served, because sending one to
 * the wrong endpoint fails silently or with a bare code:
 *
 *   - **chat completions** — the OpenAI-shaped default.
 *   - **Responses** (GPT family) — the chat path answers error 1032 for these.
 *   - **native Anthropic messages** (Claude family, `-hq` ids) — the OpenAI paths
 *     return empty output for them, and the bare label answers 6002.
 *
 * Each path's SSE is parsed by the hub's existing translator for that protocol,
 * so this route adds request shaping (envelope, headers, per-family thinking
 * parameters) rather than a fourth stream parser.
 *
 * @module dsh-subscription-hub/providers/joycode
 */

import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { proxiedFetch } from '../http.js'
import type { JoyCodeSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ModelListNotFetched } from './common.js'
import {
  discoverOrRetryAuth,
  idleWatchdog,
  isDiscoveryAborted,
  isMissingOrInvalidCredential,
  mapFetchFailure,
  mergeReasoning,
  ModelCatalogCache,
} from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import { resolveImages } from '../translate/resolved.js'
import type { TranslatableMessage } from '../translate/resolved.js'
import { toChatMessages, toChatTools, streamChatCompletions } from '../translate/chat-completions.js'
import { toResponsesInput, toResponsesTools, streamResponses } from '../translate/responses.js'
import { markMessageCache, streamAnthropic, toAnthropicMessages, toAnthropicSystem, toAnthropicTools } from '../translate/anthropic.js'
import type { JoyCodeCredential, JoyCodeEndpoint } from './joycode/client.js'
import {
  joyCodeEnvelope,
  joyCodeHeaders,
  joyCodeHttpError,
  joyCodeUrl,
} from './joycode/client.js'
import type { JoyCodePath } from './joycode/catalog.js'
import { joyCodeAnthropicId, joyCodeModel, joyCodePathFor } from './joycode/catalog.js'
import { joyCodeCredentialOf } from './joycode-session.js'
import type { JoyCodeRosterEntry } from './joycode/models.js'
import { fetchJoyCodeModels, joyCodeModelInfo } from './joycode/models.js'
import { guardJoyCodeStream, normalizeChatSse, unwrapDoubleWrappedSse } from './joycode/translate.js'

/** Route identity. */
export const JOYCODE_PROVIDER = 'joycode'

/** What the Anthropic path's required `max_tokens` falls back to. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 32_000

/**
 * The Anthropic path's `max_tokens` ceiling.
 *
 * The probe table records every model advertising a 64k output cap, so that is
 * the ceiling; the reference clamps at 32 768 for its own aggregation path, which
 * is a choice about ITS reader rather than an upstream limit.
 */
const JOYCODE_ANTHROPIC_CEILING = 64_000

/** Adapter construction options. */
export interface JoyCodeAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<JoyCodeSession>
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  catalogStore?: CatalogPersistence
  defaultEffortOf?: (model: string) => string | undefined
  rateLimit?: RateLimitWait
  pool?: () => PoolAdapter | undefined
}

/** JoyCode wire adapter: one instance serves the `joycode` provider route. */
export class JoyCodeAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache
  /** In-memory rosters for non-default accounts (the persisted cache is the default's). */
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  private catalogOwner: string | undefined
  /**
   * Why a route's roster was not retrieved, when it was not — the settings card
   * reads this so an empty list is not mistaken for "this account has no models".
   */
  private readonly notFetched = new Map<string, ModelListNotFetched>()

  constructor(private readonly options: JoyCodeAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  private get fetchFn(): FetchFn {
    return this.options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'JoyCode' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `joycode: provider "${provider}" retryPolicy`,
    )
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
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
      return unionAccountCatalogs(
        accounts,
        (key, accountSignal) => this.listOwnModels(provider, key, accountSignal),
        { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } },
      )
    }
    if (!await this.options.tokens.hasSession(account)) return []
    if (!this.options.discovery) {
      // Configured roster (discovery off): only what the operator declared, with
      // no capabilities invented for it.
      return this.options.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: joyCodeModel(model.id)?.vision === true ? ['text', 'image'] as const : ['text'] as const,
      }))
    }
    const catalog = await this.catalogFor(account)
    try {
      const discovered = await discoverOrRetryAuth(
        force => this.options.tokens.session(account, force),
        catalog,
        () => catalog.get(async () => {
          const session = await this.options.tokens.session(account)
          const entries = await fetchJoyCodeModels(joyCodeCredentialOf(session), this.fetchFn)
          return entries.map(entry => ({
            id: entry.id,
            name: entry.name,
            ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
            ...entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens },
            ...entry.vision === undefined && entry.pinned === undefined
              ? {}
              : { inputModalities: (entry.vision ?? entry.pinned?.vision ?? false) ? ['text', 'image'] as const : ['text'] as const },
          }))
        }),
      )
      if (discovered.length > 0) this.notFetched.delete(provider)
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: model.inputModalities ?? ['text'] as const,
        ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
      }))
    } catch (error) {
      if (isDiscoveryAborted(error, signal)) throw error
      if (isMissingOrInvalidCredential(error)) return []
      // Nothing is served rather than a fabricated roster: an empty list that
      // claims to be complete is indistinguishable from a healthy account with
      // no models, which is the failure this route must never repeat.
      this.reportNotFetched(provider, {
        what: 'The JoyCode model list could not be fetched',
        detail: describe(error),
      })
      return []
    }
  }

  /** Why this route's roster is empty, when it is empty because nothing was read. */
  notFetchedReason(provider: string): ModelListNotFetched | undefined {
    return this.notFetched.get(provider)
  }

  private reportNotFetched(provider: string, reason: ModelListNotFetched): void {
    this.notFetched.set(provider, reason)
    this.options.onWarn?.(`${reason.what} (${reason.detail})`)
  }

  /**
   * Capabilities of one JoyCode model.
   *
   * The pinned table is the capability source (the live endpoint publishes
   * budgets but no capability flags), so an id the table does not describe is
   * reported with no context window, no output cap and NO reasoning levels
   * rather than a guess. The user's configured default level is folded in on top
   * exactly as it is on every other route.
   */
  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pinned = joyCodeModel(model)
    const efforts = pinned?.efforts ?? []
    const reasoning = efforts.length === 0
      ? undefined
      : mergeReasoning(this.options.defaultEffortOf?.(model), {
        efforts: efforts.map(id => ({
          id: ReasoningEffortId(id),
          name: id === 'off' ? 'Off' : effortLabel(id),
        })),
      })
    return {
      provider,
      id: model,
      name: pinned?.id ?? model,
      inputModalities: pinned?.vision === true ? ['text', 'image'] : ['text'],
      ...pinned === undefined ? {} : { context: { contextWindow: pinned.contextWindow } },
      ...pinned === undefined ? {} : { defaultMaxTokens: pinned.maxOutputTokens },
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  private async catalogFor(account: string | undefined): Promise<ModelCatalogCache> {
    const defaultKey = await this.options.tokens.defaultAccount()
    const key = account ?? defaultKey
    if (key === undefined) return this.catalog
    if (key === defaultKey) {
      if (this.catalogOwner !== undefined && this.catalogOwner !== defaultKey) this.catalog.invalidate()
      this.catalogOwner = defaultKey
      return this.catalog
    }
    let cache = this.accountCatalogs.get(key)
    if (cache === undefined) {
      cache = new ModelCatalogCache()
      this.accountCatalogs.set(key, cache)
    }
    return cache
  }

  /** Drop cached rosters: one account's, or every account's when omitted. */
  clearAccountCatalog(account?: string): void {
    if (account === undefined) {
      this.accountCatalogs.clear()
      this.catalogOwner = undefined
      this.catalog.invalidate()
      return
    }
    this.accountCatalogs.delete(account)
    if (account === this.catalogOwner || this.catalogOwner === undefined) {
      this.catalogOwner = undefined
      this.catalog.invalidate()
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamCore(options)
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncGenerator<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    let path: JoyCodePath = 'chat'
    try {
      const session = await this.options.tokens.session(account)
      const credential = joyCodeCredentialOf(session)
      path = joyCodePathFor(options.model)
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      const request = this.buildRequest(credential, options, messages, path)
      const response = await this.fetchFn(joyCodeUrl(credential, request.endpoint), {
        method: 'POST',
        headers: joyCodeHeaders(credential, { anthropic: path === 'anthropic', stream: true }),
        body: JSON.stringify(request.body),
        signal: watchdog.signal,
      })
      if (!response.ok) {
        throw joyCodeHttpError(response.status, await response.text().catch(() => ''), `JoyCode ${path}`)
      }
      if (response.body === null) {
        throw new LlmError(`JoyCode ${path} answered no body`, 'MALFORMED_RESPONSE')
      }
      // This upstream answers a REFUSED call with HTTP 200 and a JSON error body.
      // Without this guard that body reaches a stream parser, produces no events,
      // and surfaces as "stream ended before a finish chunk" — which is how a
      // gateway policy refusal got reported as a broken stream.
      const body = guardJoyCodeStream(response.body, `JoyCode ${path}`)
      switch (path) {
        case 'chat':
          // The chat path may answer with bare JSON lines, and may omit the
          // `[DONE]` terminator entirely — the normalizer fixes both before the
          // translator sees them.
          yield* streamChatCompletions(normalizeChatSse(body, watchdog.pulse), watchdog.pulse)
          return
        case 'responses':
          // This path double-wraps every event in another `data:`/`event:` layer.
          yield* streamResponses(unwrapDoubleWrappedSse(body, watchdog.pulse), watchdog.pulse)
          return
        case 'anthropic':
          yield* streamAnthropic(body, watchdog.pulse)
          return
      }
    } catch (error) {
      throw mapFetchFailure(`joycode ${path}`, error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /**
   * Shape one request for its path.
   *
   * `stream: true` is not a choice on this API: the native path forces it (and
   * the reference aggregates SSE when a caller asks for JSON), so this route
   * always streams.
   */
  private buildRequest(
    credential: JoyCodeCredential,
    options: GenerateOptions,
    messages: readonly TranslatableMessage[],
    path: JoyCodePath,
  ): { endpoint: JoyCodeEndpoint, body: Record<string, unknown> } {
    const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
    if (path === 'anthropic') {
      const anthropicMessages = toAnthropicMessages(messages)
      markMessageCache(anthropicMessages)
      const maxTokens = Math.min(options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS, JOYCODE_ANTHROPIC_CEILING)
      return {
        endpoint: 'anthropic',
        body: {
          ...joyCodeEnvelope(credential, { anthropic: true }),
          model: joyCodeAnthropicId(options.model),
          max_tokens: maxTokens,
          system: toAnthropicSystem(options.system, messages),
          messages: anthropicMessages,
          ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toAnthropicTools(options.tools) }
            : {},
          stream: true,
        },
      }
    }
    if (path === 'responses') {
      const { instructions, input } = toResponsesInput(messages, options.system)
      return {
        endpoint: 'responses',
        body: {
          ...joyCodeEnvelope(credential),
          model: options.model,
          ...instructions === undefined ? {} : { instructions },
          input,
          ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toResponsesTools(options.tools, { strict: false }) }
            : {},
          // GPT-family levels are the one set the reference VERIFIES as distinct;
          // `off` is this route's spelling of "no reasoning" and maps to `none`.
          ...effort === undefined ? {} : { reasoning: { effort: effort === 'off' ? 'none' : effort } },
          ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
          stream: true,
        },
      }
    }
    const chat = {
      ...joyCodeEnvelope(credential),
      model: options.model,
      messages: toChatMessages(messages, options.system),
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: toChatTools(options.tools) }
        : {},
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      // The chat families take the level as `reasoning_effort`, and Doubao
      // additionally needs the thinking SWITCH (the reference turns it on
      // whenever an effort is present). No chat model advertises levels today —
      // see catalog.ts — so this branch only fires if a level arrives from
      // elsewhere, and the translation stays correct when one does.
      ...effort === undefined ? {} : effort === 'off'
        ? { thinking: { type: 'disabled' } }
        : { reasoning_effort: effort, ...thinkingSwitch(options.model) },
      stream: true,
    }
    return { endpoint: 'chat', body: chat }
  }
}

/** Turn on thinking for the chat families that gate it on a switch (Doubao). */
function thinkingSwitch(model: string): Record<string, unknown> {
  return model.trim().toLowerCase().startsWith('doubao') ? { thinking: { type: 'enabled' } } : {}
}

/** Display name for one effort level. */
function effortLabel(id: string): string {
  return id === 'xhigh' ? 'Extra High' : id.charAt(0).toUpperCase() + id.slice(1)
}

/** One-line description of a discovery failure. */
function describe(error: unknown): string {
  if (error instanceof LlmError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported so callers can classify a refusal without importing errors. */
export type { JoyCodeRosterEntry, DiscoveredModel }

/**
 * Freebuff (freebuff.com) subscription route.
 *
 * ## What this route is
 *
 * Freebuff is a browser product whose only credential is a browser session
 * (`src/providers/freebuff-session.ts` explains why there is no OAuth flow and no
 * discovery path). This adapter takes that session and speaks whichever of the
 * two upstream protocols it can: the desktop/Bearer OpenAI-shaped completions
 * endpoint, or the web protocol's `/api/chat/stream`. Both are described in
 * `src/providers/freebuff/client.ts`, which also owns the one SSE translator this
 * route needs (the web protocol's 11 event types are NOT OpenAI-shaped).
 *
 * Everything protocol-shaped lives in `freebuff/`: this file is the adapter
 * plumbing — provider identity, retry policy, roster, capability resolution and
 * the stream path.
 *
 * ## The roster is PINNED, not discovered
 *
 * Neither protocol exposes a model-list endpoint, and the reference's own roster
 * is a hardcoded authoritative table it tops up from a public source file
 * (`ref-freebuff2api/src/models.rs:15-39`, `:562-566`, "硬编码权威底座"). So:
 *
 *   - {@link FreebuffAdapter.listOwnModels} serves the pinned table, PAUSED ids
 *     excluded — a roster that offers a paused model is how a client picks a dead
 *     one (`src/models.rs:260-320`);
 *   - with `discovery` on it ADDS whatever that public file declares, and declares
 *     NO capabilities for the additions: an id nobody published a ladder or a
 *     window for gets neither (the reference's prefix-based ladder fallback,
 *     `src/models.rs:117-132` in `router.rs`, is deliberately NOT ported — a
 *     guessed ladder turns into a picker value the upstream would coerce);
 *   - a failed top-up does not empty the roster: the pinned half is always
 *     served, and the failure is reported through `notFetchedReason`.
 *
 * ## Tools exist on ONE wire, and the cookie credential cannot reach it
 *
 * A caller's `tools` array rides the desktop body unchanged (the reference
 * forwards it, `src/api.rs:2707-2708`), so the Bearer path is the tool-capable
 * one. The web body has no `tools` field at all and no tool-turn encoding — it is
 * one flat prompt string (`src/web_protocol.rs:380-388`,
 * `src/web_threads.rs:176-254`) whose only tool vocabulary runs DOWNSTREAM
 * (upstream `agent_tool` → OpenAI `tool_calls`, `src/web_protocol.rs:811-828`).
 * A tool-declaring turn on the web wire is therefore REFUSED
 * ({@link freebuffWebToolRefusal}) rather than downgraded to a tool-less chat,
 * which is the defect this route was reported for: the harness's local tools
 * silently disappeared and the assistant reported Freebuff's own server-side
 * agents as its entire tool set. A replayed tool turn (assistant `tool_calls` +
 * a result) still renders into that prompt so the transcript stays coherent —
 * see {@link webPromptMessages}.
 *
 * @module dsh-subscription-hub/providers/freebuff
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
import type { FreebuffSession, ProviderId } from '../auth/store.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS } from './accounts.js'
import type { FetchFn, ModelEntry, ModelListNotFetched } from './common.js'
import { idleWatchdog, mapFetchFailure, mergeReasoning } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import { resolveImages, toolResultsOf } from '../translate/resolved.js'
import type { TranslatableBlock, TranslatableMessage } from '../translate/resolved.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'
import { freebuffModel, freebuffRoster } from './freebuff/catalog.js'
import type { FreebuffModel } from './freebuff/catalog.js'
import type { FreebuffCredential, FreebuffPromptMessage, FreebuffWire } from './freebuff/client.js'
import {
  freebuffChatBody,
  freebuffChatHeaders,
  freebuffChatUrl,
  freebuffGuardStream,
  freebuffResponseError,
  freebuffWebBody,
  freebuffWebPrompt,
  freebuffWebToChatCompletions,
  freebuffWebToolRefusal,
  freebuffWireFor,
  FREEBUFF_UPSTREAM_MODELS_URL,
  parseFreebuffUpstreamModels,
} from './freebuff/client.js'
import { freebuffCredentialOf } from './freebuff-session.js'

/** Route identity. */
export const FREEBUFF_PROVIDER = 'freebuff'

/** Adapter construction options. */
export interface FreebuffAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<FreebuffSession>
  /**
   * Whether to top the pinned roster up from the public upstream roster file.
   * Off means "the pinned table, and nothing else".
   */
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  defaultEffortOf?: (model: string) => string | undefined
  rateLimit?: RateLimitWait
  pool?: () => PoolAdapter | undefined
}

/** Freebuff wire adapter: one instance serves the `freebuff` provider route. */
export class FreebuffAdapter extends LlmAdapter {
  /** Extra ids the upstream roster declared, per model id (no capabilities attached). */
  private readonly discovered = new Map<string, string>()

  /**
   * Why the top-up failed, when it did — the settings card reads this so a pinned
   * roster is not mistaken for a complete one. The pinned half is still served;
   * this is an advisory, not an empty list.
   */
  private readonly notFetched = new Map<string, ModelListNotFetched>()

  constructor(private readonly options: FreebuffAdapterOptions) {
    super()
  }

  private get fetchFn(): FetchFn {
    return this.options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Freebuff' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `freebuff: provider "${provider}" retryPolicy`,
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

  /**
   * The roster this route serves.
   *
   * Logged out → nothing, like every other route in this plugin: a model list
   * nobody can call is not a list. Logged in → the pinned available rows, plus
   * whatever the operator configured, plus the upstream's declared extras when
   * discovery is on.
   * @param provider - the provider route id.
   * @param account - the account to answer for, or undefined for any.
   * @param signal - optional cancellation.
   * @returns the model entries.
   */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account === undefined) {
      const accounts = await this.options.tokens.list()
      if (accounts.length === 0) return []
    } else if (!await this.options.tokens.hasSession(account)) {
      return []
    }
    if (this.options.discovery) await this.refreshUpstreamRoster(signal)
    const entries = new Map<string, LlmModelInfo>()
    for (const model of freebuffRoster()) {
      entries.set(model.id, this.modelInfo(provider, model))
    }
    for (const configured of this.options.models) {
      if (entries.has(configured.id)) continue
      entries.set(configured.id, {
        provider,
        id: configured.id,
        name: configured.name ?? configured.id,
        ...configured.contextWindow === undefined ? {} : { context: { contextWindow: configured.contextWindow } },
      })
    }
    for (const id of this.discovered.keys()) {
      if (entries.has(id)) continue
      // A discovered id gets NO declared capability: no window, no ladder. The
      // pin does not describe it, and a claim about what upstream accepts is
      // exactly what must not be invented.
      entries.set(id, { provider, id, name: id })
    }
    return [...entries.values()]
  }

  /** Why this route's roster is incomplete, when it is. */
  notFetchedReason(provider: string): ModelListNotFetched | undefined {
    return this.notFetched.get(provider)
  }

  /**
   * Drop per-account state. This route caches no catalog (the roster is pinned),
   * so this clears the top-up advisory and the declared extras, which is the
   * state a credential change can invalidate.
   */
  clearAccountCatalog(_account?: string): void {
    this.notFetched.delete(FREEBUFF_PROVIDER)
    this.discovered.clear()
  }

  /**
   * Capabilities of one Freebuff model.
   *
   * The pinned table is the capability source, so an id it does not describe is
   * reported with NO context window and NO reasoning levels rather than a guess
   * (`src/models.rs:676-693`: the reference is explicit that only its table
   * carries this). The user's configured default level is folded in on top, and a
   * configured level for a model with no ladder produces NO reasoning block at
   * all — the picker must not offer a level the request path would then strip.
   * @param provider - the provider route id.
   * @param model - the wire model id.
   * @returns the resolved model metadata.
   */
  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pinned = freebuffModel(model)
    const configured = this.options.models.find(entry => entry.id === model)
    // The pinned table wins over a configured window: the reference keeps its
    // hardcoded base authoritative over everything it fetches (`src/models.rs:579`),
    // and a configured value therefore only fills an id the table omits.
    const contextWindow = pinned?.contextWindow ?? configured?.contextWindow
    const reasoning = pinned?.efforts === undefined
      ? undefined
      : mergeReasoning(this.options.defaultEffortOf?.(model), {
        efforts: pinned.efforts.map(id => ({ id: ReasoningEffortId(id), name: effortLabel(id) })),
      })
    return {
      provider,
      id: model,
      name: pinned?.id ?? configured?.name ?? model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...reasoning === undefined ? {} : { reasoning },
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
    let wire: FreebuffWire = 'chat-completions'
    try {
      const session = await this.options.tokens.session(account)
      const credential = freebuffCredentialOf(session)
      wire = freebuffWireFor(credential)
      const label = `freebuff ${wire}`
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      const response = wire === 'web'
        ? await this.webRequest(credential, options, messages, watchdog)
        : await this.desktopRequest(credential, options, messages, watchdog)
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const error = await freebuffResponseError(response.status, response.headers, body, label, this.options.onWarn)
        // A 401 invalidates the credential (`src/web_pool.rs:268-275` cools a
        // deterministic failure immediately). Forcing a refresh puts the
        // re-validation through the token manager, which DELETES the stored
        // session when the upstream refuses the credential there too — so the
        // next attempt asks the user for a fresh paste instead of retrying a
        // credential nobody honours.
        if (response.status === 401 || response.status === 403) await this.invalidateCredential(account)
        throw error
      }
      if (response.body === null) {
        throw new LlmError(`Freebuff ${wire} answered no body`, 'MALFORMED_RESPONSE')
      }
      // A refusal can arrive inside a 200 body; the guard reads the opening bytes
      // and errors the stream with the upstream's own words instead of letting an
      // empty stream surface as a truncated one.
      const guarded = freebuffGuardStream(response.body, { label, status: response.status, onActivity: watchdog.pulse })
      const stream = wire === 'web'
        ? freebuffWebToChatCompletions(guarded, { label, onActivity: watchdog.pulse })
        : guarded
      yield* streamChatCompletions(stream, watchdog.pulse)
    } catch (error) {
      throw mapFetchFailure(`freebuff ${wire}`, error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /** The desktop (Bearer) request. */
  private async desktopRequest(
    credential: FreebuffCredential,
    options: GenerateOptions,
    messages: readonly TranslatableMessage[],
    watchdog: { signal: AbortSignal },
  ): Promise<Response> {
    const tools = options.tools === undefined || options.tools.length === 0
      ? undefined
      : toChatTools(options.tools)
    return await this.fetchFn(freebuffChatUrl('chat-completions'), {
      method: 'POST',
      headers: freebuffChatHeaders(credential, 'chat-completions'),
      body: JSON.stringify(freebuffChatBody({
        model: options.model,
        messages: toChatMessages(messages, options.system),
        ...tools === undefined ? {} : { tools },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
        credential: credential.accessToken,
      })),
      signal: watchdog.signal,
    })
  }

  /** The web (cookie) request. */
  private async webRequest(
    credential: FreebuffCredential,
    options: GenerateOptions,
    messages: readonly TranslatableMessage[],
    watchdog: { signal: AbortSignal },
  ): Promise<Response> {
    // The web body has no `tools` field and no tool-turn encoding, so a turn that
    // declares tools can only ever reach the model as a tool-LESS chat: the
    // harness's local tools (file read/write, shell, glob/grep) simply do not
    // exist for it, and the assistant reports Freebuff's own server-side agents
    // as its whole tool set. That is a silent loss of every local capability, so
    // it is refused outright instead — see the module doc in `freebuff/client.ts`
    // for the wire citation and the live evidence.
    const tools = options.tools?.length ?? 0
    if (tools > 0) throw freebuffWebToolRefusal(tools)
    // The web protocol takes images through a SEPARATE upload endpoint
    // (`POST /api/chat/upload`, `src/web_protocol.rs:5`) which this route does not
    // implement. Sending `images: []` and letting the turn proceed would answer a
    // question about a picture the model never received, so an image-bearing turn
    // fails here and says why.
    if (messages.some(message => message.content.some(block => block.type === 'image'))) {
      throw new LlmError(
        'Freebuff (web protocol) cannot carry images: they require the upload endpoint this route does not '
        + 'implement. Use a Bearer credential (the desktop protocol takes image parts inline) or ask without the image.',
        'HTTP_400',
      )
    }
    const prompt = freebuffWebPrompt([
      ...translatableToPrompt(options.system),
      ...messages.flatMap(webPromptMessages),
    ])
    if (prompt === undefined) {
      throw new LlmError(
        'Freebuff (web protocol) needs at least one non-empty user message: this wire takes a single prompt string, '
        + 'not a message array.',
        'HTTP_400',
      )
    }
    return await this.fetchFn(freebuffChatUrl('web'), {
      method: 'POST',
      headers: freebuffChatHeaders(credential, 'web'),
      body: JSON.stringify(freebuffWebBody({
        model: options.model,
        content: prompt,
        credential: credential.cookie ?? credential.accessToken,
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
      })),
      signal: watchdog.signal,
    })
  }

  /**
   * Ask the token manager to re-validate after a 401.
   *
   * The call itself is the invalidation: a refresh that the upstream refuses is
   * permanent (`isFreebuffPermanentRefreshError`) and removes the stored session,
   * while a transient failure leaves it in place. Its own outcome is swallowed
   * because the request's 401 already carries the diagnosis.
   * @param account - the account the request used.
   */
  private async invalidateCredential(account?: string): Promise<void> {
    try {
      await this.options.tokens.session(account, true)
    } catch {
      // The 401 is already being reported; a refresh failure adds nothing.
    }
  }

  /** The pinned roster entry as the picker's model info. */
  private modelInfo(provider: string, model: FreebuffModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.id,
      ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
    }
  }

  /**
   * Top the roster up from the upstream's public roster file.
   *
   * A failure is recorded, not thrown: the pinned half of the roster is served
   * either way, and the reference has the same behaviour (its `refresh_from_upstream`
   * returns "0 added, 0 removed" on a non-2xx rather than failing, `src/models.rs:562-575`).
   * @param signal - optional cancellation.
   */
  private async refreshUpstreamRoster(signal?: AbortSignal): Promise<void> {
    try {
      const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
      const response = await this.fetchFn(FREEBUFF_UPSTREAM_MODELS_URL, {
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const declared = parseFreebuffUpstreamModels(await response.text())
      if (declared.length === 0) return
      this.discovered.clear()
      for (const id of declared) this.discovered.set(id, id)
      this.notFetched.delete(FREEBUFF_PROVIDER)
    } catch (error) {
      this.reportNotFetched(FREEBUFF_PROVIDER, {
        what: 'The upstream Freebuff roster could not be read; the pinned model table is being served alone',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private reportNotFetched(provider: string, reason: ModelListNotFetched): void {
    this.notFetched.set(provider, reason)
    this.options.onWarn?.(`${reason.what} (${reason.detail})`)
  }
}

/** Display name for one effort level (the hub's own spelling rules). */
function effortLabel(id: string): string {
  return id === 'xhigh' ? 'Extra High' : id.charAt(0).toUpperCase() + id.slice(1)
}

/** One system message as the web prompt flattener wants it. */
function translatableToPrompt(system?: string): FreebuffPromptMessage[] {
  const text = system?.trim() ?? ''
  return text === '' ? [] : [{ role: 'system', text }]
}

/** The text of every text block in a content list, joined with newlines. */
function textOf(blocks: readonly TranslatableBlock[]): string {
  return blocks
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(part => part !== '')
    .join('\n')
}

/**
 * One hub message as the web prompt flattener wants it — TOOL TURNS included.
 *
 * The web wire takes a flat prompt, so every part of a tool exchange has to be
 * rendered into it or it is lost:
 *
 *   - a tool result becomes one `[工具结果]` part — the reference's own label for
 *     exactly this case (`src/web_threads.rs:242`) — whether it arrives as a
 *     `role:"tool"` message or as a `tool-result` block inside a user-role message
 *     (`toolResultsOf` is the hub's reader for both spellings). The tool-call id
 *     has no home in that rendering — the reference drops it too, because the wire
 *     has no field for it — so a transcript with parallel calls pairs by text,
 *     like the reference's. Before this, the text INSIDE a `tool-result` block was
 *     dropped outright on this wire (the message carrying it had no text blocks of
 *     its own), losing the tool's entire output;
 *   - an assistant `tool-call` block becomes its own `[工具调用]` part (see
 *     `FREEBUFF_PROMPT_LABELS` in the client for why that one label is an
 *     extension and where its body rendering comes from). Dropping it, as the
 *     route used to, left the `[工具结果]` that follows with no antecedent and an
 *     assistant turn that called several tools with no text at all.
 *
 * One message can therefore produce SEVERAL prompt parts, and the split is what
 * keeps each of them labelled: `freebuffWebPrompt` sends a one-message
 * conversation VERBATIM, so an unlabelled `[工具结果]` is the failure this
 * avoids.
 * @param message - one hub message.
 * @returns the prompt parts it renders to, in reading order.
 */
function webPromptMessages(message: TranslatableMessage): FreebuffPromptMessage[] {
  if (message.role === 'system') {
    const text = textOf(message.content).trim()
    return text === '' ? [] : [{ role: 'system', text }]
  }
  if (message.role === 'tool') {
    const result = toolResultsOf(message)[0]
    const text = result === undefined ? '' : textOf(result.content).trim()
    return text === '' ? [] : [{ role: 'tool', text }]
  }
  const parts: FreebuffPromptMessage[] = []
  const text = textOf(message.content).trim()
  if (text !== '') parts.push({ role: message.role === 'assistant' ? 'assistant' : 'user', text })
  if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      // The reference's own rendering of a tool as text (`src/web_protocol.rs:991`,
      // `format!("{name}: {label}")`), with the call's arguments as the label.
      parts.push({ role: 'tool-call', text: `${block.name}: ${block.arguments}` })
    }
    return parts
  }
  for (const result of toolResultsOf(message)) {
    const body = textOf(result.content).trim()
    if (body !== '') parts.push({ role: 'tool', text: body })
  }
  return parts
}

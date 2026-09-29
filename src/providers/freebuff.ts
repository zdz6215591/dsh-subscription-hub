/**
 * Freebuff (codebuff.com) subscription route.
 *
 * ## What this route is
 *
 * Freebuff is a product whose free tier rides its own desktop protocol, and this
 * adapter speaks exactly that: the Bearer/OpenAI-shaped
 * `POST {www.codebuff.com}/api/v1/chat/completions`, whose SSE the hub's own
 * `streamChatCompletions` translator already reads. Everything protocol-shaped
 * lives in `freebuff/client.ts`; the credential paths live in
 * `freebuff-cli.ts` (the official CLI's login) and `freebuff-session.ts`
 * (validation + keepalive). This file is the adapter plumbing — provider
 * identity, retry policy, roster, capability resolution and the stream path.
 *
 * ## The credential is a Bearer, and there is exactly one wire
 *
 * A browser COOKIE is refused by name (`freebuffCookieRefusal`): the only wire it
 * can ride takes one flat prompt string with no `tools` field
 * (`ref-freebuff2api/src/web_protocol.rs:380-388`), so a turn through it would
 * lose every harness tool without saying so. Live-verified 2026-09-28 with a
 * cookie credential, a `tools` array bolted onto that body is ignored and the
 * model answers that its available tools are Freebuff's own server-side agents —
 * the exact silent downgrade this route must not ship. So the cookie wire's code
 * (its body builder, prompt flattener and SSE translator) has been DELETED
 * rather than kept behind a branch nothing can reach.
 *
 * ## Every turn is bootstrapped, and the free AGENT matters
 *
 * The upstream does not accept a bare OpenAI request: without a run id it answers
 * `400 No runId found in request body`. Following the CLI (`qDA`, `CV`), a turn
 * is:
 *
 *   1. `POST /api/v1/freebuff/session/admission` with the CLI's header set and the
 *      model — this admits the instance and is also what the session is bound to;
 *   2. `POST /api/v1/agent-runs {action:"START", agentId, ancestorRunIds:[]}` —
 *      the `runId` the chat body must carry, started for the MODEL-SPECIFIC free
 *      agent (`base2-free-space-bunny-alpha` for `stealth/space-bunny-alpha`);
 *   3. `POST /api/v1/chat/completions` with that `run_id` in `codebuff_metadata`,
 *      beside the `cli:`-prefixed instance id, `freebuff_multi_session:"1"` and
 *      `surface:"cli"`.
 *
 * Step 2's agent is the difference between a turn and
 * `403 free_mode_invalid_agent_model`: free mode validates the RUN's agent
 * against the requested model, so starting every run for the generic
 * `base2-free` (which is what `ref-freebuff2api/src/models.rs:16` does, and what
 * the first probe here did) fails for every model but one.
 *
 * ## What a FREE CLI credential actually gets: not the tools, a refusal
 *
 * Live 2026-09-28, with the credential the official CLI itself stored
 * (`~/.config/manicode/credentials.json` → `default.authToken`) and the complete
 * CLI-shaped bootstrap above, a PLAIN chat turn (no tools, nothing but
 * "Reply with exactly: ok") was refused:
 *
 *     POST /api/v1/chat/completions -> 403
 *     {"error":"free_mode_cli_required","message":"Free mode is only available
 *      through the freebuff CLI. Install it with `npm i -g freebuff`, then run
 *      `freebuff`. Calling the API directly is not supported and may get your
 *      account banned."}
 *
 * So free mode is gated to the CLI's own channel, not to the credential: the
 * tool question is never reached, and the refusal warns about the account. Probing
 * stopped there by design. {@link freebuffTextError} maps that code to
 * `UNSUPPORTED` with the upstream's own warning in the message, so the card shows
 * the gate instead of the retry plugin hammering a refusal that will not change.
 * Two further observations from the same run: the run bootstrap itself SUCCEEDS
 * (200 + a run id) even for a gated chat, and the session ADMISSION can be
 * refused independently with `409 purchase_capacity` when another desktop session
 * holds the account's single free slot — both are reported with the upstream's
 * own words.
 *
 * The QUOTA read is the one credentialed call that works: see
 * `freebuff/usage.ts`.
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
import { resolveImages } from '../translate/resolved.js'
import type { TranslatableMessage } from '../translate/resolved.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'
import { freebuffModel, freebuffRoster } from './freebuff/catalog.js'
import type { FreebuffModel } from './freebuff/catalog.js'
import type { FreebuffCredential } from './freebuff/client.js'
import {
  freebuffAgentFor,
  freebuffAssertDesktopCredential,
  freebuffChatBody,
  freebuffChatHeaders,
  freebuffChatUrl,
  freebuffGuardStream,
  freebuffInstanceId,
  freebuffResponseError,
  freebuffRunBody,
  freebuffRunHeaders,
  freebuffRunUrl,
  freebuffSessionAdmissionUrl,
  freebuffSessionHeaders,
  freebuffSessionStatusError,
  parseFreebuffRunId,
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

/** Freebuff desktop wire adapter: one instance serves the `freebuff` provider route. */
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

  /**
   * One turn: bootstrap, then stream.
   *
   * The bootstrap is per turn on purpose, matching the reference (its
   * `ensure_root_run` starts a fresh root run for every attempt,
   * `src/api.rs:3385-3394`) and the CLI (a run is one task). The instance id is
   * derived from the credential, so it is stable across turns — which is what
   * makes the session admission idempotent for one account.
   * @param options - the caller's request.
   * @param account - the account to serve, or undefined for the default one.
   * @yields the translated stream chunks.
   */
  private async *streamCore(options: GenerateOptions, account?: string): AsyncGenerator<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const session = await this.options.tokens.session(account)
      const credential = freebuffCredentialOf(session)
      // A cookie credential is refused BEFORE anything is sent: see the module doc.
      freebuffAssertDesktopCredential(credential)
      const label = 'freebuff desktop'
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      const runId = await this.bootstrap(credential, options.model, label, watchdog)
      const response = await this.desktopRequest(credential, options, messages, runId, watchdog)
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const error = await freebuffResponseError(response.status, response.headers, body, label, this.options.onWarn)
        // A 401/403 invalidates the credential (`src/web_pool.rs:268-275` cools a
        // deterministic failure immediately). Forcing a refresh puts the
        // re-validation through the token manager, which DELETES the stored
        // session when the upstream refuses the credential there too — so the
        // next attempt asks for a fresh import instead of retrying a credential
        // nobody honours.
        if (response.status === 401 || response.status === 403) await this.invalidateCredential(account)
        throw error
      }
      if (response.body === null) {
        throw new LlmError(`Freebuff ${label} answered no body`, 'MALFORMED_RESPONSE')
      }
      // A refusal can arrive inside a 200 body; the guard reads the opening bytes
      // and errors the stream with the upstream's own words instead of letting an
      // empty stream surface as a truncated one.
      const guarded = freebuffGuardStream(response.body, { label, status: response.status, onActivity: watchdog.pulse })
      yield* streamChatCompletions(guarded, watchdog.pulse)
    } catch (error) {
      throw mapFetchFailure('freebuff desktop', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /**
   * Admit a session and start the agent run this turn needs.
   *
   * The sequence is the CLI's (`CV` then `qDA`), and both halves are load-bearing:
   * the admission binds the instance to the model, and the run is what the chat
   * body's `run_id` refers to — without it the upstream answers
   * `400 No runId found in request body`.
   * @param credential - the Bearer credential.
   * @param model - the model this turn asks for.
   * @param label - diagnostic prefix.
   * @param watchdog - the turn's abort/idle watchdog.
   * @returns the run id to put in the body.
   * @throws {LlmError} the upstream's own refusal, classified.
   */
  private async bootstrap(
    credential: FreebuffCredential,
    model: string,
    label: string,
    watchdog: { signal: AbortSignal },
  ): Promise<string> {
    const instanceId = freebuffInstanceId(credential.accessToken)
    const admissionLabel = `${label} session admission`
    const admission = await this.fetchFn(freebuffSessionAdmissionUrl(), {
      method: 'POST',
      headers: freebuffSessionHeaders({ credential, method: 'POST', instanceId, model }),
      // The CLI sends no body here (`CV` calls `fetch(E, {method, headers, signal})`);
      // an empty JSON object is what the legacy session POST took and is ignored.
      body: '{}',
      signal: watchdog.signal,
    })
    const admissionBody = await admission.text().catch(() => '')
    const admissionPayload = tryJson(admissionBody)
    if (!admission.ok) {
      throw await freebuffResponseError(admission.status, admission.headers, admissionBody, admissionLabel, this.options.onWarn)
    }
    const statusError = freebuffSessionStatusError(admissionPayload, admission.status, admissionLabel)
    if (statusError !== undefined) throw statusError

    const runLabel = `${label} agent run`
    const runResponse = await this.fetchFn(freebuffRunUrl(), {
      method: 'POST',
      headers: freebuffRunHeaders(credential),
      body: JSON.stringify(freebuffRunBody(freebuffAgentFor(model))),
      signal: watchdog.signal,
    })
    const runBody = await runResponse.text().catch(() => '')
    if (!runResponse.ok) {
      throw await freebuffResponseError(runResponse.status, runResponse.headers, runBody, runLabel, this.options.onWarn)
    }
    const runId = parseFreebuffRunId(tryJson(runBody))
    if (runId === undefined) {
      throw new LlmError(
        `${runLabel} answered no runId, and a chat body without one is refused: ${runBody.slice(0, 200)}`,
        'MALFORMED_RESPONSE',
      )
    }
    return runId
  }

  /** The desktop (Bearer) chat request. */
  private async desktopRequest(
    credential: FreebuffCredential,
    options: GenerateOptions,
    messages: readonly TranslatableMessage[],
    runId: string,
    watchdog: { signal: AbortSignal },
  ): Promise<Response> {
    const tools = options.tools === undefined || options.tools.length === 0
      ? undefined
      : toChatTools(options.tools)
    return await this.fetchFn(freebuffChatUrl(), {
      method: 'POST',
      headers: freebuffChatHeaders(credential),
      body: JSON.stringify(freebuffChatBody({
        model: options.model,
        messages: toChatMessages(messages, options.system),
        ...tools === undefined ? {} : { tools },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
        credential: credential.accessToken,
        runId,
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

/** Parse JSON without throwing. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

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
  freebuffResponseError,
  freebuffRunBody,
  freebuffRunHeaders,
  freebuffRunUrl,
  freebuffSessionAdmissionUrl,
  freebuffSessionAttemptUrl,
  freebuffSessionHeaders,
  freebuffSessionStatus,
  parseFreebuffRunId,
  FREEBUFF_UPSTREAM_MODELS_URL,
  parseFreebuffUpstreamModels,
} from './freebuff/client.js'
import type { FreebuffAdmissionVerdict } from './freebuff/client.js'
import {
  freebuffClaimOf,
  freebuffForgetClaim,
  freebuffMintInstanceId,
  freebuffRecordClaim,
} from './freebuff/claim.js'
import type { FreebuffClaim } from './freebuff/claim.js'
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
   * `src/api.rs:3385-3394`) and the CLI (a run is one task). The SESSION, on the
   * other hand, is not re-created per turn: the attempt this process holds is
   * re-admitted while it is live (which the upstream answers idempotently), and
   * only replaced when it is over — see {@link FreebuffAdapter.admit}.
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
      const { instanceId, runId } = await this.bootstrap(credential, options.model, label, watchdog)
      const response = await this.desktopRequest(credential, options, messages, instanceId, runId, watchdog)
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
   *
   * ## Why the attempt id is per CLAIM, not per credential
   *
   * The admission's `x-freebuff-desktop-attempt-id` is one session START, and the
   * upstream retires it for good once that start is over — the CLI therefore
   * mints a fresh `cli:<uuid>` per claim (`wr()`) instead of pinning one to the
   * credential. Deriving it from the token (what this route did until
   * 2026-09-29) means a released or cancelled attempt can never be claimed again:
   * every later turn answers `409 {"status":"purchase_claim_released",…}`, which
   * is the failure this flow exists to prevent. See `./freebuff/claim.js` for the
   * live bytes and the CLI's own lifecycle.
   *
   * The flow, in the CLI's own order:
   *
   *  1. speak for the claim this process already holds, when the model matches —
   *     a re-admission of a live instance is idempotent (live 2026-09-29:
   *     `200 status:"active"` with the SAME `admittedAt`/`expiresAt`, so the hour
   *     is not extended and no extra session is consumed);
   *  2. on a MODEL change, end the held claim first (`DELETE …/session/attempt`)
   *     and then mint fresh — exactly the CLI's `releaseSlot()` → `J=wr()`. A new
   *     instance minted while the old claim is still live would be refused with
   *     `purchase_capacity` naming the old one (`slotLimit: 1` on the free tier,
   *     reproduced live);
   *  3. on a retired attempt (`purchase_claim_released`,
   *     `admission_attempt_closed`) or a status that says the attempt has no
   *     session at all, mint a FRESH attempt and retry ONCE — the mechanical
   *     equivalent of the CLI's "Choose a model to start a new session", which
   *     also mints a fresh instance before re-POSTing;
   *  4. anything else is reported as it is, with the remedy in the user's terms
   *     ({@link freebuffSessionStatus}), never as a bare HTTP status.
   * @param credential - the Bearer credential.
   * @param model - the model this turn asks for.
   * @param label - diagnostic prefix.
   * @param watchdog - the turn's abort/idle watchdog.
   * @returns the admitted instance and the run id to put in the body.
   * @throws {LlmError} the upstream's own refusal, classified.
   */
  private async bootstrap(
    credential: FreebuffCredential,
    model: string,
    label: string,
    watchdog: { signal: AbortSignal },
  ): Promise<{ instanceId: string; runId: string }> {
    const instanceId = await this.admit(credential, model, label, watchdog)
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
    return { instanceId, runId }
  }

  /**
   * Open — or re-open — the session this turn chats on.
   *
   * The claim lifecycle is `./freebuff/claim.js`'s; this is the wire half: one
   * POST per turn, a retry ONCE with a fresh attempt when the upstream says the
   * attempt is over, and a release-then-fresh attempt when the model changed.
   * @param credential - the Bearer credential.
   * @param model - the model this turn asks for.
   * @param label - diagnostic prefix.
   * @param watchdog - the turn's abort/idle watchdog.
   * @returns the instance id the chat must speak for.
   * @throws {LlmError} when no attempt can be admitted.
   */
  private async admit(
    credential: FreebuffCredential,
    model: string,
    label: string,
    watchdog: { signal: AbortSignal },
  ): Promise<string> {
    const admissionLabel = `${label} session admission`
    const held = freebuffClaimOf(credential.accessToken)
    if (held !== undefined && held.model !== model) {
      await this.releaseClaim(credential, held, model, admissionLabel, watchdog)
    }
    const current = freebuffClaimOf(credential.accessToken)
    let instanceId = current?.instanceId ?? freebuffMintInstanceId()
    let freshAttemptTried: string | undefined
    for (;;) {
      const response = await this.fetchFn(freebuffSessionAdmissionUrl(), {
        method: 'POST',
        headers: freebuffSessionHeaders({ credential, method: 'POST', instanceId, model }),
        // The CLI sends no body here (`CV` calls `fetch(E, {method, headers, signal})`);
        // an empty JSON object is what the legacy session POST took and is ignored.
        body: '{}',
        signal: watchdog.signal,
      })
      const body = await response.text().catch(() => '')
      const payload = tryJson(body)
      // The state machine's own vocabulary, read before the generic classifier:
      // that is how `purchase_claim_released` becomes a named state with a remedy
      // instead of a bare HTTP 409.
      const reading = freebuffSessionStatus(payload, response.status, admissionLabel, {
        body,
        attempt: instanceId,
        ...freshAttemptTried === undefined ? {} : { freshAttemptTried },
      })
      if (reading.verdict === 'active') {
        return this.recordClaim(credential.accessToken, instanceId, model, payload)
      }
      if (freshAttemptTried === undefined && this.retryWithFreshAttempt(reading.verdict)) {
        // The CLI's own next move after a release is a NEW attempt (`J=wr()`),
        // which is also what its "Choose a model to start a new session" prompt
        // does — the released id itself is never re-admitted.
        freebuffForgetClaim(credential.accessToken, instanceId)
        freshAttemptTried = instanceId
        instanceId = freebuffMintInstanceId()
        continue
      }
      // Only a state this table could not name falls back to the hub's own
      // classification, which is where a 5xx stays SERVER and a 429 RATE_LIMIT.
      throw reading.error
        ?? await freebuffResponseError(response.status, response.headers, body, admissionLabel, this.options.onWarn)
    }
  }

  /**
   * Whether a verdict is worth replacing the attempt for.
   *
   * `retired` and `no-claim` both mean the upstream holds nothing for this
   * attempt, so a fresh attempt is the CLI's own next move and cannot collide
   * with a slot (a slot that IS held is reported as `slot-held`, which must never
   * be retried — a new attempt against a held slot is refused with
   * `purchase_capacity` naming the holder, reproduced live).
   * @param verdict - what the answer meant.
   * @returns whether to mint a fresh attempt and retry once.
   */
  private retryWithFreshAttempt(verdict: FreebuffAdmissionVerdict): boolean {
    return verdict === 'retired' || verdict === 'no-claim'
  }

  /**
   * Record what an accepted admission binds: the instance, its model, its end.
   *
   * The fields are the CLI's own persistence shape (`wJA` writes `{instanceId,
   * model, tokenKey, ownerPid, expiresAt}`), and `expiresAt` is the answer's own
   * value — a claim with no disclosed expiry stays usable in-process, which is
   * what the CLI does with an instance it did not record.
   *
   * The instance the TURN then speaks for is the one the upstream echoed back,
   * not necessarily the one that was sent: the CLI follows the same rule (its
   * session state takes `g.instanceId`, which is why a server-assigned id would
   * quietly switch the route to the single-session wire — and why such an id is
   * not recorded as a claim at all).
   * @param token - the Bearer the claim belongs to.
   * @param instanceId - the attempt that was sent.
   * @param model - the model it was admitted for.
   * @param payload - the admission's answer.
   * @returns the instance id this turn must chat with.
   */
  private recordClaim(token: string, instanceId: string, model: string, payload: unknown): string {
    const echoed = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).instanceId
      : undefined
    const bound = typeof echoed === 'string' && echoed !== '' ? echoed : instanceId
    const expiresAt = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).expiresAt
      : undefined
    const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN
    freebuffRecordClaim(token, {
      instanceId: bound,
      model,
      ...Number.isFinite(expires) ? { expiresAt: expires } : {},
    })
    return bound
  }

  /**
   * End the claim this process holds, before a turn that cannot continue it.
   *
   * This is the CLI's `releaseSlot()`: the reason to end a live session here is a
   * MODEL change, because the admission binds an instance to one model — asking
   * the live instance for a different model releases its claim and the next
   * attempt is refused with `purchase_capacity` for the holder that is still
   * live (both reproduced live 2026-09-29). The CLI's own order is DELETE, then a
   * fresh instance, then POST, so that is this route's order too.
   * @param credential - the Bearer credential.
   * @param claim - the live claim being replaced.
   * @param model - the model the turn actually wants.
   * @param label - diagnostic prefix.
   * @param watchdog - the turn's abort/idle watchdog.
   * @throws {LlmError} when the upstream does not confirm the session ended.
   */
  private async releaseClaim(
    credential: FreebuffCredential,
    claim: FreebuffClaim,
    model: string,
    label: string,
    watchdog: { signal: AbortSignal },
  ): Promise<void> {
    const response = await this.fetchFn(freebuffSessionAttemptUrl(), {
      method: 'DELETE',
      headers: freebuffSessionHeaders({ credential, method: 'DELETE', instanceId: claim.instanceId }),
      signal: watchdog.signal,
    })
    const body = await response.text().catch(() => '')
    const payload = tryJson(body)
    const status = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).status
      : undefined
    // The CLI's own confirmation is `status === "ended"` (`releaseSlot` throws
    // "The server did not confirm that the session ended." otherwise) — live
    // 2026-09-29 that answer is `{"status":"ended","desktopAttemptId":"<uuid>",
    // "refundReceiptId":"…","freebucksRefundPending":true}`. `none` is accepted
    // as "already gone": there is nothing left to release, and the fresh attempt
    // below is then admitted (the freed slot admits one immediately).
    if (status === 'ended' || status === 'none') {
      freebuffForgetClaim(credential.accessToken, claim.instanceId)
      return
    }
    throw new LlmError(
      `${label} could not end the ${claim.model} session it was holding (DELETE …/session/attempt answered HTTP `
      + `${String(response.status)}, status="${String(status)}"${body.trim() === '' ? '' : `: ${body.slice(0, 200)}`}), so `
      + `the switch to ${model} was not applied. Run \`/end-session\` in the Freebuff CLI, then pick ${model} here. `
      + '(Sessions end on their own after 1 hour.)',
      response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP_409',
      { status: response.status },
    )
  }

  /** The desktop (Bearer) chat request. */
  private async desktopRequest(
    credential: FreebuffCredential,
    options: GenerateOptions,
    messages: readonly TranslatableMessage[],
    instanceId: string,
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
        // The admitted attempt, not a value recomputed from the credential: the
        // chat has to name the same instance the run was started for.
        instanceId,
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

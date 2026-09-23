/**
 * The hub-facing Qoder adapter: one `LlmAdapter` over the ported protocol.
 *
 * Everything below this file is protocol; this file is the seam. It owns
 * exactly the behaviour that is transport rather than wire format:
 *
 *  - the catalog cache (a subscription's model list changes only when the plan
 *    does, so re-reading it per request is waste);
 *  - the job-token self-heal — one fresh exchange, then one paced retry, when
 *    the gateway rejects a token it previously accepted, which is a gateway
 *    rotation or fault window rather than a revoked PAT;
 *  - the two notices that self-heal owes the user, and the latch that keeps a
 *    rejection storm from printing one row per retry.
 *
 * The reference's `DefaultQoderTransport` is the same seam. Its `resolvePat`
 * hook becomes {@link QoderAdapterOptions.personalToken} here, widened to take
 * an account key so this directory needs no knowledge of how (or from where)
 * the hub stores credentials. That makes the class structurally compatible
 * with the hub's `AccountAwareAdapter` — the interface the account pool drives
 * (`streamAccount`, `listOwnModels`, `resolveOwnModel`, `clearAccountCatalog`)
 * — without importing a single hub-side session type.
 *
 * `region` is an adapter option that accepts either a fixed deployment or a
 * per-account resolver, because both deployments speak this identical protocol
 * against different hosts while a PAT is minted for exactly one of them: one
 * `qoder` route can therefore serve global and China accounts together, each
 * resolved from its own credential. Everything that talks to the network —
 * the token exchange, the catalog read, the quota read, the center image
 * upload — is scoped to the region resolved for that account, and each region
 * gets its own cache so the two can never cross.
 *
 * @module dsh-subscription-hub/providers/qoder/adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { proxiedFetch } from '../../http.js'
import type { FetchFn, ModelEntry, ProviderUsage } from '../common.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from '../rate-limit.js'
import type { RateLimitWait } from '../rate-limit.js'
import { QoderAuthService } from './auth.js'
import { defaultModels, fetchQoderModels } from './catalog.js'
import type { QoderCatalogModel } from './catalog.js'
import { streamQoderChat } from './chat.js'
import type { QoderChatDependencies } from './chat.js'
import type { CosyCredentials } from './cosy.js'
import { isQoderAuthRejection, qoderError, QODER_ABORTED_CODE, QODER_MISSING_CREDENTIAL_CODE } from './errors.js'
import { QoderImageUploader } from './image-upload.js'
import type { QoderLogger } from './logging.js'
import type { QoderRegion } from './region.js'
import { defaultResponseHeaderTimeoutMs, opaqueCredentialKey, retryMetadataRead, SingleFlight } from './request.js'
import { translateQoderMessages, validateQoderRequestShape } from './serialize.js'
import type { QoderImageAttachments } from './translate.js'
import { fetchQoderUsage, QoderUsageReader } from './usage.js'
import type { QoderWireMessage } from './wire-types.js'

/** Default idle ceiling for one chat stream. */
export const defaultStreamIdleTimeoutMs = 5 * 60 * 1000

/**
 * How long a rotated-token notice may wait for an accepting chat.
 *
 * The heal's own retry can lose a race with a transient fault and be rescued
 * by a later attempt, so the notice is deferred until some chat is accepted.
 * That deferral has to be bounded: an unbounded one let a rotation from minutes
 * earlier surface as a fresh-looking row whose timestamp named a moment the
 * user could not connect to the row appearing now. Five minutes comfortably
 * covers the host's own retry cycle (its backoff caps at 10s) while keeping the
 * row adjacent to the event it describes.
 */
const jobTokenNoticeMaxAgeMs = 5 * 60 * 1000

/** How long a discovered catalog is trusted before it is re-read. */
const catalogTtlMs = 5 * 60 * 1000

/** Wait between the two paced self-heal rounds. */
const reauthBackoffMs = 2_000

/**
 * Resolve which deployment one account's credential belongs to.
 *
 * A Qoder PAT is minted against exactly one deployment and is refused by the
 * other, so the region is a property of the CREDENTIAL, not of the transport.
 * @param account - the hub's account key, or undefined for the default account.
 * @returns the deployment to address.
 */
export type QoderRegionResolver = (account?: string) => QoderRegion | Promise<QoderRegion>

/** Options the hub passes in to build one adapter. */
export interface QoderAdapterOptions {
  /** Configured catalog: the fallback list and each entry's display metadata. */
  models: readonly ModelEntry[]
  /** Idle ceiling for one chat stream. */
  streamIdleTimeoutMs: number
  /**
   * Resolve the account's Personal Access Token — NOT the job token.
   *
   * The PAT is the durable secret; this transport exchanges it for a job token
   * and caches that per (region, PAT) itself, so the caller need not.
   * @param account - the hub's account key, or undefined for the default account.
   * @returns the PAT, or undefined when that account is not logged in.
   */
  personalToken: (account?: string) => Promise<string | undefined>
  /** Whether to read the live catalog instead of the configured list. */
  discovery: boolean
  /** Diagnostic sink for catalog/usage/upload degradation. */
  onWarn?: (message: string) => void
  /** Fetcher to use; defaults to the hub's proxy-aware fetch. */
  fetchFn?: FetchFn
  /** Rate-limit waiting behavior for the retry policy. */
  rateLimit?: RateLimitWait
  /**
   * Which deployment this instance talks to.
   *
   * Either the fixed region for a deployment-scoped route, or a resolver that
   * reads it from the account (the hub stores it on the session). One route can
   * therefore carry global and China accounts side by side. Defaults to
   * `global`. A resolved value is remembered per account key — the region is a
   * property of the credential, so it cannot change under a stable account.
   */
  region?: QoderRegion | QoderRegionResolver
  /** Provider display name; defaults to `Qoder`. */
  displayName?: string
  /** Attachment store, for image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Whether prior assistant reasoning content is replayed (default true). */
  preserveThinking?: boolean
  /** Machine-fingerprint resolver; defaults to this machine's stable id. */
  resolveMachineId?: () => string
  /** Deadline for a model request's response headers. */
  responseHeaderTimeoutMs?: number
  /** Deadline for each metadata request. */
  metadataTimeoutMs?: number
  /**
   * Called once per successful re-auth, right after a fresh job token was
   * exchanged and accepted following a 401 rejection.
   */
  onJobTokenRefreshed?: (info: { region: QoderRegion; at: number }) => void
  /**
   * Called once per unresolved self-heal failure: a fresh job token was
   * exchanged, the chat retried, and the upstream rejected it anyway.
   *
   * Reported at most once per outage (reset when a later chat is accepted), so
   * a long rejection storm does not print a row per retry.
   */
  onJobTokenRefreshFailed?: (info: { region: QoderRegion; at: number; status?: number }) => void
}

function aborted(message: string): Error {
  return qoderError(message, QODER_ABORTED_CODE)
}

/**
 * Qoder's adapter: protocol transport plus the harness `LlmAdapter` contract.
 *
 * One instance serves one region. The account pool drives it through the
 * `AccountAwareAdapter` methods below (`streamAccount`, `listOwnModels`,
 * `resolveOwnModel`, `clearAccountCatalog`), each of which delegates to
 * {@link QoderAdapterOptions.personalToken} for the credential.
 */
export class QoderAdapter extends LlmAdapter {
  private readonly regionOption: QoderRegion | QoderRegionResolver
  private readonly resolvePat: (account?: string) => Promise<string | undefined>
  private readonly fetchImpl: FetchFn
  private readonly logger: QoderLogger | undefined
  private readonly streamIdleTimeoutMs: number
  private readonly responseHeaderTimeoutMs: number
  private readonly metadataTimeoutMs: number | undefined
  /** One credential store per region: the cache key includes the region, so the two never cross. */
  private readonly authByRegion = new Map<QoderRegion, QoderAuthService>()
  /** One usage reader per region (its own cache and single-flight). */
  private readonly usageByRegion = new Map<QoderRegion, QoderUsageReader>()
  /** One image uploader per region (the center host differs). */
  private readonly uploaderByRegion = new Map<QoderRegion, QoderImageUploader>()
  /** Regions already resolved, keyed by account key. */
  private readonly regionCache = new Map<string, QoderRegion>()
  private readonly attachments: QoderImageAttachments | undefined
  private readonly preserveThinking: boolean | undefined
  private readonly onJobTokenRefreshed: QoderAdapterOptions['onJobTokenRefreshed']
  private readonly onJobTokenRefreshFailed: QoderAdapterOptions['onJobTokenRefreshFailed']
  /** Discovered catalogs, keyed `region:account:PAT-hash` so one account's clear cannot drop a sibling's. */
  private readonly catalogs = new Map<string, { at: number; models: readonly QoderCatalogModel[] }>()
  private readonly modelFlights = new SingleFlight<readonly QoderCatalogModel[]>()
  /**
   * Set when the self-heal exchanged a fresh job token, cleared when a chat
   * afterwards succeeds. The notice reports "the token was rotated because the
   * old one was rejected", which is true from that exchange on — so it must not
   * be tied to the heal's OWN retry, which can still lose a race with a
   * transient upstream timeout and be rescued by a later attempt.
   */
  private pendingRefreshAt: number | undefined
  /** The region whose token is pending a rotation notice. */
  private pendingRefreshRegion: QoderRegion | undefined
  /**
   * Whether the current unresolved heal failure has already been reported.
   *
   * One upstream rejection can outlive many host-level retries (an observed
   * storm ran 59 of them across 75 steps), and the transport re-heals inside
   * every one of them. Without this latch the failure notice would print once
   * per retry; with it, the user is told once per outage. Cleared as soon as any
   * chat is accepted, so the next outage announces itself again.
   */
  private refreshFailureAnnounced = false

  constructor(private readonly options: QoderAdapterOptions) {
    super()
    this.regionOption = options.region ?? 'global'
    this.resolvePat = options.personalToken
    this.fetchImpl = options.fetchFn ?? proxiedFetch
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs
    this.metadataTimeoutMs = options.metadataTimeoutMs
    this.logger = this.buildLogger()
    this.attachments = options.resolveAttachments?.()
    this.preserveThinking = options.preserveThinking
    this.onJobTokenRefreshed = options.onJobTokenRefreshed
    this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed
  }

  /** Adapt the hub's warn sink to the transport's logger seam. */
  private buildLogger(): QoderLogger | undefined {
    const warn = this.options.onWarn
    return warn === undefined ? undefined : { warn: (message: string) => { warn(message) } }
  }

  /**
   * Resolve one account's deployment, remembering it per account key.
   * @param account - the hub's account key, or undefined for the default account.
   * @returns the deployment to address for every call this operation makes.
   */
  private async regionFor(account?: string): Promise<QoderRegion> {
    if (typeof this.regionOption === 'string') return this.regionOption
    const key = account ?? ''
    const cached = this.regionCache.get(key)
    if (cached !== undefined) return cached
    const resolved = await this.regionOption(account)
    this.regionCache.set(key, resolved)
    return resolved
  }

  private authFor(region: QoderRegion): QoderAuthService {
    let service = this.authByRegion.get(region)
    if (service === undefined) {
      const logger = this.logger
      service = new QoderAuthService({
        fetchFn: this.fetchImpl,
        region,
        ...logger === undefined ? {} : { logger },
        ...this.options.resolveMachineId === undefined ? {} : { resolveMachineId: this.options.resolveMachineId },
        ...this.metadataTimeoutMs === undefined ? {} : { timeoutMs: this.metadataTimeoutMs },
      })
      this.authByRegion.set(region, service)
    }
    return service
  }

  private usageFor(region: QoderRegion): QoderUsageReader {
    let reader = this.usageByRegion.get(region)
    if (reader === undefined) {
      const logger = this.logger
      reader = new QoderUsageReader({
        authService: this.authFor(region),
        fetchFn: this.fetchImpl,
        region,
        ...logger === undefined ? {} : { logger },
        ...this.metadataTimeoutMs === undefined ? {} : { timeoutMs: this.metadataTimeoutMs },
      })
      this.usageByRegion.set(region, reader)
    }
    return reader
  }

  private uploaderFor(region: QoderRegion): QoderImageUploader {
    let uploader = this.uploaderByRegion.get(region)
    if (uploader === undefined) {
      const logger = this.logger
      uploader = new QoderImageUploader({
        fetchFn: this.fetchImpl,
        region,
        ...logger === undefined ? {} : { logger },
        refreshCredentials: async (signal) => {
          const pat = await this.requirePat(undefined, signal)
          const auth = this.authFor(region)
          auth.clear(pat)
          return auth.getCredentials(pat, signal)
        },
      })
      this.uploaderByRegion.set(region, uploader)
    }
    return uploader
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName ?? 'Qoder' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `qoder: provider "${provider}" retryPolicy`,
    )
  }

  /**
   * Drop account-scoped state: one account's, or every account's when omitted.
   * @param account - the hub's account key, or undefined to drop all of them.
   */
  clearAccountCatalog(account?: string): void {
    if (account === undefined) {
      this.catalogs.clear()
      this.regionCache.clear()
      return
    }
    const marker = `:${account}:`
    for (const key of [...this.catalogs.keys()]) {
      if (key.includes(marker)) this.catalogs.delete(key)
    }
    this.regionCache.delete(account)
  }

  /**
   * Read the live catalog for one account.
   *
   * @param signal - caller cancellation.
   * @param account - the hub's account key, or undefined for the default account.
   * @returns the provider's enabled models.
   * @throws LlmError when the read fails (callers fall back to the configured list).
   */
  async discoverModels(signal?: AbortSignal, account?: string): Promise<readonly QoderCatalogModel[]> {
    const region = await this.regionFor(account)
    const pat = await this.requirePat(account, signal)
    const key = this.catalogKey(region, account, pat)
    const cached = this.catalogs.get(key)
    if (cached !== undefined && Date.now() - cached.at < catalogTtlMs) return cached.models
    const auth = this.authFor(region)
    const models = await this.modelFlights.run(
      key,
      signal,
      async (sharedSignal) => {
        const credentials = await auth.getCredentials(pat, sharedSignal)
        return retryMetadataRead(sharedSignal, () => fetchQoderModels(credentials, {
          fetchFn: this.fetchImpl,
          signal: sharedSignal,
          region,
          ...this.metadataTimeoutMs === undefined ? {} : { timeoutMs: this.metadataTimeoutMs },
          ...this.logger === undefined ? {} : { logger: this.logger },
        }))
      },
      () => aborted('Qoder model discovery was aborted.'),
    )
    this.catalogs.set(key, { at: Date.now(), models })
    return models
  }

  private catalogKey(region: QoderRegion, account: string | undefined, pat: string): string {
    return `${region}:${account ?? ''}:${opaqueCredentialKey(pat)}`
  }

  /**
   * The catalog a request should be resolved against: discovered when possible,
   * the configured list otherwise.
   */
  private async effectiveCatalog(signal?: AbortSignal, account?: string): Promise<readonly QoderCatalogModel[]> {
    if (!this.options.discovery) return this.configuredCatalog()
    try {
      return await this.discoverModels(signal, account)
    } catch {
      return this.configuredCatalog()
    }
  }

  private configuredCatalog(): QoderCatalogModel[] {
    if (this.options.models.length === 0) return defaultModels
    return this.options.models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { supportsImages: model.inputModalities.includes('image') },
    }))
  }

  private listedModel(model: QoderCatalogModel, provider: string): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: model.supportsImages === true ? ['text', 'image'] as const : ['text'] as const,
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.listOwnModels(provider)
  }

  /**
   * List this provider's OWN models, bypassing any pool delegation.
   * @param provider - the registered route.
   * @param account - the hub's account key, or undefined for the default account.
   * @returns the model list, discovered when possible.
   */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    return (await this.effectiveCatalog(signal, account)).map(model => this.listedModel(model, provider))
  }

  /**
   * Resolve one model's metadata from the account's own catalog.
   * @param provider - the registered route.
   * @param model - the wire model id.
   * @param signal - caller cancellation.
   * @returns the resolved model metadata.
   */
  async resolveOwnModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const catalog = await this.effectiveCatalog(signal)
    const entry = catalog.find(candidate => candidate.id === model)
    const configured = this.options.models.find(candidate => candidate.id === model)
    const contextWindow = entry?.contextWindow ?? configured?.contextWindow ?? 180_000
    const maxTokens = entry?.maxTokens ?? configured?.maxTokens ?? 32_768
    const efforts = entry?.reasoningEfforts
    const defaultEffort = entry?.defaultReasoningEffort
    // The runtime rejects a `defaultEffort` outside `efforts`
    // (INVALID_MODEL_REASONING), so a default the catalog did not also list is
    // dropped rather than carried.
    const defaultEffortId = defaultEffort !== undefined && efforts?.some(effort => effort.id === defaultEffort) === true
      ? ReasoningEffortId(defaultEffort)
      : undefined
    const reasoning = efforts === undefined
      ? undefined
      : {
          efforts: efforts.map(effort => ({
            id: ReasoningEffortId(effort.id),
            name: effort.name,
            ...effort.description === undefined ? {} : { description: effort.description },
          })),
          ...defaultEffortId === undefined ? {} : { defaultEffort: defaultEffortId },
        }
    const supportsImages = entry?.supportsImages ?? configured?.inputModalities?.includes('image') ?? false
    return {
      provider,
      id: model,
      name: entry?.name ?? configured?.name ?? model,
      inputModalities: supportsImages === true ? ['text', 'image'] as const : ['text'] as const,
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // A single-credential route resolves its own models; the pool routes,
    // when configured, intercept before this is reached.
    return this.resolveOwnModel(provider, model, signal)
  }

  /**
   * Read this account's usage, projected onto the hub's shape.
   * @param signal - caller cancellation.
   * @param account - the hub's account key, or undefined for the default account.
   * @returns the usage; `supported: false` when there is nothing to show.
   */
  async readUsage(signal?: AbortSignal, account?: string): Promise<ProviderUsage> {
    const pat = await this.requirePat(account, signal)
    const region = await this.regionFor(account)
    return fetchQoderUsage(this.usageFor(region), pat, signal)
  }

  /** Resolve the PAT, or fail with the hub's logged-out code. */
  private async requirePat(account: string | undefined, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    const pat = (await this.resolvePat(account))?.trim() ?? ''
    if (!pat) {
      throw qoderError(
        'Qoder Personal Access Token is missing. Add a Qoder account in Settings → Subscriptions.',
        QODER_MISSING_CREDENTIAL_CODE,
      )
    }
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    return pat
  }

  /**
   * Report the pending self-heal once a chat is accepted, then clear it.
   *
   * The notice means "the stale token was rejected, so it was rotated, and the
   * chat works again" — all three are true by the time a chat is accepted after
   * the refresh, no matter which attempt delivered it.
   */
  private flushPendingRefreshNotice(): void {
    if (this.pendingRefreshAt === undefined) return
    const at = this.pendingRefreshAt
    const region = this.pendingRefreshRegion ?? 'global'
    this.pendingRefreshAt = undefined
    this.pendingRefreshRegion = undefined
    // A rotation whose acceptance took this long is no longer news. Printing it
    // would drop a row into the conversation long after the fact, and its
    // timestamp would name a moment the user has no reason to connect to now —
    // which reads exactly like a clock bug (observed: a 16:56 rotation reported
    // at 17:47). Dropping it keeps the notice meaningful.
    if (Date.now() - at > jobTokenNoticeMaxAgeMs) return
    this.logger?.warn?.('[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered')
    this.onJobTokenRefreshed?.({ region, at })
  }

  /**
   * Drop a pending rotation notice whose heal did not rescue anything.
   *
   * The heal's own retry was rejected too, so "the rotation fixed it" is not
   * what happened. Leaving the notice pending made a LATER, unrelated chat
   * acceptance flush it — printing a success row that contradicts the failure
   * row already shown, stamped with the old rotation time.
   */
  private discardPendingRefreshNotice(): void {
    this.pendingRefreshAt = undefined
    this.pendingRefreshRegion = undefined
  }

  /**
   * Note that the upstream accepted a chat, ending any unresolved heal failure.
   *
   * Called the moment the first chunk arrives — the only point at which "the
   * credential was accepted" is actually known. A rejected chat throws before
   * that, so this never fires on a failing attempt.
   */
  private onChatAccepted(): void {
    this.refreshFailureAnnounced = false
    this.flushPendingRefreshNotice()
  }

  /**
   * Stream one chat, reporting acceptance as soon as the FIRST chunk arrives.
   *
   * `streamQoderChat` throws before yielding anything when the upstream rejects
   * the request, so a first chunk means the credential was accepted. Reporting
   * at that moment — rather than after the whole stream drains — matters because
   * the consumer may close the stream early, and code after a completed `yield*`
   * would then never run.
   *
   * @param options - the request.
   * @param model - the resolved catalog entry, when known.
   * @param region - the deployment this turn is scoped to.
   * @param credentials - the credentials to sign with.
   * @param messages - already-translated wire messages.
   * @param onAccepted - called once, before the first chunk is forwarded.
   */
  private async * streamChat(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    region: QoderRegion,
    credentials: CosyCredentials,
    messages: QoderWireMessage[],
    onAccepted: () => void,
  ): AsyncGenerator<StreamChunk> {
    const dependencies: QoderChatDependencies = {
      fetchFn: this.fetchImpl,
      region,
      responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      ...this.logger === undefined ? {} : { logger: this.logger },
    }
    const stream = streamQoderChat(options, model, credentials, messages, dependencies)
    const first = await stream.next()
    onAccepted()
    if (!first.done) yield first.value
    yield* stream
  }

  /** Wait out the re-auth backoff, honoring caller cancellation. */
  private async reauthBackoff(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, reauthBackoffMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(aborted('Request was aborted during the re-auth backoff.'))
      }, { once: true })
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCore(options)
  }

  /**
   * Stream through one named account instead of the default one.
   * @param options - the request.
   * @param account - the hub's account key.
   * @returns the chunk stream.
   */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async * streamCore(options: GenerateOptions, account?: string): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw aborted('Request was aborted prior to generation.')

    // Phase 0: which deployment this account's credential belongs to. Resolved
    // once, before any I/O, and used for EVERY request this turn makes — the
    // exchange, the catalog, the image publication and the chat must agree, or
    // the signature names a host the credential was not minted for.
    const region = await this.regionFor(account)
    const auth = this.authFor(region)
    // Phase 1: static validation finishes before credential resolution or any
    // provider I/O, so an unusable request never consumes a subscription.
    const pat = await this.requirePat(account, options.signal)
    const catalog = await this.effectiveCatalog(options.signal, account)
    const model = catalog.find(candidate => candidate.id === options.model)
    validateQoderRequestShape(options, model)
    // Phase 2: credentials, which the center image exchange must be able to sign with.
    const credentials = await auth.getCredentials(pat, options.signal)
    // Phase 3: read attachments, publish images, and assemble wire messages.
    const messages = await translateQoderMessages(options, this.attachments, {
      uploader: this.uploaderFor(region),
      credentials,
      preserveThinking: this.preserveThinking,
    })
    // Image publication may have refreshed a rejected job token, so the chat
    // credential is read once more: it must be the token that actually signs.
    const chatCredentials = await auth.getCredentials(pat, options.signal)
    try {
      // A pending notice from an earlier heal is reported as soon as this
      // request is accepted (see `streamChat`).
      yield* this.streamChat(options, model, region, chatCredentials, messages, () => {
        this.onChatAccepted()
      })
      return
    } catch (error: unknown) {
      // A cached job token the upstream has started rejecting (a gateway-side
      // invalidation or its own rotation) reads as HTTP 401 before any stream
      // byte is produced. One fresh exchange self-heals that window; a genuinely
      // revoked PAT fails the retry identically, and the retry trades one extra
      // exchange call against turning a transient gateway state into a false
      // "sign in again" report for the user.
      if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
      this.logger?.warn?.(
        '[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once',
        { status: error.failure.status },
      )
    }
    // A gateway fault window outlives one immediate retry (observed: 401s
    // lasting minutes). Two paced rounds cover a short window; a revoked PAT
    // still terminates honestly at the first round's failure, just two exchanges
    // later. Each retry exchanges OUTSIDE the shared single-flight
    // (exchangeFresh): the flight can be aborted by a departing concurrent
    // waiter (quota poll, catalog sweep), and a retry joined to it would be
    // cancelled by a path unrelated to the chat.
    let lastRejection: unknown
    for (let round = 0; round < 2; round++) {
      const refreshed = await auth.exchangeFresh(pat, options.signal)
      // The rotation has happened; the first chat accepted afterwards — this
      // round's retry or any subsequent one — is what makes it reportable.
      this.pendingRefreshAt = Date.now()
      this.pendingRefreshRegion = region
      try {
        yield* this.streamChat(options, model, region, refreshed, messages, () => {
          this.onChatAccepted()
        })
        return
      } catch (error: unknown) {
        if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
        lastRejection = error
        if (round + 1 < 2) {
          this.logger?.warn?.('[Qoder Stream] Fresh job token also rejected; waiting and retrying once more', {
            status: error.failure.status,
            round: round + 1,
          })
          await this.reauthBackoff(options.signal)
        }
      }
    }
    // Both paced rounds exhausted on authorization rejections: the honest answer
    // is the last rejection, not a silently empty stream.
    //
    // The rotation did NOT rescue this chat, so the deferred success notice it
    // would otherwise have qualified for is void. Dropping it here is what stops
    // a later, unrelated chat acceptance from printing "token auto-refreshed and
    // recovered" with a stale rotation time.
    this.discardPendingRefreshNotice()
    // Report the failed heal once per outage. The success notice covers "the
    // rotation rescued the chat"; without this, a rejection the rotation could
    // NOT rescue was announced nowhere at all.
    if (!this.refreshFailureAnnounced) {
      this.refreshFailureAnnounced = true
      this.logger?.warn?.('[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it', {
        status: lastRejection instanceof LlmError ? lastRejection.failure.status : undefined,
      })
      this.onJobTokenRefreshFailed?.({
        region,
        at: Date.now(),
        ...(lastRejection instanceof LlmError && lastRejection.failure.status !== undefined
          ? { status: lastRejection.failure.status }
          : {}),
      })
    }
    throw lastRejection
  }
}

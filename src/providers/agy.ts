/**
 * Google Antigravity over HTTP OAuth (no `agy` CLI, no cmd.exe windows).
 */

import { attributionHeaders, errorChain, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FlowSpec } from '../auth/oauth-flow.js'
import { accountKeyOf, saveAccountSession, type AgySession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { directFetch, proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import {
  discoverOrRetryAuth,
  httpLlmError,
  idleWatchdog,
  isDiscoveryAborted,
  isMissingOrInvalidCredential,
  mapFetchFailure,
  ModelCatalogCache,
  oauthEndpointError,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import {
  AGY_CLIENT_ID,
  AGY_CLIENT_SECRET,
  AGY_ENDPOINT_FALLBACKS,
  AGY_SCOPES,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  fetchAgyFirstOk,
  getAgyBootstrapClientMetadata,
  getAgyBootstrapUserAgent,
  getAgyGenerateUserAgent,
} from './agy/constants.js'
import { AGY_PUBLIC_MODELS, catalogModel } from './agy/catalog.js'
import { fetchAvailableModels, listAgyModels, parseAgyQuotaUsage, resolveAgyModel } from './agy/models.js'
import { parseAgySse } from './agy/parse.js'
import { recordToolSignature } from './agy/signature-cache.js'
import { toAgyRequestBody } from './agy/translate.js'

export const AGY_PREEMPT_MS = 2 * 60_000

export const agyFlow: FlowSpec = {
  callbackPath: '/oauth-callback',
  listen: { host: '127.0.0.1', ports: [51121, 0] },
  timeoutMs: 300_000,
  buildAuthorizeUrl({ redirectUri, state, pkce }) {
    const params = new URLSearchParams({
      client_id: AGY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: AGY_SCOPES.join(' '),
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    })
    return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
  },
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

async function googleTokens(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await proxiedFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'agy')
  return await response.json() as GoogleTokenResponse
}

function agyBootstrapHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': getAgyBootstrapUserAgent(),
    'Client-Metadata': getAgyBootstrapClientMetadata(),
    'X-Goog-Api-Client': 'google-cloud-sdk vscode/1.96.0',
  }
}

function agyGenerateHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': getAgyGenerateUserAgent(),
    'Client-Metadata': getAgyBootstrapClientMetadata(),
  }
}

function deriveAgySessionId(account: string | undefined): string | undefined {
  if (account === undefined || account.trim().length === 0) return undefined
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < account.length; i++) {
    hash ^= BigInt(account.charCodeAt(i))
    hash = BigInt.asIntN(64, hash * 0x100000001b3n)
  }
  const folded = hash < 0n ? -hash : hash
  return `-${(folded % 9_000_000_000_000_000_000n).toString()}`
}

export function extractAgyProjectId(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const project = (data as { cloudaicompanionProject?: unknown }).cloudaicompanionProject
  if (typeof project === 'string' && project.length > 0) return project
  if (typeof project === 'object' && project !== null) {
    const id = (project as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return ''
}

function extractOnboardTierId(subscriptionInfo: unknown): string {
  const subscription = (subscriptionInfo ?? {}) as Record<string, unknown>
  const tierOf = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined
  }
  const paid = tierOf(subscription.paidTier)
  if (paid !== undefined) return paid
  const ineligible = Array.isArray(subscription.ineligibleTiers) && subscription.ineligibleTiers.length > 0
  if (!ineligible) {
    const current = tierOf(subscription.currentTier)
    if (current !== undefined) return current
  }
  if (Array.isArray(subscription.allowedTiers)) {
    for (const tier of subscription.allowedTiers) {
      if (typeof tier === 'object' && tier !== null && (tier as { isDefault?: unknown }).isDefault === true) {
        const id = tierOf(tier)
        if (id !== undefined) return id
      }
    }
  }
  return tierOf(subscription.currentTier) ?? 'legacy-tier'
}

export async function loadCodeAssist(
  accessToken: string,
  fetchFn: FetchFn = proxiedFetch,
): Promise<{ projectId: string; tierId: string }> {
  const headers = agyBootstrapHeaders(accessToken)
  const body = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
  for (const base of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchFn(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) continue
      const data: unknown = await response.json()
      const projectId = extractAgyProjectId(data)
      if (projectId.length > 0) {
        const subscription = typeof data === 'object' && data !== null
          ? (data as { subscriptionInfo?: unknown }).subscriptionInfo
          : undefined
        return { projectId, tierId: extractOnboardTierId(subscription) }
      }
    } catch { /* try the next host */ }
  }
  return { projectId: '', tierId: 'legacy-tier' }
}

async function onboardAgyUser(
  accessToken: string,
  tierId: string,
  fetchFn: FetchFn,
): Promise<{ projectId: string; tierId: string }> {
  const headers = agyBootstrapHeaders(accessToken)
  const body = JSON.stringify({ tier_id: tierId, metadata: { ideType: 'ANTIGRAVITY' } })
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const base of AGY_ENDPOINT_FALLBACKS) {
      try {
        const response = await fetchFn(`${base}/v1internal:onboardUser`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) continue
        const result = await response.json() as { done?: boolean }
        if (result.done === true) {
          const discovered = await loadCodeAssist(accessToken, fetchFn)
          if (discovered.projectId.length > 0) return discovered
        }
      } catch { /* try next */ }
    }
    await new Promise(resolve => setTimeout(resolve, 3_000 + Math.floor(Math.random() * 4_000)))
  }
  return { projectId: '', tierId }
}

export async function bootstrapAgyAccount(
  accessToken: string,
  fetchFn: FetchFn = proxiedFetch,
): Promise<{ projectId: string; tierId: string }> {
  const discovered = await loadCodeAssist(accessToken, fetchFn)
  if (discovered.projectId.length > 0) return discovered
  return onboardAgyUser(accessToken, discovered.tierId, fetchFn)
}

export async function ensureAgyProject(
  session: AgySession,
  fetchFn: FetchFn = proxiedFetch,
): Promise<AgySession> {
  if (typeof session.projectId === 'string' && session.projectId.length > 0) return session
  const boot = await bootstrapAgyAccount(session.accessToken, fetchFn)
  if (boot.projectId.length === 0) return session
  return { ...session, projectId: boot.projectId }
}

export async function exchangeAgyCode(code: string, verifier: string, redirectUri: string): Promise<AgySession> {
  const tokens = await googleTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: AGY_CLIENT_ID,
    client_secret: AGY_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }))
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new Error('agy token endpoint returned no access/refresh token')
  }
  const expiresIn = typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 3600
  let account: string | undefined
  try {
    const info = await proxiedFetch(OAUTH_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    if (info.ok) {
      const payload = await info.json() as { email?: string }
      if (typeof payload.email === 'string' && payload.email.length > 0) account = payload.email
    }
  } catch { /* identity is optional */ }
  let projectId: string | undefined
  try {
    const boot = await bootstrapAgyAccount(tokens.access_token)
    if (boot.projectId.length > 0) projectId = boot.projectId
  } catch { /* generate will heal a missing project */ }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...account === undefined ? {} : { account },
    ...projectId === undefined ? {} : { projectId },
  }
}

export async function refreshAgy(session: AgySession): Promise<AgySession> {
  const tokens = await googleTokens(new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: AGY_CLIENT_ID,
    client_secret: AGY_CLIENT_SECRET,
    refresh_token: session.refreshToken,
  }))
  if (typeof tokens.access_token !== 'string') throw new Error('agy refresh returned no access token')
  const expiresIn = typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 3600
  return {
    ...session,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

export function isAgyPermanentRefreshError(error: unknown): boolean {
  return error instanceof Error && /invalid_grant/i.test(error.message)
}

export async function fetchAgyUsage(
  session: AgySession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const ready = await ensureAgyProject(session, fetchFn)
  if (ready.projectId !== undefined && ready.projectId !== session.projectId) {
    try { await saveAccountSession('agy', accountKeyOf('agy', ready), ready) } catch { /* cache is optional */ }
  }
  try {
    const dynamic = await fetchAvailableModels(ready.accessToken, ready.projectId, fetchFn)
    const fromCatalog = parseAgyQuotaUsage(dynamic)
    if (fromCatalog.supported) return fromCatalog
  } catch { /* fall through to the quota summary */ }
  const headers = {
    ...agyBootstrapHeaders(ready.accessToken),
    ...attributionHeaders(),
  }
  const body = JSON.stringify({
    metadata: { ideType: 'ANTIGRAVITY' },
    ...ready.projectId === undefined ? {} : { project: ready.projectId },
  })
  const response = await fetchAgyFirstOk('/v1internal:retrieveUserQuotaSummary', {
    method: 'POST',
    headers,
    body,
    ...signal === undefined ? {} : { signal },
  }, fetchFn)
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) return { supported: true, windows: [] }
    throw await oauthEndpointError(response, 'agy quota')
  }
  const payload = await response.json() as {
    summaries?: Array<{ remainingFraction?: number; resetTime?: string; displayName?: string }>
  }
  const windows = (payload.summaries ?? []).map((row, index) => ({
    kind: (index === 0 ? 'session' : 'weekly') as 'session' | 'weekly',
    usedPercent: Math.max(0, Math.min(100, Math.round((1 - (row.remainingFraction ?? 1)) * 100))),
    remaining: Math.round((row.remainingFraction ?? 1) * 1000) / 10,
    limit: 100,
    ...typeof row.resetTime === 'string' ? { resetsAt: Date.parse(row.resetTime) } : {},
    ...typeof row.displayName === 'string' ? { scope: row.displayName } : {},
  }))
  return { supported: true, windows }
}

export interface AgyAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<AgySession>
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  catalogStore?: CatalogPersistence
  defaultEffortOf?: (model: string) => string | undefined
  rateLimit?: RateLimitWait
}

function discoveredFromList(models: readonly LlmModelInfo[]): DiscoveredModel[] {
  return models.map(model => {
    const meta = catalogModel(model.id)
    return {
      id: model.id,
      name: model.name,
      ...meta === undefined ? {} : { contextWindow: meta.contextLength },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] as ('text' | 'image')[] },
    }
  })
}

export class AgyAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  private catalogOwner: string | undefined

  constructor(private readonly options: AgyAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  private async catalogFor(account?: string): Promise<ModelCatalogCache> {
    const defaultKey = await this.options.tokens.defaultAccount()
    const key = account ?? defaultKey
    if (key === undefined || key === defaultKey) {
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

  private async ensureProject(account?: string): Promise<AgySession> {
    const session = await this.options.tokens.session(account)
    const next = await ensureAgyProject(session, this.options.fetchFn ?? proxiedFetch)
    if (next.projectId !== undefined && next.projectId !== session.projectId) {
      const key = account ?? await this.options.tokens.defaultAccount()
      if (key !== undefined) await this.options.tokens.update(key, next)
    }
    return next
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `agy: provider "${provider}" retryPolicy`,
    )
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveAgyModel(provider, model)
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
      return this.options.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: ['text', 'image'] as const,
      }))
    }
    const catalog = await this.catalogFor(account)
    try {
      const discovered = await discoverOrRetryAuth(
        force => this.options.tokens.session(account, force),
        catalog,
        () => catalog.get(async () => {
          const session = await this.ensureProject(account)
          const models = await listAgyModels(session.accessToken, session.projectId, this.options.fetchFn ?? proxiedFetch)
          return discoveredFromList(models)
        }),
      )
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: model.inputModalities ?? ['text', 'image'] as const,
      }))
    } catch (error) {
      if (isDiscoveryAborted(error, signal)) throw error
      if (isMissingOrInvalidCredential(error)) return []
      this.options.onWarn?.(`agy catalog failed; using the built-in catalog (${errorChain(error)})`)
      return AGY_PUBLIC_MODELS.filter(model => !model.id.includes('tab')).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: model.supportsVision === false ? ['text'] as const : ['text', 'image'] as const,
      }))
    }
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.accountCatalogs.clear()
    else this.accountCatalogs.delete(account)
    if (account === undefined || this.catalogOwner === account || this.catalogOwner === undefined) {
      this.catalogOwner = undefined
      this.catalog.invalidate()
    }
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveAgyModel(provider, model)
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
      const session = await this.ensureProject(account)
      if (session.projectId === undefined || session.projectId.length === 0) {
        throw new LlmError(
          'agy has no Cloud Code project yet — log in again via Settings → Subscriptions',
          'INVALID_CREDENTIAL',
        )
      }
      const images = new Map<string, { mediaType: string; data: string }>()
      const store = this.options.resolveAttachments?.()
      for (const message of options.messages) {
        if (message.role !== 'user') continue
        for (const block of message.content) {
          if (block.type !== 'image') continue
          if (store === undefined) {
            throw new LlmError('agy image input requires the attachment service', 'UNSUPPORTED_CONTENT')
          }
          const stored = await store.readImage(block.attachment, options.signal)
          images.set(block.attachment.attachmentId, {
            mediaType: stored.ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
          })
        }
      }
      const sessionId = deriveAgySessionId(session.account)
      const body = toAgyRequestBody(options, {
        projectId: session.projectId,
        ...sessionId === undefined ? {} : { sessionId },
        ...(images.size > 0 ? { images } : {}),
      })
      const init = {
        method: 'POST' as const,
        headers: agyGenerateHeaders(session.accessToken),
        body: JSON.stringify(body),
        signal: watchdog.signal,
      }
      const fetchFn = this.options.fetchFn ?? proxiedFetch
      let response: Response
      try {
        response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', init, fetchFn)
        if (!response.ok) {
          const peek = await response.clone().text()
          if (/api key is invalid/i.test(peek) && fetchFn !== directFetch) {
            response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', init, directFetch)
          }
        }
      } catch (error) {
        throw mapFetchFailure('agy', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'agy')
      if (response.body === null) throw new LlmError('agy returned an empty stream', 'EMPTY_RESPONSE')
      for await (const chunk of parseAgySse(response.body, {
        signal: watchdog.signal,
        // Persist each thoughtSignature the upstream returned alongside a
        // functionCall so the NEXT request can replay it on the assistant
        // functionCall part (the API rejects a missing/empty signature).
        onToolSignature: recordToolSignature,
      })) {
        watchdog.pulse()
        yield chunk
      }
    } finally {
      watchdog.stop()
    }
  }
}

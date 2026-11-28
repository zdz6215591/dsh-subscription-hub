import type { InputModality } from './modality.js'
/**
 * Google Antigravity over HTTP OAuth (no `agy` CLI, no cmd.exe windows).
 */

import { attributionHeaders, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
  mergeReasoning,
  ModelCatalogCache,
  OAuthEndpointError,
  oauthEndpointError,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ModelListNotFetched, ProviderUsage, UsageWindow } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, jsonBody, resetInstantFromValue, retryAfterInstant, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js'
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
import { catalogModel } from './agy/catalog.js'
import { fetchAvailableModels, listAgyModels, parseAgyQuotaUsage, resolveAgyModel } from './agy/models.js'
import { parseAgySse } from './agy/parse.js'
import { recordToolSignature } from './agy/signature-cache.js'
import { toAgyRequestBody } from './agy/translate.js'
import { readRequestImage } from '../translate/image-request.js'

export {
  AGY_VERSION_FALLBACK,
  agyCliUserAgent,
  currentAgyUserAgent,
  currentAgyVersion,
  setAgyIdentity,
} from './agy/constants.js'

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

/**
 * Whether a Google refresh failure means the grant is permanently dead.
 *
 * Checked on the structured `oauthCode` FIRST, because the message is built from
 * `error_description`: Google answers
 * `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`,
 * so the message reads "…: Token has been expired or revoked." and never
 * contains the literal `invalid_grant`. Matching the message alone meant a
 * revoked grant was treated as transient — the session was never removed, the
 * card never said "log in again", and a doomed refresh was retried forever.
 * The message test stays only as a fallback for a body that carried no code.
 */
export function isAgyPermanentRefreshError(error: unknown): boolean {
  if (error instanceof OAuthEndpointError && error.oauthCode !== undefined) {
    return error.oauthCode === 'invalid_grant'
  }
  return error instanceof Error && /invalid_grant/i.test(error.message)
}

export const agyRateLimitReset: RateLimitResetReader = (response, body, now) => {
  const parsed = jsonBody(body)
  if (typeof parsed === 'object' && parsed !== null) {
    const error = (parsed as { error?: { details?: Array<{ metadata?: { quotaResetTimeStamp?: string; quotaResetDelay?: string } }> } }).error
    for (const detail of error?.details ?? []) {
      const ts = detail.metadata?.quotaResetTimeStamp
      if (typeof ts === 'string') {
        const ms = resetInstantFromValue(ts, now)
        if (ms !== undefined) return ms
      }
      const delay = detail.metadata?.quotaResetDelay
      if (typeof delay === 'string') {
        const ms = resetInstantFromValue(delay, now)
        if (ms !== undefined) return ms
      }
    }
  }
  return retryAfterInstant(response, now)
}

interface AgyQuotaBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  remainingFraction?: number
  description?: string
}

interface AgyQuotaGroup {
  displayName?: string
  description?: string
  buckets?: AgyQuotaBucket[]
}

interface AgyQuotaSummaryPayload {
  groups?: AgyQuotaGroup[]
  description?: string
  summaries?: Array<{ remainingFraction?: number; resetTime?: string; displayName?: string }>
}

/**
 * Parse Code Assist quota groups (e.g. Gemini Models, Claude/GPT models)
 * into UsageWindows covering both 5-hour rolling limits and weekly limits.
 */
export function parseAgyUserQuotaSummary(payload: unknown): UsageWindow[] {
  if (typeof payload !== 'object' || payload === null) return []
  const data = payload as AgyQuotaSummaryPayload
  const windows: UsageWindow[] = []

  if (Array.isArray(data.groups) && data.groups.length > 0) {
    for (const group of data.groups) {
      const scope = group.displayName && group.displayName.includes('Gemini')
        ? 'Gemini'
        : group.displayName && group.displayName.includes('Claude')
          ? 'Claude / GPT'
          : group.displayName ?? ''

      // Keep 5-hour window first, then weekly window
      const buckets = [...(group.buckets ?? [])].sort((a, b) => {
        const orderA = a.window === 'weekly' ? 1 : 0
        const orderB = b.window === 'weekly' ? 1 : 0
        return orderA - orderB
      })

      for (const bucket of buckets) {
        const remainingFraction = typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
          ? bucket.remainingFraction
          : 1
        const kind: UsageWindow['kind'] = bucket.window === 'weekly' ? 'weekly' : 'session'
        const resetsAt = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : undefined

        windows.push({
          kind,
          scope,
          usedPercent: Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100))),
          remaining: Math.round(remainingFraction * 1000) / 10,
          limit: 100,
          // A PERCENTAGE: `remaining` is the remaining fraction expressed as a
          // 0-100 number and the cap is 100, so the amounts are points of a
          // percentage rather than units of any currency. Drawing them with a
          // `$` was plainly wrong.
          unit: 'percent',
          ...resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {},
        })
      }
    }
  }

  // Legacy summaries fallback
  if (windows.length === 0 && Array.isArray(data.summaries)) {
    for (const [index, row] of data.summaries.entries()) {
      const remainingFraction = typeof row.remainingFraction === 'number' && Number.isFinite(row.remainingFraction)
        ? row.remainingFraction
        : 1
      // The same guard as the groups path: an unparsable reset is no reset,
      // never a NaN the card would render as "Invalid Date".
      const resetsAt = typeof row.resetTime === 'string' ? Date.parse(row.resetTime) : undefined
      windows.push({
        kind: index === 0 ? 'session' : 'weekly',
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100))),
        remaining: Math.round(remainingFraction * 1000) / 10,
        limit: 100,
        unit: 'percent',
        ...resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {},
        ...typeof row.displayName === 'string' ? { scope: row.displayName } : {},
      })
    }
  }

  return windows
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
  const headers = {
    ...attributionHeaders(),
    ...agyBootstrapHeaders(ready.accessToken),
  }
  const body = JSON.stringify({
    ...ready.projectId === undefined ? {} : { project: ready.projectId },
  })

  // 1. Fetch quota summary (groups for 3p models like Claude / GPT with 5h + weekly limits)
  // and available models (exposing per-model quotaInfo for 1st-party Gemini models) in parallel.
  const [summaryRes, catalogRes] = await Promise.allSettled([
    fetchAgyFirstOk('/v1internal:retrieveUserQuotaSummary', {
      method: 'POST',
      headers,
      body,
      ...signal === undefined ? {} : { signal },
    }, fetchFn).then(async r => r.ok ? r.json() : null),
    fetchAvailableModels(ready.accessToken, ready.projectId, fetchFn, signal),
  ])

  let summaryWindows: UsageWindow[] = []
  if (summaryRes.status === 'fulfilled' && summaryRes.value !== null) {
    summaryWindows = parseAgyUserQuotaSummary(summaryRes.value)
  }

  let catalogWindows: UsageWindow[] = []
  if (catalogRes.status === 'fulfilled' && catalogRes.value) {
    const fromCatalog = parseAgyQuotaUsage(catalogRes.value)
    if (fromCatalog.supported && Array.isArray(fromCatalog.windows)) {
      catalogWindows = fromCatalog.windows
    }
  }

  // 2. Merge windows:
  // Google's retrieveUserQuotaSummary only returns 3p groups ("Claude and GPT models") on
  // consumer accounts, omitting 1st-party Gemini models whose quota lives on fetchAvailableModels.
  // If summaryWindows has windows, keep them (they have exact 5h and weekly buckets).
  // If Gemini or other families are not already represented in summaryWindows, prepend from catalogWindows.
  let windows: UsageWindow[] = []
  if (summaryWindows.length > 0) {
    // An unnamed summary group has scope ''; ''.includes-matching would then
    // claim every catalog window as covered and drop all the Gemini rows.
    const coveredScopes = new Set(summaryWindows.map(w => w.scope?.toLowerCase() ?? '').filter(scope => scope !== ''))
    const missingFromCatalog = catalogWindows.filter(w => {
      const s = w.scope?.toLowerCase() ?? ''
      if (s === 'other') return false
      for (const cov of coveredScopes) {
        if (cov.includes(s) || s.includes(cov)) return false
      }
      return true
    })
    // Prepend missing 1st-party models (Gemini) so Google's native models display first,
    // followed by 3p Claude and GPT windows.
    windows = [...missingFromCatalog, ...summaryWindows]
  } else {
    windows = catalogWindows.filter(w => w.scope?.toLowerCase() !== 'other')
  }

  if (windows.length > 0) {
    const worst = Math.min(...windows.map(w => w.remaining ?? 100))
    return { supported: true, windows, remaining: worst, limit: 100, unit: 'percent' }
  }

  return { supported: false }
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

/**
 * Whether a model id is one Antigravity marks as NOT ENABLED for this account.
 *
 * Measured: `gemini-4-neon-disabled` answers `404 NOT_FOUND` while
 * `gemini-3-flash` on the same account answers normally, so these rows are in the
 * catalogue but cannot be called. The suffix is the vendor's own word for it, which
 * makes this a fact read from the id rather than a guess.
 *
 * @param id - the model id.
 * @returns true when the model must not be offered.
 */
function isDisabledAgyModel(id: string): boolean {
  return /-disabled$/i.test(id)
}
function discoveredFromList(models: readonly LlmModelInfo[]): DiscoveredModel[] {
  return models.map(model => {
    const meta = catalogModel(model.id)
    return {
      id: model.id,
      name: model.name,
      ...meta === undefined ? {} : { contextWindow: meta.contextLength },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] as InputModality[] },
    }
  })
}

export class AgyAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  /** Tier → concrete id per family, from the last roster read. */
  private readonly agyFamilies = new Map<string, { name: string; variants: Map<string, string> }>()
  private catalogOwner: string | undefined
  /**
   * Why a route's roster was not retrieved, when it was not.
   *
   * Empty means "a live read succeeded", so the settings card can distinguish a
   * provider that fetched nothing from one that genuinely serves no models. An
   * empty roster alone cannot say which, which is why the reason is carried
   * separately and cleared on every successful read.
   */
  private readonly notFetched = new Map<string, ModelListNotFetched>()

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
      return this.options.models.filter(model => !isDisabledAgyModel(model.id)).map(model => ({
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
      if (discovered.length > 0) this.notFetched.delete(provider)
      // Tiered ids collapse into one row per family: Antigravity lists
      // `gemini-4-hydrogen-low|medium|high|xhigh` as four ids that all carry the label
      // "Gemini 4 Hydrogen", so taking the catalogue literally shows one model four
      // times with no way to tell the rows apart (the reference's 185ab5e).
      const visible = discovered.filter(model => !isDisabledAgyModel(model.id))
      const { singles, families } = groupAgyFamilies(visible)
      // Merge, never clear: accounts list concurrently, and clearing here let the
      // last account to finish erase another account's families, so a family id
      // only that account serves went upstream unresolved (HTTP 404).
      for (const family of families) {
        const known = this.agyFamilies.get(family.family)
        this.agyFamilies.set(family.family, {
          name: family.name,
          variants: known === undefined ? family.variants : new Map([...known.variants, ...family.variants]),
        })
      }
      const rows: { id: string; name: string }[] = [
        ...singles,
        ...families.map(family => ({ id: family.family, name: family.name })),
      ]
      return uniqueAgyLabels(rows).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ['text', 'image'] as const,
      }))
    } catch (error) {
      if (isDiscoveryAborted(error, signal)) throw error
      if (isMissingOrInvalidCredential(error)) return []
      // NOTHING IS SERVED. This used to return the whole pinned
      // {@link AGY_PUBLIC_MODELS} roster — twelve models with capabilities — so a
      // failed discovery was indistinguishable from a healthy one: the user saw a
      // complete model list and had no way to tell that the READ had failed rather
      // than the account genuinely having those models. That is exactly the failure
      // the user reported being unable to diagnose, so it now reports itself through
      // the same visible channel the other routes use.
      //
      // The pinned catalog is NOT deleted, and the distinction matters: it remains
      // the source of capability metadata for ids the LIVE endpoint returned (see
      // `discoveredFromList` → `catalogModel`), which is enrichment of a real read
      // rather than a substitute for one. Agy's endpoint supplies ids and quotaInfo
      // and no capabilities at all, so deleting it would drop a real disclosure.
      this.reportNotFetched(provider, {
        what: 'The Antigravity model list could not be fetched',
        detail: errorChain(error),
      })
      return []
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

  /**
   * Record that a route's roster could not be retrieved, and say so on the log too.
   *
   * `onWarn` is the log; {@link notFetchedReason} is what the settings card reads, so
   * the absence is visible where the user actually looks rather than only in a log
   * they never open.
   */
  private reportNotFetched(provider: string, reason: ModelListNotFetched): void {
    this.notFetched.set(provider, reason)
    this.options.onWarn?.(`${reason.what} (${reason.detail})`)
  }

  /** Why this route's roster is empty, when it is empty because nothing was read. */
  notFetchedReason(provider: string): ModelListNotFetched | undefined {
    return this.notFetched.get(provider)
  }

  /**
   * One Antigravity model's metadata, with the user's configured thinking level
   * folded in as the default.
   *
   * `resolveAgyModel` can only report the PINNED table's own hint, which is
   * `medium` for every family that offers one. The Settings page's per-model
   * "default thinking level" is a user setting, exactly as it is on every other
   * route, so it has to be merged on top — and here it simply was not: this
   * adapter declared `defaultEffortOf` and never called it, so a model whose
   * default was set to `high` (e.g. `gemini-3.8-flash-tiered`) kept opening on
   * `medium` with no setting able to change it.
   *
   * `mergeReasoning` keeps the runtime's `defaultEffort ∈ efforts` invariant, and
   * drops a level the table does not list rather than sending it on every turn.
   */
  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = resolveAgyModel(provider, model)
    // A family row owns an effort axis; the tier ids live in its variants map and
    // are chosen at request time from the effort the caller picked.
    const family = this.agyFamilies.get(model)
    const familyEfforts = family === undefined ? [] : agyFamilyEfforts(family.variants)
    const base: LlmResolvedModelInfo = family === undefined
      ? info
      : {
          ...info,
          name: family.name,
          reasoning: {
            efforts: familyEfforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
            defaultEffort: ReasoningEffortId(family.variants.has('high') ? 'high' : [...family.variants.keys()].at(-1) ?? 'high'),
          },
        }
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), base.reasoning)
    if (reasoning === undefined) return base
    return { ...base, reasoning }
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamCore(options)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      // A family row is a label plus an effort axis; the wire needs one concrete id.
      // The effort picks the tier (defaulting to the family's own default), and an id
      // that is not a family passes through untouched.
      const family = this.agyFamilies.get(options.model)
      const resolvedModel = family === undefined
        ? options.model
        : family.variants.get(String(options.reasoningEffort ?? '')) ?? family.variants.get('high') ?? [...family.variants.values()][0] ?? options.model
      if (resolvedModel !== options.model) options = { ...options, model: resolvedModel }
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
          const stored = await readRequestImage(store, block.attachment, options.signal)
          images.set(block.attachment.attachmentId, {
            mediaType: stored.mediaType,
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
      if (!response.ok) {
        throw await httpLlmError(response, 'agy', {
          rateLimitReset: agyRateLimitReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
        })
      }
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

/** Tier suffixes Antigravity publishes as separate ids for one model family. */
const AGY_TIER_SUFFIX = /^(.*)-(low|medium|high|xhigh)$/
/** Display order, weakest first; `xhigh` is opt-in so it never becomes the default. */
const AGY_TIER_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

/**
 * The family a tiered Antigravity id belongs to, or undefined when it is not tiered.
 *
 * Ported from the reference (`185ab5e fix(antigravity): group xhigh tiers into their
 * model family`): Antigravity lists `gemini-4-hydrogen-low|medium|high|xhigh` as four
 * ids that all carry the label "Gemini 4 Hydrogen", so a roster that takes the
 * catalogue literally repeats one model up to four times with no way to tell the
 * rows apart.
 *
 * @param id - a model id.
 * @returns the family id and tier, when the id carries one.
 */
export function agyTierOf(id: string): { family: string; tier: string } | undefined {
  const match = AGY_TIER_SUFFIX.exec(id)
  if (match === null) return undefined
  return { family: match[1] as string, tier: match[2] as string }
}

/** A family's tier → concrete id, and the label to show once. */
export interface AgyFamily {
  family: string
  name: string
  variants: Map<string, string>
}

/**
 * Group tiered ids into one row per family.
 *
 * A family with a single tier keeps its own id (grouping one row would rename a
 * model for no gain); a family with two or more becomes the family id plus a
 * reasoning-effort axis, which is what the reference does.
 *
 * @param models - roster rows, in catalogue order.
 * @returns family rows plus the untouched singles.
 */
export function groupAgyFamilies(models: readonly { id: string; name: string }[]): {
  singles: { id: string; name: string }[]
  families: AgyFamily[]
} {
  const byFamily = new Map<string, { id: string; name: string; tier: string }[]>()
  const singles: { id: string; name: string }[] = []
  for (const model of models) {
    const tier = agyTierOf(model.id)
    if (tier === undefined) {
      singles.push({ id: model.id, name: model.name })
      continue
    }
    const list = byFamily.get(tier.family) ?? []
    list.push({ id: model.id, name: model.name, tier: tier.tier })
    byFamily.set(tier.family, list)
  }
  const families: AgyFamily[] = []
  for (const [family, rows] of byFamily) {
    if (rows.length < 2) {
      const only = rows[0]
      if (only !== undefined) singles.push({ id: only.id, name: only.name })
      continue
    }
    const variants = new Map<string, string>()
    for (const tier of AGY_TIER_ORDER) {
      const row = rows.find(entry => entry.tier === tier)
      if (row !== undefined) variants.set(tier, row.id)
    }
    // The label is the one the family's own rows carry, with the tier removed so the
    // effort axis owns it instead.
    const label = rows[0]?.name ?? family
    const name = label.replace(/\s*\(?\b(?:low|medium|high|xhigh)\b\)?\s*$/i, '').trim() || family
    families.push({ family, name, variants })
  }
  return { singles, families }
}

/** The effort list a family exposes, in display order. */
export function agyFamilyEfforts(variants: ReadonlyMap<string, string>): { id: string; name: string }[] {
  return AGY_TIER_ORDER.filter(tier => variants.has(tier)).map(tier => ({
    id: tier,
    name: tier === 'xhigh' ? 'Extra High' : tier[0]?.toUpperCase() + tier.slice(1),
  }))
}

/**
 * Make every row's label distinguishable.
 *
 * The reference's rule is "correct the label, never add or hide a model id". Two ids
 * can still share one display label — Antigravity publishes `gemini-3.8-flash-low`
 * and `gemini-3.8-flash-medium` as "Gemini 3.8 Flash", and a configured row from the
 * static catalogue can collide with a discovered one — so a repeated label gains the
 * part of its id that tells the rows apart: `Gemini 3.8 Flash (Low)`.
 *
 * @param rows - roster rows in catalogue order.
 * @returns the same rows, with unique labels.
 */
export function uniqueAgyLabels(rows: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  return rows.map(row => {
    if ((counts.get(row.name) ?? 0) < 2) return { id: row.id, name: row.name }
    // The qualifier is the id minus the label's own words, which is exactly the part
    // that differs between the rows sharing it.
    const qualifier = row.id
      .split('-')
      .filter(part => part !== '' && !row.name.toLowerCase().includes(part.toLowerCase()))
      .join(' ')
    if (qualifier === '') return { id: row.id, name: `${row.name} (${row.id})` }
    return { id: row.id, name: `${row.name} (${qualifier.replace(/\b\w/g, ch => ch.toUpperCase())})` }
  })
}

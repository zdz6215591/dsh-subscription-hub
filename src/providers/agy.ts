/**
 * Google Antigravity over HTTP OAuth (no `agy` CLI, no cmd.exe windows).
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
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { AgySession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  oauthEndpointError,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import {
  AGY_CLIENT_ID,
  AGY_CLIENT_SECRET,
  AGY_SCOPES,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  fetchAgyFirstOk,
  getAgyBootstrapUserAgent,
} from './agy/constants.js'
import { AGY_PUBLIC_MODELS } from './agy/catalog.js'
import { listAgyModels, resolveAgyModel } from './agy/models.js'
import { parseAgySse } from './agy/parse.js'
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
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...account === undefined ? {} : { account },
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
  const response = await fetchAgyFirstOk('/v1internal:retrieveUserQuotaSummary', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
      'user-agent': getAgyBootstrapUserAgent(),
      ...attributionHeaders(),
    },
    body: '{}',
    ...signal === undefined ? {} : { signal },
  }, fetchFn)
  if (!response.ok) throw await oauthEndpointError(response, 'agy quota')
  const payload = await response.json() as {
    summaries?: Array<{ remainingFraction?: number; resetTime?: string; displayName?: string }>
  }
  const windows = (payload.summaries ?? []).map((row, index) => ({
    kind: (index === 0 ? 'session' : 'weekly') as 'session' | 'weekly',
    usedPercent: Math.max(0, Math.min(100, Math.round((1 - (row.remainingFraction ?? 1)) * 100))),
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

export class AgyAdapter extends LlmAdapter {
  constructor(private readonly options: AgyAdapterOptions) {
    super()
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
    try {
      const session = await this.options.tokens.session(account)
      return await listAgyModels(session.accessToken, session.projectId)
    } catch (error) {
      this.options.onWarn?.(`agy catalog failed (${error instanceof Error ? error.message : String(error)})`)
      return AGY_PUBLIC_MODELS.filter(model => !model.id.includes('tab')).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: model.supportsVision === false ? ['text'] as const : ['text', 'image'] as const,
      }))
    }
  }

  clearAccountCatalog(_account?: string): void { /* live catalog, no cache */ }

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
      const session = await this.options.tokens.session(account)
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
      const body = toAgyRequestBody(options, {
        ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
        ...(images.size > 0 ? { images } : {}),
      })
      let response: Response
      try {
        response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'user-agent': getAgyBootstrapUserAgent(),
            ...attributionHeaders(),
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        }, this.options.fetchFn ?? proxiedFetch)
      } catch (error) {
        throw mapFetchFailure('agy', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'agy')
      if (response.body === null) throw new LlmError('agy returned an empty stream', 'EMPTY_RESPONSE')
      for await (const chunk of parseAgySse(response.body, { signal: watchdog.signal })) {
        watchdog.pulse()
        yield chunk
      }
    } finally {
      watchdog.stop()
    }
  }
}

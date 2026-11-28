/**
 * Mistral (Vibe Pro / Team subscription) route.
 *
 * The credential is a Mistral API key: `Authorization: Bearer <key>` against
 * `https://api.mistral.ai/v1`, which is why this route needs no reverse
 * engineering — the wire IS OpenAI chat-completions, so the shared translator
 * does the messages, tools, usage and SSE work. Reference for the endpoints and
 * the quota shapes: `lordraiden/dsh-mistral-pro` (`lib/wire.js`, `lib/usage.js`).
 *
 * Three upstream facts worth stating, because each one is a place this route
 * could lie:
 *
 *   - **The catalogue is live** (`GET /v1/models`). The reference also ships a
 *     19-row built-in table because discovery can fail; here a failed read is
 *     reported and the configured rows are served, never a guessed window.
 *   - **The quota is published** for an API key: `/billing/subscription` names the
 *     plan and `/billing/budget` reports the Vibe and API allowances as a
 *     percentage of their initial size. Those are percentages, not token counts,
 *     as a PERCENTAGE (0-100), which is what the parser reports; the console's
 *     $used /  is the figure this route reproduces.
 *     does not send one: a stable key per conversation is what makes it hit, and
 *     the hub does not own the conversation's lifetime. A cache that never hits
 *     would be worse than none.
 */

import { attributionHeaders, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { MistralSession, ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager } from '../providers/accounts.js'
import { effortDisplayName, httpLlmError, idleWatchdog, mapFetchFailure } from '../providers/common.js'
import type { FetchFn, ModelEntry, ModelListNotFetched, ProviderUsage, UsageWindow } from '../providers/common.js'
import type { PoolAdapter } from '../providers/pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, subscriptionRetryPolicy } from '../providers/rate-limit.js'
import type { RateLimitWait } from '../providers/rate-limit.js'
import { resolveImages } from '../translate/resolved.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'

/** API origin and paths. */
export const MISTRAL_API_BASE = 'https://api.mistral.ai/v1'
export const MISTRAL_CHAT_PATH = '/chat/completions'
export const MISTRAL_MODELS_PATH = '/models'
export const MISTRAL_SUBSCRIPTION_PATH = '/billing/subscription'
export const MISTRAL_BUDGET_PATH = '/billing/budget'

/** The effort levels Mistral accepts; low and high were measured, medium is the documented middle. */
const MISTRAL_REASONING_EFFORTS = ['low', 'medium', 'high'] as const

/** Retry ladder: a busy gateway recovers in place. */
const MISTRAL_RETRY = Object.freeze({ maxRetries: 3, initialDelayMs: 800, maxDelayMs: 30_000, jitterRatio: 0.1 })

/** How long a discovered roster is trusted before it is re-read. */
const CATALOG_TTL_MS = 60 * 60_000

/** One model as `/v1/models` lists it. */
export interface MistralModel {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages: boolean
  /** capabilities.reasoning: the model accepts 
easoning_effort. */
  supportsReasoning: boolean
}

/**
 * Parse `/v1/models`.
 *
 * Mistral answers `{ data: [{ id, capabilities: { completion_chat, vision, … },
 * max_context_length, max_output_tokens? }] }`. Only what the row states is kept:
 * a model with no `max_context_length` is published WITHOUT a window rather than
 * with a plausible one.
 *
 * @param payload - the parsed body.
 * @returns the rows.
 */
export function parseMistralModels(payload: unknown): MistralModel[] {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as { data?: unknown }
  const rows = Array.isArray(source.data) ? source.data : Array.isArray(payload) ? payload : []
  const out: MistralModel[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      id?: unknown
      name?: unknown
      capabilities?: { vision?: unknown; completion_chat?: unknown; reasoning?: unknown }
      max_context_length?: unknown
      max_output_tokens?: unknown
    }
    if (typeof row.id !== 'string' || row.id === '' || seen.has(row.id)) continue
    seen.add(row.id)
    const context = row.max_context_length
    const output = row.max_output_tokens
    out.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      ...typeof context === 'number' && Number.isFinite(context) && context > 0 ? { contextWindow: Math.trunc(context) } : {},
      ...typeof output === 'number' && Number.isFinite(output) && output > 0 ? { maxOutputTokens: Math.trunc(output) } : {},
      supportsImages: row.capabilities?.vision === true,
      supportsReasoning: row.capabilities?.reasoning === true,
    })
  }
  return out
}

/**
 * Wrap a Mistral row as harness model info.
 *
 * @param model - roster row.
 * @param provider - registered route id.
 * @returns the selector-facing entry.
 */
export function toMistralModelInfo(model: MistralModel, provider: string): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
  }
}

/** One budget window as `/billing/budget` reports it. */
interface MistralBudget {
  usage_percentage?: unknown
  usagePercentage?: unknown
  initial_budget?: unknown
  initialBudget?: unknown
  budget?: unknown
}

/**
 * Parse the plan and the budget windows from the two billing answers.
 *
 * Measured on a live key:
 *
 *   /billing/subscription → { "plan_name": "EDU", … }
 *   /billing/budget       → { "vibe_budget": { "usage_percentage": 0.0,
 *                                              "initial_budget": 150.0,
 *                                              "currency": "USD",
 *                                              "reset_at": "2026-12-01T00:00:00Z" }, … }
 *
 * `usage_percentage` is a PERCENTAGE (0–100). This was first read as a fraction on
 * the strength of a guessed spend, which made the card show 41.89% where the
 * console showed $0.06 of $15 — the console figure is the authority: with
 * `initial_budget: 15` and `usage_percentage: 0.41892786666666665`, 0.4189…% of 15
 * is 0.0628, i.e. the site's "$0.06 / $15".
 *
 * The amounts are money, so the window is `unit: 'currency'` and `limit`, `used`
 * and `remaining` are all in the entry's `currency`.
 *
 * @param subscription - `/billing/subscription` body.
 * @param budget - `/billing/budget` body.
 * @returns the usage payload, or `{ supported: false }` when neither said anything.
 */
export function mistralUsageFromBilling(subscription: unknown, budget: unknown): ProviderUsage {
  const planRecord = (typeof subscription === 'object' && subscription !== null ? subscription : {}) as Record<string, unknown>
  const plan = [planRecord.plan_name, planRecord.plan, planRecord.planName].find(value => typeof value === 'string' && value !== '') as string | undefined
  const body = (typeof budget === 'object' && budget !== null ? budget : {}) as Record<string, unknown>
  const windows: UsageWindow[] = []
  const add = (entry: unknown, scope: string): void => {
    if (typeof entry !== 'object' || entry === null) return
    const record = entry as MistralBudget & { reset_at?: unknown; resetsAt?: unknown }
    const raw = [record.usage_percentage, record.usagePercentage].find(value => typeof value === 'number' && Number.isFinite(value)) as number | undefined
    const size = [record.initial_budget, record.initialBudget, record.budget].find(value => typeof value === 'number' && Number.isFinite(value)) as number | undefined
    if (raw === undefined && size === undefined) return
    // A wallet funded with nothing is not a wallet. The Vibe CLI's own credential
    // reports `api_budget.initial_budget: 0`, and a "$0 / $0" row reads as a bug
    // rather than as "this credential has no pay-as-you-go wallet".
    if (size !== undefined && size <= 0) return
    // `usage_percentage` is a PERCENTAGE (0–100), not a fraction. Verified against
    // the console: the live key reported 0.41892786666666665 here while the site
    // showed $0.06 of $15, and 0.4189…% of 15 is 0.0628. Reading it as a fraction
    // (an earlier, wrong guess) displayed 41.89% for that same $0.06.
    const usedPercent = Math.min(100, Math.max(0, raw ?? 0))
    const reset = [record.reset_at, record.resetsAt].find(value => typeof value === 'string' || typeof value === 'number')
    const resetsAt = typeof reset === 'number' ? reset : typeof reset === 'string' ? Date.parse(reset) : Number.NaN
    windows.push({
      kind: 'other',
      scope,
      usedPercent,
      unit: 'currency',
      ...size === undefined ? {} : {
        limit: size,
        used: size * usedPercent / 100,
        remaining: Math.max(0, size * (1 - usedPercent / 100)),
      },
      ...Number.isFinite(resetsAt) ? { resetsAt } : {},
    })
  }
  add(body.vibe_budget, 'Vibe allowance (plan)')
  add(body.api_budget, 'API wallet (pay-as-you-go)')
  if (windows.length === 0) add(body.budget, 'Monthly budget')
  if (windows.length === 0) return { supported: false }
  return {
    supported: true,
    windows,
    ...plan === undefined ? {} : { plan },
  }
}

/** Adapter dependencies. */
export interface MistralAdapterOptions {
  /** Validated `models.mistral` entries (the operator's overrides). */
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<MistralSession>
  discovery: boolean
  pool?: () => PoolAdapter | undefined
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
}

/** Mistral provider adapter. */
export class MistralAdapter extends LlmAdapter {
  private readonly rosters = new Map<string, { at: number; models: MistralModel[] }>()
  private readonly notFetched = new Map<string, ModelListNotFetched>()
  private readonly fetchFn: FetchFn

  constructor(private readonly options: MistralAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Mistral (Vibe Pro / Team)' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(MISTRAL_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `mistral: "${provider}"`)
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
   * Why this route's roster is empty, when the read failed rather than listing
   * nothing.
   * @param provider - the registered route.
   * @returns the recorded reason.
   */
  notFetchedReason(provider: string): ModelListNotFetched | undefined {
    return this.notFetched.get(provider)
  }

  /** Configured rows, as a roster. */
  private configuredRoster(): MistralModel[] {
    return this.options.models.map(entry => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      ...entry.maxTokens === undefined ? {} : { maxOutputTokens: entry.maxTokens },
      supportsImages: entry.inputModalities?.includes('image') ?? false,
      supportsReasoning: (entry as { reasoning?: boolean }).reasoning === true,
    }))
  }

  private baseUrl(session: MistralSession): string {
    const configured = typeof session.baseUrl === 'string' && session.baseUrl !== '' ? session.baseUrl : MISTRAL_API_BASE
    return configured.replace(/\/+$/, '')
  }

  async listOwnModels(provider: string, account?: string): Promise<readonly LlmModelInfo[]> {
    if (!this.options.discovery) return this.configuredRoster().map(model => toMistralModelInfo(model, provider))
    const key = account ?? (await this.options.tokens.list())[0]?.key
    if (key === undefined) return this.configuredRoster().map(model => toMistralModelInfo(model, provider))
    const cached = this.rosters.get(key)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.models.map(model => toMistralModelInfo(model, provider))
    }
    try {
      const session = await this.options.tokens.session(key)
      const response = await this.fetchFn(`${this.baseUrl(session)}${MISTRAL_MODELS_PATH}`, {
        headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', ...attributionHeaders() },
      })
      if (!response.ok) throw await httpLlmError(response, 'mistral models')
      const models = parseMistralModels(await response.json())
      if (models.length === 0) {
        this.notFetched.set(provider, { what: 'Mistral returned no models', detail: '/v1/models listed nothing' })
        return this.configuredRoster().map(model => toMistralModelInfo(model, provider))
      }
      // Configured rows merge on top, so a hand-added model costs none of the listed ones.
      const listed = new Map(models.map(model => [model.id, model]))
      for (const entry of this.configuredRoster()) if (!listed.has(entry.id)) listed.set(entry.id, entry)
      const merged = [...listed.values()]
      this.rosters.set(key, { at: Date.now(), models: merged })
      this.notFetched.delete(provider)
      return merged.map(model => toMistralModelInfo(model, provider))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.notFetched.set(provider, { what: 'Mistral returned no models', detail })
      this.options.onWarn?.(`mistral catalog failed (${detail})`)
      return (cached?.models ?? this.configuredRoster()).map(model => toMistralModelInfo(model, provider))
    }
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    const known = [...this.rosters.values()].flatMap(entry => entry.models).find(entry => entry.id === model)
      ?? this.configuredRoster().find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? known?.contextWindow
    const maxTokens = configured?.maxTokens ?? known?.maxOutputTokens
    // Mistral HONOURS `reasoning_effort` on models that declare
    // `capabilities.reasoning` — measured on a live key, the same prompt spent 102
    // reasoning tokens with no effort, 193 with `high` and 64 with `low`. A model
    // without that capability claims no axis at all, rather than offering knobs the
    // API answers with `Reasoning prompt mode is not enabled for this model`.
    const efforts = known?.supportsReasoning === true
      ? MISTRAL_REASONING_EFFORTS.map(effort => ({ id: ReasoningEffortId(effort), name: effortDisplayName(effort) }))
      : []
    return {
      provider,
      id: model,
      name: configured?.name ?? known?.name ?? model,
      inputModalities: configured?.inputModalities ?? (known?.supportsImages === true ? ['text', 'image'] : ['text']),
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens },
      ...efforts.length === 0 ? {} : { reasoning: { efforts } },
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
      const resolved = await resolveImages(options.messages, this.options.resolveAttachments?.(), options.signal)
      const body: Record<string, unknown> = {
        model: options.model,
        messages: toChatMessages(resolved, options.system),
        stream: true,
      }
      if (options.tools !== undefined && options.tools.length > 0) body.tools = toChatTools(options.tools)
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
      if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
      // Only for models that declare the capability; any other value would be
      // rejected by the API (Reasoning prompt mode is not enabled for this model).
      const declared = [...this.rosters.values()].flatMap(entry => entry.models).find(entry => entry.id === options.model)
      const effort = options.reasoningEffort === undefined ? '' : String(options.reasoningEffort).trim()
      if (declared?.supportsReasoning === true && effort !== '' && effort !== 'off') body.reasoning_effort = effort

      let response: Response
      try {
        response = await this.fetchFn(`${this.baseUrl(session)}${MISTRAL_CHAT_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.accessToken}`,
            accept: 'text/event-stream',
            ...attributionHeaders(),
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (error) {
        throw mapFetchFailure('mistral', error, watchdog, options.signal)
      }
      if (!response.ok) {
        // Mistral answers 402 with `billing_api_budget_exhausted` when a wallet is
        // empty. That is a QUOTA state, not a request fault: classifying it as
        // `HTTP_402` (what the shared mapping does) stops a pool from switching to
        // an account that still has budget, which is the one useful reaction.
        if (response.status === 402) {
          const detail = (await response.clone().text().catch(() => '')).slice(0, 300)
          throw new LlmError(`mistral: budget exhausted (402): ${detail}`, QUOTA_EXCEEDED_CODE)
        }
        throw await httpLlmError(response, 'mistral')
      }
      if (response.body === null) throw new LlmError('mistral returned an empty stream', 'EMPTY_RESPONSE')
      yield* streamChatCompletions(response.body, () => { watchdog.pulse() })
    } finally {
      watchdog.stop()
    }
  }
}

/**
 * Read a Mistral account's plan and budget.
 *
 * Both are API-key calls, so no browser session is needed. Any failure reports
 * `{ supported: false }` — a quota view that guessed would be worse than none.
 *
 * @param fetchFn - fetch to use.
 * @param session - the stored session.
 * @param signal - caller cancellation.
 * @returns the usage payload.
 */
export async function fetchMistralUsage(
  fetchFn: typeof fetch,
  session: MistralSession,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const base = (typeof session.baseUrl === 'string' && session.baseUrl !== '' ? session.baseUrl : MISTRAL_API_BASE).replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', ...attributionHeaders() }
  const read = async (path: string): Promise<unknown> => {
    const response = await fetchFn(`${base}${path}`, { headers, ...signal === undefined ? {} : { signal } })
    if (!response.ok) throw new Error(`mistral ${path} answered ${response.status}`)
    return await response.json()
  }
  try {
    const [subscription, budget] = await Promise.all([read(MISTRAL_SUBSCRIPTION_PATH), read(MISTRAL_BUDGET_PATH)])
    return mistralUsageFromBilling(subscription, budget)
  } catch {
    return { supported: false }
  }
}

/**
 * Validate a pasted Mistral API key before it reaches the store.
 *
 * @param value - raw paste.
 * @param label - diagnostic prefix naming the route.
 * @returns the trimmed key.
 * @throws {LlmError} when the paste cannot be a key.
 */
export function assertUsableMistralKey(value: string, label: string): string {
  const key = value.trim()
  if (key === '') throw new LlmError(`${label}: Mistral API key is empty`, 'INVALID_CREDENTIAL')
  if (/\s/.test(key)) {
    throw new LlmError(`${label}: that looks like a request header, not a bare API key (it contains whitespace)`, 'INVALID_CREDENTIAL')
  }
  if (!/^[A-Za-z0-9_-]{16,}$/.test(key)) {
    throw new LlmError(`${label}: that does not look like a Mistral API key`, 'INVALID_CREDENTIAL')
  }
  return key
}

/**
 * Build a session from a pasted key. A Mistral key has no refresh grant: it works
 * until revoked, so the session is static.
 *
 * @param apiKey - validated key.
 * @param account - account label.
 * @param baseUrl - optional origin override.
 * @returns the session.
 */
export function sessionFromMistralKey(apiKey: string, account: string, baseUrl?: string): MistralSession {
  return {
    accessToken: apiKey,
    refreshToken: apiKey,
    expiresAt: Date.now() + 3650 * 24 * 60 * 60 * 1000,
    account,
    ...baseUrl === undefined || baseUrl === '' ? {} : { baseUrl },
  }
}

/** Mask a key for display. */
export function maskMistralKey(value: string): string {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/** A Mistral key never becomes permanently invalid from a refresh attempt. */
export function isMistralPermanentRefreshError(_error: unknown): boolean {
  return false
}

/** Refresh a static key: the identity. */
export async function refreshMistral(session: MistralSession): Promise<MistralSession> {
  return session
}

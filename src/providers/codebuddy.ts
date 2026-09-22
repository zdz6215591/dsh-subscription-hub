/**
 * Tencent CodeBuddy: browser OAuth poll + OpenAI-compatible chat + check-in.
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
import type { CodeBuddySession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import { effortDisplayName, httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning } from './common.js'
import type { FetchFn, ModelEntry, ProviderUsage } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import {
  getConfig,
  getLoginAccount,
  pollAuthToken,
  refreshAccessToken,
  requestAuthState,
} from './codebuddy-lib/codebuddy.js'
import {
  CODEBUDDY_CHAT_BASE,
  CODEBUDDY_CLI_VERSION,
  CODEBUDDY_DISPLAY_NAME,
  CODEBUDDY_IDE_VERSION,
} from './codebuddy-lib/constants.js'
import { serializeRequest } from './codebuddy-lib/serialize.js'
import { parseSse } from './codebuddy-lib/sse.js'
import { translate } from './codebuddy-lib/translate.js'
import { hasDisclosedCapacity } from './codebuddy-lib/types.js'
import type { CodeBuddyModel } from './codebuddy-lib/types.js'
import { fetchCodeBuddyMeter } from './codebuddy-lib/usage.js'
import type { CodeBuddyIdentity } from './codebuddy-lib/codebuddy.js'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export const CODEBUDDY_PREEMPT_MS = 2 * 60_000

function identityOf(session: CodeBuddySession): CodeBuddyIdentity {
  return {
    accessToken: session.accessToken,
    domain: session.domain,
    uid: session.uid,
    ...session.enterpriseId === undefined ? {} : { enterpriseId: session.enterpriseId },
  }
}

export async function startCodeBuddyLogin(signal?: AbortSignal): Promise<{ authorizeUrl: string; state: string }> {
  const state = await requestAuthState(signal)
  return { authorizeUrl: state.authUrl, state: state.state }
}

export async function completeCodeBuddyLogin(state: string, signal?: AbortSignal): Promise<CodeBuddySession> {
  const token = await pollAuthToken(state, signal)
  if (token === undefined) throw new Error('CodeBuddy login timed out or was refused')
  const account = await getLoginAccount(state, token.accessToken, token.domain)
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    domain: token.domain,
    uid: account.uid,
    account: account.nickname,
    ...account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId },
  }
}

export async function refreshCodeBuddy(session: CodeBuddySession): Promise<CodeBuddySession> {
  const token = await refreshAccessToken(identityOf(session), session.refreshToken)
  // `undefined` here means the server ANSWERED and refused the credential —
  // the only case that makes the account permanently dead. A request that never
  // arrived throws CodeBuddyTransportError instead and propagates as transient.
  if (token === undefined) throw new Error('CodeBuddy refresh was refused by the server')
  return {
    ...session,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || session.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    domain: token.domain || session.domain,
  }
}

/**
 * Whether a CodeBuddy refresh failure means the credential is permanently dead.
 *
 * Matched on the exact refusal marker rather than a loose `/refused|401|invalid/i`
 * over the message: that regex also matched transport wording ("connection
 * refused", "invalid URL"), so a network blip deleted the account and forced a
 * re-login. Only the server's own refusal counts.
 */
export function isCodeBuddyPermanentRefreshError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('refused by the server')
}

export async function fetchCodeBuddyUsage(
  session: CodeBuddySession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  return fetchCodeBuddyMeter(identityOf(session), fetchFn, signal)
}

function billingBase(domain: string): string {
  const lower = domain.toLowerCase()
  return lower === 'workbuddy.ai' || lower.endsWith('.workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : 'https://www.codebuddy.cn'
}

function billingHeaders(session: CodeBuddySession): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': `CodeBuddyIDE/${CODEBUDDY_IDE_VERSION} CodeBuddy/${CODEBUDDY_IDE_VERSION}`,
    authorization: `Bearer ${session.accessToken}`,
    'x-domain': session.domain,
    'x-user-id': session.uid,
    ...session.enterpriseId === undefined ? {} : {
      'x-enterprise-id': session.enterpriseId,
      'x-tenant-id': session.enterpriseId,
    },
  }
}

interface CheckinEnvelope {
  code?: number
  msg?: string
  message?: string
  data?: {
    today_checked_in?: boolean
    todayCheckedIn?: boolean
    active?: boolean
    Active?: boolean
    streak_days?: number
    streakDays?: number
    message?: string
  }
}

async function postBilling(
  session: CodeBuddySession,
  path: string,
  fetchFn: FetchFn,
): Promise<{ ok: boolean; status: number; body: CheckinEnvelope; text: string }> {
  const response = await fetchFn(`${billingBase(session.domain)}${path}`, {
    method: 'POST',
    headers: billingHeaders(session),
    body: '{}',
  })
  const text = await response.text()
  let body: CheckinEnvelope = {}
  try { body = JSON.parse(text) as CheckinEnvelope } catch { /* non-JSON */ }
  return { ok: response.ok && (body.code === undefined || body.code === 0), status: response.status, body, text }
}

function alreadyCheckedIn(body: CheckinEnvelope, text = ''): boolean {
  const data = body.data
  if (data?.today_checked_in === true || data?.todayCheckedIn === true) return true
  const msg = `${body.msg ?? ''} ${body.message ?? ''} ${data?.message ?? ''} ${text}`
  return /already|已签|重复签|签到配置加载失败/i.test(msg)
}

/**
 * Daily CodeBuddy (CN) check-in via the billing meter. Global (workbuddy.ai)
 * accounts do not support check-in. Already-signed-today is treated as success.
 */
export async function checkinCodeBuddy(
  session: CodeBuddySession,
  fetchFn: FetchFn = proxiedFetch,
): Promise<{ ok: boolean; message: string }> {
  if (/workbuddy\.ai/i.test(session.domain)) {
    return { ok: false, message: 'Global CodeBuddy accounts do not support daily check-in' }
  }
  try {
    const status = await postBilling(session, '/v2/billing/meter/checkin-activity-status', fetchFn)
    if (status.ok && alreadyCheckedIn(status.body, status.text)) {
      const streak = status.body.data?.streak_days ?? status.body.data?.streakDays
      return { ok: true, message: streak === undefined ? 'Already checked in today' : `Already checked in today (streak ${streak})` }
    }
    if (status.ok && status.body.data?.active === false) {
      return { ok: false, message: 'Check-in activity is not active' }
    }
  } catch {
    // Status probe is advisory; still attempt the check-in POST.
  }
  try {
    const result = await postBilling(session, '/v2/billing/meter/daily-checkin', fetchFn)
    if (result.ok) {
      const msg = result.body.msg ?? result.body.message ?? result.body.data?.message
      return { ok: true, message: msg && msg.length > 0 ? msg : 'Check-in succeeded' }
    }
    if (alreadyCheckedIn(result.body, result.text)) {
      return { ok: true, message: 'Already checked in today' }
    }
    const fallback = await postBilling(session, '/v2/billing/meter/checkin-status', fetchFn)
    if (fallback.ok && alreadyCheckedIn(fallback.body, fallback.text)) {
      return { ok: true, message: 'Already checked in today' }
    }
    const detail = result.body.msg ?? result.body.message ?? result.text.slice(0, 160)
    if (/签到配置加载失败/.test(detail)) {
      return { ok: true, message: 'Already checked in today (server check-in config unavailable)' }
    }
    return { ok: false, message: `HTTP ${result.status}: ${detail}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export interface CodeBuddyCheckinState {
  /** The calendar date of the last successful check-in ("YYYY-MM-DD"). */
  lastDate?: string
  /** Timestamp of the last check-in. */
  lastTime?: number
  /** Status message returned by the last check-in. */
  lastMessage?: string
  /** The calendar date for which a random morning check-in is planned ("YYYY-MM-DD"). */
  scheduledDate?: string
  /** Epoch ms timestamp of the scheduled morning check-in (between 06:00:00 and 07:55:00). */
  scheduledTime?: number
  /** Compatibility with legacy state file ({ slot: "YYYY-MM-DD-am" }). */
  slot?: string
}

export interface CodeBuddyCheckinStatusView {
  lastDate?: string
  lastTime?: number
  lastMessage?: string
  scheduledDate?: string
  scheduledTime?: number
  checkedInToday: boolean
}

export function localDateString(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Randomly pick a check-in time before 8:00 AM on the given calendar date.
 * Default range: between 06:00:00 and 07:55:00 (115-minute morning window).
 */
export function generateMorningTargetTime(date: Date): number {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6, 0, 0, 0)
  const offsetMs = Math.floor(Math.random() * 115 * 60 * 1000)
  return target.getTime() + offsetMs
}

export function checkinStatePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'codebuddy-checkin.json')
}

export async function readCheckinState(): Promise<CodeBuddyCheckinState> {
  try {
    const raw = JSON.parse(await readFile(checkinStatePath(), 'utf8')) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return {}
    const state: CodeBuddyCheckinState = {}
    if (typeof raw.lastDate === 'string' && raw.lastDate.length > 0) state.lastDate = raw.lastDate
    else if (typeof raw.slot === 'string' && raw.slot.length >= 10) state.lastDate = raw.slot.slice(0, 10)
    if (typeof raw.lastTime === 'number' && Number.isFinite(raw.lastTime)) state.lastTime = raw.lastTime
    if (typeof raw.lastMessage === 'string') state.lastMessage = raw.lastMessage
    if (typeof raw.scheduledDate === 'string') state.scheduledDate = raw.scheduledDate
    if (typeof raw.scheduledTime === 'number' && Number.isFinite(raw.scheduledTime)) state.scheduledTime = raw.scheduledTime
    if (typeof raw.slot === 'string') state.slot = raw.slot
    return state
  } catch {
    return {}
  }
}

export async function writeCheckinState(state: CodeBuddyCheckinState): Promise<void> {
  const path = checkinStatePath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' })
  try { await chmod(tmp, 0o600) } catch { /* windows */ }
  await rename(tmp, path)
}

export async function recordManualCheckin(message: string, now = new Date()): Promise<void> {
  const todayStr = localDateString(now)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const tomorrowStr = localDateString(tomorrow)
  const previous = await readCheckinState()
  const state: CodeBuddyCheckinState = {
    ...previous,
    lastDate: todayStr,
    lastTime: now.getTime(),
    lastMessage: message,
    scheduledDate: tomorrowStr,
    scheduledTime: generateMorningTargetTime(tomorrow),
    slot: `${todayStr}-am`,
  }
  await writeCheckinState(state)
}

export async function getCodeBuddyCheckinStatus(now = new Date()): Promise<CodeBuddyCheckinStatusView> {
  const todayStr = localDateString(now)
  let state = await readCheckinState()

  if (state.lastDate === todayStr) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = localDateString(tomorrow)
    if (state.scheduledDate !== tomorrowStr || state.scheduledTime === undefined) {
      state.scheduledDate = tomorrowStr
      state.scheduledTime = generateMorningTargetTime(tomorrow)
      await writeCheckinState(state)
    }
  } else if (state.scheduledDate !== todayStr || state.scheduledTime === undefined) {
    state.scheduledDate = todayStr
    state.scheduledTime = generateMorningTargetTime(now)
    await writeCheckinState(state)
  }

  return {
    ...state.lastDate !== undefined ? { lastDate: state.lastDate } : {},
    ...state.lastTime !== undefined ? { lastTime: state.lastTime } : {},
    ...state.lastMessage !== undefined ? { lastMessage: state.lastMessage } : {},
    ...state.scheduledDate !== undefined ? { scheduledDate: state.scheduledDate } : {},
    ...state.scheduledTime !== undefined ? { scheduledTime: state.scheduledTime } : {},
    checkedInToday: state.lastDate === todayStr,
  }
}

/**
 * Run daily check-in once per day for every logged-in CodeBuddy account.
 * Scheduled at a random time before 8:00 AM (between 06:00 and 07:55).
 * If DSH was not running during the morning window, catches up on the next start.
 */
export async function autoCheckinCodeBuddy(
  sessions: readonly CodeBuddySession[],
  fetchFn: FetchFn = proxiedFetch,
  now = new Date(),
): Promise<void> {
  if (sessions.length === 0) return

  const todayStr = localDateString(now)
  let state = await readCheckinState()

  // 1. If today has already checked in, ensure tomorrow has a planned target and return
  if (state.lastDate === todayStr) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = localDateString(tomorrow)
    if (state.scheduledDate !== tomorrowStr || state.scheduledTime === undefined) {
      state.scheduledDate = tomorrowStr
      state.scheduledTime = generateMorningTargetTime(tomorrow)
      await writeCheckinState(state)
    }
    return
  }

  // 2. Today has not checked in. Ensure a morning target is planned for today
  if (state.scheduledDate !== todayStr || state.scheduledTime === undefined) {
    state.scheduledDate = todayStr
    state.scheduledTime = generateMorningTargetTime(now)
    await writeCheckinState(state)
  }

  // 3. If current time has not reached the scheduled target, wait
  if (now.getTime() < state.scheduledTime) {
    return
  }

  // 4. Target time reached! Perform check-in for all accounts
  let anyOk = false
  let lastMessage = ''
  for (const session of sessions) {
    const result = await checkinCodeBuddy(session, fetchFn)
    if (result.ok) {
      anyOk = true
      lastMessage = result.message
    }
  }

  // 5. On success or already-checked-in, record today as completed and plan tomorrow
  if (anyOk) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const tomorrowStr = localDateString(tomorrow)
    state = {
      lastDate: todayStr,
      lastTime: now.getTime(),
      lastMessage,
      scheduledDate: tomorrowStr,
      scheduledTime: generateMorningTargetTime(tomorrow),
      slot: `${todayStr}-am`,
    }
    await writeCheckinState(state)
  }
}

export interface CodeBuddyAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<CodeBuddySession>
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
  defaultEffortOf?: (model: string) => string | undefined
}

const CATALOG_TTL_MS = 5 * 60_000

export class CodeBuddyAdapter extends LlmAdapter {
  private readonly catalogs = new Map<string, { at: number; models: CodeBuddyModel[] }>()

  constructor(private readonly options: CodeBuddyAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: CODEBUDDY_DISPLAY_NAME }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `codebuddy: provider "${provider}" retryPolicy`,
    )
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.catalogs.clear()
    else this.catalogs.delete(account)
  }

  private listedModel(model: CodeBuddyModel, provider: string): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.supportsImages === true ? ['text', 'image'] as const : ['text'] as const,
    }
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if ([...this.catalogs.values()].every(entry => entry.models.length === 0)) {
      await this.listOwnModels(provider)
    }
    const entry = [...this.catalogs.values()].flatMap(item => item.models).find(candidate => candidate.id === model)
    const configured = this.options.models.find(item => item.id === model)
    const contextWindow = entry?.maxAllowedSize !== undefined && entry.maxAllowedSize > 0
      ? entry.maxAllowedSize
      : configured?.contextWindow ?? 128_000
    const maxTokens = entry?.maxOutputTokens !== undefined && entry.maxOutputTokens > 0
      ? entry.maxOutputTokens
      : configured?.maxTokens ?? 8_192
    let reasoning: { efforts: { id: ReasoningEffortId; name: string }[]; defaultEffort?: ReasoningEffortId } | undefined
    if (entry?.supportsReasoning === true || entry?.reasoning !== undefined) {
      const supported = entry?.reasoning?.supportedEfforts ?? ['low', 'medium', 'high']
      const efforts = supported.map(eff => ({
        id: ReasoningEffortId(eff.toLowerCase()),
        name: effortDisplayName(eff),
      }))
      const def = entry?.reasoning?.defaultEffort ?? entry?.reasoning?.effort
      const defaultEffort = def !== undefined && efforts.some(e => e.id === ReasoningEffortId(def.toLowerCase()))
        ? ReasoningEffortId(def.toLowerCase())
        : efforts[0]?.id
      reasoning = {
        efforts,
        ...defaultEffort !== undefined ? { defaultEffort } : {},
      }
    }
    const mergedReasoning = mergeReasoning(this.options.defaultEffortOf?.(model), reasoning)
    return {
      provider,
      id: model,
      name: entry?.name ?? configured?.name ?? model,
      inputModalities: entry?.supportsImages === true ? ['text', 'image'] : ['text', 'image'],
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
      ...mergedReasoning !== undefined ? { reasoning: mergedReasoning } : {},
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
      return this.options.models.map(model => ({ provider, id: model.id, name: model.name ?? model.id }))
    }
    const cached = this.catalogs.get(account)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.models.map(model => this.listedModel(model, provider))
    }
    try {
      const session = await this.options.tokens.session(account)
      const config = await getConfig(identityOf(session), signal)
      const models = (config.models ?? []).filter(model => hasDisclosedCapacity(model))
      if (models.length > 0) this.catalogs.set(account, { at: Date.now(), models })
      return models.map(model => this.listedModel(model, provider))
    } catch (error) {
      if (cached !== undefined) return cached.models.map(model => this.listedModel(model, provider))
      this.options.onWarn?.(`codebuddy catalog failed (${error instanceof Error ? error.message : String(error)})`)
      return this.options.models.map(model => ({ provider, id: model.id, name: model.name ?? model.id }))
    }
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
      const request = serializeRequest(options, true)
      let response: Response
      try {
        response = await proxiedFetch(`${CODEBUDDY_CHAT_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${session.accessToken}`,
            'x-domain': session.domain,
            'x-user-id': session.uid,
            ...session.enterpriseId === undefined ? {} : { 'x-enterprise-id': session.enterpriseId },
            'user-agent': `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
          },
          body: JSON.stringify(request),
          signal: watchdog.signal,
        })
      } catch (error) {
        throw mapFetchFailure('codebuddy', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'codebuddy')
      if (response.body === null) throw new LlmError('codebuddy returned an empty stream', 'EMPTY_RESPONSE')
      yield* translate(parseSse(response.body, () => watchdog.pulse()))
    } finally {
      watchdog.stop()
    }
  }
}

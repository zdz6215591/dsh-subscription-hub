/**
 * Command Code Go: Studio loopback login + /alpha/generate JSONL stream.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../compat.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CommandCodeSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import { httpLlmError, idleWatchdog, mapFetchFailure } from './common.js'
import type { FetchFn, ModelEntry, ProviderUsage } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'

export const COMMANDCODE_PREEMPT_MS = 365 * 24 * 60 * 60 * 1000
export const COMMANDCODE_API_BASE = 'https://api.commandcode.ai'
const STUDIO_BASE = 'https://commandcode.ai'
const LOGIN_ORIGINS = new Set(['https://commandcode.ai', 'https://staging.commandcode.ai', 'http://localhost:3000'])

export async function refreshCommandCode(session: CommandCodeSession): Promise<CommandCodeSession> {
  return session
}

export function isCommandCodePermanentRefreshError(_error: unknown): boolean {
  return false
}

function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === 'api') return stringValue(value.key)
  if (type === 'oauth') return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

/** Read the official CLI file at `~/.commandcode/auth.json` (same as Mars-Sea). */
export function commandCodeCliAuthPath(): string {
  return join(homedir(), '.commandcode', 'auth.json')
}

export function parseCommandCodeAuthFile(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const direct = stringValue(raw.apiKey) ?? stringValue(raw.commandcode)
  if (direct !== undefined) return direct
  return apiKeyFromCredentialRecord(raw.commandcode) ?? apiKeyFromCredentialRecord(raw['command-code'])
}

async function sessionFromApiKey(apiKey: string, fetchFn: FetchFn = proxiedFetch): Promise<CommandCodeSession> {
  const key = apiKey.trim()
  if (key.length === 0) throw new Error('Command Code API key is empty')
  let account: string | undefined
  let userId: string | undefined
  try {
    const response = await fetchFn(`${COMMANDCODE_API_BASE}/alpha/whoami`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...attributionHeaders() },
    })
    if (response.ok) {
      const body = await response.json() as { user?: { id?: string; name?: string; userName?: string } }
      const user = body.user
      account = typeof user?.name === 'string' && user.name.length > 0
        ? user.name
        : typeof user?.userName === 'string' && user.userName.length > 0 ? user.userName : undefined
      userId = typeof user?.id === 'string' && user.id.length > 0 ? user.id : undefined
    }
  } catch { /* identity is optional; the key can still be stored */ }
  return {
    accessToken: key,
    refreshToken: key,
    expiresAt: Date.now() + COMMANDCODE_PREEMPT_MS,
    ...account === undefined ? {} : { account },
    ...userId === undefined ? {} : { userId },
  }
}

/** Import the key the official `cmd login` / `command-code login` already wrote. */
export async function importCommandCodeCli(fetchFn: FetchFn = proxiedFetch): Promise<CommandCodeSession> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(commandCodeCliAuthPath(), 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No Command Code CLI login found (~/.commandcode/auth.json). Paste an API key, or run `cmd login`.')
    }
    throw error
  }
  const key = parseCommandCodeAuthFile(raw)
  if (key === undefined) {
    throw new Error('~/.commandcode/auth.json has no API key. Paste one, or run `cmd login` again.')
  }
  return sessionFromApiKey(key, fetchFn)
}

/** Paste a Command Code API key (`user_…`) or a JSON blob that contains one. */
export async function sessionFromCommandCodePaste(input: string, fetchFn: FetchFn = proxiedFetch): Promise<CommandCodeSession> {
  const trimmed = input.trim()
  if (trimmed.startsWith('{')) {
    const key = parseCommandCodeAuthFile(JSON.parse(trimmed) as unknown)
    if (key === undefined) throw new Error('JSON paste needs apiKey / commandcode.key')
    return sessionFromApiKey(key, fetchFn)
  }
  return sessionFromApiKey(trimmed, fetchFn)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export const COMMANDCODE_PLANS: Readonly<Record<string, { name: string; monthlyCredits: number }>> = {
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15 },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
}

const COMMANDCODE_PLAN_PREFIXES = Object.keys(COMMANDCODE_PLANS).sort((a, b) => b.length - a.length)

export function commandCodePlanInfo(planId: string): { name: string; monthlyCredits: number } | undefined {
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  const prefix = COMMANDCODE_PLAN_PREFIXES.find(candidate => normalized.startsWith(candidate))
  return prefix === undefined ? undefined : COMMANDCODE_PLANS[prefix]
}

function creditWindow(
  kind: 'session' | 'weekly' | 'other',
  used: number | undefined,
  cap: number | undefined,
  resetAt?: number,
  scope?: string,
): NonNullable<ProviderUsage['windows']>[number] | undefined {
  if (typeof used !== 'number' || typeof cap !== 'number' || !(cap > 0)) return undefined
  return {
    kind,
    usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
    remaining: Math.max(cap - used, 0),
    limit: cap,
    ...typeof resetAt === 'number' ? { resetsAt: resetAt } : {},
    ...scope === undefined ? {} : { scope },
  }
}

function periodEndMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function parseCommandCodeCredits(
  body: unknown,
  planCap?: number,
  planName?: string,
  periodEnd?: number,
): ProviderUsage {
  if (!isRecord(body)) return { supported: false }
  const credits = isRecord(body.credits) ? body.credits : undefined
  const windowLimits = isRecord(body.windowLimits) ? body.windowLimits : undefined
  const monthlyRemaining = numberValue(credits?.monthlyCredits)
  const purchased = numberValue(credits?.purchasedCredits) ?? 0
  const free = numberValue(credits?.freeCredits) ?? 0
  const planId = stringValue(credits?.planId)
  const info = planId === undefined ? undefined : commandCodePlanInfo(planId)
  const monthlyLimit = planCap ?? info?.monthlyCredits
  const windows: NonNullable<ProviderUsage['windows']> = []
  if (monthlyRemaining !== undefined) {
    const cap = monthlyLimit !== undefined && monthlyLimit > 0 ? monthlyLimit : undefined
    const used = cap === undefined ? undefined : Math.max(cap - monthlyRemaining, 0)
    windows.push({
      kind: 'other',
      scope: 'monthly',
      usedPercent: cap !== undefined && used !== undefined
        ? Math.min(100, Math.max(0, (used / cap) * 100))
        : 0,
      remaining: monthlyRemaining,
      ...cap === undefined ? {} : { limit: cap },
      ...periodEnd === undefined ? {} : { resetsAt: periodEnd },
    })
  }
  const five = isRecord(windowLimits?.fiveHour) ? windowLimits.fiveHour : undefined
  const weekly = isRecord(windowLimits?.weekly) ? windowLimits.weekly : undefined
  const fiveWindow = creditWindow('session', numberValue(five?.used), numberValue(five?.cap), numberValue(five?.resetAt))
  const weeklyWindow = creditWindow('weekly', numberValue(weekly?.used), numberValue(weekly?.cap), numberValue(weekly?.resetAt))
  if (fiveWindow !== undefined) windows.push(fiveWindow)
  if (weeklyWindow !== undefined) windows.push(weeklyWindow)
  const onDemand = purchased + free
  if (onDemand > 0) {
    windows.push({ kind: 'other', scope: 'on-demand', usedPercent: 0, remaining: onDemand })
  }
  if (windows.length === 0) return { supported: false }
  const plan = planName ?? info?.name
  return {
    supported: true,
    windows,
    ...monthlyRemaining === undefined ? {} : { remaining: monthlyRemaining },
    ...monthlyLimit === undefined ? {} : { limit: monthlyLimit },
    ...plan === undefined ? {} : { plan },
  }
}

export async function fetchCommandCodeUsage(
  session: CommandCodeSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const headers = { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', ...attributionHeaders() }
  const opts = { headers, ...signal === undefined ? {} : { signal } }
  let planName: string | undefined
  let planCap: number | undefined
  let periodEnd: number | undefined
  let orgId: string | undefined
  try {
    const whoami = await fetchFn(`${COMMANDCODE_API_BASE}/alpha/whoami`, opts)
    if (whoami.ok) {
      const body = await whoami.json() as { user?: { name?: string }; org?: { id?: string } }
      if (typeof body.user?.name === 'string') planName = body.user.name
      if (typeof body.org?.id === 'string' && body.org.id.length > 0) orgId = body.org.id
    }
  } catch { /* identity is optional */ }
  try {
    const subPath = orgId === undefined
      ? '/alpha/billing/subscriptions'
      : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`
    const subscription = await fetchFn(`${COMMANDCODE_API_BASE}${subPath}`, opts)
    if (subscription.ok) {
      const body = await subscription.json() as { data?: { planId?: string; currentPeriodEnd?: unknown } }
      const planId = typeof body.data?.planId === 'string' ? body.data.planId : undefined
      const info = planId === undefined ? undefined : commandCodePlanInfo(planId)
      if (info !== undefined) {
        planName = info.name
        planCap = info.monthlyCredits
      }
      periodEnd = periodEndMs(body.data?.currentPeriodEnd)
    }
  } catch { /* plan cap is optional */ }
  try {
    const credits = await fetchFn(`${COMMANDCODE_API_BASE}/alpha/billing/credits`, opts)
    if (!credits.ok) return { supported: false }
    return parseCommandCodeCredits(await credits.json(), planCap, planName, periodEnd)
  } catch {
    return { supported: false }
  }
}

export async function startCommandCodeLogin(): Promise<{ authorizeUrl: string; wait: () => Promise<CommandCodeSession> }> {
  const state = randomBytes(16).toString('hex')
  const server = createHttpServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('commandcode login: no port'))
      else resolve(address.port)
    })
  })
  const authorizeUrl = `${STUDIO_BASE}/studio/auth/cli?callback=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}&state=${state}`
  const wait = (): Promise<CommandCodeSession> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Command Code login timed out'))
    }, 180_000)
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const origin = req.headers.origin
      const cors = typeof origin === 'string' && LOGIN_ORIGINS.has(origin) ? origin : undefined
      res.setHeader('Connection', 'close')
      if (cors !== undefined) res.setHeader('Access-Control-Allow-Origin', cors)
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end()
        return
      }
      if (req.method !== 'POST' || req.url?.split('?')[0] !== '/callback') {
        res.writeHead(404).end()
        return
      }
      if (typeof origin === 'string' && !LOGIN_ORIGINS.has(origin)) {
        res.writeHead(403).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > 10_000) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            apiKey?: string; state?: string; userId?: string; userName?: string
          }
          if (body.state !== state || typeof body.apiKey !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true }))
          clearTimeout(timer)
          server.close()
          resolve({
            accessToken: body.apiKey,
            refreshToken: body.apiKey,
            expiresAt: Date.now() + COMMANDCODE_PREEMPT_MS,
            ...typeof body.userName === 'string' ? { account: body.userName } : {},
            ...typeof body.userId === 'string' ? { userId: body.userId } : {},
          })
        } catch (error) {
          clearTimeout(timer)
          server.close()
          reject(error)
        }
      })
    })
  })
  return { authorizeUrl, wait }
}

function mapCommandCodeFinish(reason: unknown): FinishReason {
  if (reason === 'tool-calls' || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'max-tokens' || reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Parse Command Code JSONL / SSE events into harness StreamChunks. */
export async function* parseCommandCodeStream(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textIndex = -1
  let textContent = ''
  let reasoningIndex = -1
  let reasoningContent = ''
  let finished = false

  const closeText = function* (): Generator<StreamChunk> {
    if (textIndex < 0) return
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } }
    textIndex = -1
    textContent = ''
  }
  const closeReasoning = function* (): Generator<StreamChunk> {
    if (reasoningIndex < 0) return
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningContent } }
    reasoningIndex = -1
    reasoningContent = ''
  }

  const handle = function* (event: Record<string, unknown>): Generator<StreamChunk> {
    switch (event.type) {
      case 'text-delta': {
        yield* closeReasoning()
        const delta = stringValue(event.text) ?? stringValue(event.delta) ?? ''
        if (delta.length === 0) return
        if (textIndex < 0) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textContent += delta
        yield { type: 'text-delta', index: textIndex, text: delta }
        return
      }
      case 'reasoning-delta': {
        yield* closeText()
        const delta = stringValue(event.text) ?? stringValue(event.delta) ?? ''
        if (delta.length === 0) return
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoningContent += delta
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta }
        return
      }
      case 'reasoning-start':
        yield* closeText()
        return
      case 'reasoning-end':
        yield* closeReasoning()
        return
      case 'tool-call': {
        yield* closeText()
        yield* closeReasoning()
        const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? randomUUID()
        const name = stringValue(event.toolName) ?? stringValue(event.name) ?? ''
        const args = JSON.stringify(isRecord(event.input) ? event.input : isRecord(event.args) ? event.args : event.arguments ?? {})
        const index = nextIndex++
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } }
        return
      }
      case 'finish': {
        yield* closeText()
        yield* closeReasoning()
        const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
        if (usage !== undefined) {
          const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
          const totalInput = numberValue(usage.inputTokens) ?? 0
          const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
          const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
          const tokenUsage: TokenUsage = {
            inputTokens: numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
            outputTokens: numberValue(usage.outputTokens) ?? 0,
            ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
            ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
          }
          yield { type: 'usage', usage: tokenUsage }
        }
        yield { type: 'finish', reason: mapCommandCodeFinish(event.finishReason) }
        finished = true
        return
      }
      case 'error': {
        const err = isRecord(event.error) ? event.error : undefined
        const detail = err !== undefined
          ? (stringValue(err.message) ?? JSON.stringify(err))
          : (stringValue(event.message) ?? 'Stream error')
        throw new LlmError(`Command Code stream error: ${detail}`, 'PROVIDER_STREAM_ERROR')
      }
      default: {
        const delta = stringValue(event.delta) ?? stringValue(event.text)
        if (delta !== undefined && delta.length > 0 && event.type === undefined) {
          yield* closeReasoning()
          if (textIndex < 0) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textContent += delta
          yield { type: 'text-delta', index: textIndex, text: delta }
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        let event: unknown
        try { event = JSON.parse(payload) }
        catch { continue }
        if (!isRecord(event)) continue
        yield* handle(event)
        if (finished) return
      }
    }
    if (!finished) {
      yield* closeText()
      yield* closeReasoning()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } finally {
    reader.releaseLock()
  }
}

export interface CommandCodeAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<CommandCodeSession>
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
}

const COMMANDCODE_CATALOG_TTL_MS = 5 * 60_000

export class CommandCodeAdapter extends LlmAdapter {
  private readonly catalogs = new Map<string, { at: number; models: LlmModelInfo[] }>()

  constructor(private readonly options: CommandCodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `commandcode: "${provider}"`)
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.catalogs.clear()
    else this.catalogs.delete(account)
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? ['text'],
      context: { contextWindow: configured?.contextWindow ?? 128_000 },
      defaultMaxTokens: configured?.maxTokens ?? 8192,
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
    const cached = this.catalogs.get(account)
    if (cached !== undefined && Date.now() - cached.at < COMMANDCODE_CATALOG_TTL_MS) return cached.models
    try {
      const session = await this.options.tokens.session(account)
      const response = await proxiedFetch(`${COMMANDCODE_API_BASE}/provider/v1/models`, {
        headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', ...attributionHeaders() },
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw await httpLlmError(response, 'commandcode models')
      const payload = await response.json() as { data?: Array<{ id?: string; name?: string }> }
      const models = (payload.data ?? [])
        .filter(row => typeof row.id === 'string' && row.id.length > 0)
        .map(row => ({ provider, id: row.id as string, name: row.name ?? row.id as string }))
      if (models.length > 0) {
        this.catalogs.set(account, { at: Date.now(), models })
        return models
      }
    } catch (error) {
      if (cached !== undefined) return cached.models
      this.options.onWarn?.(`commandcode catalog failed (${error instanceof Error ? error.message : String(error)})`)
    }
    return this.options.models.map(model => ({ provider, id: model.id, name: model.name ?? model.id }))
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
      const systemText = [options.system ?? '', ...options.messages.filter(m => m.role === 'system')
        .map(m => m.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('\n'))]
        .filter(Boolean).join('\n\n')
      const messages = options.messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role,
          content: m.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join(''),
        }))
      const body = {
        config: { workingDir: process.cwd(), date: new Date().toISOString().slice(0, 10), environment: `${process.platform}`, structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [] },
        memory: null,
        taste: null,
        skills: null,
        params: {
          model: options.model,
          messages,
          tools: (options.tools ?? []).map(tool => ({ type: 'function', name: tool.name, description: tool.description, input_schema: tool.parameters })),
          system: systemText,
          max_tokens: options.maxTokens ?? 8192,
          temperature: options.temperature ?? 0.3,
          stream: true,
          ...options.reasoningEffort !== undefined && options.reasoningEffort !== 'off'
            ? { reasoning_effort: options.reasoningEffort }
            : {},
        },
        threadId: randomUUID(),
      }
      let response: Response
      try {
        response = await proxiedFetch(`${COMMANDCODE_API_BASE}/alpha/generate`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.accessToken}`,
            'x-command-code-version': '1.37.0',
            'x-cli-environment': 'production',
            ...attributionHeaders(),
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (error) {
        throw mapFetchFailure('commandcode', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'commandcode')
      if (response.body === null) throw new LlmError('commandcode returned an empty stream', 'EMPTY_RESPONSE')
      yield* parseCommandCodeStream(response.body, () => watchdog.pulse())
    } finally {
      watchdog.stop()
    }
  }
}

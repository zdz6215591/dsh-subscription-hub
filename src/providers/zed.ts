/**
 * Zed Pro hosted models. Import credentials from the Zed desktop (or paste
 * `userId` + client token), mint a short-lived LLM token from cloud.zed.dev,
 * then stream via POST /completions (NDJSON wrapped native provider events).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ZedSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import { httpLlmError, idleWatchdog, mapFetchFailure } from './common.js'
import type { FetchFn, ModelEntry, ProviderUsage, UsageWindow } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'
import { streamAnthropic, toAnthropicMessages, toAnthropicTools } from '../translate/anthropic.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import { resolveImages } from '../translate/resolved.js'

export const ZED_PREEMPT_MS = 4 * 60_000
const ZED_CLOUD = 'https://cloud.zed.dev'
const ZED_VERSION = process.env.ZED_APP_VERSION ?? '0.227.1+stable'

export interface ZedCatalogModel {
  id: string
  name: string
  provider: string
  supportsImages: boolean
  supportsThinking: boolean
  contextWindow: number
  maxTokens: number
}

function authHeader(session: ZedSession): string {
  return `${session.userId} ${session.accessToken}`
}

function normalizeZedToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  const token = value.replace(/^secret\s*=\s*/i, '').trim()
  if (!token.startsWith('{')) return token
  try {
    const parsed = JSON.parse(token) as { id?: string; token?: string }
    if (typeof parsed.id === 'string' && typeof parsed.token === 'string') {
      return JSON.stringify({ version: 2, id: parsed.id, token: parsed.token })
    }
  } catch { /* leave as-is */ }
  return token
}

function sessionFromFields(userId: string, token: string, account?: string): ZedSession {
  return {
    accessToken: token,
    refreshToken: token,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    userId,
    ...account === undefined ? {} : { account },
  }
}

function sessionFromRecord(raw: Record<string, unknown>): ZedSession | undefined {
  const nested = typeof raw.auth === 'object' && raw.auth !== null
    ? raw.auth as Record<string, unknown>
    : raw
  const userId = String(nested.userId ?? nested.user_id ?? nested.username ?? raw.userId ?? raw.user_id ?? '')
  const token = normalizeZedToken(
    nested.token ?? nested.access_token ?? nested.accessToken ?? nested.password
    ?? raw.token ?? raw.access_token ?? raw.accessToken,
  )
  if (userId.length === 0 || token.length === 0) return undefined
  const email = nested.email ?? raw.email
  return sessionFromFields(userId, token, typeof email === 'string' ? email : undefined)
}

function zedCredentialPaths(): string[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return [
    join(local, 'Zed', 'credentials.json'),
    join(local, 'Zed', 'credentials'),
    join(appData, 'Zed', 'credentials.json'),
    join(homedir(), 'AppData', 'Roaming', 'Zed', 'credentials.json'),
    join(homedir(), 'AppData', 'Local', 'Zed', 'credentials.json'),
    join(homedir(), '.config', 'zed', 'credentials.json'),
    join(homedir(), 'Library', 'Application Support', 'Zed', 'credentials.json'),
  ]
}

async function importZedFromFiles(): Promise<ZedSession | undefined> {
  for (const path of zedCredentialPaths()) {
    try {
      const text = (await readFile(path, 'utf8')).trim()
      if (text.startsWith('{')) {
        const session = sessionFromRecord(JSON.parse(text) as Record<string, unknown>)
        if (session !== undefined) return session
      }
    } catch { /* try next */ }
  }
  return undefined
}

/** Zed's Windows keyring target is `zed:url=<server_url>`, not a JSON file. */
const WINDOWS_ZED_CRED_SCRIPT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshZedCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr credentials);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
"@
function Decode-Blob([IntPtr]$ptr, [int]$size) {
  if ($ptr -eq [IntPtr]::Zero -or $size -le 0) { return '' }
  $bytes = New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size)
  $uni = [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0)
  $utf = [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0)
  if ($uni -match '^[\\x20-\\x7E]{8,}$') { return $uni }
  if ($utf -match '^[\\x20-\\x7E]{8,}$') { return $utf }
  if ($uni.Length -ge $utf.Length) { return $uni }
  return $utf
}
function Row-FromPtr([IntPtr]$credPtr) {
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][DshZedCred+CREDENTIAL])
  return [pscustomobject]@{
    target = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.TargetName)
    user = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.UserName)
    secret = Decode-Blob $cred.CredentialBlob $cred.CredentialBlobSize
  }
}
$rows = @()
$targets = @(
  'zed:url=https://zed.dev',
  'zed:url=https://collab.zed.dev',
  'LegacyGeneric:target=zed:url=https://zed.dev',
  'https://zed.dev',
  'Zed'
)
foreach ($target in $targets) {
  $ptr = [IntPtr]::Zero
  if ([DshZedCred]::CredRead($target, 1, 0, [ref]$ptr) -and $ptr -ne [IntPtr]::Zero) {
    try { $rows += Row-FromPtr $ptr } finally { [DshZedCred]::CredFree($ptr) }
  }
}
$count = 0; $enumPtr = [IntPtr]::Zero
if ([DshZedCred]::CredEnumerate($null, 1, [ref]$count, [ref]$enumPtr)) {
  try {
    for ($i = 0; $i -lt $count; $i++) {
      $credPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($enumPtr, $i * [IntPtr]::Size)
      $row = Row-FromPtr $credPtr
      if ($row.target -match '(?i)zed') { $rows += $row }
    }
  } finally { [DshZedCred]::CredFree($enumPtr) }
}
$rows | ConvertTo-Json -Compress
`

interface WindowsCredRow {
  target?: string
  user?: string
  secret?: string
}

async function importZedFromWindowsVault(): Promise<ZedSession | undefined> {
  if (process.platform !== 'win32') return undefined
  const scriptPath = join(tmpdir(), `dsh-zed-cred-${process.pid}-${Date.now()}.ps1`)
  try {
    await writeFile(scriptPath, WINDOWS_ZED_CRED_SCRIPT, 'utf8')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: 20_000, windowsHide: true, encoding: 'utf8' },
    )
    const text = stdout.trim()
    if (text.length === 0) return undefined
    const parsed: unknown = JSON.parse(text)
    const rows: WindowsCredRow[] = Array.isArray(parsed) ? parsed as WindowsCredRow[] : [parsed as WindowsCredRow]
    for (const row of rows) {
      const userId = typeof row.user === 'string' ? row.user.trim() : ''
      const token = normalizeZedToken(row.secret)
      if (userId.length > 0 && token.length > 0) return sessionFromFields(userId, token)
      if (typeof row.secret === 'string' && row.secret.trim().startsWith('{')) {
        try {
          const session = sessionFromRecord(JSON.parse(row.secret) as Record<string, unknown>)
          if (session !== undefined) return session
        } catch { /* next row */ }
      }
    }
  } catch { /* vault unavailable */ } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined)
  }
  return undefined
}

export async function importZedDesktop(): Promise<ZedSession> {
  const fromFile = await importZedFromFiles()
  if (fromFile !== undefined) return fromFile
  const fromVault = await importZedFromWindowsVault()
  if (fromVault !== undefined) return fromVault
  throw new Error(
    'Zed desktop is signed in, but this plugin could not read Windows Credential Manager '
    + '(target zed:url=https://zed.dev). Use the two fields below: userId is the numeric id '
    + 'shown as 用户 in that credential; token is its password. There is no credentials.json in the Zed app.',
  )
}

export async function sessionFromZedPaste(input: string): Promise<ZedSession> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new Error('Zed paste is empty — fill userId and token, or paste JSON {"userId":"...","token":"..."}')
  }
  if (trimmed.startsWith('{')) {
    const session = sessionFromRecord(JSON.parse(trimmed) as Record<string, unknown>)
    if (session === undefined) throw new Error('Zed JSON needs userId and token')
    return session
  }
  const pairs: Record<string, string> = {}
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^\s*(userId|user_id|username|token|accessToken|access_token)\s*[:=]\s*(.+)\s*$/i)
    if (match !== null) pairs[match[1].toLowerCase()] = match[2].trim()
  }
  if (Object.keys(pairs).length > 0) {
    const userId = pairs.userid ?? pairs.user_id ?? pairs.username ?? ''
    const token = normalizeZedToken(pairs.token ?? pairs.accesstoken ?? pairs.access_token)
    if (userId.length > 0 && token.length > 0) return sessionFromFields(userId, token)
  }
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  if (lines.length >= 2) {
    return sessionFromFields(lines[0], normalizeZedToken(lines.slice(1).join('\n')))
  }
  const [userId, ...rest] = trimmed.split(/\s+/)
  const token = rest.join(' ')
  if (!userId || !token) {
    throw new Error('Zed paste needs userId + token (two fields, two lines, or JSON).')
  }
  return sessionFromFields(userId, normalizeZedToken(token))
}

async function mintLlmToken(session: ZedSession, systemId: string): Promise<{ token: string; expiresAt: number }> {
  const response = await proxiedFetch(`${ZED_CLOUD}/client/llm_tokens`, {
    method: 'POST',
    headers: {
      authorization: authHeader(session),
      'content-type': 'application/json',
      'x-zed-system-id': systemId,
      'x-zed-version': ZED_VERSION,
    },
    body: JSON.stringify({ organization_id: null }),
  })
  if (!response.ok) throw await httpLlmError(response, 'zed llm token')
  const body = await response.json() as { token?: string; expires_at?: string }
  if (typeof body.token !== 'string') throw new Error('zed llm_tokens returned no token')
  return {
    token: body.token,
    expiresAt: typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Date.now() + 50 * 60 * 1000,
  }
}

export async function refreshZed(session: ZedSession): Promise<ZedSession> {
  const minted = await mintLlmToken(session, session.userId)
  return { ...session, llmToken: minted.token, llmExpiresAt: minted.expiresAt, expiresAt: minted.expiresAt }
}

export function isZedPermanentRefreshError(error: unknown): boolean {
  return error instanceof Error && /401|unauthorized|invalid/i.test(error.message)
}

function planDisplayName(plan: unknown): string | undefined {
  if (typeof plan !== 'string' || plan.length === 0) return undefined
  switch (plan) {
    case 'zed_free': return 'Zed Free'
    case 'zed_pro': return 'Zed Pro'
    case 'zed_pro_trial': return 'Zed Pro Trial'
    case 'zed_business': return 'Zed Business'
    case 'zed_vip': return 'Zed VIP'
    case 'zed_student': return 'Zed Student'
    default: return plan.replaceAll('_', ' ')
  }
}

function numberish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function centsToUsd(cents: number): number {
  return cents / 100
}

function usagePercent(used: number, limit: number): number {
  if (!(limit > 0)) return 0
  return Math.min(100, Math.max(0, (used / limit) * 100))
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === 'object' && value !== null && 'secs' in value) {
    const secs = numberish((value as { secs?: unknown }).secs)
    return secs === undefined ? undefined : secs * 1000
  }
  return undefined
}

function editPredictionWindow(usage: unknown, resetsAt?: number): UsageWindow[] {
  if (typeof usage !== 'object' || usage === null) return []
  const predictions = (usage as { edit_predictions?: unknown }).edit_predictions
  if (typeof predictions !== 'object' || predictions === null) return []
  const row = predictions as { used?: unknown; limit?: unknown }
  const used = numberish(row.used)
  if (used === undefined) return []
  const limitRaw = row.limit
  if (limitRaw === 'unlimited' || (typeof limitRaw === 'object' && limitRaw !== null && 'Unlimited' in (limitRaw as object))) {
    return [{ kind: 'other', scope: 'Edit Predictions', usedPercent: 0, ...resetsAt === undefined ? {} : { resetsAt } }]
  }
  const limited = typeof limitRaw === 'object' && limitRaw !== null && 'Limited' in (limitRaw as object)
    ? numberish((limitRaw as { Limited?: unknown }).Limited)
    : numberish(limitRaw)
  if (limited === undefined || limited <= 0) {
    return [{ kind: 'other', scope: 'Edit Predictions', usedPercent: 0, ...resetsAt === undefined ? {} : { resetsAt } }]
  }
  return [{
    kind: 'other',
    scope: 'Edit Predictions',
    usedPercent: usagePercent(used, limited),
    ...resetsAt === undefined ? {} : { resetsAt },
  }]
}

function spendWindow(record: Record<string, unknown>, resetsAt?: number): UsageWindow[] {
  const spentCents = numberish(record.spent_cents ?? record.used_cents ?? record.current_spend_cents
    ?? record.token_spend_cents ?? record.spend_cents)
  const spentUsd = spentCents !== undefined ? centsToUsd(spentCents)
    : numberish(record.spent ?? record.used ?? record.current_spend ?? record.token_spend ?? record.spend)
  const includedCents = numberish(record.included_cents ?? record.included_credit_cents ?? record.credit_cents)
  const limitCents = numberish(record.spend_limit_cents ?? record.limit_cents ?? record.monthly_limit_cents)
  const includedUsd = includedCents !== undefined ? centsToUsd(includedCents)
    : numberish(record.included ?? record.included_credit ?? record.credit)
  const limitUsd = limitCents !== undefined ? centsToUsd(limitCents)
    : numberish(record.spend_limit ?? record.limit ?? record.monthly_limit)
  const cap = (includedUsd ?? 0) + (limitUsd ?? 0)
  if (spentUsd === undefined || cap <= 0) return []
  return [{
    kind: 'weekly',
    scope: 'Hosted models',
    usedPercent: usagePercent(spentUsd, cap),
    used: spentUsd,
    limit: cap,
    remaining: Math.max(cap - spentUsd, 0),
    ...resetsAt === undefined ? {} : { resetsAt },
  }]
}

/**
 * The token-based Zed Pro hosted-models quota: `usage.model_requests` carries
 * `{ used, limit }` (a `{ limited: N }` / `"unlimited"` shape like
 * `edit_predictions`). This is the "已用 / 总额度" the dashboard shows for
 * `/client/users/me`, so surface it as a used/limit window instead of
 * waiting for a dollar-spend bucket that token plans never return.
 */
function modelRequestsWindow(usage: unknown, resetsAt?: number): UsageWindow[] {
  if (typeof usage !== 'object' || usage === null) return []
  const requests = (usage as { model_requests?: unknown }).model_requests
  if (typeof requests !== 'object' || requests === null) return []
  const row = requests as { used?: unknown; limit?: unknown }
  const used = numberish(row.used)
  if (used === undefined) return []
  const limitRaw = row.limit
  if (limitRaw === 'unlimited' || (typeof limitRaw === 'object' && limitRaw !== null && 'Unlimited' in (limitRaw as object))) {
    return [{
      kind: 'weekly',
      scope: 'Hosted models',
      usedPercent: 0,
      used,
      ...resetsAt === undefined ? {} : { resetsAt },
    }]
  }
  const limited = typeof limitRaw === 'object' && limitRaw !== null && 'Limited' in (limitRaw as object)
    ? numberish((limitRaw as { Limited?: unknown }).Limited)
    : numberish(limitRaw)
  if (limited === undefined || limited <= 0) return []
  return [{
    kind: 'weekly',
    scope: 'Hosted models',
    usedPercent: usagePercent(used, limited),
    used,
    limit: limited,
    remaining: Math.max(limited - used, 0),
    ...resetsAt === undefined ? {} : { resetsAt },
  }]
}

/** Parse `/client/users/me` (and optional org billing JSON) into a usage snapshot. */
export function parseZedUsage(me: unknown, billing?: unknown): ProviderUsage {
  if (typeof me !== 'object' || me === null) return { supported: false }
  const root = me as Record<string, unknown>
  const planInfo = (typeof root.plan === 'object' && root.plan !== null ? root.plan : root) as Record<string, unknown>
  const plan = planDisplayName(planInfo.plan_v3 ?? planInfo.plan)
  const period = typeof planInfo.subscription_period === 'object' && planInfo.subscription_period !== null
    ? planInfo.subscription_period as Record<string, unknown>
    : undefined
  const resetsAt = timestampMs(period?.ended_at ?? period?.ends_at)
  const usage = planInfo.usage ?? root.usage
  const windows: UsageWindow[] = [
    ...editPredictionWindow(usage, resetsAt),
    ...modelRequestsWindow(usage, resetsAt),
    ...spendWindow(planInfo, resetsAt),
    ...typeof billing === 'object' && billing !== null ? spendWindow(billing as Record<string, unknown>, resetsAt) : [],
  ]
  if (windows.length === 0 && plan === undefined) return { supported: false }
  return {
    supported: true,
    ...plan === undefined ? {} : { plan },
    windows,
  }
}

function orgIdsFromMe(me: unknown): string[] {
  if (typeof me !== 'object' || me === null) return []
  const root = me as Record<string, unknown>
  const ids: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0 && !ids.includes(value)) ids.push(value)
  }
  push(root.default_organization_id)
  if (Array.isArray(root.organizations)) {
    for (const org of root.organizations) {
      if (typeof org === 'object' && org !== null) push((org as { id?: unknown }).id)
    }
  }
  return ids
}

/**
 * Zed hosted-model usage from the same cloud API the dashboard reads.
 * Primary: `GET /client/users/me` (plan + edit-prediction quota + billing period).
 * Then try org billing routes for dollar spend (`/org_…/billing/usage` on the dashboard).
 */
export async function fetchZedUsage(
  session: ZedSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const headers = {
    authorization: authHeader(session),
    accept: 'application/json',
    'x-zed-version': ZED_VERSION,
    ...attributionHeaders(),
  }
  const opts = { headers, ...signal === undefined ? {} : { signal } }
  const meResponse = await fetchFn(`${ZED_CLOUD}/client/users/me`, opts)
  if (!meResponse.ok) throw await httpLlmError(meResponse, 'zed usage')
  const me: unknown = await meResponse.json()
  let billing: unknown
  for (const orgId of orgIdsFromMe(me)) {
    for (const path of [
      `/client/organizations/${orgId}/billing/usage`,
      `/client/organizations/${orgId}/usage`,
      `/client/organizations/${orgId}/billing`,
    ]) {
      try {
        const response = await fetchFn(`${ZED_CLOUD}${path}`, opts)
        if (!response.ok) continue
        billing = await response.json()
        break
      } catch { /* try the next path */ }
    }
    if (billing !== undefined) break
  }
  return parseZedUsage(me, billing)
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return undefined
}

export function parseZedModels(payload: unknown): ZedCatalogModel[] {
  const root = payload as { models?: unknown }
  const rows = Array.isArray(root.models) ? root.models : Array.isArray(payload) ? payload : []
  const models: ZedCatalogModel[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    models.push({
      id: record.id,
      name: typeof record.display_name === 'string' ? record.display_name
        : typeof record.name === 'string' ? record.name : record.id,
      provider: typeof record.provider === 'string' ? record.provider : 'open_ai',
      supportsImages: record.supports_images === true,
      supportsThinking: record.supports_thinking === true,
      contextWindow: numberField(record, 'max_token_count', 'max_tokens', 'context_window', 'max_input_tokens')
        ?? 200_000,
      maxTokens: numberField(record, 'max_output_tokens', 'max_completion_tokens') ?? 16_384,
    })
  }
  return models
}

/** Build the native provider_request Zed wraps in POST /completions. */
export function buildZedProviderRequest(
  options: GenerateOptions,
  meta: ZedCatalogModel | undefined,
  images: Awaited<ReturnType<typeof resolveImages>>,
): { provider: string; body: Record<string, unknown> } {
  const zedProvider = meta?.provider ?? (options.model.startsWith('claude') ? 'anthropic'
    : options.model.startsWith('gemini') ? 'google' : 'open_ai')
  if (zedProvider === 'anthropic') {
    return {
      provider: zedProvider,
      body: {
        model: options.model,
        messages: toAnthropicMessages(images),
        ...options.system !== undefined && options.system.length > 0
          ? { system: [{ type: 'text', text: options.system }] }
          : {},
        max_tokens: options.maxTokens ?? meta?.maxTokens ?? 8192,
        stream: true,
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.tools !== undefined && options.tools.length > 0 ? { tools: toAnthropicTools(options.tools) } : {},
      },
    }
  }
  if (zedProvider === 'open_ai') {
    const { instructions, input } = toResponsesInput(images, options.system)
    return {
      provider: zedProvider,
      body: {
        model: options.model,
        input,
        stream: true,
        ...instructions === undefined ? {} : { instructions },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined && meta?.maxTokens === undefined
          ? {}
          : { max_output_tokens: options.maxTokens ?? meta?.maxTokens },
        ...options.tools !== undefined && options.tools.length > 0 ? { tools: toResponsesTools(options.tools) } : {},
        ...meta?.supportsThinking && options.reasoningEffort !== undefined
          ? { reasoning: { effort: String(options.reasoningEffort), summary: 'auto' } }
          : {},
      },
    }
  }
  return {
    provider: zedProvider,
    body: {
      model: zedProvider === 'google' ? `models/${options.model}` : options.model,
      messages: toChatMessages(images, options.system),
      stream: true,
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.tools !== undefined && options.tools.length > 0 ? { tools: toChatTools(options.tools) } : {},
    },
  }
}

/**
 * Convert Zed's NDJSON completion stream (`{event}` / `{status}` lines) into
 * an SSE byte stream the existing Anthropic / chat-completions translators
 * already understand.
 */
export function ndjsonToSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          const trimmed = line.trim()
          if (trimmed.length === 0) continue
          let payload = trimmed
          try {
            const parsed = JSON.parse(trimmed) as { event?: unknown; status?: unknown }
            if (parsed.status !== undefined && parsed.event === undefined) continue
            if (parsed.event !== undefined) payload = JSON.stringify(parsed.event)
          } catch { /* already a JSON event line */ }
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
          return
        }
        const { done, value } = await reader.read()
        if (done) {
          const tail = buffer.trim()
          if (tail.length > 0) {
            let payload = tail
            try {
              const parsed = JSON.parse(tail) as { event?: unknown }
              if (parsed.event !== undefined) payload = JSON.stringify(parsed.event)
            } catch { /* keep tail */ }
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
          }
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } catch { /* ignore */ }
    },
  })
}

export interface ZedAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<ZedSession>
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
}

export class ZedAdapter extends LlmAdapter {
  private readonly catalogs = new Map<string, ZedCatalogModel[]>()
  private readonly systemId = randomUUID()

  constructor(private readonly options: ZedAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Zed Pro' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `zed: "${provider}"`)
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.catalogs.clear()
    else this.catalogs.delete(account)
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if ([...this.catalogs.values()].flat().length === 0) {
      await this.listOwnModels(provider)
    }
    const cached = [...this.catalogs.values()].flat().find(entry => entry.id === model)
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: cached?.name ?? configured?.name ?? model,
      inputModalities: cached?.supportsImages === false ? ['text'] : ['text', 'image'],
      context: { contextWindow: cached?.contextWindow ?? configured?.contextWindow ?? 200_000 },
      defaultMaxTokens: cached?.maxTokens ?? configured?.maxTokens ?? 16_384,
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
    if (cached !== undefined) {
      return cached.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: model.supportsImages ? ['text', 'image'] as const : ['text'] as const,
        context: { contextWindow: model.contextWindow },
      }))
    }
    try {
      let session = await this.options.tokens.session(account)
      if (session.llmToken === undefined || (session.llmExpiresAt ?? 0) < Date.now() + 60_000) {
        session = await this.options.tokens.session(account, true)
      }
      const response = await proxiedFetch(`${ZED_CLOUD}/models`, {
        headers: {
          authorization: `Bearer ${session.llmToken}`,
          'x-zed-client-supports-x-ai': 'true',
          'x-zed-version': ZED_VERSION,
          ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw await httpLlmError(response, 'zed models')
      const models = parseZedModels(await response.json())
      if (models.length > 0) {
        this.catalogs.set(account, models)
        return models.map(model => ({
          provider,
          id: model.id,
          name: model.name,
          inputModalities: model.supportsImages ? ['text', 'image'] as const : ['text'] as const,
          context: { contextWindow: model.contextWindow },
        }))
      }
    } catch (error) {
      this.options.onWarn?.(`zed catalog failed (${error instanceof Error ? error.message : String(error)})`)
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
      let session = await this.options.tokens.session(account)
      if (session.llmToken === undefined || (session.llmExpiresAt ?? 0) < Date.now() + 60_000) {
        session = await this.options.tokens.session(account, true)
      }
      const images = await resolveImages(options.messages, this.options.resolveAttachments?.())
      if ([...this.catalogs.values()].flat().length === 0) {
        await this.listOwnModels('zed', account)
      }
      const meta = account === undefined
        ? [...this.catalogs.values()].flat().find(entry => entry.id === options.model)
        : this.catalogs.get(account)?.find(entry => entry.id === options.model)
      const { provider: zedProvider, body: providerRequest } = buildZedProviderRequest(options, meta, images)
      let response: Response
      try {
        response = await proxiedFetch(`${ZED_CLOUD}/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.llmToken}`,
            'x-zed-version': ZED_VERSION,
            'x-zed-client-supports-x-ai': 'true',
            'x-zed-client-supports-status-messages': 'true',
            'x-zed-system-id': this.systemId,
            ...attributionHeaders(),
          },
          body: JSON.stringify({
            intent: 'user_prompt',
            provider: zedProvider,
            model: options.model,
            provider_request: providerRequest,
          }),
          signal: watchdog.signal,
        })
      } catch (error) {
        throw mapFetchFailure('zed', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'zed')
      if (response.body === null) throw new LlmError('zed returned an empty stream', 'EMPTY_RESPONSE')
      const sse = ndjsonToSse(response.body)
      const pulse = (): void => { watchdog.pulse() }
      if (zedProvider === 'anthropic') yield* streamAnthropic(sse, pulse)
      else if (zedProvider === 'open_ai') yield* streamResponses(sse, pulse)
      else yield* streamChatCompletions(sse, pulse)
    } finally {
      watchdog.stop()
    }
  }
}

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
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ZedSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import { effortDisplayName, httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning } from './common.js'
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
  reasoning?: {
    efforts: { id: ReasoningEffortId; name: string }[]
    defaultEffort?: ReasoningEffortId
  }
  contextWindow: number
  maxTokens: number
  contextWindowInMaxMode?: number
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

function sessionFromFields(userId: string, token: string, account?: string, cookie?: string): ZedSession {
  return {
    accessToken: token,
    refreshToken: token,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    userId,
    ...account === undefined ? {} : { account },
    ...cookie === undefined ? {} : { cookie },
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
  const cookie = typeof raw.cookie === 'string' && raw.cookie.trim().length > 0 ? raw.cookie.trim()
    : typeof nested.cookie === 'string' && nested.cookie.trim().length > 0 ? nested.cookie.trim() : undefined
  return sessionFromFields(userId, token, typeof email === 'string' ? email : undefined, cookie)
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

const CHROME_COOKIE_EXTRACT_SCRIPT = `
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'network.mojom.NetworkService' } | Select-Object -First 1
if (-not $proc) { exit 0 }
$dump = Join-Path $env:TEMP "dsh-chrome-$($proc.ProcessId).dmp"
Add-Type @"
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
public class ChromeDump {
    [DllImport("dbghelp.dll", SetLastError = true)]
    public static extern bool MiniDumpWriteDump(IntPtr hProcess, uint pId, IntPtr hFile, int dumpType, IntPtr exp, IntPtr usr, IntPtr cb);
    public static bool Dump(int pid, string path) {
        using (var p = Process.GetProcessById(pid)) {
            using (var fs = new FileStream(path, FileMode.Create)) {
                return MiniDumpWriteDump(p.Handle, (uint)pid, fs.SafeFileHandle.DangerousGetHandle(), 2, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            }
        }
    }
}
"@
try {
    if ([ChromeDump]::Dump($proc.ProcessId, $dump) -and (Test-Path $dump)) {
        $bytes = [System.IO.File]::ReadAllBytes($dump)
        $str = [System.Text.Encoding]::ASCII.GetString($bytes)
        $match = [regex]::Match($str, 'zed\\.session=([A-Za-z0-9+/=]+=\\{"sid":"[^"]+"\\})')
        if ($match.Success) {
            Write-Output ("zed.session=" + $match.Groups[1].Value)
        }
    }
} finally {
    Remove-Item $dump -Force -ErrorAction SilentlyContinue
}
`

export async function importZedCookieFromChrome(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const scriptPath = join(tmpdir(), `dsh-zed-cookie-${process.pid}-${Date.now()}.ps1`)
  try {
    await writeFile(scriptPath, CHROME_COOKIE_EXTRACT_SCRIPT, 'utf8')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: 15_000, windowsHide: true, encoding: 'utf8' },
    )
    const text = stdout.trim()
    if (text.startsWith('zed.session=')) return text
  } catch { /* chrome not running or unprivileged */ } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined)
  }
  return undefined
}

export async function importZedDesktop(): Promise<ZedSession> {
  let session = await importZedFromFiles() ?? await importZedFromWindowsVault()
  if (session === undefined) {
    throw new Error(
      'Zed desktop is signed in, but this plugin could not read Windows Credential Manager '
      + '(target zed:url=https://zed.dev). Use the two fields below: userId is the numeric id '
      + 'shown as 用户 in that credential; token is its password. There is no credentials.json in the Zed app.',
    )
  }
  const cookie = await importZedCookieFromChrome()
  if (cookie !== undefined) {
    session = { ...session, cookie }
  }
  return session
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
    const match = line.match(/^\s*(userId|user_id|username|token|accessToken|access_token|cookie|zed\.session)\s*[:=]\s*(.+)\s*$/i)
    if (match !== null) pairs[match[1].toLowerCase()] = match[2].trim()
  }
  const cookieMatch = trimmed.match(/zed\.session=[A-Za-z0-9+/=]+=\{[^\}]+\}/)
  const cookie = pairs.cookie ?? pairs['zed.session'] ?? cookieMatch?.[0]
  if (Object.keys(pairs).length > 0) {
    const userId = pairs.userid ?? pairs.user_id ?? pairs.username ?? ''
    const token = normalizeZedToken(pairs.token ?? pairs.accesstoken ?? pairs.access_token)
    if (userId.length > 0 && token.length > 0) return sessionFromFields(userId, token, undefined, cookie)
  }
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  if (lines.length >= 2) {
    return sessionFromFields(lines[0], normalizeZedToken(lines.slice(1).join('\n')), undefined, cookie)
  }
  const [userId, ...rest] = trimmed.split(/\s+/)
  const token = rest.join(' ')
  if (!userId || !token) {
    throw new Error('Zed paste needs userId + token (two fields, two lines, or JSON).')
  }
  return sessionFromFields(userId, normalizeZedToken(token), undefined, cookie)
}

async function mintLlmToken(session: ZedSession, systemId: string, orgId?: string | null): Promise<{ token: string; expiresAt: number }> {
  const response = await proxiedFetch(`${ZED_CLOUD}/client/llm_tokens`, {
    method: 'POST',
    headers: {
      authorization: authHeader(session),
      'content-type': 'application/json',
      'x-zed-system-id': systemId,
      'x-zed-version': ZED_VERSION,
    },
    body: JSON.stringify({ organization_id: orgId ?? session.organizationId ?? null }),
  })
  if (!response.ok) throw await httpLlmError(response, 'zed llm token')
  const body = await response.json() as { token?: string; expires_at?: string }
  if (typeof body.token !== 'string') throw new Error('zed llm_tokens returned no token')
  return {
    token: body.token,
    expiresAt: typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Date.now() + 50 * 60 * 1000,
  }
}

async function resolveOrganizationId(session: ZedSession): Promise<string | undefined> {
  if (session.organizationId !== undefined && session.organizationId.length > 0) {
    return session.organizationId
  }
  try {
    const response = await proxiedFetch(`${ZED_CLOUD}/client/users/me`, {
      headers: {
        authorization: authHeader(session),
        accept: 'application/json',
        'x-zed-version': ZED_VERSION,
        ...attributionHeaders(),
      },
    })
    if (response.ok) {
      const me = await response.json() as {
        default_organization_id?: string
        organizations?: Array<{ id?: string }>
      }
      return me.default_organization_id ?? me.organizations?.[0]?.id
    }
  } catch { /* leave undefined */ }
  return undefined
}

export async function refreshZed(session: ZedSession): Promise<ZedSession> {
  const organizationId = await resolveOrganizationId(session)
  const minted = await mintLlmToken(session, session.userId, organizationId)
  return {
    ...session,
    ...organizationId !== undefined ? { organizationId } : {},
    llmToken: minted.token,
    llmExpiresAt: minted.expiresAt,
    expiresAt: minted.expiresAt,
  }
}

export function isZedPermanentRefreshError(error: unknown): boolean {
  return error instanceof Error && /401|unauthorized|invalid/i.test(error.message)
}

function planDisplayName(plan: unknown): string | undefined {
  if (typeof plan !== 'string' || plan.length === 0) return undefined
  switch (plan.toLowerCase().trim()) {
    case 'token_based_zed_free':
    case 'zed_free': return 'Zed Free'
    case 'token_based_zed_pro':
    case 'zed_pro': return 'Zed Pro'
    case 'token_based_zed_pro_trial':
    case 'zed_pro_trial': return 'Zed Pro Trial'
    case 'token_based_zed_business':
    case 'zed_business': return 'Zed Business'
    case 'token_based_zed_vip':
    case 'zed_vip': return 'Zed VIP'
    case 'token_based_zed_student':
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
  const limited = limitedCount(row.limit)
  if (limited === undefined) {
    return [{ kind: 'other', scope: 'Edit Predictions', usedPercent: 0, ...resetsAt === undefined ? {} : { resetsAt } }]
  }
  if (limited <= 0) {
    return [{ kind: 'other', scope: 'Edit Predictions', usedPercent: 0, ...resetsAt === undefined ? {} : { resetsAt } }]
  }
  return [{
    kind: 'other',
    scope: 'Edit Predictions',
    usedPercent: usagePercent(used, limited),
    ...resetsAt === undefined ? {} : { resetsAt },
  }]
}

/**
 * The numeric quota behind a Zed `limit` value. Accepts a bare number, an
 * `"unlimited"` marker (returns `undefined` → open-ended, no cap), or an
 * object `{ limited: N }` / `{ Limited: N }` — the live `/client/users/me`
 * uses the LOWERCASE `limited` key, while the earlier port guessed the
 * uppercase `Limited`; supporting both keeps the quota from silently showing
 * zero/absent.
 */
function limitedCount(limitRaw: unknown): number | undefined {
  if (limitRaw === 'unlimited' || (typeof limitRaw === 'object' && limitRaw !== null && 'Unlimited' in (limitRaw as object))) {
    return undefined
  }
  if (typeof limitRaw === 'object' && limitRaw !== null) {
    const record = limitRaw as Record<string, unknown>
    if ('limited' in record || 'Limited' in record) {
      return numberish(record.limited ?? record.Limited)
    }
  }
  return numberish(limitRaw)
}

/** Default included LLM token allowance in USD for plans with bundled credit. */
function planDefaultLimit(plan: unknown): number | undefined {
  if (typeof plan !== 'string') return undefined
  switch (plan.toLowerCase().trim()) {
    case 'token_based_zed_student':
    case 'zed_student':
    case 'token_based_zed_pro':
    case 'zed_pro':
    case 'token_based_zed_pro_trial':
    case 'zed_pro_trial':
    case 'token_based_zed_vip':
    case 'zed_vip':
      return 10
    default:
      return undefined
  }
}

/**
 * The dollar-spend bucket for a Zed cloud payload (the plan root, the nested
 * `usage` object, or an org billing response). Zed Pro / Zed Student bundles
 * $10 of included LLM tokens per monthly subscription period. When the account
 * hasn't spent anything yet or when token spend is reported, this window
 * surfaces the "已用 $x / 总额 $y" dollars display.
 */
function spendWindow(record: Record<string, unknown>, resetsAt?: number, planKey?: string): UsageWindow[] {
  const currentUsage = typeof record.current_usage === 'object' && record.current_usage !== null
    ? record.current_usage as Record<string, unknown>
    : undefined
  const tokenSpend = (typeof record.token_spend === 'object' && record.token_spend !== null
    ? record.token_spend as Record<string, unknown>
    : undefined) ?? (currentUsage && typeof currentUsage.token_spend === 'object' && currentUsage.token_spend !== null
    ? currentUsage.token_spend as Record<string, unknown>
    : undefined)

  const spentCents = pickCents(record, [
    'spent_cents', 'used_cents', 'current_spend_cents', 'token_spend_cents',
    'spend_cents', 'total_spent_cents', 'total_spend_cents', 'cost_cents', 'balance_used_cents',
  ]) ?? (currentUsage ? pickCents(currentUsage, ['token_spend_in_cents', 'spent_cents', 'used_cents', 'cost_cents']) : undefined)
     ?? (tokenSpend ? pickCents(tokenSpend, ['spend_in_cents', 'spent_in_cents', 'spend_cents', 'spent_cents', 'cost_in_cents']) : undefined)

  let spentUsd = spentCents !== undefined ? centsToUsd(spentCents) : pickUsd(record, [
    'spent', 'used', 'current_spend', 'token_spend', 'spend',
    'total_spent', 'total_spend', 'cost', 'balance_used',
  ])

  const includedCents = pickCents(record, [
    'included_cents', 'included_credit_cents', 'credit_cents', 'included_spend_cents', 'limit_cents',
  ])
  let includedUsd = includedCents !== undefined ? centsToUsd(includedCents) : pickUsd(record, [
    'included', 'included_credit', 'credit', 'included_spend', 'credit_limit',
  ])

  const spendingLimitCents = pickCents(record, [
    'spend_limit_cents', 'limit_cents', 'monthly_limit_cents', 'spend_cap_cents', 'credit_limit_cents',
  ]) ?? (tokenSpend ? pickCents(tokenSpend, ['limit_in_cents', 'spend_limit_cents']) : undefined)
  let spendingLimitUsd = spendingLimitCents !== undefined ? centsToUsd(spendingLimitCents) : pickUsd(record, [
    'spend_limit', 'limit', 'monthly_limit', 'spend_cap', 'credit_limit',
  ])

  if (includedUsd === undefined && spendingLimitUsd === undefined) {
    const defaultLimit = planDefaultLimit(planKey)
    if (defaultLimit !== undefined) {
      includedUsd = defaultLimit
    }
  }

  const cap = (includedUsd ?? 0) + (spendingLimitUsd ?? 0)
  if (spentUsd === undefined) {
    if (cap > 0) spentUsd = 0
    else return []
  }

  const base: UsageWindow = {
    kind: 'weekly',
    scope: 'Hosted models',
    usedPercent: cap > 0 ? usagePercent(spentUsd, cap) : 0,
    used: spentUsd,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
  return [{
    ...base,
    ...cap > 0 ? { limit: cap, remaining: Math.max(cap - spentUsd, 0) } : {},
  }]
}

/** First number found across `*_cents` dollar keys, applied to /100. */
function pickCents(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberish(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** First number found across plain (whole-dollar) keys. */
function pickUsd(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberish(record[key])
    if (value !== undefined) return value
  }
  return undefined
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
  const limited = limitedCount(row.limit)
  if (limited === undefined) {
    return [{
      kind: 'weekly',
      scope: 'Hosted models',
      usedPercent: 0,
      used,
      ...resetsAt === undefined ? {} : { resetsAt },
    }]
  }
  if (limited <= 0) return []
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
  const defaultOrg = typeof root.default_organization_id === 'string' ? root.default_organization_id : undefined
  const plansByOrg = typeof root.plans_by_organization === 'object' && root.plans_by_organization !== null
    ? root.plans_by_organization as Record<string, unknown>
    : undefined
  const orgPlan = defaultOrg && plansByOrg ? plansByOrg[defaultOrg] : undefined
  const billingObj = typeof billing === 'object' && billing !== null ? billing as Record<string, unknown> : undefined
  const rawPlan = billingObj?.plan ?? planInfo.plan_v3 ?? planInfo.plan ?? orgPlan
  const plan = planDisplayName(rawPlan)
  const period = typeof planInfo.subscription_period === 'object' && planInfo.subscription_period !== null
    ? planInfo.subscription_period as Record<string, unknown>
    : undefined
  const resetsAt = timestampMs(period?.ended_at ?? period?.ends_at)
  const usage = planInfo.usage ?? root.usage

  const planKey = typeof rawPlan === 'string' ? rawPlan : undefined
  const billingSpend = billingObj !== undefined
    ? spendWindow(billingObj, resetsAt, planKey)
    : []
  const usageSpend = typeof usage === 'object' && usage !== null
    ? spendWindow(usage as Record<string, unknown>, resetsAt, planKey)
    : []
  const planSpend = spendWindow(planInfo, resetsAt, planKey)
  const modelRequests = modelRequestsWindow(usage, resetsAt)

  const hostedWindow = billingSpend[0] ?? usageSpend[0] ?? planSpend[0] ?? modelRequests[0]

  // Surface ONLY the hosted models dollar window when present. This keeps the
  // card clean (single progress bar) and avoids triggering the UI accordion
  // fold that collapses the card whenever windows.length > 1.
  const windows: UsageWindow[] = hostedWindow !== undefined
    ? [hostedWindow]
    : editPredictionWindow(usage, resetsAt)

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
 * Then try dashboard frontend billing route with the browser session cookie,
 * followed by org billing routes for dollar spend (`/org_…/billing/usage`).
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
  let cookie = session.cookie
  if (cookie === undefined) {
    cookie = await importZedCookieFromChrome()
    if (cookie !== undefined) session.cookie = cookie
  }

  if (typeof cookie === 'string' && cookie.length > 0) {
    for (const path of [
      '/frontend/billing/usage',
      ...orgIdsFromMe(me).map(orgId => `/frontend/organizations/${orgId}/billing/usage`),
    ]) {
      try {
        const response = await fetchFn(`${ZED_CLOUD}${path}`, {
          headers: {
            cookie,
            accept: 'application/json',
            'content-type': 'application/json',
            ...attributionHeaders(),
          },
          ...signal === undefined ? {} : { signal },
        })
        if (response.ok) {
          billing = await response.json()
          break
        }
      } catch { /* try next path */ }
    }
  }

  if (billing === undefined) {
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

    let reasoning: { efforts: { id: ReasoningEffortId; name: string }[]; defaultEffort?: ReasoningEffortId } | undefined
    if (record.supports_thinking === true && Array.isArray(record.supported_effort_levels)) {
      const efforts: { id: ReasoningEffortId; name: string }[] = []
      let defaultEffort: ReasoningEffortId | undefined
      for (const level of record.supported_effort_levels) {
        if (typeof level === 'object' && level !== null) {
          const l = level as { name?: string; value?: string; is_default?: boolean }
          if (typeof l.value === 'string' && l.value.length > 0) {
            const effortId = ReasoningEffortId(l.value.toLowerCase())
            const effortName = typeof l.name === 'string' && l.name.length > 0 ? l.name : effortDisplayName(l.value)
            efforts.push({ id: effortId, name: effortName })
            if (l.is_default === true && defaultEffort === undefined) {
              defaultEffort = effortId
            }
          }
        }
      }
      if (efforts.length > 0) {
        reasoning = {
          efforts,
          ...defaultEffort !== undefined ? { defaultEffort } : {},
        }
      }
    }

    const maxTokensInMaxMode = numberField(record, 'max_token_count_in_max_mode')

    models.push({
      id: record.id,
      name: typeof record.display_name === 'string' ? record.display_name
        : typeof record.name === 'string' ? record.name : record.id,
      provider: typeof record.provider === 'string' ? record.provider : 'open_ai',
      supportsImages: record.supports_images === true,
      supportsThinking: record.supports_thinking === true,
      ...reasoning !== undefined ? { reasoning } : {},
      contextWindow: numberField(record, 'max_token_count', 'max_tokens', 'context_window', 'max_input_tokens')
        ?? 200_000,
      maxTokens: numberField(record, 'max_output_tokens', 'max_completion_tokens') ?? 16_384,
      ...maxTokensInMaxMode !== undefined ? { contextWindowInMaxMode: maxTokensInMaxMode } : {},
    })
  }
  return models
}

/**
 * Filter out speculative sandbox escalation parameters when the execution
 * environment already provides unconfined access or has approval disabled.
 * Eager models (like GPT-5 series) proactively populate sandbox_permissions
 * if advertised in the tool schema, which trips DSH's strictly-wider policy.
 */
function sanitizeToolsForModel(tools: readonly ToolSchema[] | undefined, system?: string): readonly ToolSchema[] | undefined {
  if (tools === undefined || tools.length === 0) return tools
  const isFullAccess = typeof system === 'string'
    && (system.includes('danger-full-access') || system.includes('Approval prompts are disabled in this session'))
  if (!isFullAccess) return tools
  return tools.map(tool => {
    if (!tool.parameters || typeof tool.parameters !== 'object') return tool
    const params = tool.parameters as Record<string, unknown>
    const props = params.properties as Record<string, unknown> | undefined
    if (!props || (!('sandbox_permissions' in props) && !('justification' in props))) return tool
    const cleanProps = { ...props }
    delete cleanProps.sandbox_permissions
    delete cleanProps.justification
    const required = Array.isArray(params.required)
      ? params.required.filter(r => r !== 'sandbox_permissions' && r !== 'justification')
      : params.required
    return {
      ...tool,
      parameters: {
        ...params,
        properties: cleanProps,
        ...required !== undefined ? { required } : {},
      },
    }
  })
}

/**
 * Drop speculative sandbox-escalation keys from one tool call's arguments.
 *
 * Used on the DELTA path (see the guard in `stream`): the harness assembles a
 * tool call's arguments by concatenating deltas, so the escalation keys have to
 * be gone from that concatenated JSON — sanitizing the closing `block-end`
 * snapshot has no effect. Returns the original string unchanged when there is
 * nothing to strip or the JSON does not parse (a malformed fragment is left for
 * the harness to report, never silently rewritten).
 * @param args - the concatenated JSON arguments of one tool call.
 * @returns the sanitized JSON, or `args` itself when nothing was removed.
 */
export function stripSandboxArguments(args: string): string {
  if (!args.includes('sandbox_permissions') && !args.includes('justification')) return args
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return args
    if (!('sandbox_permissions' in parsed) && !('justification' in parsed)) return args
    // Escalation is meaningless when the call already runs unconfined, and
    // `justification` is only valid alongside `sandbox_permissions` — dropping
    // one without the other would fail validation instead.
    delete parsed.sandbox_permissions
    delete parsed.justification
    return JSON.stringify(parsed)
  } catch {
    return args
  }
}

/** Build the native provider_request Zed wraps in POST /completions. */
export function buildZedProviderRequest(
  options: GenerateOptions,
  meta: ZedCatalogModel | undefined,
  images: Awaited<ReturnType<typeof resolveImages>>,
): { provider: string; body: Record<string, unknown> } {
  const zedProvider = meta?.provider ?? (options.model.startsWith('claude') ? 'anthropic'
    : options.model.startsWith('gemini') ? 'google' : 'open_ai')
  const cleanTools = sanitizeToolsForModel(options.tools, options.system)
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
        ...cleanTools !== undefined && cleanTools.length > 0 ? { tools: toAnthropicTools(cleanTools) } : {},
        ...meta?.supportsThinking && options.reasoningEffort !== undefined
          ? {
              thinking: { type: 'adaptive', display: 'summarized' },
              output_config: { effort: String(options.reasoningEffort) },
            }
          : {},
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
        ...cleanTools !== undefined && cleanTools.length > 0 ? { tools: toResponsesTools(cleanTools) } : {},
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
      ...cleanTools !== undefined && cleanTools.length > 0 ? { tools: toChatTools(cleanTools) } : {},
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
  defaultEffortOf?: (model: string) => string | undefined
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
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), cached?.reasoning)
    return {
      provider,
      id: model,
      name: cached?.name ?? configured?.name ?? model,
      inputModalities: cached?.supportsImages === false ? ['text'] : ['text', 'image'],
      context: { contextWindow: cached?.contextWindow ?? configured?.contextWindow ?? 200_000 },
      defaultMaxTokens: cached?.maxTokens ?? configured?.maxTokens ?? 16_384,
      ...reasoning !== undefined ? { reasoning } : {},
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
        ...model.reasoning !== undefined ? { reasoning: model.reasoning } : {},
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
          ...model.reasoning !== undefined ? { reasoning: model.reasoning } : {},
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
      const isFullAccess = typeof options.system === 'string'
        && (options.system.includes('danger-full-access') || options.system.includes('Approval prompts are disabled in this session'))
      const stream = zedProvider === 'anthropic' ? streamAnthropic(sse, pulse)
        : zedProvider === 'open_ai' ? streamResponses(sse, pulse)
        : streamChatCompletions(sse, pulse)
      // Speculative-sandbox-argument guard. The harness rebuilds a tool call's
      // arguments by CONCATENATING `tool-call-delta.argumentsDelta` (see
      // dsh-llm's assembler: `partial.toolCallArguments += chunk.argumentsDelta`);
      // the `arguments` string on the closing `block-end` is only a snapshot
      // that the assembler DISCARDS. Rewriting that snapshot therefore cannot
      // influence the call, so an eager model that populates
      // `sandbox_permissions` would still reach dsh-tool-bash and fail with
      // `sandbox escalation to "danger-full-access" is not strictly wider than
      // this call's current "danger-full-access" mode`.
      //
      // Intercepting has to happen on the DELTA path, and a delta stream is
      // fragmentary JSON that cannot be parsed incrementally. So when full
      // access is already granted, buffer each tool call's deltas and emit the
      // sanitized arguments in one piece at block-end.
      const pendingToolArgs = new Map<number, string>()
      for await (const chunk of stream) {
        if (!isFullAccess) {
          yield chunk
          continue
        }
        if (chunk.type === 'tool-call-delta') {
          pendingToolArgs.set(chunk.index, `${pendingToolArgs.get(chunk.index) ?? ''}${chunk.argumentsDelta}`)
          // Held back until block-end so the fragments can be sanitized whole.
          continue
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          const accumulated = pendingToolArgs.get(chunk.index)
          pendingToolArgs.delete(chunk.index)
          const args = accumulated ?? chunk.block.arguments
          const clean = stripSandboxArguments(args)
          if (clean !== args) {
            chunk.block.arguments = clean
            // Emit one consolidated delta carrying the sanitized JSON: the
            // harness's accumulated string must equal block.arguments.
            yield {
              type: 'tool-call-delta',
              index: chunk.index,
              id: chunk.block.id,
              name: chunk.block.name,
              argumentsDelta: clean,
            }
          } else if (accumulated !== undefined && accumulated.length > 0) {
            // Nothing to strip: replay the held deltas verbatim so the
            // accumulated string still matches block.arguments.
            yield {
              type: 'tool-call-delta',
              index: chunk.index,
              id: chunk.block.id,
              name: chunk.block.name,
              argumentsDelta: accumulated,
            }
          }
          yield chunk
          continue
        }
        yield chunk
      }
    } finally {
      watchdog.stop()
    }
  }
}

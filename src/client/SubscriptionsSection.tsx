/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import { callSubscriptionsAuth, SubscriptionsAuthError } from './subscriptions-rpc.js'
import { ModalityIcons, VendorMark } from './ModelIcons.js'
import type { InputModality } from '../providers/modality.js'
import { LAB_BADGES } from './lab-badges.js'
import { normalizeLabLogo } from '../lab-logo.js'
export { callSubscriptionsAuth, SubscriptionsAuthError } from './subscriptions-rpc.js'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/**
 * Model count above which the expanded default-effort list also offers a name
 * filter; below it the list is short enough to scan.
 */
const MODEL_FILTER_THRESHOLD = 8

/**
 * Height cap of the expanded default-effort list, in px. Past it the list
 * scrolls internally so a provider with dozens of models cannot stretch the
 * card (roughly 7 rows, which keeps the next card's header on screen).
 */
const MODEL_LIST_MAX_HEIGHT = 260

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'copilot' | 'agy' | 'commandcode' | 'cline' | 'codebuddy' | 'qoder' | 'trae' | 'zed'

/** One logged-in account as answered by the `status` endpoint. */
export interface AccountStatus {
  key: string
  account?: string
  expiresAt?: number
  plan?: string
  isDefault: boolean
}

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  busy: boolean
  accounts: AccountStatus[]
  detail?: string
}

/** `status` endpoint value: the node half owns this shape. */
interface StatusResponse {
  providers: Record<SubscriptionProvider, ProviderStatus>
}

/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent: number
  resetsAt?: number
  remaining?: number
  limit?: number
  /** Amount already consumed in the same units as {@link limit} (spend-style windows). */
  used?: number
  /**
   * What the amounts are counted in, as the HOST declared it.
   *
   * A window carries this so the renderer never has to infer a unit from the
   * numbers: it used to draw every `used`/`limit` window with a `$`, which put a
   * currency symbol on credit pools and on AGY's percentage. Absent means the
   * host did not say, and the amount then renders as a bare number.
   */
  unit?: 'currency' | 'credits' | 'percent' | 'tokens'
}

/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
  supported: boolean
  windows?: UsageWindow[]
  plan?: string
  remaining?: number
  limit?: number
}

/** One model's default-effort picker state as answered by `modelDefaults`. */
export interface ModelDefaultView {
  id: string
  name: string
  /** Advertised effort levels, in catalog order (empty when the model has no reasoning). */
  efforts: { id: string; name: string }[]
  /** The user-configured default effort, when set. */
  configured?: string
}

/** `modelDefaults` endpoint value: one provider's picker state. */
export interface ModelDefaultsCatalog {
  provider: SubscriptionProvider
  models: ModelDefaultView[]
}

/** One catalog row as answered by the `visibility` endpoint. */
export interface VisibleModelView {
  id: string
  name: string
  visible: boolean
  unread?: boolean
  /** Owning vendor, resolved host-side; absent when the id names none. */
  vendor?: { id: string; label: string; lab?: string }
  /** Accepted input modalities; absent when the route never declared them. */
  inputModalities?: InputModality[]
}

/** The one-click auto-configure report, as answered by `clineAutoConfigure`. */
export interface ClineAutoConfigureView {
  model: string
  ok: boolean
  stage: 'probe' | 'discover' | 'pin' | 'verify' | 'done'
  error: string
  pipeline: string
  channels: string[]
  pinned: string[]
  excluded: string[]
  available: string[]
  rateLimited: string[]
  unusable: string[]
  verified: boolean
  actual: string
  summary: { ok: number; limited: number; bad: number; auth: number; unknown: number }
}

/** One Cline model's upstream-channel pin, as answered by `clinePins`. */export interface ClinePinView {
  model: string
  /** Upstream channels discovered for this model. */
  channels: string[]
  /** Pinned channels, in try order. */
  upstreams: string[]
  /** Channels the user excluded. */
  exclude: string[]
  /** `strict` pins one channel; `preferred` fails over between them. */
  pinMode: 'strict' | 'preferred'
  /** Sort metric, or `''` for none. */
  sort: string
  /** Which gateway pipeline last served this model, when observed. */
  pipeline?: 'direct' | 'planner'
  /** Per-channel availability, for the row dots. */
  verdicts: Record<string, { status: string; note: string; ms: number; checkedAt: number }>
}

/** `proxyGet` endpoint value: the node half owns this shape (no secrets). */
export interface ProxyConfigView {
  enabled: boolean
  url: string
  username?: string
  passwordSet: boolean
  bypass: string[]
  providers: Record<SubscriptionProvider, boolean>
  error?: string
}

/** GeoIP probe result for one network route. */
export interface ProxyGeoProbe {
  ok: boolean
  latencyMs?: number
  ip?: string
  country?: string
  countryCode?: string
  emoji?: string
  error?: string
}

/** Result of probing an individual subscription provider's real endpoint. */
export interface ProviderProbeDetail {
  ok: boolean
  latencyMs: number
  region?: string
  city?: string
  countryCode?: string
  emoji?: string
  viaProxy: boolean
  status?: number
  error?: string
}

/** `proxyTest` endpoint value. */
export interface ProxyTestResult {
  ok: boolean
  viaProxy: boolean
  status?: number
  latencyMs?: number
  error?: string
  /** Probe through the configured/draft proxy. */
  proxyProbe?: ProxyGeoProbe
  /** Probe directly without proxy. */
  directProbe?: ProxyGeoProbe
  /** Per-provider real endpoint probe results. */
  providers?: Partial<Record<SubscriptionProvider, ProviderProbeDetail>>
}

/** Global multi-account call mode as answered by the `poolGet`/`poolSet` endpoints. */
export interface PoolModeView {
  mode: 'priority' | 'quota_aware'
  configured?: 'priority' | 'quota_aware'
  error?: string
}

/** CodeBuddy daily auto check-in state. */
export interface CheckinStatusView {
  lastDate?: string
  lastTime?: number
  lastMessage?: string
  scheduledDate?: string
  scheduledTime?: number
  checkedInToday: boolean
}

/** One provider's share of the token-savings estimate. */
export interface ProviderSavingsView {
  tokens: number
  costUsd: number
  turns: number
}

/** `tokenStats` endpoint value: lifetime subscription token totals and savings. */
export interface TokenSavingsView {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Cache-write tokens; priced only when the published rate table carries a rate for them. */
  cacheWriteTokens?: number
  /** Cache-write tokens that no published rate covers, so they are billed at nothing. */
  unpricedCacheWriteTokens?: number
  savedRmb: number
  savedUsd: number
  /** The host's USD→CNY rate; absent on a Host older than the field. */
  rmbPerUsd?: number
  turns: number
  byProvider: Record<string, ProviderSavingsView>
  updatedAt: number
}

/** The rate to print per-provider RMB figures with, tolerating an older Host. */
const FALLBACK_RMB_PER_USD = 7.23

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
  /** Device-flow providers (copilot): the code the user types at authorizeUrl. */
  userCode?: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>

/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS: readonly { id: SubscriptionProvider; name: string }[] = [  { id: 'codex', name: 'Codex (ChatGPT)' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok (X Premium / SuperGrok)' },
  { id: 'agy', name: 'Antigravity' },
  { id: 'commandcode', name: 'Command Code Go' },
  { id: 'cline', name: 'Cline' },
  { id: 'codebuddy', name: 'CodeBuddy' },
  { id: 'qoder', name: 'Qoder' },
  { id: 'trae', name: 'Trae' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'zed', name: 'Zed Pro' },
]

/** Providers that offer a daily check-in (each keeps its own schedule). */
const CHECKIN_PROVIDERS: ReadonlySet<SubscriptionProvider> = new Set<SubscriptionProvider>(['codebuddy', 'trae', 'qoder'])

/** Dot color for one Cline upstream availability verdict. */
function verdictColor(status: string): string {
  switch (status) {
    case 'ok': return 'var(--dsw-alias-state-success-primary)'
    case 'limited': return 'var(--dsw-alias-state-warn-label)'
    case 'bad':
    case 'auth': return 'var(--dsw-alias-state-danger-primary, #f43f5e)'
    default: return 'var(--dsw-alias-label-caption)'
  }
}

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale<T>(map: Record<string, T>, live: ReadonlySet<string>): Record<string, T> {
  const stale = Object.keys(map).filter(key => !live.has(key))
  if (stale.length === 0) return map
  const next = { ...map }
  for (const key of stale) delete next[key]
  return next
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Compact token count for the savings banner (1.24B / 2196.16M / 12.3K). */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: '0 0 2px 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' },
  savingsCard: {
    position: 'relative', overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14,
    padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
    background: 'linear-gradient(135deg, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)) 0%, var(--dsw-alias-bg-layer-1) 60%)',
  },
  savingsGlow: {
    position: 'absolute', top: -60, right: -40, width: 190, height: 190,
    borderRadius: '50%', pointerEvents: 'none',
    background: 'radial-gradient(circle, var(--dsw-alias-state-success-primary) 0%, transparent 70%)',
    opacity: 0.13,
  },
  savingsHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
    position: 'relative',
  },
  savingsTitleRow: { display: 'flex', alignItems: 'center', gap: 6 },
  savingsTitle: {
    margin: 0, fontWeight: 600, fontSize: 15, lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)',
  },
  savingsSubtitle: {
    margin: '2px 0 0 0', fontSize: 12, lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  savingsHero: {
    display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
    position: 'relative',
  },
  savingsHeroValue: {
    fontSize: 32, fontWeight: 700, lineHeight: '36px', letterSpacing: -0.5,
    color: 'var(--dsw-alias-state-success-primary)', fontVariantNumeric: 'tabular-nums',
  },
  savingsHeroLabel: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  savingsHeroUsd: {
    fontSize: 12, color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums', marginLeft: 4,
  },
  savingsMetrics: { display: 'flex', gap: 24, flexWrap: 'wrap', position: 'relative' },
  savingsMetric: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 70 },
  savingsMetricValue: {
    fontSize: 15, fontWeight: 600, lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
  },
  savingsMetricLabel: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
  savingsProviders: {
    display: 'flex', flexDirection: 'column', gap: 6,
    paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2)',
    position: 'relative',
  },
  savingsProviderRow: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, lineHeight: '18px' },
  savingsProviderName: {
    color: 'var(--dsw-alias-label-secondary)',
    width: 175,
    flexShrink: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  savingsProviderBar: {
    flex: 1, height: 5, borderRadius: 3, overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    border: '1px solid var(--dsw-alias-border-l2)',
  },
  savingsProviderFill: { display: 'block', height: '100%', borderRadius: 3, background: 'var(--dsw-alias-state-success-primary)' },
  savingsProviderValue: {
    color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums',
    width: 140, flexShrink: 0, textAlign: 'right', fontSize: 11,
  },
  emptyHint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardHeaderStatus: {
    fontSize: 12, lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
    marginLeft: 4,
  },
  addSectionCard: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  compactAddRow: {
    display: 'flex', flexDirection: 'column',
    padding: '8px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    gap: 6,
  },
  compactAddMain: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8,
  },
  compactAddLeft: {
    display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
  },
  compactAddName: {
    fontSize: 13, fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap',
  },
  compactAddTag: {
    fontSize: 11, lineHeight: '16px',
    color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap',
  },
  compactAddActions: {
    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
  },
  buttonSmall: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 24, padding: '0 8px', borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 11, lineHeight: '16px',
    cursor: 'pointer',
  },
  globalCard: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  globalRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  },
  globalRowLeft: {
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1,
  },
  globalRowHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
  },
  globalRowTitle: {
    fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)',
  },
  globalRowDesc: {
    margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  globalRowRight: {
    flexShrink: 0, display: 'flex', alignItems: 'center',
  },
  globalSelect: {
    height: 30, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '0 8px',
    font: 'inherit', fontSize: 12, lineHeight: '18px', cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    color: 'var(--dsw-alias-label-primary)',
  },
  globalDivider: {
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    opacity: 0.6,
    margin: '2px 0',
  },
  overrideTag: {
    fontSize: 11, lineHeight: '16px', fontWeight: 500,
    color: 'var(--dsw-alias-state-warn-label)',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6, padding: '0 6px',
  },
  providersHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginTop: 6, marginBottom: -2, paddingLeft: 2,
  },
  providersTitle: {
    fontSize: 13, fontWeight: 600, lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary)', letterSpacing: 0.2,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  button: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 28, padding: '0 10px', borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  buttonDisabled: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 28, padding: '0 10px', borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'default', opacity: 0.75,
  },
  usage: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  usageHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  usageTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  usagePlan: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  usageRefresh: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 22, padding: '0 8px', borderRadius: 11, marginLeft: 'auto',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usageRow: { display: 'flex', flexDirection: 'column', gap: 3 },
  usageMeta: {
    display: 'flex', justifyContent: 'space-between', gap: 8,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  usageDetailsToggle: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 4,
    height: 22, padding: 0, border: 'none', background: 'transparent',
    font: 'inherit', fontSize: 12, lineHeight: '18px', textAlign: 'left',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  },
  unreadDot: {
    width: 6, height: 6, borderRadius: '50%',
    background: 'var(--dsw-alias-state-danger-primary, #f43f5e)',
    display: 'inline-block', flexShrink: 0,
    marginLeft: 6, marginRight: 2,
    opacity: 0.85,
  },
  unreadModelDot: {
    width: 5, height: 5, borderRadius: '50%',
    background: 'var(--dsw-alias-state-danger-primary, #f43f5e)',
    display: 'inline-block', flexShrink: 0,
    marginLeft: 6,
    verticalAlign: 'middle',
    opacity: 0.85,
  },
  // ---- Cline upstream pins ----
  pinList: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: MODEL_LIST_MAX_HEIGHT, overflowY: 'auto' },
  pinRow: {
    display: 'flex', flexDirection: 'column', gap: 5,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 8px',
  },
  pinHeader: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  pinPipeline: {
    fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 4,
    color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  pinChips: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  pinChipGroup: { display: 'inline-flex', alignItems: 'center' },
  pinChip: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 4,
    height: 20, padding: '0 6px',
    borderTopLeftRadius: 10, borderBottomLeftRadius: 10,
    borderTopRightRadius: 0, borderBottomRightRadius: 0,
    border: '1px solid var(--dsw-alias-border-l2)', borderRight: 'none',
    background: 'transparent', font: 'inherit', fontSize: 11, lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  },
  pinChipActive: {
    borderColor: 'var(--dsw-alias-state-business-primary)',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  pinChipExcluded: { textDecoration: 'line-through', opacity: 0.55 },
  pinOrder: {
    fontSize: 9, lineHeight: '12px', fontWeight: 600,
    color: 'var(--dsw-alias-state-business-primary)', fontVariantNumeric: 'tabular-nums',
  },
  pinDot: { width: 5, height: 5, borderRadius: '50%', flexShrink: 0 },
  pinChipLabel: { maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pinExclude: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 20, width: 20,
    borderTopRightRadius: 10, borderBottomRightRadius: 10,
    borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent', font: 'inherit', fontSize: 11, lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
  },
  pinExcludeActive: {
    color: 'var(--dsw-alias-state-danger-primary, #f43f5e)',
    borderColor: 'var(--dsw-alias-state-danger-primary, #f43f5e)',
  },
  pinControls: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  visibilityGrid: {
    display: 'flex', flexWrap: 'wrap', gap: '6px 12px',
    maxHeight: MODEL_LIST_MAX_HEIGHT, overflowY: 'auto', paddingRight: 2,
  },
  visibilityItem: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    flex: '1 1 180px', minWidth: 160, maxWidth: '100%',
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
  },
  /**
   * Pushes the capability icons and the score to the row's trailing edge, so a
   * grid of rows reads as two aligned columns rather than ragged text. It is
   * `flex: 1` and `minWidth: 0` so the NAME truncates instead of the icons
   * wrapping when a row is narrow.
   */
  visibilitySpacer: { flex: '1 1 auto', minWidth: 8 },
  accountRow: {
    display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '8px 10px', marginTop: 4,
  },
  accountHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  accountName: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', userSelect: 'all' },
  starButton: {
    border: 'none', background: 'transparent', padding: 0,
    font: 'inherit', fontSize: 14, lineHeight: '20px', cursor: 'pointer',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  usageTrack: {
    height: 6, borderRadius: 3, overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  usageFill: { height: '100%', borderRadius: 3 },
  defaultEffort: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  /** The always-visible disclosure header: title, summary, chevron. */
  defaultEffortToggle: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: 0, border: 'none', background: 'transparent',
    font: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
  defaultEffortChevron: {
    marginLeft: 'auto', flexShrink: 0, fontSize: 10, lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  /** Body of the expanded disclosure: bounded height so a long catalog scrolls. */
  defaultEffortList: {
    display: 'flex', flexDirection: 'column', gap: 6,
    maxHeight: MODEL_LIST_MAX_HEIGHT, overflowY: 'auto', paddingRight: 2,
  },
  defaultEffortRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  defaultEffortName: {
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  defaultEffortSaving: {
    marginLeft: 'auto', flexShrink: 0,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  defaultEffortSelect: {
    maxWidth: 220, flexShrink: 0, height: 28, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 8px', font: 'inherit', fontSize: 12, lineHeight: '18px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  defaultEffortFilter: {
    height: 28, width: '100%', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 8px', font: 'inherit', fontSize: 12, lineHeight: '18px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  manual: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  manualBox: {
    marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  manualRow: { display: 'flex', gap: 8, marginTop: 6 },
  manualInput: {
    flex: 1, height: 32, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  deviceCode: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  deviceCodeText: {
    fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
  },
  proxyField: { display: 'flex', flexDirection: 'column', gap: 4 },
  proxyLabel: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  proxyInput: {
    height: 32, width: '100%', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  proxyHint: {
    margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  proxyCheck: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
  },
  proxyProviderItem: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '2px 0', minHeight: 26, gap: 12,
  },
  probeBadgeProxy: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 11, lineHeight: '16px', fontWeight: 500,
    padding: '1px 8px', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-state-success-primary)',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  probeBadgeDirect: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 11, lineHeight: '16px', fontWeight: 500,
    padding: '1px 8px', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  probeBadgeError: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 11, lineHeight: '16px', fontWeight: 500,
    padding: '1px 8px', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    color: 'var(--dsw-alias-state-error-primary)',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  probeBadgeWarn: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 11, lineHeight: '16px', fontWeight: 500,
    padding: '1px 8px', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    border: '1px solid var(--dsw-alias-state-warn-label)',
    color: 'var(--dsw-alias-state-warn-label)',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  probeBadgeLoading: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 11, lineHeight: '16px',
    padding: '1px 8px', borderRadius: 6,
    color: 'var(--dsw-alias-label-tertiary)',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  proxyMessage: { margin: 0, fontSize: 12, lineHeight: '18px' },
  proxyActions: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 },
  modalOverlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    background: 'rgba(0, 0, 0, 0.45)',
  },
  modal: {
    width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
    padding: '16px 18px', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  modalTitle: { fontWeight: 600, fontSize: 15, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
}

/** Status dot color for one provider state. */
function dotColor(status: ProviderStatus | undefined): string {
  if (status?.busy === true) return 'var(--dsw-alias-state-warn-label)'
  if ((status?.accounts.length ?? 0) > 0) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/**
 * Whether a provider has at least one connected account. Multi-account made
 * "logged in" a property of the account list rather than a flag, so every
 * logged-in test goes through this one predicate.
 * @param status - the provider's last reported state, possibly absent.
 * @returns true when the provider serves at least one account.
 */
function hasAccount(status: ProviderStatus | undefined): boolean {
  return (status?.accounts.length ?? 0) > 0
}

/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t: SubscriptionsSectionInjected['t'], status: ProviderStatus | undefined): string {
  if (status === undefined) return t('checking')
  if (status.busy) return t('loginInProgress')
  if (status.accounts.length > 0) return t('loggedInCount', { count: status.accounts.length })
  return t('notLoggedIn')
}

/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour window" or "Weekly · Opus".
 */
function usageWindowLabel(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  if (window.scope === 'monthly') return t('usageMonthly')
  if (window.scope === 'on-demand') return t('usageOnDemand')
  if (window.scope === 'credits') return t('usageCredits')
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

function formatAmount(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}

/**
 * Format an amount in the units its window declares.
 *
 * The unit comes from the WINDOW, never from the shape of the numbers: this used
 * to draw any window carrying `used` and `limit` with a `$`, which labelled
 * Qoder's 300 credits as three hundred dollars. A window that declares no unit
 * prints a bare number — a missing symbol is honest, a wrong one is not.
 * @param value - the amount.
 * @param unit - what the window is counted in.
 * @returns the formatted amount.
 */
function formatUnitAmount(value: number, unit: UsageWindow['unit']): string {
  if (unit === 'currency') return `$${String(Math.round(value * 100) / 100)}`
  return formatAmount(value)
}

/** The label a unit needs where the number alone would not say what it is. */
function unitLabel(unit: UsageWindow['unit']): string {
  switch (unit) {
    case 'credits': return 'credits'
    case 'tokens': return 'tokens'
    case 'percent': return '%'
    default: return ''
  }
}

function usageAmountText(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  const percent = `${String(Math.round(Math.min(100, Math.max(0, window.usedPercent))))}%`
  const label = unitLabel(window.unit)
  const suffix = label === '' ? '' : ` ${label}`
  // Spend-style windows (Zed's "Token Spend", CommandCode's weekly cap, Qoder's
  // credit pool) show "used / total" in whatever the window is counted in.
  if (window.used !== undefined && window.limit !== undefined) {
    return `${t('usageSpentOf', {
      used: formatUnitAmount(window.used, window.unit),
      limit: formatUnitAmount(window.limit, window.unit) + suffix,
    })} · ${percent}`
  }
  if (window.remaining !== undefined && window.limit !== undefined) {
    return `${t('usageRemaining', {
      remaining: formatUnitAmount(window.remaining, window.unit),
      limit: formatUnitAmount(window.limit, window.unit) + suffix,
    })} · ${percent}`
  }
  if (window.remaining !== undefined) {
    return `${t('usageRemainingOnly', {
      remaining: formatUnitAmount(window.remaining, window.unit) + suffix,
    })} · ${percent}`
  }
  return percent
}

/** Bar fill color: success normally, warn from 80%, error from 95%. */
function usageBarColor(usedPercent: number): string {
  if (usedPercent >= 95) return 'var(--dsw-alias-state-error-primary)'
  if (usedPercent >= 80) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-alias-state-success-primary)'
}

/** One-line status text of the proxy config card. */
function proxyStatusText(
  t: SubscriptionsSectionInjected['t'],
  proxy: ProxyConfigView | undefined,
  loadError: string | undefined,
): string {
  if (loadError !== undefined) return t('proxyLoadFailed', { message: loadError })
  if (proxy === undefined) return t('proxyLoading')
  if (proxy.error !== undefined) return t('proxyStatusError', { message: proxy.error })
  if (proxy.enabled) return t('proxyStatusEnabled', { url: proxy.url })
  return t('proxyStatusNone')
}

/** Feedback-line color of the proxy dialog. */
function messageColor(tone: 'success' | 'error'): string {
  return tone === 'error'
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-state-success-primary)'
}

/** What one provider's collapsible default-effort section renders. */
export interface ModelDefaultsView {
  /** Models with reasoning levels, after the name filter — one row each. */
  shown: ModelDefaultView[]
  /** Models with reasoning levels before filtering (the header total). */
  total: number
  /** How many of those carry a user override (the header count). */
  overridden: number
  /** Models without reasoning levels: one count line, never a row each. */
  withoutEfforts: number
  /** Whether the list is long enough to deserve a filter box. */
  showFilter: boolean
}

/**
 * Derive one provider's default-effort section from its catalog and filter.
 * Pure so the collapsed-header counts and the filter stay testable without a
 * DOM: rows come only from models that advertise levels, the count of the rest
 * rides as one line, and the filter matches display name or model id.
 * @param models - the provider's catalog models, or undefined while loading.
 * @param filter - the raw filter input (trimmed and lowercased here).
 * @returns the section's rows and header counts.
 */
export function deriveModelDefaultsView(
  models: readonly ModelDefaultView[] | undefined,
  filter: string,
): ModelDefaultsView {
  const all = models ?? []
  const withEfforts = all.filter(model => model.efforts.length > 0)
  const query = filter.trim().toLowerCase()
  const shown = query === ''
    ? withEfforts
    : withEfforts.filter(model => model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query))
  return {
    shown,
    total: withEfforts.length,
    overridden: withEfforts.filter(model => model.configured !== undefined).length,
    withoutEfforts: all.length - withEfforts.length,
    showFilter: withEfforts.length > MODEL_FILTER_THRESHOLD,
  }
}

/** Inputs of the default-effort fetch decision (see {@link shouldFetchModelDefaults}). */
export interface ModelDefaultsFetchInput {
  /** Providers that currently have at least one account. */
  loggedIn: readonly SubscriptionProvider[]
  /** Providers whose disclosure is open. */
  open: readonly SubscriptionProvider[]
  /** The account signature the last completed fetch was answered for. */
  loadedFor: string | undefined
  /** The account signature of the current status snapshot. */
  signature: string
  /** Whether the last attempt failed (a failure latches until Retry). */
  failed: boolean
}

/**
 * Whether the default-effort catalog needs (re)fetching.
 *
 * Fetching is gated on an *attempt* signature rather than on the payload
 * being empty: an empty answer is a legitimate result (a narrowed
 * `config.providers`, or a catalog that is momentarily unavailable), and
 * treating it as "not loaded yet" re-ran this effect forever. The signature
 * also covers the accounts, so logging a second provider in refetches
 * instead of leaving that card on the previous answer.
 * @param input - the decision inputs.
 * @returns true when the caller should start a fetch.
 */
export function shouldFetchModelDefaults(input: ModelDefaultsFetchInput): boolean {
  if (input.failed) return false
  if (input.loggedIn.length === 0) return false
  // Only an open disclosure pays for the per-model live resolve.
  if (!input.open.some(provider => input.loggedIn.includes(provider))) return false
  return input.loadedFor !== input.signature
}

/**
 * Stable signature of the accounts a catalog answer depends on. A change
 * means a previous answer is stale (an account arrived or left), so the next
 * open disclosure refetches.
 * @param statuses - the per-provider status snapshot.
 * @returns a signature string, stable across renders with equal accounts.
 */
export function modelDefaultsSignature(
  statuses: Partial<Record<SubscriptionProvider, ProviderStatus>>,
): string {
  return PROVIDERS
    .map(({ id }) => `${id}:${(statuses[id]?.accounts ?? []).map(account => account.key).sort().join(',')}`)
    .join('|')
}

/**
 * The lab logos the rows draw from: the host's live answer over the vendored set.
 *
 * Called with `undefined` when the `labBadges` call failed or was never made, so
 * the vendored snapshot is exactly what an unavailable host degrades to. A lab
 * neither source has draws NOTHING — the point of the whole arrangement, and the
 * reason there is no drawing to fall back to.
 *
 * The host validates what it sends, but this re-checks anyway: the markup is
 * injected into the page as HTML, so a blob that is not a complete inert `<svg>`
 * must never reach the DOM. Normalizing here also means the rows do not have to
 * care whether a mark came from this bundle or from the host.
 * @param remote - the host's `labBadges` answer, when it has been fetched.
 * @returns the logos to render from.
 */
export function mergeLabBadges(remote: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const merged: Record<string, string> = { ...LAB_BADGES }
  for (const [lab, markup] of Object.entries(remote ?? {})) {
    const normalized = normalizeLabLogo(markup)
    if (normalized !== undefined) merged[lab] = normalized
  }
  return merged
}

/**
 * The labs the listed models are attributed to that this build has no vendored
 * logo for, sorted and deduplicated.
 *
 * This is what the `labBadges` call asks the host for: a lab the bundle already
 * carries needs no request, and a lab it does not carry is exactly the case the
 * live fetch exists for — including a lab models.dev has no logo for today,
 * whose mark appears by itself if models.dev publishes one.
 * @param models - the visibility rows loaded so far, by provider.
 * @returns the lab slugs to resolve, sorted for a stable signature.
 */
export function labsNeedingBadges(
  models: Partial<Record<SubscriptionProvider, VisibleModelView[]>>,
): string[] {
  const labs = new Set<string>()
  for (const list of Object.values(models)) {
    for (const model of list ?? []) {
      const lab = model.vendor?.lab
      if (lab === undefined || LAB_BADGES[lab] !== undefined) continue
      labs.add(lab)
    }
  }
  return [...labs].sort()
}

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [statuses, setStatuses] = useState<Partial<Record<SubscriptionProvider, ProviderStatus>>>({})
  const [errors, setErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [manualDrafts, setManualDrafts] = useState<Record<SubscriptionProvider, string>>({
    codex: '', claude: '', grok: '', copilot: '', agy: '', commandcode: '', cline: '', codebuddy: '', qoder: '', trae: '', zed: '',
  })
  /** Pending device-flow codes (copilot), shown while the attempt polls. */
  const [deviceCodes, setDeviceCodes] = useState<Partial<Record<SubscriptionProvider, { userCode: string; verificationUrl: string }>>>({})
  const [copiedCode, setCopiedCode] = useState<SubscriptionProvider | undefined>(undefined)
  /** Usage snapshots keyed `${provider}:${accountKey}` — every account tracks its own windows. */
  const [usages, setUsages] = useState<Record<string, ProviderUsage>>({})
  const [usageErrors, setUsageErrors] = useState<Record<string, string>>({})
  const [usageLoading, setUsageLoading] = useState<Record<string, boolean>>({})
  const [usageDetailsOpen, setUsageDetailsOpen] = useState<Record<string, boolean>>({})
  const [zedUserId, setZedUserId] = useState('')
  const [zedToken, setZedToken] = useState('')
  const [manualOpen, setManualOpen] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())
  /** Accounts with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
  const usageInflightRef = useRef(new Set<string>())
  /** Proxy config as last answered by `proxyGet`/`proxySet`. */
  const [proxy, setProxy] = useState<ProxyConfigView | undefined>(undefined)
  const [proxyLoadError, setProxyLoadError] = useState<string | undefined>(undefined)
  /** Proxy dialog state (draft fields; the password never pre-fills). */
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [proxyClearPassword, setProxyClearPassword] = useState(false)
  const [proxyBypass, setProxyBypass] = useState('')
  const [proxyProviders, setProxyProviders] = useState<Record<SubscriptionProvider, boolean>>({
    codex: true, claude: true, grok: true, copilot: true,
    agy: true, commandcode: true, cline: true, codebuddy: true, qoder: true, trae: true, zed: true,
  })
  const [proxySaving, setProxySaving] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyMessage, setProxyMessage] = useState<{ tone: 'success' | 'error'; text: string } | undefined>(undefined)
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | undefined>(undefined)
  /** Global multi-account call mode as answered by `poolGet`/`poolSet`. */
  const [poolMode, setPoolMode] = useState<PoolModeView | undefined>(undefined)
  const [poolModeError, setPoolModeError] = useState<string | undefined>(undefined)
  const [poolModeSaving, setPoolModeSaving] = useState(false)
  /** Lifetime subscription token totals + estimated pay-as-you-go savings. */
  const [savings, setSavings] = useState<TokenSavingsView | undefined>(undefined)
  const [savingsLoading, setSavingsLoading] = useState(false)
  /** Provider whose model catalog is being refreshed (undefined = idle). */
  const [refreshingModels, setRefreshingModels] = useState<string | undefined>(undefined)
  /** Per-model default-effort picker state as answered by `modelDefaults`. */
  const [modelDefaults, setModelDefaults] = useState<Partial<Record<SubscriptionProvider, ModelDefaultsCatalog>>>({})
  const [modelDefaultsLoading, setModelDefaultsLoading] = useState(false)
  const [modelDefaultsLoadError, setModelDefaultsLoadError] = useState<string | undefined>(undefined)
  /** One set in flight: the `${provider}/${model}` key. */
  const [modelDefaultsSaving, setModelDefaultsSaving] = useState<string | undefined>(undefined)
  /** Per-model save failures, keyed `${provider}/${model}`. */
  const [modelDefaultsSaveErrors, setModelDefaultsSaveErrors] = useState<Record<string, string>>({})
  /** Providers whose default-effort disclosure is open (collapsed by default). */
  const [modelDefaultsOpen, setModelDefaultsOpen] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  /** Per-provider name filter of the expanded list. */
  const [modelDefaultsFilters, setModelDefaultsFilters] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  /** Account signature the last completed catalog fetch was answered for. */
  const [modelDefaultsLoadedFor, setModelDefaultsLoadedFor] = useState<string | undefined>(undefined)
  /** Optimistic in-flight selections, keyed `${provider}/${model}` ('' = follow provider). */
  const [modelDefaultsPending, setModelDefaultsPending] = useState<Record<string, string>>({})
  /** Guard the catalog effect against concurrent loads. */
  const modelDefaultsInflightRef = useRef(false)
  /** Providers whose visible-models disclosure is open. */
  const [visibilityOpen, setVisibilityOpen] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  const [visibilityModels, setVisibilityModels] = useState<Partial<Record<SubscriptionProvider, VisibleModelView[]>>>({})
  /**
   * Why a route's roster is empty, when it is empty because the read failed.
   * Kept apart from `visibilityError`: a transport error and an upstream read
   * that returned no roster are different facts, and the second is the one that
   * used to be hidden behind a substituted model list.
   */
  const [visibilityNotFetched, setVisibilityNotFetched] = useState<
    Partial<Record<SubscriptionProvider, { what: string; detail: string } | undefined>>
  >({})
  const [visibilityLoading, setVisibilityLoading] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  const [visibilityError, setVisibilityError] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const visibilityInflightRef = useRef(new Set<SubscriptionProvider>())
  /**
   * The lab logos the rows draw from. Seeded with the vendored set, so a host
   * that cannot answer still renders every mark this build ships — and nothing
   * at all for a lab it does not.
   */
  const [labBadges, setLabBadges] = useState<Readonly<Record<string, string>>>(LAB_BADGES)
  /** The lab signature the last completed `labBadges` call was answered for. */
  const labBadgesLoadedForRef = useRef<string | undefined>(undefined)
  /**
   * Cline's per-model upstream pins. Cline is the only route with a channel
   * layer, so this state is provider-specific rather than part of the shared
   * visibility model.
   */
  const [clinePinsOpen, setClinePinsOpen] = useState(false)
  const [clinePins, setClinePins] = useState<ClinePinView[] | undefined>(undefined)
  const [clinePinsLoading, setClinePinsLoading] = useState(false)
  const [clinePinsError, setClinePinsError] = useState<string | undefined>(undefined)
  /** Model whose channels are being probed (undefined = idle). */
  const [clineProbing, setClineProbing] = useState<string | undefined>(undefined)
  /** Model whose channels are being validated (undefined = idle). */
  const [clineValidating, setClineValidating] = useState<string | undefined>(undefined)
  /** The model whose one-click auto-configure is running, if any. */
  const [clineAutoRunning, setClineAutoRunning] = useState<string | undefined>(undefined)
  /** The last auto-configure report per model, shown until the next run. */
  const [clineAutoResults, setClineAutoResults] = useState<Record<string, ClineAutoConfigureView>>({})

  const setProviderError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrors((prev) => {
      const next = { ...prev }
      if (message === undefined) delete next[provider]
      else next[provider] = message
      return next
    })
  }, [])

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    let response: StatusResponse
    try {
      response = await callSubscriptionsAuth<StatusResponse>(rpc, 'status', {})
    } catch {
      // A failed poll must not kill the page; busy providers keep polling and
      // the action paths report their own errors.
      return
    }
    if (!mountedRef.current) return
    setStatuses(response.providers)
    for (const { id } of PROVIDERS) {
      const status = response.providers[id]
      if (status.accounts.length > 0 || !status.busy) {
        stopPolling(id)
        // The attempt settled (success, timeout, or cancel): drop the code card.
        setDeviceCodes((prev) => {
          if (prev[id] === undefined) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    }
  }, [rpc, stopPolling])

  const startPolling = useCallback((provider: SubscriptionProvider): void => {
    if (pollersRef.current.has(provider)) return
    pollersRef.current.set(provider, setInterval(() => { void refresh() }, POLL_INTERVAL_MS))
  }, [refresh])

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  const loadUsage = useCallback(async (provider: SubscriptionProvider, account: string, force = false): Promise<void> => {
    const key = `${provider}:${account}`
    if (rpc === undefined || usageInflightRef.current.has(key)) return
    usageInflightRef.current.add(key)
    setUsageLoading(prev => ({ ...prev, [key]: true }))
    try {
      const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account, ...force ? { force: true } : {} })
      if (!mountedRef.current) return
      setUsages(prev => ({ ...prev, [key]: usage }))
      setUsageErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    } catch (error) {
      if (mountedRef.current) setUsageErrors(prev => ({ ...prev, [key]: messageOf(error) }))
    } finally {
      usageInflightRef.current.delete(key)
      if (mountedRef.current) setUsageLoading(prev => ({ ...prev, [key]: false }))
    }
  }, [rpc])

  // Fetch usage once an account is logged in; drop the snapshots of accounts
  // that vanished so a re-login refetches. A failed lookup does not auto-retry
  // — the per-account Refresh button is the retry path.
  useEffect(() => {
    const live = new Set<string>()
    for (const { id } of PROVIDERS) {
      for (const account of statuses[id]?.accounts ?? []) {
        const key = `${id}:${account.key}`
        live.add(key)
        if (usages[key] === undefined && usageErrors[key] === undefined) void loadUsage(id, account.key)
      }
    }
    setUsages(prev => dropStale(prev, live))
    setUsageErrors(prev => dropStale(prev, live))
  }, [statuses, usages, usageErrors, loadUsage])

  const loadModelDefaultsData = useCallback(async (signature: string): Promise<void> => {
    if (rpc === undefined || modelDefaultsInflightRef.current) return
    modelDefaultsInflightRef.current = true
    setModelDefaultsLoading(true)
    try {
      const catalog = await callSubscriptionsAuth<ModelDefaultsCatalog[]>(rpc, 'modelDefaults', {})
      if (!mountedRef.current) return
      const next: Partial<Record<SubscriptionProvider, ModelDefaultsCatalog>> = {}
      for (const entry of catalog) next[entry.provider] = entry
      setModelDefaults(next)
      setModelDefaultsLoadError(undefined)
      // Latch the answered signature, empty answer included: an empty catalog
      // is a result, not a missing load, and re-deriving "loaded" from the
      // payload re-triggered this fetch on every render.
      setModelDefaultsLoadedFor(signature)
      // The shown state is now authoritative; stale per-row failures would
      // otherwise linger next to rows that are correct again.
      setModelDefaultsSaveErrors({})
    } catch (error) {
      if (mountedRef.current) setModelDefaultsLoadError(messageOf(error))
    } finally {
      modelDefaultsInflightRef.current = false
      if (mountedRef.current) setModelDefaultsLoading(false)
    }
  }, [rpc])

  // Fetch the default-effort catalogs only once a card's list is expanded: the
  // node half resolves live model info per model, so a collapsed page must not
  // pay for it. One fetch covers every logged-in provider (the node half
  // answers them together), and the levels follow the picker's catalog union
  // across that provider's accounts. The account signature drives refetching,
  // so connecting another provider or account does not leave an open card on
  // the previous answer. Everything resets once the last account logs out.
  useEffect(() => {
    const loggedIn = PROVIDERS.filter(({ id }) => hasAccount(statuses[id])).map(({ id }) => id)
    const signature = modelDefaultsSignature(statuses)
    if (loggedIn.length > 0) {
      const open = PROVIDERS.filter(({ id }) => modelDefaultsOpen[id] === true).map(({ id }) => id)
      if (shouldFetchModelDefaults({
        loggedIn,
        open,
        loadedFor: modelDefaultsLoadedFor,
        signature,
        failed: modelDefaultsLoadError !== undefined,
      })) {
        void loadModelDefaultsData(signature)
      }
    } else if (modelDefaultsLoadedFor !== undefined
      || Object.keys(modelDefaults).length > 0
      || Object.keys(modelDefaultsOpen).length > 0) {
      setModelDefaults({})
      setModelDefaultsSaveErrors({})
      setModelDefaultsLoadError(undefined)
      setModelDefaultsLoadedFor(undefined)
      setModelDefaultsLoading(false)
      setModelDefaultsOpen({})
      setModelDefaultsFilters({})
    }
  }, [
    statuses,
    modelDefaults,
    modelDefaultsOpen,
    modelDefaultsLoadError,
    modelDefaultsLoadedFor,
    loadModelDefaultsData,
  ])

  /** Open or close one provider's default-effort disclosure. */
  const toggleModelDefaults = useCallback((provider: SubscriptionProvider): void => {
    setModelDefaultsOpen(prev => ({ ...prev, [provider]: prev[provider] !== true }))
  }, [])

  const setModelDefault = useCallback(async (provider: SubscriptionProvider, model: string, effort: string | undefined): Promise<void> => {
    if (rpc === undefined) return
    const key = `${provider}/${model}`
    setModelDefaultsSaving(key)
    // Hold the picked level locally for the duration of the save: the select
    // is controlled by server state, which only updates after the round trip,
    // so without this the row visibly snaps back to "Follow provider" (greyed
    // out) mid-save and reads as a rejected change.
    setModelDefaultsPending(prev => ({ ...prev, [key]: effort ?? '' }))
    setModelDefaultsSaveErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setModelDefault', {
        provider,
        model,
        ...(effort === undefined ? {} : { effort }),
      })
      if (!mountedRef.current) return
      setModelDefaults((prev) => {
        const section = prev[provider]
        if (section === undefined) return prev
        return {
          ...prev,
          [provider]: {
            ...section,
            models: section.models.map((entry) => {
              if (entry.id !== model) return entry
              if (effort !== undefined) return { ...entry, configured: effort }
              // Cleared: drop the key rather than keep the stale level, or the
              // select would snap back and the header would keep counting it.
              const { configured: _cleared, ...rest } = entry
              return rest
            }),
          },
        }
      })
    } catch (error) {
      if (mountedRef.current) setModelDefaultsSaveErrors((prev) => ({ ...prev, [key]: messageOf(error) }))
    } finally {
      if (mountedRef.current) {
        setModelDefaultsSaving(current => current === key ? undefined : current)
        // Drop the optimistic value: on success the server state now carries
        // it, on failure the row must fall back to the real stored level
        // rather than keep showing a change that did not land.
        setModelDefaultsPending((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    }
  }, [rpc])

  const loadVisibility = useCallback(async (provider: SubscriptionProvider, force = false): Promise<void> => {
    if (rpc === undefined) return
    if (visibilityInflightRef.current.has(provider) && !force) return
    visibilityInflightRef.current.add(provider)
    setVisibilityLoading(prev => ({ ...prev, [provider]: true }))
    try {
      const response = await callSubscriptionsAuth<{
        models: VisibleModelView[]
        notFetched?: { what: string; detail: string }
      }>(rpc, 'visibility', { provider })
      if (!mountedRef.current) return
      setVisibilityModels(prev => ({ ...prev, [provider]: response.models }))
      setVisibilityNotFetched(prev => ({ ...prev, [provider]: response.notFetched }))
      setVisibilityError(prev => {
        const next = { ...prev }
        delete next[provider]
        return next
      })
    } catch (error) {
      if (mountedRef.current) setVisibilityError(prev => ({ ...prev, [provider]: messageOf(error) }))
    } finally {
      visibilityInflightRef.current.delete(provider)
      if (mountedRef.current) setVisibilityLoading(prev => ({ ...prev, [provider]: false }))
    }
  }, [rpc])

  const toggleVisibility = useCallback((provider: SubscriptionProvider): void => {
    setVisibilityOpen(prev => {
      const nextOpen = prev[provider] !== true
      if (nextOpen) {
        void loadVisibility(provider)
        if (rpc !== undefined && visibilityModels[provider]?.some(m => m.unread)) {
          void callSubscriptionsAuth(rpc, 'markModelsRead', { provider }).catch(() => {})
        }
      } else {
        setVisibilityModels(cur => ({
          ...cur,
          [provider]: (cur[provider] ?? []).map(m => m.unread ? { ...m, unread: false } : m),
        }))
      }
      return { ...prev, [provider]: nextOpen }
    })
  }, [loadVisibility, rpc, visibilityModels])

  // Preload visibility in background for connected providers so summary and unread badges show immediately.
  useEffect(() => {
    if (rpc === undefined) return
    for (const { id } of PROVIDERS) {
      if (hasAccount(statuses[id]) && visibilityModels[id] === undefined && !visibilityInflightRef.current.has(id)) {
        void loadVisibility(id)
      }
    }
  }, [rpc, statuses, loadVisibility, visibilityModels])

  /**
   * Fetch the logos for the labs the loaded rows name that this build has no
   * vendored mark for. Keyed on the lab SET rather than on the rows, so a new
   * model from a lab already listed costs no request, while a lab that appears
   * for the first time resolves its mark without a rebuild. A lab the host
   * cannot produce a logo for simply never arrives, and its row draws nothing.
   */
  const labBadgesNeeded = labsNeedingBadges(visibilityModels)
  const labBadgesSignature = labBadgesNeeded.join(',')
  useEffect(() => {
    if (rpc === undefined || labBadgesSignature === '') return
    if (labBadgesLoadedForRef.current === labBadgesSignature) return
    labBadgesLoadedForRef.current = labBadgesSignature
    // The signature is the request: lab slugs are comma-free by construction
    // (models.dev's own alphabet), so splitting it back is lossless and keeps
    // this effect from depending on a fresh array identity every render.
    const labs = labBadgesSignature.split(',')
    let alive = true
    void callSubscriptionsAuth<{ badges: Record<string, string> }>(rpc, 'labBadges', { labs })
      .then((answer) => {
        if (alive) setLabBadges(mergeLabBadges(answer.badges))
      })
      .catch(() => {
        // A mark that could not be fetched is simply absent, which is the honest
        // rendering — an error line for a missing icon would be noise. The
        // vendored set stays as it was, so nothing is substituted for it.
      })
    return () => { alive = false }
  }, [rpc, labBadgesSignature])

  /** Drop the server's cached catalogs, then re-read this provider's model list. */
  /** Load Cline's per-model upstream pins plus whatever discovery knows. */
  const loadClinePins = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    setClinePinsLoading(true)
    try {
      const response = await callSubscriptionsAuth<{ models: ClinePinView[] }>(rpc, 'clinePins', {})
      if (!mountedRef.current) return
      setClinePins(response.models)
      setClinePinsError(undefined)
    } catch (error) {
      if (mountedRef.current) setClinePinsError(messageOf(error))
    } finally {
      if (mountedRef.current) setClinePinsLoading(false)
    }
  }, [rpc])

  /** Persist one model's pin, updating the row optimistically. */
  const saveClinePin = useCallback(async (
    model: string,
    next: { upstreams: string[]; exclude: string[]; pinMode: 'strict' | 'preferred'; sort: string },
  ): Promise<void> => {
    if (rpc === undefined) return
    setClinePins(prev => (prev ?? []).map(row => (row.model === model ? { ...row, ...next } : row)))
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setClinePin', { model, ...next })
    } catch (error) {
      setClinePinsError(messageOf(error))
      void loadClinePins()
    }
  }, [rpc, loadClinePins])

  /** Discover the channels one model can use (free: the probe spends no token). */
  const probeClineChannels = useCallback(async (model: string): Promise<void> => {
    if (rpc === undefined || clineProbing !== undefined) return
    setClineProbing(model)
    try {
      const result = await callSubscriptionsAuth<{ channels: string[]; pipeline?: 'direct' | 'planner' }>(
        rpc, 'probeClineChannels', { model },
      )
      if (!mountedRef.current) return
      setClinePins(prev => (prev ?? []).map(row => (row.model === model
        ? { ...row, channels: result.channels, ...result.pipeline === undefined ? {} : { pipeline: result.pipeline } }
        : row)))
    } catch (error) {
      if (mountedRef.current) setClinePinsError(messageOf(error))
    } finally {
      if (mountedRef.current) setClineProbing(undefined)
    }
  }, [rpc, clineProbing])

  /** Validate each channel for one model with a minimal real request to test availability. */
  const validateClineChannels = useCallback(async (model: string): Promise<void> => {
    if (rpc === undefined || clineValidating !== undefined) return
    setClineValidating(model)
    try {
      const result = await callSubscriptionsAuth<{ verdicts: Record<string, { status: string; note: string; ms: number; checkedAt: number }> }>(
        rpc, 'validateClineChannels', { model },
      )
      if (!mountedRef.current) return
      setClinePins(prev => (prev ?? []).map(row => (row.model === model
        ? { ...row, verdicts: { ...row.verdicts, ...result.verdicts } }
        : row)))
    } catch (error) {
      if (mountedRef.current) setClinePinsError(messageOf(error))
    } finally {
      if (mountedRef.current) setClineValidating(undefined)
    }
  }, [rpc, clineValidating])

  /**
   * The one-click path: probe, measure, pin the working channels fastest first,
   * exclude the broken, and verify.
   *
   * The pins list is reloaded afterwards rather than patched from the response,
   * because the host is the authority on what was actually saved — and on the
   * paths where nothing was saved it has deliberately left the pin empty.
   */
  const autoConfigureCline = useCallback(async (model: string): Promise<void> => {
    if (rpc === undefined || clineAutoRunning !== undefined) return
    setClineAutoRunning(model)
    try {
      const result = await callSubscriptionsAuth<ClineAutoConfigureView>(rpc, 'clineAutoConfigure', { model })
      if (!mountedRef.current) return
      setClineAutoResults(prev => ({ ...prev, [model]: result }))
      await loadClinePins()
    } catch (error) {
      if (mountedRef.current) setClinePinsError(messageOf(error))
    } finally {
      if (mountedRef.current) setClineAutoRunning(undefined)
    }
  }, [rpc, clineAutoRunning, loadClinePins])

  const toggleClineSection = useCallback((): void => {    setClinePinsOpen((prev) => {
      const next = !prev
      if (next) void loadClinePins()
      return next
    })
  }, [loadClinePins])

  const refreshModelList = useCallback(async (provider: SubscriptionProvider): Promise<void> => {    if (rpc === undefined || refreshingModels !== undefined) return
    setRefreshingModels(provider)
    try {
      await callSubscriptionsAuth<{ ok: boolean }>(rpc, 'refreshModels', { provider })
      await loadVisibility(provider, true)
    } catch (error) {
      setVisibilityError(prev => ({ ...prev, [provider]: messageOf(error) }))
    } finally {
      if (mountedRef.current) setRefreshingModels(undefined)
    }
  }, [rpc, refreshingModels, loadVisibility])

  const setVisible = useCallback(async (provider: SubscriptionProvider, model: string, visible: boolean): Promise<void> => {
    if (rpc === undefined) return
    setVisibilityModels(prev => ({
      ...prev,
      [provider]: (prev[provider] ?? []).map(entry => entry.id === model ? { ...entry, visible } : entry),
    }))
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setVisible', { provider, model, visible })
    } catch (error) {
      setVisibilityError(prev => ({ ...prev, [provider]: messageOf(error) }))
      void loadVisibility(provider)
    }
  }, [rpc, loadVisibility])

  const setAllVisible = useCallback(async (provider: SubscriptionProvider, visible: boolean): Promise<void> => {
    const models = visibilityModels[provider] ?? []
    for (const model of models) {
      if (model.visible !== visible) await setVisible(provider, model.id, visible)
    }
  }, [visibilityModels, setVisible])

  const login = useCallback(async (provider: SubscriptionProvider, method?: 'oauth' | 'keychain' | 'import'): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    // Cline and Qoder have no OAuth or device flow: the credential IS something
    // the user pastes, so the paste field is the sign-in and there is nothing to
    // call on the host yet.
    if (provider === 'cline' || provider === 'qoder') {
      setManualOpen(prev => ({ ...prev, [provider]: true }))
      return
    }
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', {
        provider,
        ...method === undefined ? {} : { method },
      })
      if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
        // Instant login (e.g. imported from Claude Code credentials)
        await refresh()
        return
      }
      if (typeof response.authorizeUrl !== 'string') {
        throw new SubscriptionsAuthError(t('loginMissingUrl'))
      }
      if (!mountedRef.current) return
      // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
      setStatuses(prev => ({
        ...prev,
        [provider]: { accounts: prev[provider]?.accounts ?? [], ...prev[provider], busy: true },
      }))
      if (typeof response.userCode === 'string' && response.userCode.length > 0) {
        // Device flow: show the code card instead of opening the page blind —
        // the user copies the code first, then opens the verification page.
        setDeviceCodes(prev => ({ ...prev, [provider]: { userCode: response.userCode as string, verificationUrl: response.authorizeUrl } }))
      } else {
        window.open(response.authorizeUrl, '_blank', 'noopener')
      }
      startPolling(provider)
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
  }, [rpc, t, setProviderError, startPolling])

  const cancel = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    stopPolling(provider)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, stopPolling, setProviderError, refresh])

  const submitManual = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    let input = manualDrafts[provider].trim()
    if (provider === 'zed') {
      const userId = zedUserId.trim()
      const token = zedToken.trim()
      if (userId.startsWith('{')) input = userId
      else if (userId !== '' && token !== '') input = JSON.stringify({ userId, token })
      else if (userId !== '') input = userId
    }
    if (input === '') return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', { provider, input })
      if (mountedRef.current) {
        setManualDrafts(prev => ({ ...prev, [provider]: '' }))
        if (provider === 'zed') {
          setZedUserId('')
          setZedToken('')
        }
        setManualOpen(prev => ({ ...prev, [provider]: false }))
      }
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, manualDrafts, zedUserId, zedToken, setProviderError, refresh])

  const logout = useCallback(async (provider: SubscriptionProvider, account: string, display: string, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutAccountConfirm', { provider: name, account: display }))) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider, account })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, t, setProviderError, refresh])

  const setDefault = useCallback(async (provider: SubscriptionProvider, account: string): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setDefault', { provider, account })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, setProviderError, refresh])

  const copyDeviceCode = useCallback((provider: SubscriptionProvider, userCode: string): void => {
    void navigator.clipboard?.writeText(userCode).then(() => {
      if (!mountedRef.current) return
      setCopiedCode(provider)
      setTimeout(() => {
        if (mountedRef.current) {
          setCopiedCode(current => current === provider ? undefined : current)
        }
      }, 1500)
    }).catch(() => undefined)
  }, [])

  // Proxy configuration: load once on mount; the dialog drives proxySet/proxyTest.
  useEffect(() => {
    if (rpc === undefined) return
    let alive = true
    void callSubscriptionsAuth<ProxyConfigView>(rpc, 'proxyGet', {}).then((view) => {
      if (!alive) return
      setProxy(view)
      setProxyLoadError(undefined)
    }).catch((error) => {
      if (alive) setProxyLoadError(messageOf(error))
    })
    return () => { alive = false }
  }, [rpc])

  // Global multi-account call mode: load once on mount.
  useEffect(() => {
    if (rpc === undefined) return
    let alive = true
    void callSubscriptionsAuth<PoolModeView>(rpc, 'poolGet', {}).then((view) => {
      if (!alive) return
      setPoolMode(view)
      setPoolModeError(view.error)
    }).catch((error) => {
      if (alive) setPoolModeError(messageOf(error))
    })
    return () => { alive = false }
  }, [rpc])

  // Check-in state per check-in-capable provider (CodeBuddy and Trae each keep
  // their own daily schedule, so one shared slot would show the wrong account's
  // state).
  const [checkinStatuses, setCheckinStatuses] = useState<Partial<Record<SubscriptionProvider, CheckinStatusView>>>({})

  const loadCheckinStatus = useCallback(async (provider: SubscriptionProvider = 'codebuddy'): Promise<void> => {
    if (rpc === undefined) return
    try {
      const res = await callSubscriptionsAuth<CheckinStatusView>(rpc, 'checkinStatus', { provider })
      if (mountedRef.current) setCheckinStatuses(prev => ({ ...prev, [provider]: res }))
    } catch { /* best effort */ }
  }, [rpc])

  useEffect(() => {
    void loadCheckinStatus('codebuddy')
    void loadCheckinStatus('trae')
    void loadCheckinStatus('qoder')
  }, [loadCheckinStatus])

  const loadSavings = useCallback(async (refresh = false): Promise<void> => {
    if (rpc === undefined) return
    if (refresh) setSavingsLoading(true)
    try {
      // `refresh` makes the HOST re-walk the session history; without it the
      // endpoint answers from its cached summary, so the button would relabel a
      // cached figure as freshly recalculated.
      const res = await callSubscriptionsAuth<TokenSavingsView>(rpc, 'tokenStats', refresh ? { refresh: true } : {})
      if (mountedRef.current) setSavings(res)
    } catch { /* best effort */ } finally {
      if (mountedRef.current) setSavingsLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    void loadSavings()
  }, [loadSavings])

  /** Save a new global multi-account call mode. */
  const setPoolModeOption = useCallback((mode: 'priority' | 'quota_aware'): void => {
    if (rpc === undefined || poolModeSaving) return
    setPoolModeSaving(true)
    const previous = poolMode
    // Optimistically apply so the select reflects the choice immediately.
    setPoolMode(current => current === undefined ? { mode } : { ...current, mode })
    void callSubscriptionsAuth<PoolModeView>(rpc, 'poolSet', { mode }).then((view) => {
      setPoolMode(view)
      setPoolModeError(view.error ?? undefined)
    }).catch((error) => {
      setPoolMode(previous)
      setPoolModeError(messageOf(error))
    }).finally(() => {
      setPoolModeSaving(false)
    })
  }, [rpc, poolMode, poolModeSaving])

  useEffect(() => {
    if (!proxyOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProxyOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [proxyOpen])

  const openProxyDialog = useCallback((): void => {
    if (proxy === undefined) return
    setProxyEnabled(proxy.enabled)
    setProxyUrl(proxy.url)
    setProxyUsername(proxy.username ?? '')
    setProxyPassword('')
    setProxyClearPassword(false)
    setProxyBypass(proxy.bypass.join(', '))
    setProxyProviders({
      codex: proxy.providers.codex !== false,
      claude: proxy.providers.claude !== false,
      grok: proxy.providers.grok !== false,
      copilot: proxy.providers.copilot !== false,
      agy: proxy.providers.agy !== false,
      commandcode: proxy.providers.commandcode !== false,
      cline: proxy.providers.cline !== false,
      codebuddy: proxy.providers.codebuddy !== false,
      qoder: proxy.providers.qoder !== false,
      trae: proxy.providers.trae !== false,
      zed: proxy.providers.zed !== false,
    })
    setProxyMessage(undefined)
    setProxyTestResult(undefined)
    setProxyOpen(true)
  }, [proxy])

  const saveProxy = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    setProxySaving(true)
    setProxyMessage(undefined)
    try {
      const view = await callSubscriptionsAuth<ProxyConfigView>(rpc, 'proxySet', {
        enabled: proxyEnabled,
        url: proxyUrl.trim(),
        username: proxyUsername,
        ...proxyClearPassword ? { password: null } : proxyPassword !== '' ? { password: proxyPassword } : {},
        bypass: proxyBypass.split(/[,\n]/).map(entry => entry.trim()).filter(entry => entry !== ''),
        providers: proxyProviders,
      })
      setProxy(view)
      setProxyLoadError(undefined)
      setProxyMessage({ tone: 'success', text: t('proxySaved') })
      setProxyOpen(false)
    } catch (error) {
      setProxyMessage({ tone: 'error', text: t('proxySaveFailed', { message: messageOf(error) }) })
    } finally {
      setProxySaving(false)
    }
  }, [rpc, proxyEnabled, proxyUrl, proxyUsername, proxyPassword, proxyClearPassword, proxyBypass, proxyProviders, t])

  const testProxy = useCallback(async (): Promise<void> => {
    if (rpc === undefined || proxyTesting) return
    setProxyTesting(true)
    setProxyTestResult(undefined)
    try {
      // Test the dialog's current inputs (they do not need to be saved first);
      // the host builds a throwaway agent for the probe.
      const draftUrl = proxyUrl.trim()
      setProxyTestResult(await callSubscriptionsAuth<ProxyTestResult>(rpc, 'proxyTest', {
        ...draftUrl !== '' ? {
          proxy: {
            url: draftUrl,
            ...proxyUsername.trim() !== '' ? { username: proxyUsername.trim() } : {},
            ...proxyPassword !== '' ? { password: proxyPassword } : {},
          },
        } : {},
        providers: proxyProviders,
      }))
    } catch (error) {
      setProxyTestResult({ ok: false, viaProxy: false, error: messageOf(error) })
    } finally {
      setProxyTesting(false)
    }
  }, [rpc, proxyTesting, proxyUrl, proxyUsername, proxyPassword, proxyProviders])

  const renderProviderProbeBadge = (id: SubscriptionProvider) => {
    if (proxyTesting) {
      return (
        <span style={styles.probeBadgeLoading}>
          {t('proxyTestingItems')}
        </span>
      )
    }
    if (proxyTestResult === undefined) return null

    // 1. Precise per-provider probe result (real destination domain respecting Clash rules):
    const detail = proxyTestResult.providers?.[id]
    if (detail !== undefined) {
      if (detail.ok) {
        const flag = detail.emoji ? `${detail.emoji} ` : ''
        const region = `${flag}${detail.region || detail.countryCode || 'OK'}`
        const latency = ` · ${detail.latencyMs}ms`
        const direct = !detail.viaProxy ? ` · ${t('proxyDirectTag')}` : ''
        return (
          <span style={detail.viaProxy ? styles.probeBadgeProxy : styles.probeBadgeDirect}>
            {`${region}${latency}${direct}`}
          </span>
        )
      }
      return (
        <span style={styles.probeBadgeError} title={detail.error}>
          {detail.viaProxy ? t('proxyFailedTag') : t('proxyDirectFailedTag')}
        </span>
      )
    }

    // 2. Fallback for legacy backend before DSH restart:
    const isChecked = proxyProviders[id] !== false
    const willUseProxy = proxyEnabled && isChecked
    const probe = willUseProxy ? proxyTestResult.proxyProbe : proxyTestResult.directProbe

    if (probe === undefined) {
      if (!willUseProxy) {
        return (
          <span style={styles.probeBadgeDirect}>
            {t('proxyDirectTag')}
          </span>
        )
      }
      if (proxyTestResult.ok) {
        return (
          <span style={styles.probeBadgeWarn} title={t('proxyNeedRestartHint')}>
            {t('proxyNeedRestartTag')}
          </span>
        )
      }
      return (
        <span style={styles.probeBadgeError} title={proxyTestResult.error}>
          {proxyUrl.trim() === '' ? t('proxyNotConfiguredTag') : t('proxyFailedTag')}
        </span>
      )
    }

    if (probe.ok) {
      const regionText = `${probe.emoji ? `${probe.emoji} ` : ''}${probe.country || probe.countryCode || 'OK'}`
      const latencyText = typeof probe.latencyMs === 'number' ? ` · ${probe.latencyMs}ms` : ''
      const directText = !willUseProxy ? ` · ${t('proxyDirectTag')}` : ''
      const fullText = `${regionText}${latencyText}${directText}`
      return (
        <span
          style={willUseProxy ? styles.probeBadgeProxy : styles.probeBadgeDirect}
          title={probe.ip ? `IP: ${probe.ip}` : undefined}
        >
          {fullText}
        </span>
      )
    }

    return (
      <span style={styles.probeBadgeError} title={probe.error}>
        {willUseProxy ? t('proxyFailedTag') : t('proxyDirectFailedTag')}
      </span>
    )
  }

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  // Connected providers render first and keep every management control; the
  // rest collapse under "Add a subscription" with only their sign-in buttons.
  const connectedProviders = PROVIDERS.filter(({ id }) => hasAccount(statuses[id]))
  const availableProviders = PROVIDERS.filter(({ id }) => !hasAccount(statuses[id]))
  const orderedProviders = [...connectedProviders, ...availableProviders]
  const savingsProviders = savings === undefined
    ? []
    : Object.entries(savings.byProvider)
      .filter(([, stat]) => stat.tokens > 0)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
  const savingsPeak = savingsProviders.length > 0 ? savingsProviders[0]![1].costUsd : 1

  const renderSavingsBanner = (): ReactNode => (
    <div style={styles.savingsCard}>
      <div style={styles.savingsGlow} aria-hidden="true" />
      <div style={styles.savingsHeader}>
        <div>
          <div style={styles.savingsTitleRow}>
            <span style={styles.savingsTitle}>{t('savingsTitle')}</span>
          </div>
          <p style={styles.savingsSubtitle}>{t('savingsSubtitle')}</p>
        </div>
        <button
          type="button"
          style={{ ...styles.button, ...savingsLoading ? { opacity: 0.5, cursor: 'default' } : {} }}
          disabled={savingsLoading}
          onClick={() => { void loadSavings(true) }}
        >
          {savingsLoading ? t('savingsScanning') : t('savingsRefresh')}
        </button>
      </div>
      {savings === undefined || savings.totalTokens === 0 ? (
        <p style={styles.emptyHint}>{t('savingsEmpty')}</p>
      ) : (
        <>
          <div style={styles.savingsHero}>
            <span style={styles.savingsHeroValue}>{`¥ ${savings.savedRmb.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>
            <span style={styles.savingsHeroLabel}>{t('savingsLabel')}</span>
            <span style={styles.savingsHeroUsd}>{t('savingsUsd', { amount: savings.savedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</span>
          </div>
          <div style={styles.savingsMetrics}>
            <div style={styles.savingsMetric}>
              <span style={styles.savingsMetricValue}>{formatTokens(savings.totalTokens)}</span>
              <span style={styles.savingsMetricLabel}>{t('savingsTokens')}</span>
            </div>
            <div style={styles.savingsMetric}>
              <span style={styles.savingsMetricValue}>{savings.turns.toLocaleString()}</span>
              <span style={styles.savingsMetricLabel}>{t('savingsTurns')}</span>
            </div>
            <div style={styles.savingsMetric}>
              <span style={styles.savingsMetricValue}>{formatTokens(savings.cacheReadTokens)}</span>
              <span style={styles.savingsMetricLabel}>
                {`缓存读取 (${savings.totalTokens > 0 ? ((savings.cacheReadTokens / savings.totalTokens) * 100).toFixed(0) : 0}%)`}
              </span>
            </div>
            {(savings.cacheWriteTokens ?? 0) > 0 && (
              <div style={styles.savingsMetric}>
                <span style={styles.savingsMetricValue}>{formatTokens(savings.cacheWriteTokens ?? 0)}</span>
                <span style={styles.savingsMetricLabel}>{t('savingsCacheWrite')}</span>
              </div>
            )}
          </div>
          {savingsProviders.length > 0 && (
            <div style={styles.savingsProviders}>
              {savingsProviders.map(([id, stat]) => (
                <div key={id} style={styles.savingsProviderRow}>
                  <span style={styles.savingsProviderName}>
                    {PROVIDERS.find(entry => entry.id === id)?.name ?? id}
                  </span>
                  <span style={styles.savingsProviderBar}>
                    <span style={{
                      ...styles.savingsProviderFill,
                      width: `${String(Math.max(3, Math.round((stat.costUsd / savingsPeak) * 100)))}%`,
                    }} />
                  </span>
                  <span style={styles.savingsProviderValue}>
                    {`${formatTokens(stat.tokens)} · ¥${(stat.costUsd * (savings.rmbPerUsd ?? FALLBACK_RMB_PER_USD)).toFixed(2)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div style={styles.section}>
      {renderSavingsBanner()}
      <div style={styles.globalCard}>
        {/* Row 1: 多账号调用模式 */}
        <div style={styles.globalRow}>
          <div style={styles.globalRowLeft}>
            <div style={styles.globalRowHeader}>
              <span style={styles.globalRowTitle}>{t('poolModeTitle')}</span>
              {poolMode?.configured !== undefined && poolMode.mode !== poolMode.configured ? (
                <span
                  style={styles.overrideTag}
                  title={t('poolModeReadOverride', {
                    configured: poolMode.configured === 'priority' ? t('poolModeSequential') : t('poolModeBalanced'),
                  })}
                >
                  {t('poolModeOverrideTag')}
                </span>
              ) : null}
            </div>
            <p style={styles.globalRowDesc}>
              {poolModeError !== undefined
                ? t('poolModeLoadFailed', { message: poolModeError })
                : poolMode?.configured !== undefined && poolMode.mode !== poolMode.configured
                  ? t('poolModeReadOverride', {
                      configured: poolMode.configured === 'priority' ? t('poolModeSequential') : t('poolModeBalanced'),
                    })
                  : t('poolModeHint')}
            </p>
          </div>
          <div style={styles.globalRowRight}>
            <select
              style={styles.globalSelect}
              value={poolMode?.mode ?? 'quota_aware'}
              disabled={poolModeSaving}
              onChange={(event) => { void setPoolModeOption(event.target.value as 'priority' | 'quota_aware') }}
            >
              <option value="priority">{t('poolModeSequential')}</option>
              <option value="quota_aware">{t('poolModeBalanced')}</option>
            </select>
          </div>
        </div>

        <div style={styles.globalDivider} />

        {/* Row 2: 代理 */}
        <div style={styles.globalRow}>
          <div style={styles.globalRowLeft}>
            <div style={styles.globalRowHeader}>
              <span style={{
                ...styles.dot,
                background: proxy?.enabled === true
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-label-dimmed)',
              }} />
              <span style={styles.globalRowTitle}>{t('proxyTitle')}</span>
            </div>
            <p style={styles.globalRowDesc}>{proxyStatusText(t, proxy, proxyLoadError)}</p>
          </div>
          <div style={styles.globalRowRight}>
            <button
              type="button"
              style={styles.button}
              onClick={openProxyDialog}
            >
              {t('proxyConfigure')}
            </button>
          </div>
        </div>
      </div>

      <div style={styles.providersHeader}>
        <span style={styles.providersTitle}>{t('activeSectionTitle')}</span>
      </div>

      {connectedProviders.length === 0 && (
        <p style={styles.emptyHint}>{t('noActiveSubscriptions')}</p>
      )}

      {connectedProviders.map(({ id, name }) => {
        const status = statuses[id]
        const accounts = status?.accounts ?? []
        return (
          <div key={id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ ...styles.dot, background: dotColor(status) }} />
              <span style={styles.name}>{name}</span>
              <span style={styles.cardHeaderStatus}>{statusText(t, status)}</span>
            </div>
            {status?.detail !== undefined && status.detail !== '' && (
              <p style={styles.statusLine}>{status.detail}</p>
            )}
            {errors[id] !== undefined && <p style={styles.errorLine}>{errors[id]}</p>}
            {accounts.map((account) => {
              const usageKey = `${id}:${account.key}`
              const usage = usages[usageKey]
              const usageError = usageErrors[usageKey]
              const display = account.account ?? account.key
              // Providers without a usage endpoint answer supported:false — no block.
              const showUsage = usage?.supported !== false
                && (usage !== undefined || usageError !== undefined || usageLoading[usageKey] === true)
              return (
                <div key={account.key} style={styles.accountRow}>
                  <div style={styles.accountHeader}>
                    <button
                      type="button"
                      style={styles.starButton}
                      title={account.isDefault ? t('defaultBadge') : t('setDefault')}
                      onClick={() => {
                        if (!account.isDefault) void setDefault(id, account.key)
                      }}
                    >
                      {account.isDefault ? '★' : '☆'}
                    </button>
                    <span style={styles.accountName}>{display}</span>
                    {account.plan !== undefined && (
                      <span style={styles.usagePlan}>{account.plan}</span>
                    )}
                    {account.expiresAt !== undefined && (
                      <span style={styles.statusLine}>
                        {t('accountExpires', { date: new Date(account.expiresAt).toLocaleString() })}
                      </span>
                    )}
                    <button
                      type="button"
                      style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
                      onClick={() => { void logout(id, account.key, display, name) }}
                    >
                      {t('logout')}
                    </button>
                    {CHECKIN_PROVIDERS.has(id) && rpc !== undefined && (
                      (() => {
                        const status = checkinStatuses[id]
                        const isDone = status?.checkedInToday === true
                        const buttonText = isDone
                          ? `✓ ${t('checkinDone')}`
                          : t('checkin')
                        const buttonTooltip = isDone
                          ? (status?.lastMessage
                              ? `${t('checkinTodayDone')} · ${status.lastMessage}`
                              : t('checkinTodayDone'))
                          : (status?.scheduledTime
                              ? t('checkinNextScheduled', {
                                  time: new Date(status.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                })
                              : t('checkinAutoSchedule'))
                        return (
                          <button
                            type="button"
                            style={isDone ? styles.buttonDisabled : styles.button}
                            title={buttonTooltip}
                            onClick={() => {
                              void callSubscriptionsAuth<{ ok: boolean; message: string }>(rpc, 'checkin', { provider: id, account: account.key })
                                .then(result => {
                                  setProviderError(id, result.ok ? t('checkinOk', { message: result.message }) : t('checkinFail', { message: result.message }))
                                  void loadCheckinStatus(id)
                                })
                                .catch(error => { setProviderError(id, t('checkinFail', { message: messageOf(error) })) })
                            }}
                          >
                            {buttonText}
                          </button>
                        )
                      })()
                    )}
                  </div>
                  {showUsage && (
                    <div style={styles.usage}>
                      <div style={styles.usageHeader}>
                        <span style={styles.usageTitle}>{t('usageTitle')}</span>
                        {usage?.plan !== undefined && (
                          <span style={styles.usagePlan}>{t('usagePlan', { plan: usage.plan })}</span>
                        )}
                        <button
                          type="button"
                          style={{ ...styles.usageRefresh, ...usageLoading[usageKey] === true ? { opacity: 0.5, cursor: 'default' } : {} }}
                          disabled={usageLoading[usageKey] === true}
                          onClick={() => { void loadUsage(id, account.key, true) }}
                        >
                          {t('usageRefresh')}
                        </button>
                      </div>
                      {usage === undefined && usageError === undefined && (
                        <p style={styles.statusLine}>{t('usageLoading')}</p>
                      )}
                      {usageError !== undefined && (
                        <p style={styles.errorLine}>{t('usageError', { message: usageError })}</p>
                      )}
                      {usage?.windows !== undefined && usage.windows.length === 0 && usage.remaining === undefined && (
                        <p style={styles.statusLine}>{t('usageEmpty')}</p>
                      )}
                      {usage?.remaining !== undefined && (
                        <div style={styles.usageRow}>
                          <div style={styles.usageMeta}>
                            <span>{t('usageCredits')}</span>
                            <span>
                              {usage.limit !== undefined
                                ? t('usageRemaining', { remaining: formatAmount(usage.remaining), limit: formatAmount(usage.limit) })
                                : t('usageRemainingOnly', { remaining: formatAmount(usage.remaining) })}
                              {(() => {
                                const primaryWindow = usage.windows?.find(w => w.kind === 'session') ?? usage.windows?.[0]
                                return primaryWindow?.resetsAt !== undefined
                                  ? ` · ${t('usageResets', { date: new Date(primaryWindow.resetsAt).toLocaleString() })}`
                                  : ''
                              })()}
                            </span>
                          </div>
                          {usage.limit !== undefined && usage.limit > 0 && (
                            <div style={styles.usageTrack}>
                              {(() => {
                                const percent = Math.min(100, Math.max(0, ((usage.limit - usage.remaining) / usage.limit) * 100))
                                return (
                                  <div style={{ ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) }} />
                                )
                              })()}
                            </div>
                          )}
                        </div>
                      )}
                      {(() => {
                        const windows = usage?.windows ?? []
                        if (windows.length === 0) return null
                        const collapse = usage?.remaining !== undefined || windows.length > 1
                        const open = collapse ? usageDetailsOpen[usageKey] === true : true
                        return (
                          <>
                            {collapse && (
                              <button
                                type="button"
                                style={styles.usageDetailsToggle}
                                aria-expanded={open}
                                onClick={() => {
                                  setUsageDetailsOpen(prev => ({ ...prev, [usageKey]: prev[usageKey] !== true }))
                                }}
                              >
                                {open ? t('usageDetailsHide') : t('usageDetails')}
                                {` ${open ? '▲' : '▼'}`}
                              </button>
                            )}
                            {open && windows.map((window, index) => {
                              const percent = Math.min(100, Math.max(0, window.usedPercent))
                              return (
                                <div key={index} style={styles.usageRow}>
                                  <div style={styles.usageMeta}>
                                    <span>{usageWindowLabel(t, window)}</span>
                                    <span>
                                      {usageAmountText(t, window)}
                                      {window.resetsAt !== undefined
                                        && ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`}
                                    </span>
                                  </div>
                                  <div style={styles.usageTrack}>
                                    <div style={{ ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) }} />
                                  </div>
                                </div>
                              )
                            })}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )
            })}
            {accounts.length > 0 && (() => {
              // Collapsed by default: providers with a large catalog (Copilot
              // lists dozens of models) must not push the page down. The
              // header carries the summary so the collapsed state still says
              // how many models are overridden. The section is per provider,
              // not per account: the override keys off the model id, which the
              // pool shares across a provider's accounts.
              const open = modelDefaultsOpen[id] === true
              const catalog = modelDefaults[id]
              const filter = modelDefaultsFilters[id] ?? ''
              const view = deriveModelDefaultsView(catalog?.models, filter)
              const saveErrors = Object.entries(modelDefaultsSaveErrors).filter(([key]) => key.startsWith(`${id}/`))
              return (
                <div style={styles.defaultEffort}>
                  <button
                    type="button"
                    style={styles.defaultEffortToggle}
                    aria-expanded={open}
                    onClick={() => { toggleModelDefaults(id) }}
                  >
                    <span style={styles.usageTitle}>{t('modelDefaultsTitle')}</span>
                    <span style={styles.usagePlan}>
                      {catalog === undefined
                        ? (modelDefaultsLoading ? t('modelDefaultsLoading') : '')
                        : view.total === 0
                          ? t('modelDefaultsSummaryEmpty')
                          : view.overridden === 0
                            ? t('modelDefaultsSummaryNone', { total: view.total })
                            : t('modelDefaultsSummary', { total: view.total, configured: view.overridden })}
                    </span>
                    {/* Decoration: `aria-expanded` on the button already
                        carries the state, and labelling the glyph only
                        appended it to the button's accessible name. */}
                    <span style={styles.defaultEffortChevron} aria-hidden="true">
                      {open ? '▲' : '▼'}
                    </span>
                  </button>
                  {/* Save failures stay visible while collapsed: a row the user
                      cannot see must not swallow its own error. */}
                  {saveErrors.map(([key, message]) => (
                    // Named: the failing row may be scrolled out of the
                    // bounded list, and several anonymous "Save failed" lines
                    // cannot be told apart.
                    <p key={key} style={styles.errorLine} role="alert">
                      {t('modelDefaultsSaveFailedNamed', {
                        model: catalog?.models.find(entry => `${id}/${entry.id}` === key)?.name
                          ?? key.slice(id.length + 1),
                        message,
                      })}
                    </p>
                  ))}
                  {open && (
                    <>
                      <p style={styles.statusLine}>{t('modelDefaultsHint')}</p>
                      {modelDefaultsLoadError !== undefined && (
                        <>
                          <p style={styles.errorLine}>{t('modelDefaultsLoadFailed', { message: modelDefaultsLoadError })}</p>
                          <div style={styles.actions}>
                            <button
                              type="button"
                              style={styles.button}
                              onClick={() => {
                                // Clearing the latch lets the effect pick the
                                // fetch back up on the next render.
                                setModelDefaultsLoadError(undefined)
                              }}
                            >
                              {t('modelDefaultsRetry')}
                            </button>
                          </div>
                        </>
                      )}
                      {modelDefaultsLoadError === undefined && catalog === undefined && (
                        <p style={styles.statusLine}>{t('modelDefaultsLoading')}</p>
                      )}
                      {view.showFilter && (
                        <input
                          style={styles.defaultEffortFilter}
                          value={filter}
                          placeholder={t('modelDefaultsFilterPlaceholder')}
                          // The placeholder disappears once the user types, so
                          // the name has to live somewhere permanent too.
                          aria-label={t('modelDefaultsFilterPlaceholder')}
                          onChange={(event) => {
                            setModelDefaultsFilters(prev => ({ ...prev, [id]: event.target.value }))
                          }}
                        />
                      )}
                      {view.shown.length > 0 && (
                        <div style={styles.defaultEffortList}>
                          {view.shown.map((model) => {
                            const rowKey = `${id}/${model.id}`
                            const saving = modelDefaultsSaving === rowKey
                            // Ids carry the provider: a model id alone repeats
                            // across cards, and duplicate ids break the label
                            // association the select relies on.
                            const labelId = `dsh-model-default-${id}-${model.id}`
                            return (
                              <div key={model.id} style={styles.defaultEffortRow}>
                                <span id={labelId} style={styles.defaultEffortName} title={model.id}>{model.name}</span>
                                {saving && (
                                  <span style={styles.defaultEffortSaving}>{t('modelDefaultsSaving')}</span>
                                )}
                                <select
                                  style={styles.defaultEffortSelect}
                                  // The row's only accessible name: a sibling
                                  // span is not associated by adjacency, which
                                  // left every select announced identically.
                                  aria-labelledby={labelId}
                                  value={modelDefaultsPending[rowKey] ?? model.configured ?? ''}
                                  disabled={saving}
                                  onChange={(event) => {
                                    void setModelDefault(id, model.id, event.target.value === '' ? undefined : event.target.value)
                                  }}
                                >
                                  <option value="">{t('modelDefaultsFollowProvider')}</option>
                                  {model.efforts.map(effort => (
                                    <option key={effort.id} value={effort.id}>{effort.name}</option>
                                  ))}
                                </select>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {catalog !== undefined && view.shown.length === 0 && filter.trim() !== '' && (
                        <p style={styles.statusLine}>{t('modelDefaultsFilterEmpty', { query: filter.trim() })}</p>
                      )}
                      {/* Models without reasoning levels collapse into one
                          count line instead of one dead row each. */}
                      {view.withoutEfforts > 0 && (
                        <p style={styles.statusLine}>{t('modelDefaultsNoLevels', { count: view.withoutEfforts })}</p>
                      )}
                    </>
                  )}
                </div>
              )
            })()}
            {/* Cline only: per-model upstream channel pinning. The gateway fans
                a model across several backing providers; this chooses which.
                Only the models enabled in this provider's visibility card are
                listed — a model the picker does not offer needs no pin — plus
                any model that already carries a pin, so nothing is hidden. */}
            {id === 'cline' && accounts.length > 0 && (() => {
              const visibleCline = visibilityModels['cline']
              const clineRows = clinePins === undefined
                ? undefined
                : clinePins.filter(row => visibleCline === undefined
                  || visibleCline.length === 0
                  || row.upstreams.length > 0
                  || visibleCline.some(model => model.id === row.model && model.visible))
              return (
              <div style={styles.defaultEffort}>
                <button
                  type="button"
                  style={styles.defaultEffortToggle}
                  aria-expanded={clinePinsOpen}
                  onClick={toggleClineSection}
                >
                  <span style={styles.usageTitle}>{t('clinePinsTitle')}</span>
                  <span style={styles.usagePlan}>
                    {clineRows === undefined
                      ? (clinePinsLoading ? t('visibilityLoading') : '')
                      : t('clinePinsSummary', {
                          pinned: clineRows.filter(row => row.upstreams.length > 0).length,
                          total: clineRows.length,
                        })}
                  </span>
                  <span style={styles.defaultEffortChevron} aria-hidden="true">
                    {clinePinsOpen ? '▲' : '▼'}
                  </span>
                </button>
                {clinePinsOpen && (
                  <>
                    <p style={styles.statusLine}>{t('clinePinsHint')}</p>
                    {clinePinsError !== undefined && <p style={styles.errorLine}>{clinePinsError}</p>}
                    {clinePinsLoading && clineRows === undefined && (
                      <p style={styles.statusLine}>{t('visibilityLoading')}</p>
                    )}
                    {clineRows !== undefined && clineRows.length === 0 && (
                      <p style={styles.statusLine}>
                        {clinePins !== undefined && clinePins.length > 0
                          ? t('clinePinsAllHidden')
                          : t('clinePinsEmpty')}
                      </p>
                    )}
                    {clineRows !== undefined && clineRows.length > 0 && (
                      <div style={styles.pinList}>
                        {clineRows.map((row) => {
                          const probeKey = row.model
                          return (
                            <div key={row.model} style={styles.pinRow}>
                              <div style={styles.pinHeader}>
                                <span style={styles.defaultEffortName} title={row.model}>
                                  {row.model.replace(/^cline-pass\//, '')}
                                </span>
                                {row.pipeline !== undefined && (
                                  <span style={styles.pinPipeline}>{row.pipeline}</span>
                                )}
                                {/* The one-click path leads: probe + measure + pin +
                                    verify is one decision, and doing it by hand is
                                    three actions per model. */}
                                <button
                                  type="button"
                                  style={{ ...styles.buttonSmall, marginLeft: 'auto', ...clineAutoRunning === probeKey ? { opacity: 0.5, cursor: 'default' } : {} }}
                                  disabled={clineProbing !== undefined || clineValidating !== undefined || clineAutoRunning !== undefined}
                                  title={t('clineAutoHint')}
                                  onClick={() => { void autoConfigureCline(probeKey) }}
                                >
                                  {clineAutoRunning === probeKey ? t('clineAutoRunning') : t('clineAuto')}
                                </button>
                                <button
                                  type="button"
                                  style={{ ...styles.buttonSmall, ...clineProbing === probeKey ? { opacity: 0.5, cursor: 'default' } : {} }}
                                  disabled={clineProbing !== undefined || clineValidating !== undefined || clineAutoRunning !== undefined}
                                  onClick={() => { void probeClineChannels(probeKey) }}
                                >
                                  {clineProbing === probeKey ? t('refreshModelsRunning') : t('clinePinProbe')}
                                </button>
                                <button
                                  type="button"
                                  style={{ ...styles.buttonSmall, ...clineValidating === probeKey ? { opacity: 0.5, cursor: 'default' } : {} }}
                                  disabled={clineProbing !== undefined || clineValidating !== undefined || clineAutoRunning !== undefined}
                                  title={t('clinePinValidateHint')}
                                  onClick={() => { void validateClineChannels(probeKey) }}
                                >
                                  {clineValidating === probeKey ? t('clinePinValidating') : t('clinePinValidate')}
                                </button>
                              </div>
                              {/* What the last auto-configure found and did, stated as
                                  counts rather than as "done", so a partial result is
                                  visible rather than implied successful. */}
                              {(() => {
                                const report = clineAutoResults[probeKey]
                                if (report === undefined) return null
                                return (
                                  <p style={report.ok ? styles.statusLine : styles.errorLine}>
                                    {report.ok
                                      ? t('clineAutoOk', {
                                          pinned: report.pinned.join(' → '),
                                          actual: report.actual,
                                          ok: report.summary.ok,
                                          limited: report.summary.limited,
                                          unusable: report.unusable.length,
                                        })
                                      : t('clineAutoFailed', { stage: report.stage, message: report.error })}
                                  </p>
                                )
                              })()}
                              {/* Channel chips: click pins (in click order), ⊘ excludes. */}
                              {(() => {
                                const displayChannels = [...new Set([...row.channels, ...row.upstreams])]
                                return (
                                  <div style={styles.pinChips}>
                                    {displayChannels.length === 0 && (
                                      <span style={styles.statusLine}>{t('clinePinNoChannels')}</span>
                                    )}
                                    {displayChannels.map((channel) => {
                                      const pinnedIndex = row.upstreams.indexOf(channel)
                                      const excluded = row.exclude.includes(channel)
                                      const verdict = row.verdicts[channel]
                                      return (
                                        <span key={channel} style={styles.pinChipGroup}>
                                          <button
                                            type="button"
                                            title={verdict === undefined ? channel : `${channel}: ${verdict.status}${verdict.note === '' ? '' : ` · ${verdict.note}`}`}
                                            style={{
                                              ...styles.pinChip,
                                              ...pinnedIndex >= 0 ? styles.pinChipActive : {},
                                              ...excluded ? styles.pinChipExcluded : {},
                                            }}
                                            onClick={() => {
                                              // Clicking appends to the pin order; clicking a pinned
                                              // chip removes it again.
                                              const upstreams = pinnedIndex >= 0
                                                ? row.upstreams.filter(name => name !== channel)
                                                : [...row.upstreams, channel]
                                              void saveClinePin(row.model, {
                                                upstreams,
                                                exclude: row.exclude.filter(name => name !== channel),
                                                pinMode: row.pinMode,
                                                sort: row.sort,
                                              })
                                            }}
                                          >
                                            {pinnedIndex >= 0 && <span style={styles.pinOrder}>{pinnedIndex + 1}</span>}
                                            {verdict !== undefined && (
                                              <span style={{ ...styles.pinDot, background: verdictColor(verdict.status) }} />
                                            )}
                                            <span style={styles.pinChipLabel}>{channel}</span>
                                          </button>
                                          <button
                                            type="button"
                                            title={t('clinePinExclude')}
                                            style={{ ...styles.pinExclude, ...excluded ? styles.pinExcludeActive : {} }}
                                            onClick={() => {
                                              const next = excluded
                                                ? row.exclude.filter(name => name !== channel)
                                                : [...row.exclude, channel]
                                              void saveClinePin(row.model, {
                                                upstreams: row.upstreams.filter(name => name !== channel),
                                                exclude: next,
                                                pinMode: row.pinMode,
                                                sort: row.sort,
                                              })
                                            }}
                                          >
                                            ⊘
                                          </button>
                                        </span>
                                      )
                                    })}
                                  </div>
                                )
                              })()}
                              <div style={styles.pinControls}>
                                <select
                                  style={styles.defaultEffortSelect}
                                  aria-label={t('clinePinMode')}
                                  value={row.pinMode}
                                  onChange={(event) => {
                                    void saveClinePin(row.model, {
                                      upstreams: row.upstreams,
                                      exclude: row.exclude,
                                      pinMode: event.target.value === 'preferred' ? 'preferred' : 'strict',
                                      sort: row.sort,
                                    })
                                  }}
                                >
                                  <option value="strict">{t('clinePinModeStrict')}</option>
                                  <option value="preferred">{t('clinePinModePreferred')}</option>
                                </select>
                                <select
                                  style={styles.defaultEffortSelect}
                                  aria-label={t('clinePinSort')}
                                  value={row.sort}
                                  onChange={(event) => {
                                    void saveClinePin(row.model, {
                                      upstreams: row.upstreams,
                                      exclude: row.exclude,
                                      pinMode: row.pinMode,
                                      sort: event.target.value,
                                    })
                                  }}
                                >
                                  <option value="">{t('clinePinSortNone')}</option>
                                  <option value="cost">{t('clinePinSortCost')}</option>
                                  <option value="ttft">{t('clinePinSortTtft')}</option>
                                  <option value="tps">{t('clinePinSortTps')}</option>
                                </select>
                                {(row.upstreams.length > 0 || row.exclude.length > 0 || row.sort !== '') && (
                                  <button
                                    type="button"
                                    style={styles.buttonSmall}
                                    onClick={() => {
                                      void saveClinePin(row.model, { upstreams: [], exclude: [], pinMode: 'strict', sort: '' })
                                    }}
                                  >
                                    {t('clinePinReset')}
                                  </button>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
              )
            })()}
            {accounts.length > 0 && (() => {
              const open = visibilityOpen[id] === true
              const models = visibilityModels[id]
              const notFetched = visibilityNotFetched[id]
              const visibleCount = (models ?? []).filter(model => model.visible).length
              const hasUnread = (models ?? []).some(model => model.unread === true)
              return (
                <div style={styles.defaultEffort}>
                  <button
                    type="button"
                    style={styles.defaultEffortToggle}
                    aria-expanded={open}
                    onClick={() => { toggleVisibility(id) }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <span style={styles.usageTitle}>{t('visibilityTitle')}</span>
                      {!open && hasUnread && <span style={styles.unreadDot} title={t('newModelBadge')} />}
                    </span>
                    <span style={styles.usagePlan}>
                      {models === undefined
                        ? (visibilityLoading[id] === true ? t('visibilityLoading') : '')
                        : notFetched !== undefined
                          // The count is not shown when nothing was fetched: "0 of 0
                          // shown" reads like a fact about the account, and it is not.
                          ? t('visibilityNotFetchedShort')
                          : t('visibilitySummary', { visible: visibleCount, total: models.length })}
                    </span>
                    <span style={styles.defaultEffortChevron} aria-hidden="true">
                      {open ? '▲' : '▼'}
                    </span>
                  </button>
                  {open && (
                    <>
                      <p style={styles.statusLine}>{t('visibilityHint')}</p>
                      <div style={styles.actions}>
                        <button
                          type="button"
                          style={{ ...styles.button, ...refreshingModels !== undefined ? { opacity: 0.5, cursor: 'default' } : {} }}
                          disabled={refreshingModels !== undefined}
                          onClick={() => { void refreshModelList(id) }}
                        >
                          {refreshingModels === id ? t('refreshModelsRunning') : t('refreshModels')}
                        </button>
                        {models !== undefined && models.length > 0 && (
                          <>
                            <button type="button" style={styles.button} onClick={() => { void setAllVisible(id, true) }}>
                              {t('visibilityShowAll')}
                            </button>
                            <button type="button" style={styles.button} onClick={() => { void setAllVisible(id, false) }}>
                              {t('visibilityHideAll')}
                            </button>
                          </>
                        )}
                      </div>
                      {visibilityError[id] !== undefined && (
                        <p style={styles.errorLine}>{t('visibilityLoadFailed', { message: visibilityError[id] })}</p>
                      )}
                      {visibilityLoading[id] === true && models === undefined && (
                        <p style={styles.statusLine}>{t('visibilityLoading')}</p>
                      )}
                      /* The absence is stated where the list would have been, rather than
                          leaving an empty box that reads as "no models". Nothing is
                          substituted: no greyed-out rows, no placeholder ids. */
                      {notFetched !== undefined && (
                        <p style={styles.errorLine}>
                          {t('visibilityNotFetched', { what: notFetched.what })}
                          {notFetched.detail !== '' && ` (${notFetched.detail})`}
                        </p>
                      )}
                      {models !== undefined && models.length === 0 && notFetched === undefined && (
                        <p style={styles.statusLine}>{t('visibilityEmpty')}</p>
                      )}
                      {models !== undefined && models.length > 0 && (
                        <>
                          <div style={styles.visibilityGrid}>
                            {models.map(model => (
                              <label key={model.id} style={styles.visibilityItem}>
                                <input
                                  type="checkbox"
                                  checked={model.visible}
                                  onChange={event => { void setVisible(id, model.id, event.target.checked) }}
                                />
                                {/* Vendor mark, then the name, then the capability
                                    glyphs immediately after it: the row answers
                                    "who makes this, and what does it take?" without
                                    the reader's eye crossing the whole row. */}
                                {model.vendor !== undefined && <VendorMark vendor={model.vendor} badges={labBadges} />}
                                <span style={styles.defaultEffortName} title={model.id}>
                                  {model.name}
                                  {model.unread && <span style={styles.unreadModelDot} title={t('newModelBadge')} />}
                                </span>
                                <ModalityIcons modalities={model.inputModalities} />
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )
            })()}
          </div>
        )
      })}

      {/* ── Section: 添加订阅（排版紧凑，统一样式） ── */}
      <div style={styles.providersHeader}>
        <span style={styles.providersTitle}>{t('addSectionTitle')}</span>
      </div>
      <p style={styles.emptyHint}>{t('addSectionHint')}</p>

      <div style={styles.addSectionCard}>
        {PROVIDERS.map(({ id, name }, idx) => {
          const status = statuses[id]
          const busy = status?.busy === true
          const deviceCode = deviceCodes[id]
          const accounts = status?.accounts ?? []
          const isConnected = accounts.length > 0
          const isLast = idx === PROVIDERS.length - 1
          return (
            <div
              key={id}
              style={{
                ...styles.compactAddRow,
                ...isLast ? { borderBottom: 'none' } : {},
              }}
            >
              <div style={styles.compactAddMain}>
                <div style={styles.compactAddLeft}>
                  <span style={{ ...styles.dot, background: dotColor(status) }} />
                  <span style={styles.compactAddName}>{name}</span>
                  <span style={styles.compactAddTag}>
                    {isConnected ? t('connectedCount', { count: accounts.length }) : t('notConnected')}
                  </span>
                </div>
                <div style={styles.compactAddActions}>
                  {busy ? (
                    <button type="button" style={styles.buttonSmall} onClick={() => { void cancel(id) }}>
                      {t('cancel')}
                    </button>
                  ) : (
                    <>
                      {id === 'zed' && (
                        <>
                          <button type="button" style={styles.buttonSmall} onClick={() => { void login(id, 'import') }}>
                            {t('importZed')}
                          </button>
                          <button
                            type="button"
                            style={styles.buttonSmall}
                            onClick={() => { setManualOpen(prev => ({ ...prev, [id]: !prev[id] })) }}
                          >
                            {manualOpen[id] ? t('cancel') : t('manualInput')}
                          </button>
                        </>
                      )}
                      {id === 'commandcode' && (
                        <>
                          <button type="button" style={styles.buttonSmall} onClick={() => { void login(id, 'import') }}>
                            {t('importCommandCode')}
                          </button>
                          <button type="button" style={styles.buttonSmall} onClick={() => { void login(id, 'oauth') }}>
                            {t('loginAccount')}
                          </button>
                          <button
                            type="button"
                            style={styles.buttonSmall}
                            onClick={() => { setManualOpen(prev => ({ ...prev, [id]: !prev[id] })) }}
                          >
                            {manualOpen[id] ? t('cancel') : t('manualInput')}
                          </button>
                        </>
                      )}
                      {id === 'trae' && (
                        <button type="button" style={styles.buttonSmall} onClick={() => { void login(id, 'import') }}>
                          {t('importTrae')}
                        </button>
                      )}
                      {id === 'cline' && (
                        <button
                          type="button"
                          style={styles.buttonSmall}
                          onClick={() => { setManualOpen(prev => ({ ...prev, [id]: !prev[id] })) }}
                        >
                          {manualOpen[id] ? t('cancel') : t('loginAccount')}
                        </button>
                      )}
                      {id === 'claude' && (
                        <>
                          <button type="button" style={styles.buttonSmall} onClick={() => { void login(id, 'oauth') }}>
                            {t('loginAccount')}
                          </button>
                          <button type="button" style={styles.buttonSmall} onClick={() => { void login(id, 'keychain') }}>
                            {t('addAccountKeychain')}
                          </button>
                        </>
                      )}
                      {id !== 'claude' && id !== 'commandcode' && id !== 'zed' && id !== 'trae' && id !== 'cline' && (
                        <button type="button" style={styles.buttonSmall} onClick={() => { void login(id) }}>
                          {t('loginAccount')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Status errors if any and not connected */}
              {errors[id] !== undefined && !isConnected && (
                <p style={styles.errorLine}>{errors[id]}</p>
              )}

              {/* Device code prompt */}
              {busy && deviceCode !== undefined && (
                <div style={styles.deviceCode}>
                  <span style={styles.statusLine}>{t('deviceCodePrompt')}</span>
                  <span style={styles.deviceCodeText}>{deviceCode.userCode}</span>
                  <div style={styles.actions}>
                    <button type="button" style={styles.buttonSmall} onClick={() => { copyDeviceCode(id, deviceCode.userCode) }}>
                      {copiedCode === id ? t('deviceCodeCopied') : t('deviceCodeCopy')}
                    </button>
                    <button
                      type="button"
                      style={styles.buttonSmall}
                      onClick={() => { window.open(deviceCode.verificationUrl, '_blank', 'noopener') }}
                    >
                      {t('deviceCodeOpenPage')}
                    </button>
                  </div>
                </div>
              )}

              {/* Manual fallback input during oauth */}
              {busy && deviceCode === undefined && (
                <details style={styles.manual}>
                  <summary>{t('manualSummary')}</summary>
                  <div style={styles.manualRow}>
                    <input
                      style={styles.manualInput}
                      value={manualDrafts[id]}
                      placeholder={t('manualPlaceholder')}
                      onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                    />
                    <button type="button" style={styles.buttonSmall} onClick={() => { void submitManual(id) }}>
                      {t('submit')}
                    </button>
                  </div>
                </details>
              )}

              {/* Zed / CommandCode manual input form */}
              {!busy && (id === 'zed' || id === 'commandcode') && manualOpen[id] && (
                <div style={styles.manualBox}>
                  <p style={styles.statusLine}>
                    {id === 'zed' ? t('zedPasteHint') : t('commandCodePasteHint')}
                  </p>
                  {id === 'zed' ? (
                    <>
                      <div style={styles.manualRow}>
                        <input
                          style={styles.manualInput}
                          value={zedUserId}
                          placeholder={t('zedUserIdPlaceholder')}
                          autoComplete="off"
                          onChange={event => setZedUserId(event.target.value)}
                        />
                      </div>
                      <div style={styles.manualRow}>
                        <input
                          style={styles.manualInput}
                          value={zedToken}
                          placeholder={t('zedTokenPlaceholder')}
                          autoComplete="off"
                          onChange={event => setZedToken(event.target.value)}
                        />
                        <button type="button" style={styles.buttonSmall} onClick={() => { void submitManual(id) }}>
                          {t('submit')}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={styles.manualRow}>
                      <input
                        style={styles.manualInput}
                        value={manualDrafts[id]}
                        placeholder={t('manualPlaceholder')}
                        onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                      />
                      <button type="button" style={styles.buttonSmall} onClick={() => { void submitManual(id) }}>
                        {t('submit')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Cline's only login is a pasted API key: there is no OAuth or
                  device flow, so the paste field IS the sign-in. */}
              {!busy && id === 'cline' && manualOpen[id] && (
                <div style={styles.manualBox}>
                  <p style={styles.statusLine}>{t('clinePasteHint')}</p>
                  <div style={styles.manualRow}>
                    <input
                      style={styles.manualInput}
                      value={manualDrafts[id]}
                      placeholder={t('clineKeyPlaceholder')}
                      autoComplete="off"
                      onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                    />
                    <button type="button" style={styles.buttonSmall} onClick={() => { void submitManual(id) }}>
                      {t('submit')}
                    </button>
                  </div>
                </div>
              )}

              {/* Qoder's only login is a pasted Personal Access Token: no OAuth,
                  no device flow, so the paste field IS the sign-in. The region is
                  not asked for — the token is tried against both deployments and
                  recorded from whichever accepts it, with an optional `<region>:`
                  prefix for a user who knows. */}
              {!busy && id === 'qoder' && manualOpen[id] && (
                <div style={styles.manualBox}>
                  <p style={styles.statusLine}>{t('qoderPasteHint')}</p>
                  <div style={styles.manualRow}>
                    <input
                      style={styles.manualInput}
                      value={manualDrafts[id]}
                      placeholder={t('qoderPatPlaceholder')}
                      autoComplete="off"
                      onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                    />
                    <button type="button" style={styles.buttonSmall} onClick={() => { void submitManual(id) }}>
                      {t('submit')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {proxyOpen && (
        <div style={styles.modalOverlay} onClick={() => setProxyOpen(false)}>
          <div style={styles.modal} onClick={event => event.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{t('proxyDialogTitle')}</span>
              <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={() => setProxyOpen(false)}>
                {t('proxyDialogClose')}
              </button>
            </div>
            <label style={styles.proxyCheck}>
              <input type="checkbox" checked={proxyEnabled} onChange={event => setProxyEnabled(event.target.checked)} />
              <span>{t('proxyEnabled')}</span>
            </label>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyUrl')}</span>
              <input
                style={styles.proxyInput}
                value={proxyUrl}
                placeholder={t('proxyUrlPlaceholder')}
                onChange={event => setProxyUrl(event.target.value)}
              />
              <p style={styles.proxyHint}>{t('proxyUrlHint')}</p>
            </label>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyUsername')}</span>
              <input
                style={styles.proxyInput}
                value={proxyUsername}
                placeholder={t('proxyUsernamePlaceholder')}
                onChange={event => setProxyUsername(event.target.value)}
              />
            </label>
            <div style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyPassword')}</span>
              <input
                type="password"
                style={styles.proxyInput}
                value={proxyPassword}
                placeholder={t('proxyPasswordPlaceholder')}
                onChange={event => setProxyPassword(event.target.value)}
              />
              <label style={styles.proxyCheck}>
                <input
                  type="checkbox"
                  checked={proxyClearPassword}
                  onChange={event => setProxyClearPassword(event.target.checked)}
                />
                <span>{t('proxyClearPassword')}</span>
              </label>
            </div>
            <div style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyProviders')}</span>
              <p style={styles.proxyHint}>{t('proxyProvidersHint')}</p>
              {PROVIDERS.map(provider => (
                <div key={provider.id} style={styles.proxyProviderItem}>
                  <label style={styles.proxyCheck}>
                    <input
                      type="checkbox"
                      checked={proxyProviders[provider.id] !== false}
                      disabled={!proxyEnabled}
                      onChange={event => {
                        setProxyProviders(prev => ({ ...prev, [provider.id]: event.target.checked }))
                      }}
                    />
                    <span>{provider.name}</span>
                  </label>
                  {renderProviderProbeBadge(provider.id)}
                </div>
              ))}
            </div>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyBypass')}</span>
              <input
                style={styles.proxyInput}
                value={proxyBypass}
                placeholder={t('proxyBypassPlaceholder')}
                onChange={event => setProxyBypass(event.target.value)}
              />
              <p style={styles.proxyHint}>{t('proxyBypassHint')}</p>
            </label>
            <p style={styles.proxyHint}>{t('proxyNote')}</p>
            {proxyMessage !== undefined && (
              <p style={{ ...styles.proxyMessage, color: messageColor(proxyMessage.tone) }}>{proxyMessage.text}</p>
            )}
            {proxyTestResult !== undefined && (
              <p style={{
                ...styles.proxyMessage,
                color: proxyTestResult.ok
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-error-primary)',
              }}>
                {proxyTestResult.ok
                  ? (proxyTestResult.viaProxy
                    ? t('proxyTestOk', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) })
                    : t('proxyTestOkDirect', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) }))
                  : t('proxyTestFail', { message: proxyTestResult.error ?? '' })}
              </p>
            )}
            <div style={styles.proxyActions}>
              <button
                type="button"
                style={{ ...styles.button, ...proxyTesting ? { opacity: 0.5, cursor: 'default' } : {} }}
                disabled={proxyTesting}
                onClick={() => { void testProxy() }}
              >
                {proxyTesting ? t('proxyTesting') : t('proxyTest')}
              </button>
              <button
                type="button"
                style={{ ...styles.button, ...proxySaving ? { opacity: 0.5, cursor: 'default' } : {} }}
                disabled={proxySaving}
                onClick={() => { void saveProxy() }}
              >
                {proxySaving ? t('proxySaving') : t('proxySave')}
              </button>
              <button type="button" style={styles.button} onClick={() => setProxyOpen(false)}>
                {t('proxyCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Subscription usage pill for the composer's dock
 * (`conversation.composer.dock`).
 *
 * Portals directly into the host's stats row (`[data-composer-stats]`) so it
 * appears on the exact same line as the host's time/token pills (e.g.,
 * `⏱ 4 轮 38 步 · 72 tok/s  🗄 2.5M tok · 缓存命中 95%  📊 Grok 93%`).
 *
 * Click to expand a clean dialog floating above the pill showing all accounts'
 * 5-hour and weekly windows, credits, and reset countdowns without progress bars.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelDirectoriesLike } from './SpeedSelect.js'

/** How often the pill re-reads usage and the current model. */
const POLL_INTERVAL_MS = 15_000

/** Injected dependencies (slot `inject`, session-bound). */
export interface SubscriptionUsageBadgeInjected {
  /** Connection RPC caller to reach the `/subscriptions-auth` endpoints. */
  rpc: ConnectionHandle['rpc']
  /** Resolve the session's effective provider and model together. */
  currentModel: () => Promise<{ provider: string; model: string } | undefined>
}

/** Props delivered by the slot outlet + inject. */
export type SubscriptionUsageBadgeProps = PropsRuntime<'conversation.composer.dock'>
  & Partial<SubscriptionUsageBadgeInjected>

/** Account-level quota detail for the expanded popup dialog. */
interface AccountQuotaDetail {
  key: string
  account: string
  isDefault: boolean
  plan?: string | undefined
  windows: UsageWindow[]
  remaining?: number | undefined
  limit?: number | undefined
}

/** One render-ready quota reading for a single provider. */
interface UsageReading {
  provider: SubscriptionProvider
  name: string
  windows: UsageWindow[]
  remaining?: number | undefined
  limit?: number | undefined
  accounts: AccountQuotaDetail[]
}

/** Compact brand names for the pill. */
const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
  agy: 'Antigravity',
  commandcode: 'Command Code',
  cline: 'Cline',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  trae: 'Trae',
  zed: 'Zed',
}

/** Providers whose quota is a credit pool rather than a percentage. */
const CREDIT_PROVIDERS = new Set<SubscriptionProvider>(['codebuddy', 'trae'])

/** Compact reset countdown from a window's `resetsAt` timestamp. */
function resetLabel(window: UsageWindow): string {
  if (window.resetsAt === undefined) return ''
  const minutes = Math.max(0, Math.floor((window.resetsAt - Date.now()) / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}天${hours % 24}时后重置`
  if (hours > 0) return `${hours}时${minutes % 60}分后重置`
  return `${Math.max(1, minutes)}分后重置`
}

function windowKindLabel(window: UsageWindow): string {
  switch (window.kind) {
    case 'session':
      return window.scope ? `${window.scope} (5小时)` : '5小时限制'
    case 'weekly':
      return window.scope ? `${window.scope} (周限)` : '周额度限制'
    case 'other':
      return window.scope ? `${window.scope}` : '额度限制'
    default:
      return '限额'
  }
}

/** Round a possibly-fractional credit count for display. */
function creditText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

/**
 * The collapsed label for one provider reading:
 * - For CodeBuddy: remaining credits only (`CodeBuddy 12 积分`)
 * - For all other providers: remaining percentage only (`Grok 93%`, `Codex 62%`)
 */
export function compactUsageLabel(reading: UsageReading): string {
  const { provider, name } = reading
  if (CREDIT_PROVIDERS.has(provider)) {
    if (reading.remaining !== undefined) {
      const left = creditText(reading.remaining)
      return `${name} ${left} 积分`
    }
  }
  if (reading.windows.length === 0) {
    return reading.remaining === undefined ? '' : `${name} ${String(Math.round(reading.remaining))}%`
  }
  let worstPercent = 0
  for (const window of reading.windows) {
    const used = Math.min(100, Math.max(0, window.usedPercent))
    if (used > worstPercent) worstPercent = used
  }
  const left = Math.round(100 - worstPercent)
  return `${name} ${String(left)}%`
}

function makeTooltip(reading: UsageReading): string {
  const { provider, name } = reading
  if (CREDIT_PROVIDERS.has(provider) && reading.remaining !== undefined) {
    const left = creditText(reading.remaining)
    return `${name}: 剩余 ${left}${reading.limit !== undefined ? ` / ${creditText(reading.limit)}` : ''} 积分 · 点击查看详情`
  }
  if (reading.windows.length > 0) {
    const parts = reading.windows.map(w => {
      const rem = Math.round(100 - Math.min(100, Math.max(0, w.usedPercent)))
      const reset = resetLabel(w)
      return `${rem}%${reset ? ` (${reset})` : ''}`
    })
    return `${name}: 剩余 ${parts.join(' · ')} · 点击查看详情`
  }
  if (reading.remaining !== undefined) {
    return `${name}: 剩余 ${Math.round(reading.remaining)}% · 点击查看详情`
  }
  return `${name} · 点击查看详情`
}

/**
 * The `currentModel` half of the inject face: the session's effective model
 * selection through ui-model-selection's `modelDirectories` service.
 */
export function createCurrentModelReader(
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SubscriptionUsageBadgeInjected['currentModel'] {
  return async () => {
    const directories = models()
    if (directories === undefined) return undefined
    const { current } = await directories.directoryFor(sessionId).load()
    return current ?? undefined
  }
}

/**
 * The composer's subscription usage pill. Portals into `[data-composer-stats]`
 * to sit on the exact same row as official statistics.
 */
export function SubscriptionUsageBadge(props: SubscriptionUsageBadgeProps) {
  const { rpc, currentModel } = props
  const [reading, setReading] = useState<UsageReading | undefined>(undefined)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [statsRow, setStatsRow] = useState<HTMLElement | null>(null)
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number } | null>(null)

  const seatRef = useRef<HTMLSpanElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inflightRef = useRef(false)
  const mountedRef = useRef(true)

  const refresh = useCallback(async (force = false): Promise<void> => {
    if (rpc === undefined || inflightRef.current) return
    inflightRef.current = true
    if (force) setRefreshing(true)
    try {
      const current = await currentModel?.()
      if (!mountedRef.current) return
      const provider = current?.provider as SubscriptionProvider | undefined
      if (provider === undefined || !(provider in PROVIDER_NAMES)) {
        setReading(undefined)
        return
      }

      const statusResp = await callSubscriptionsAuth<{ providers: Record<SubscriptionProvider, ProviderStatus> }>(
        rpc, 'status', {},
      )
      if (!mountedRef.current) return

      const providerStatus = statusResp.providers[provider]
      if (providerStatus === undefined || providerStatus.accounts.length === 0) {
        setReading(undefined)
        return
      }

      // Fetch usage for all accounts of this provider in parallel
      const accountDetails: AccountQuotaDetail[] = await Promise.all(
        providerStatus.accounts.map(async (acc) => {
          try {
            const usage = await callSubscriptionsAuth<ProviderUsage>(
              rpc, 'usage', { provider, account: acc.key, force },
            )
            return {
              key: acc.key,
              account: acc.account ?? acc.key,
              isDefault: acc.isDefault,
              plan: acc.plan,
              windows: usage.supported ? (usage.windows ?? []) : [],
              remaining: usage.remaining,
              limit: usage.limit,
            }
          } catch {
            return {
              key: acc.key,
              account: acc.account ?? acc.key,
              isDefault: acc.isDefault,
              plan: acc.plan,
              windows: [],
            }
          }
        }),
      )

      if (!mountedRef.current) return

      const defaultAcc = accountDetails.find(a => a.isDefault) ?? accountDetails[0]
      if (defaultAcc === undefined) {
        setReading(undefined)
        return
      }

      setReading({
        provider,
        name: PROVIDER_NAMES[provider],
        windows: defaultAcc.windows,
        ...defaultAcc.remaining === undefined ? {} : { remaining: defaultAcc.remaining },
        ...defaultAcc.limit === undefined ? {} : { limit: defaultAcc.limit },
        accounts: accountDetails,
      })
    } catch {
      // Keep last reading on error
    } finally {
      inflightRef.current = false
      if (mountedRef.current) setRefreshing(false)
    }
  }, [rpc, currentModel])

  useEffect(() => {
    mountedRef.current = true
    void refresh(false)
    const timer = setInterval(() => { void refresh(false) }, POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [refresh])

  // Look for the host's `[data-composer-stats]` container to portal into.
  useEffect(() => {
    const findRow = (): HTMLElement | null => {
      if (seatRef.current) {
        let node: HTMLElement | null = seatRef.current.parentElement
        for (let i = 0; node !== null && i < 6; i++) {
          const found = node.querySelector<HTMLElement>('[data-composer-stats]')
          if (found) return found
          node = node.parentElement
        }
      }
      return document.querySelector<HTMLElement>('[data-composer-stats]')
    }

    const check = () => {
      const found = findRow()
      setStatsRow(found && found.isConnected ? found : null)
    }

    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  // Position popup above button when opened
  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next) {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect()
        const left = Math.max(12, Math.min(rect.left + rect.width / 2 - 140, window.innerWidth - 300))
        const bottom = Math.max(12, window.innerHeight - rect.top + 8)
        setPanelPos({ left, bottom })
      }
      void refresh(true)
    }
  }

  // Dismiss popup on outside pointerdown or Escape
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const label = reading === undefined ? '' : compactUsageLabel(reading)
  const seat = <span ref={seatRef} style={styles.seat} aria-hidden="true" />

  if (label === '' || !reading) return seat

  const tooltip = makeTooltip(reading)

  const pill = (
    <span className="bOPqQW_anchor" style={styles.anchor}>
      <button
        ref={buttonRef}
        type="button"
        className="bOPqQW_pill"
        style={{ ...styles.pill, ...(hover || open ? styles.pillHover : {}) }}
        title={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggleOpen}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <IconDataOutline16 size={14} />
        <span className="bOPqQW_label" style={styles.label}>{label}</span>
      </button>
    </span>
  )

  const dialog = open && panelPos && createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${reading.name} 额度详情`}
      style={{
        ...styles.panel,
        left: panelPos.left,
        bottom: panelPos.bottom,
      }}
    >
      {/* Title row mirrors the official stat dialog: leading icon + label on
          the left, value on the right, then a hairline rule. */}
      <div style={styles.title}>
        <span style={styles.titleLabel}>
          <IconDataOutline16 size={14} />
          {reading.name} 额度详情
        </span>
        <span style={styles.titleActions}>
          <button
            type="button"
            style={styles.refreshBtn}
            disabled={refreshing}
            onClick={() => { void refresh(true) }}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </span>
      </div>
      <div style={styles.titleRule} aria-hidden="true" />

      {/* One <dl> per account, exactly like the official `details` grid: label
          column auto-sized, value column right-aligned tabular numerals. */}
      {reading.accounts.map((acc, accIdx) => (
        <div key={acc.key} style={accIdx > 0 ? styles.accountSection : undefined}>
          {reading.accounts.length > 1 && (
            <div style={styles.providerRow}>
              <span style={styles.providerName}>
                {acc.account}
                {acc.isDefault && <span style={styles.currentTag}>默认</span>}
              </span>
              {acc.plan !== undefined && acc.plan !== '' && <span style={styles.providerMeta}>{acc.plan}</span>}
            </div>
          )}
          <dl style={styles.details}>
            {CREDIT_PROVIDERS.has(reading.provider) ? (
              <>
                <dt style={styles.dt}>剩余积分</dt>
                <dd style={styles.dd}>{creditText(acc.remaining ?? 0)}</dd>
                {acc.limit !== undefined && (
                  <>
                    <dt style={styles.dt}>总限额</dt>
                    <dd style={styles.dd}>{creditText(acc.limit)}</dd>
                  </>
                )}
              </>
            ) : acc.windows.length === 0 ? (
              acc.remaining !== undefined ? (
                <>
                  <dt style={styles.dt}>剩余额度</dt>
                  <dd style={styles.dd}>{`${String(Math.round(acc.remaining))}%`}</dd>
                </>
              ) : (
                <>
                  <dt style={styles.dt}>额度状态</dt>
                  <dd style={styles.dd}>正常</dd>
                </>
              )
            ) : (
              acc.windows.map((w, wIdx) => (
                <Fragment key={wIdx}>
                  <dt style={styles.dt}>{windowKindLabel(w)}</dt>
                  <dd style={styles.dd}>
                    {`剩余 ${String(Math.round(100 - Math.min(100, Math.max(0, w.usedPercent))))}%`}
                    {resetLabel(w) !== '' && <span style={styles.reset}>{` · ${resetLabel(w)}`}</span>}
                  </dd>
                </Fragment>
              ))
            )}
          </dl>
        </div>
      ))}
    </div>,
    document.body,
  )

  return (
    <>
      {seat}
      {statsRow && statsRow.isConnected ? createPortal(pill, statsRow) : null}
      {dialog}
    </>
  )
}

const styles: Record<string, CSSProperties> = {
  seat: { display: 'none' },
  anchor: { minWidth: 0, display: 'inline-flex' },
  pill: {
    boxSizing: 'border-box',
    maxWidth: '100%',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    whiteSpace: 'nowrap',
    background: 'transparent',
    border: 'none',
    borderRadius: 24,
    alignItems: 'center',
    gap: 6,
    padding: '1px 8px',
    display: 'inline-flex',
    cursor: 'pointer',
    transition: 'background 120ms ease, color 120ms ease',
  },
  pillHover: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  label: {
    textOverflow: 'ellipsis',
    minWidth: 0,
    overflow: 'hidden',
  },
  // Mirrors the harness stat-dialog panel EXACTLY (StatsPills StatDialog
  // module): `border: 0` with the hairline coming from the elevation stroke
  // token, 16px padding, 12px/18px type. A 1px CSS border reads visibly
  // heavier than the official 0.5px box-shadow stroke, which is why this
  // previously looked "thicker" than the built-in dialog.
  panel: {
    position: 'fixed',
    zIndex: 1100,
    boxSizing: 'border-box',
    background: 'var(--dsw-specific-menu)',
    // The stroke color the elevation token reads; the official panel sets it
    // on itself rather than inheriting the page's value.
    ['--dsw-elevation-stroke-color' as string]: 'var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-elevation-prominent)',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'default',
    border: 0,
    borderRadius: 12,
    padding: 16,
    fontSize: 12,
    lineHeight: '18px',
    width: 'max-content',
    minWidth: 'min(300px, 100vw - 24px)',
    maxWidth: 'min(440px, 100vw - 24px)',
    maxHeight: 'min(560px, 100dvh - 24px)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  title: {
    color: 'var(--dsw-alias-label-primary)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 16,
    marginBottom: 8,
    fontWeight: 500,
  },
  titleLabel: { alignItems: 'center', gap: 6, minWidth: 0, display: 'inline-flex' },
  titleValue: {
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 8,
  },
  titleRule: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 },
  refreshBtn: {
    background: 'transparent',
    border: 0,
    padding: 0,
    font: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
  },
  // One account block; extra accounts get the same hairline rule the official
  // dialog uses between sections.
  accountSection: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  providerRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 6,
  },
  providerName: {
    color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
    display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0,
  },
  currentTag: {
    fontSize: 10, lineHeight: '14px', fontWeight: 400, padding: '0 5px', borderRadius: 7,
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  providerMeta: {
    color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // The official detail grid: label column auto-sized (76px floor), value
  // column right-aligned tabular numerals.
  details: {
    color: 'var(--dsw-alias-label-tertiary)',
    gridTemplateColumns: 'minmax(76px, auto) minmax(0, 1fr)',
    gap: '6px 16px',
    margin: 0,
    display: 'grid',
  },
  dt: { minWidth: 0, margin: 0 },
  dd: {
    minWidth: 0, margin: 0, textAlign: 'right',
    color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums',
  },
  reset: { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
}

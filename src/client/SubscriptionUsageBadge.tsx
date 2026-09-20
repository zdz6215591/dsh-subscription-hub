/**
 * Subscription usage pill for the composer's dock
 * (`conversation.composer.dock`).
 *
 * Portals directly into the host's stats row (`[data-composer-stats]`) so it
 * appears on the exact same line as the host's time/token pills (e.g.,
 * `⏱ 4 轮 38 步 · 72 tok/s  🗄 2.5M tok · 缓存命中 95%  📊 Grok 93%`).
 *
 * Only reports the quota headroom of the provider behind the session's CURRENT model:
 *   - CodeBuddy reports remaining credits (`CodeBuddy 12 积分`);
 *   - every other provider reports ONLY the remaining percentage (`Grok 93%`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelDirectoriesLike } from './SpeedSelect.js'

/** How often the pill re-reads usage and the current model. */
const POLL_INTERVAL_MS = 10_000

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

/** One render-ready quota reading for a single provider. */
interface UsageReading {
  provider: SubscriptionProvider
  name: string
  windows: UsageWindow[]
  remaining?: number
  limit?: number
}

/** Compact brand names for the pill. */
const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
  agy: 'Antigravity',
  commandcode: 'Command Code',
  codebuddy: 'CodeBuddy',
  zed: 'Zed',
}

/** Providers whose quota is a credit pool rather than a percentage. */
const CREDIT_PROVIDERS = new Set<SubscriptionProvider>(['codebuddy'])

/** The default account of a provider's account list, when any is logged in. */
function defaultAccountOf(status: ProviderStatus | undefined): AccountStatus | undefined {
  if (status === undefined || status.accounts.length === 0) return undefined
  return status.accounts.find(a => a.isDefault) ?? status.accounts[0]
}

/** Compact reset countdown from a window's `resetsAt` timestamp (`6d18h`, `1h58m`, `42m`). */
function resetLabel(window: UsageWindow): string {
  if (window.resetsAt === undefined) {
    switch (window.kind) {
      case 'session': return '5h'
      case 'weekly': return 'Wk'
      default: return ''
    }
  }
  const minutes = Math.max(0, Math.floor((window.resetsAt - Date.now()) / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
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
  // Find the tightest window
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
    return `${name}: 剩余 ${left}${reading.limit !== undefined ? ` / ${creditText(reading.limit)}` : ''} 积分`
  }
  if (reading.windows.length > 0) {
    const parts = reading.windows.map(w => {
      const rem = Math.round(100 - Math.min(100, Math.max(0, w.usedPercent)))
      const reset = resetLabel(w)
      return `${rem}%${reset ? ` (${reset}后重置)` : ''}`
    })
    return `${name}: 剩余 ${parts.join(' · ')}`
  }
  if (reading.remaining !== undefined) {
    return `${name}: 剩余 ${Math.round(reading.remaining)}%`
  }
  return name
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
  const [statsRow, setStatsRow] = useState<HTMLElement | null>(null)
  const seatRef = useRef<HTMLSpanElement | null>(null)
  const inflightRef = useRef(false)
  const mountedRef = useRef(true)
  const accountsRef = useRef(new Map<SubscriptionProvider, string>())

  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined || inflightRef.current) return
    inflightRef.current = true
    try {
      const current = await currentModel?.()
      if (!mountedRef.current) return
      const provider = current?.provider as SubscriptionProvider | undefined
      if (provider === undefined || !(provider in PROVIDER_NAMES)) {
        setReading(undefined)
        return
      }

      let account = accountsRef.current.get(provider)
      if (account === undefined) {
        const statusResp = await callSubscriptionsAuth<{ providers: Record<SubscriptionProvider, ProviderStatus> }>(
          rpc, 'status', {},
        )
        if (!mountedRef.current) return
        const accounts = new Map<SubscriptionProvider, string>()
        for (const id of Object.keys(statusResp.providers) as SubscriptionProvider[]) {
          const entry = defaultAccountOf(statusResp.providers[id])
          if (entry !== undefined) accounts.set(id, entry.key)
        }
        accountsRef.current = accounts
        account = accounts.get(provider)
      }
      if (account === undefined) {
        setReading(undefined)
        return
      }

      const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account })
      if (!mountedRef.current) return
      if (!usage.supported || ((usage.windows ?? []).length === 0 && usage.remaining === undefined)) {
        setReading(undefined)
        return
      }
      setReading({
        provider,
        name: PROVIDER_NAMES[provider],
        windows: usage.windows ?? [],
        ...usage.remaining === undefined ? {} : { remaining: usage.remaining },
        ...usage.limit === undefined ? {} : { limit: usage.limit },
      })
    } catch {
      // Keep last reading on error
    } finally {
      inflightRef.current = false
    }
  }, [rpc, currentModel])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
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

  const label = reading === undefined ? '' : compactUsageLabel(reading)
  const seat = <span ref={seatRef} style={styles.seat} aria-hidden="true" />

  if (label === '' || !reading) return seat

  const tooltip = makeTooltip(reading)

  const pill = (
    <span className="bOPqQW_anchor" style={styles.anchor}>
      <button
        type="button"
        className="bOPqQW_pill"
        style={{ ...styles.pill, ...(hover ? styles.pillHover : {}) }}
        title={tooltip}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <IconDataOutline16 size={14} />
        <span className="bOPqQW_label" style={styles.label}>{label}</span>
      </button>
    </span>
  )

  return (
    <>
      {seat}
      {statsRow && statsRow.isConnected ? createPortal(pill, statsRow) : null}
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
    cursor: 'default',
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
}

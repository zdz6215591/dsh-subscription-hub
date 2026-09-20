/**
 * Subscription usage pill for the composer's dock
 * (`conversation.composer.dock`). Collapsed, it reports ONLY the quota headroom
 * of the provider behind the session's CURRENT model:
 *
 *   - CodeBuddy reports remaining credits (`CodeBuddy 12/50`);
 *   - every other provider reports a remaining percentage with its reset
 *     countdown (`Codex 62% · 6d18h`).
 *
 * The current model comes from ui-model-selection's `modelDirectories` service
 * (the host pushes nothing on a model switch); usage rides the
 * `/subscriptions-auth` `usage` endpoint, whose server-side cache is shared
 * with the Settings page. Nothing renders until the current model's provider
 * has a logged-in account that reports quota.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelDirectoriesLike } from './SpeedSelect.js'

/** How often the pill re-reads usage and the current model. */
const POLL_INTERVAL_MS = 20_000

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

/**
 * The `currentModel` half of the inject face: the session's effective model
 * selection through ui-model-selection's `modelDirectories` service, resolved
 * lazily per call (the service may register after this plugin, and a shell
 * without it simply reports "unknown", which the pill treats as "render
 * nothing").
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
 * The collapsed label for one provider reading: credits for CodeBuddy (the only
 * provider that bills in points), otherwise the tightest window's remaining
 * percentage plus that window's reset countdown.
 */
export function compactUsageLabel(reading: UsageReading): string {
  const { provider, name } = reading
  if (CREDIT_PROVIDERS.has(provider)) {
    if (reading.remaining !== undefined) {
      const left = creditText(reading.remaining)
      return reading.limit === undefined ? `${name} ${left}` : `${name} ${left}/${creditText(reading.limit)}`
    }
    // No credit pool disclosed — fall through to the window percentage.
  }
  if (reading.windows.length === 0) {
    return reading.remaining === undefined ? '' : `${name} ${String(Math.round(reading.remaining))}%`
  }
  // The tightest window is the one worth surfacing; its reset rides along.
  let tightest = reading.windows[0]!
  for (const window of reading.windows) {
    const left = 100 - Math.min(100, Math.max(0, window.usedPercent))
    const tightestLeft = 100 - Math.min(100, Math.max(0, tightest.usedPercent))
    if (left < tightestLeft) tightest = window
  }
  const left = Math.round(100 - Math.min(100, Math.max(0, tightest.usedPercent)))
  const reset = resetLabel(tightest)
  return reset === '' ? `${name} ${String(left)}%` : `${name} ${String(left)}% · ${reset}`
}

/**
 * The composer's subscription usage pill. Renders nothing until the session's
 * current model resolves to a provider with reportable quota, so a host
 * without subscriptions is untouched.
 */
export function SubscriptionUsageBadge(props: SubscriptionUsageBadgeProps) {
  const { rpc, currentModel } = props
  const [reading, setReading] = useState<UsageReading | undefined>(undefined)
  const inflightRef = useRef(false)
  const mountedRef = useRef(true)
  /** Provider → default account key, refreshed whenever the lookup misses. */
  const accountsRef = useRef(new Map<SubscriptionProvider, string>())

  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined || inflightRef.current) return
    inflightRef.current = true
    try {
      // The current model picks WHICH provider the pill reports; without a
      // resolvable model there is nothing precise to show, so stay hidden.
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
      // Unsupported or empty quota is a real answer: hide rather than guess.
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
      // A failed poll keeps the last reading; the next tick retries.
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

  const label = reading === undefined ? '' : compactUsageLabel(reading)
  if (label === '') return null

  return (
    <span style={styles.pill} title={`${reading!.name}: ${label.slice(reading!.name.length + 1)}`}>
      <span style={styles.dot} aria-hidden="true" />
      <span style={styles.label}>{label}</span>
    </span>
  )
}

const styles: Record<string, CSSProperties> = {
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 20, padding: '0 8px', borderRadius: 10,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
    fontSize: 12, lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  dot: {
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
    background: 'var(--dsw-alias-state-success-primary)',
  },
  label: { fontVariantNumeric: 'tabular-nums' },
}

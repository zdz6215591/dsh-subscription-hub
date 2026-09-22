/**
 * `/sub` — the subscription status command, rendered into the transcript.
 *
 * Why a command rather than only the Settings page: the question "how much
 * quota do I have left, and on which account?" is asked mid-conversation, and
 * answering it by opening a settings panel means leaving the conversation. The
 * composer pill covers the CURRENT model's provider; this covers everything at
 * once and can be read and scrolled like any other transcript content.
 *
 * The rendering is a pure function of the gathered facts, so it is testable
 * without any network or cordis involvement — the handler's only job is to
 * gather.
 *
 * House rules it follows:
 *
 * - **Never invent a number.** A window the provider did not report is omitted;
 *   a usage read that failed says so instead of showing 0%.
 * - **Say the consequence, not just the figure.** A window past the warning
 *   threshold is labelled, and its reset time is shown, because "96%" without
 *   "until 14:20" leaves the reader to work out the actionable part.
 * - **Plain text only.** Markdown is what the transcript renders, so the output
 *   stays within headings, lists and inline code — no tables that reflow badly
 *   at narrow widths.
 *
 * @module dsh-subscription-hub/command
 */

import type { ProviderUsage, UsageWindow } from './providers/common.js'
import type { ProviderId } from './auth/store.js'

/** One account's gathered state, for the report. */
export interface SubReportAccount {
  /** Stable account key. */
  key: string
  /** Display label, when the provider names one. */
  label?: string
  /** Whether this account currently serves requests. */
  active?: boolean
  /** The usage read, or undefined when it could not be read. */
  usage?: ProviderUsage
  /** Why the usage read failed, when it did. */
  usageError?: string
}

/** One provider's gathered state, for the report. */
export interface SubReportProvider {
  /** Route id, e.g. `codex`. */
  id: string
  /** Display name. */
  name: string
  accounts: SubReportAccount[]
}

/** Percent at which a window is worth warning about. */
const WARN_PERCENT = 80
/** Percent at which a window is effectively exhausted. */
const FULL_PERCENT = 95
/** Bar cells, kept narrow so the line does not wrap in a chat column. */
const BAR_CELLS = 12

/**
 * Render one window as a labelled bar.
 *
 * The bar is a coarse visual; the percentage beside it is the exact value, so a
 * mis-drawn block never becomes the source of truth.
 * @param window - the window to render.
 * @param now - the clock, injectable for tests.
 * @returns one line of text.
 */
export function renderWindow(window: UsageWindow, now = Date.now()): string {
  const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
  const filled = Math.round((percent / 100) * BAR_CELLS)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`
  const label = window.scope === undefined ? window.kind : `${window.kind} · ${window.scope}`
  const alert = percent >= FULL_PERCENT ? ' 🚨 exhausted' : percent >= WARN_PERCENT ? ' ⚠️ nearly full' : ''
  const reset = window.resetsAt === undefined ? '' : ` · resets ${formatReset(window.resetsAt, now)}`
  // An amount is more actionable than a percentage when the provider reports one.
  const amounts = window.used !== undefined && window.limit !== undefined
    ? ` (${formatAmount(window.used)} / ${formatAmount(window.limit)})`
    : window.remaining !== undefined && window.limit !== undefined
      ? ` (${formatAmount(window.limit - window.remaining)} / ${formatAmount(window.limit)})`
      : ''
  return `  ${label.padEnd(16)} ${bar} ${String(percent).padStart(3)}%${amounts}${reset}${alert}`
}

/** A compact amount: integers stay bare, fractions keep two places. */
function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * A reset instant as a short clock, absolute when it is not today.
 * @param resetsAt - epoch milliseconds.
 * @param now - the clock.
 * @returns e.g. `14:20` or `Sep 24 14:20`.
 */
export function formatReset(resetsAt: number, now: number): string {
  const reset = new Date(resetsAt)
  const current = new Date(now)
  const time = `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`
  const sameDay = reset.getFullYear() === current.getFullYear()
    && reset.getMonth() === current.getMonth()
    && reset.getDate() === current.getDate()
  if (sameDay) return time
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][reset.getMonth()] ?? ''
  return `${month} ${String(reset.getDate())} ${time}`
}

/** The tightest window across a provider's accounts, for the summary line. */
function tightest(provider: SubReportProvider): { percent: number; window: UsageWindow } | undefined {
  let best: { percent: number; window: UsageWindow } | undefined
  for (const account of provider.accounts) {
    for (const window of account.usage?.windows ?? []) {
      const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
      if (best === undefined || percent > best.percent) best = { percent, window }
    }
  }
  return best
}

/**
 * Render the `/sub` report.
 *
 * Providers with no account are omitted entirely: listing every unconfigured
 * route would bury the two lines the reader actually wants.
 * @param providers - the gathered providers.
 * @param now - the clock, injectable for tests.
 * @returns the transcript text.
 */
export function renderSubReport(providers: readonly SubReportProvider[], now = Date.now()): string {
  const connected = providers.filter(provider => provider.accounts.length > 0)
  if (connected.length === 0) {
    return 'No subscription is connected yet.\n\nOpen Settings → Subscriptions to sign in, or run `/sub help`.'
  }

  const lines: string[] = ['**Subscriptions**', '']
  // The tightest window leads: it is the one that will stop work soonest.
  const ranked = connected
    .map(provider => ({ provider, tight: tightest(provider) }))
    .sort((left, right) => (right.tight?.percent ?? -1) - (left.tight?.percent ?? -1))
  for (const { provider, tight } of ranked) {
    const accounts = provider.accounts.length
    const accountNote = accounts === 1 ? '1 account' : `${String(accounts)} accounts`
    const worst = tight === undefined ? '' : ` · tightest ${String(tight.percent)}%`
    lines.push(`## ${provider.name}  (${accountNote}${worst})`)
    for (const account of provider.accounts) {
      const name = account.label ?? account.key
      const marker = account.active === true ? '★ ' : ''
      lines.push(`- ${marker}${name}`)
      if (account.usageError !== undefined) {
        // Stated as a failure, never as 0%: a read that did not happen must not
        // look like an empty quota.
        lines.push(`  usage unavailable — ${account.usageError}`)
        continue
      }
      const usage = account.usage
      if (usage === undefined) {
        lines.push('  usage not read')
        continue
      }
      if (usage.supported === false) {
        lines.push('  this route exposes no usage endpoint')
        continue
      }
      if (usage.plan !== undefined) lines.push(`  plan: ${usage.plan}`)
      const windows = usage.windows ?? []
      if (windows.length === 0) {
        lines.push('  no usage window was reported')
        continue
      }
      for (const window of windows) lines.push(renderWindow(window, now))
    }
    lines.push('')
  }
  lines.push('`/sub help` lists the sub-commands.')
  return lines.join('\n')
}

/** The `/sub` help text. */
export const SUB_HELP = [
  '**`/sub` — subscription status**',
  '',
  '- `/sub` — every connected subscription, tightest quota first',
  '- `/sub <provider>` — one provider in detail, e.g. `/sub codex`',
  '- `/sub help` — this message',
  '',
  'Quota is read live, so a provider that is slow to answer delays the report.',
  'Anything the provider does not report is omitted rather than shown as 0%.',
].join('\n')

/**
 * Render one provider's detail.
 * @param provider - the provider to render.
 * @param now - the clock.
 * @returns the transcript text.
 */
export function renderSubProvider(provider: SubReportProvider, now = Date.now()): string {
  return renderSubReport([provider], now)
}

/**
 * Resolve a `/sub` argument to the provider it names.
 *
 * Accepts the route id or the display name, case-insensitively, so
 * `/sub Codex` and `/sub codex` behave alike.
 * @param argument - the raw text after `/sub`.
 * @param providers - the known providers.
 * @returns the match, or undefined when nothing matches.
 */
export function resolveSubTarget(
  argument: string,
  providers: readonly SubReportProvider[],
): SubReportProvider | undefined {
  const wanted = argument.trim().toLowerCase()
  if (wanted === '') return undefined
  return providers.find(provider => provider.id.toLowerCase() === wanted || provider.name.toLowerCase() === wanted)
}

/** The host facts the command gathers from. */
export interface SubCommandDeps {
  /** Every connected route with its accounts, as the auth layer reports it. */
  status(provider: ProviderId): Promise<{
    accounts: { key: string; label?: string; active?: boolean }[]
  }>
  /** One account's usage, or `{ supported: false }` when the route has none. */
  usage(provider: ProviderId, account: string, force: boolean): Promise<ProviderUsage>
  /** Display name for one route id. */
  providerName(provider: ProviderId): string
  /** Route ids to report on, in display order. */
  providerIds: readonly ProviderId[]
}

/** The structural face of the host `commands` service this registers against. */
interface CommandsSeam {
  register(definition: {
    name: string
    description: string
    recordInput?: boolean
    handler: (invocation: { rawInput: string }) => Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }>
  }): () => void
}

/**
 * Register the `/sub` command on the host command registry.
 *
 * Read reflectively rather than through a declared inject, because `commands` is
 * an OPTIONAL seam: a profile that does not mount it must leave this plugin an
 * LLM provider and nothing more. A cordis property access for an undeclared
 * service throws `cannot get property "commands" without inject`, which would
 * take the whole plugin's boot down on such a profile.
 *
 * `recordInput: false` because the invocation carries no payload worth
 * duplicating into the session log — the sub-command is fully described by the
 * command name itself.
 *
 * @param ctx - the plugin context to register against.
 * @param deps - the host facts the handler gathers from.
 */
export function registerSubCommand(
  ctx: { get(name: string): unknown; effect(callback: () => () => void, label: string): void },
  deps: SubCommandDeps,
): void {
  const commands = ctx.get('commands') as CommandsSeam | undefined
  if (commands === undefined || typeof commands.register !== 'function') return
  ctx.effect(() => commands.register({
    name: 'sub',
    description: 'Subscription status: quota, accounts and reset times',
    recordInput: false,
    handler: async (invocation) => {
      const argument = invocation.rawInput.trim()
      if (argument === 'help' || argument === '--help' || argument === '-h') {
        return { kind: 'success', text: SUB_HELP }
      }
      try {
        const providers = await gatherSubReport(deps)
        const target = resolveSubTarget(argument, providers)
        if (argument !== '' && target === undefined) {
          const names = providers.map(provider => provider.id).join(', ')
          return { kind: 'error', text: `No subscription named "${argument}". Known routes: ${names}\n\n${SUB_HELP}` }
        }
        return { kind: 'success', text: target === undefined ? renderSubReport(providers) : renderSubProvider(target) }
      } catch (error) {
        // A handler that rejects would surface as an opaque command failure, so
        // the failure is reported as text the reader can act on.
        return { kind: 'error', text: `Subscription status failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'dsh-subscription-hub: /sub command')
}

/**
 * Gather the report facts for every connected route.
 *
 * Usage is read per account and its failure is recorded per account rather than
 * failing the whole report: one provider's outage must not hide the others'
 * quota, which is the same containment the `status` RPC endpoint needed.
 * @param deps - the host facts.
 * @returns the gathered providers, unconnected routes omitted.
 */
export async function gatherSubReport(deps: SubCommandDeps): Promise<SubReportProvider[]> {
  const gathered: SubReportProvider[] = []
  for (const id of deps.providerIds) {
    let accounts: { key: string; label?: string; active?: boolean }[]
    try {
      accounts = (await deps.status(id)).accounts
    } catch {
      // A route whose own state cannot be read is skipped rather than aborting.
      continue
    }
    if (accounts.length === 0) continue
    const withUsage: SubReportAccount[] = []
    for (const account of accounts) {
      try {
        const usage = await deps.usage(id, account.key, false)
        withUsage.push({ ...account, usage })
      } catch (error) {
        withUsage.push({
          ...account,
          usageError: error instanceof Error ? error.message : String(error),
        })
      }
    }
    gathered.push({ id, name: deps.providerName(id), accounts: withUsage })
  }
  return gathered
}
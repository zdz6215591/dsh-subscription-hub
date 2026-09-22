/**
 * The `/sub` report renderer.
 *
 * The rules that matter are the honesty ones: a figure the provider did not
 * report must not appear as 0%, a failed read must say so, and a window near its
 * cap must state the consequence and the reset clock rather than just a number.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUB_HELP,
  formatReset,
  gatherSubReport,
  renderSubProvider,
  renderSubReport,
  renderWindow,
  resolveSubTarget,
} from '../src/command.js'
import type { SubCommandDeps, SubReportProvider } from '../src/command.js'
import type { ProviderId } from '../src/auth/store.js'

const NOON = new Date('2026-09-22T12:00:00').getTime()

/** A provider with one account reporting two windows. */
function provider(overrides: Partial<SubReportProvider> = {}): SubReportProvider {
  return {
    id: 'codex',
    name: 'ChatGPT (Codex)',
    accounts: [{
      key: 'default',
      label: 'me@example.com',
      active: true,
      usage: {
        supported: true,
        plan: 'plus',
        windows: [
          { kind: 'session', usedPercent: 42, resetsAt: NOON + 3 * 3_600_000, limit: 100, used: 42 },
          { kind: 'weekly', usedPercent: 12, resetsAt: NOON + 4 * 86_400_000, limit: 1000, used: 120 },
        ],
      },
    }],
    ...overrides,
  }
}

test('a window renders a bar, the exact percentage, and the reset clock', () => {
  const line = renderWindow(
    { kind: 'session', usedPercent: 42, resetsAt: NOON + 3 * 3_600_000, limit: 100, used: 42 },
    NOON,
  )
  // The percentage is the source of truth; the bar is only a visual.
  assert.match(line, /42%/)
  assert.match(line, /resets 15:00/)
  // The amount is more actionable than the percentage when both are disclosed.
  assert.match(line, /\(42 \/ 100\)/)
  // Both bar characters appear: a full or empty bar would mean a parsing bug.
  assert.match(line, /█/)
  assert.match(line, /░/)
})

test('the reset clock is absolute when it is not today', () => {
  const sameDay = formatReset(NOON + 3 * 3_600_000, NOON)
  assert.equal(sameDay, '15:00')
  const laterDay = formatReset(NOON + 4 * 86_400_000, NOON)
  // A bare time on a future date would be read as today.
  assert.match(laterDay, /^Sep 26 \d\d:\d\d$/)
})

test('a window near or past its cap names the consequence', () => {
  const warn = renderWindow({ kind: 'session', usedPercent: 85 }, NOON)
  assert.match(warn, /nearly full/)
  const full = renderWindow({ kind: 'session', usedPercent: 97 }, NOON)
  assert.match(full, /exhausted/)
  // Below the threshold, no alarm.
  const calm = renderWindow({ kind: 'session', usedPercent: 10 }, NOON)
  assert.equal(/nearly full|exhausted/.test(calm), false)
})

test('a window with no reported amount omits the amount rather than showing zero', () => {
  const line = renderWindow({ kind: 'weekly', usedPercent: 30 }, NOON)
  // No `(0 / 0)` and no fabricated reset.
  assert.equal(/\(/.test(line), false)
  assert.equal(/resets/.test(line), false)
  assert.match(line, /30%/)
})

test('the report ranks providers by their tightest window', () => {
  const text = renderSubReport([
    { id: 'a', name: 'Loose', accounts: [{ key: 'k', usage: { supported: true, windows: [{ kind: 'session', usedPercent: 5 }] } }] },
    { id: 'b', name: 'Tight', accounts: [{ key: 'k', usage: { supported: true, windows: [{ kind: 'session', usedPercent: 90 }] } }] },
  ], NOON)
  // The one that will stop work soonest leads, because that is what a reader
  // scanning the report is looking for.
  assert.ok(text.indexOf('Tight') < text.indexOf('Loose'), text)
  assert.match(text, /tightest 90%/)
  assert.match(text, /tightest 5%/)
})

test('a provider with no account is omitted entirely', () => {
  const text = renderSubReport([
    provider(),
    { id: 'claude', name: 'Claude (Subscription)', accounts: [] },
  ], NOON)
  // Nine unconfigured routes would bury the two lines worth reading.
  assert.equal(text.includes('Claude'), false)
  assert.match(text, /ChatGPT \(Codex\)/)
})

test('a failed usage read says so instead of showing 0%', () => {
  const text = renderSubReport([{
    id: 'trae',
    name: 'Trae',
    accounts: [{ key: 'ide:me', usageError: 'ECONNRESET' }],
  }], NOON)
  assert.match(text, /usage unavailable — ECONNRESET/)
  // The bug this guards: a read that did not happen looking like an empty quota.
  assert.equal(/\b0%/.test(text), false)
})

test('a route with no usage endpoint and one with no window are distinguished', () => {
  const text = renderSubReport([{
    id: 'grok',
    name: 'Grok',
    accounts: [
      { key: 'a', label: 'unsupported', usage: { supported: false } },
      { key: 'b', label: 'empty', usage: { supported: true, windows: [] } },
    ],
  }], NOON)
  assert.match(text, /no usage endpoint/)
  assert.match(text, /no usage window was reported/)
})

test('the active account is marked and the plan is shown when reported', () => {
  const text = renderSubProvider(provider(), NOON)
  assert.match(text, /★ me@example\.com/)
  assert.match(text, /plan: plus/)
})

test('nothing connected explains what to do rather than printing an empty list', () => {
  const text = renderSubReport([{ id: 'codex', name: 'ChatGPT (Codex)', accounts: [] }], NOON)
  assert.match(text, /No subscription is connected/)
  assert.match(text, /Settings → Subscriptions/)
})

test('a sub-command target resolves by route id or display name, case-insensitively', () => {
  const providers = [provider(), { id: 'claude', name: 'Claude (Subscription)', accounts: [] }]
  assert.equal(resolveSubTarget('codex', providers)?.id, 'codex')
  assert.equal(resolveSubTarget('  Codex ', providers)?.id, 'codex')
  assert.equal(resolveSubTarget('chatgpt (codex)', providers)?.id, 'codex')
  // An unknown name is undefined, which the handler turns into an error naming
  // the routes that DO exist rather than silently printing everything.
  assert.equal(resolveSubTarget('nope', providers), undefined)
  // No argument means "everything", which is not a failed lookup.
  assert.equal(resolveSubTarget('', providers), undefined)
})

test('the help text lists the sub-commands', () => {
  assert.match(SUB_HELP, /`\/sub`/)
  assert.match(SUB_HELP, /`\/sub <provider>`/)
  assert.match(SUB_HELP, /`\/sub help`/)
})

test('gatherSubReport contains a per-provider failure instead of aborting', async () => {
  // One route whose own state cannot be read must not hide the others' quota —
  // the same containment the `status` RPC endpoint needed.
  const deps: SubCommandDeps = {
    providerIds: ['codex', 'claude', 'grok'] as unknown as ProviderId[],
    providerName: id => `Name(${String(id)})`,
    status: async (id) => {
      if (id === ('claude' as unknown as ProviderId)) throw new Error('auth store unreadable')
      if (id === ('grok' as unknown as ProviderId)) return { accounts: [] }
      return { accounts: [{ key: 'default', active: true }] }
    },
    usage: async () => ({ supported: true, windows: [{ kind: 'session', usedPercent: 7 }] }),
  }
  const gathered = await gatherSubReport(deps)
  // The broken route is skipped; the unconnected one is omitted; the good one stays.
  assert.deepEqual(gathered.map(entry => entry.id), ['codex'])
  assert.equal(gathered[0]?.name, 'Name(codex)')
})

test('gatherSubReport records a per-account usage failure without failing the route', async () => {
  const deps: SubCommandDeps = {
    providerIds: ['codex'] as unknown as ProviderId[],
    providerName: () => 'Codex',
    status: async () => ({ accounts: [{ key: 'ok' }, { key: 'broken' }] }),
    usage: async (_provider, account) => {
      if (account === 'broken') throw new Error('rate limited')
      return { supported: true, windows: [{ kind: 'session', usedPercent: 3 }] }
    },
  }
  const gathered = await gatherSubReport(deps)
  assert.equal(gathered[0]?.accounts.length, 2)
  assert.equal(gathered[0]?.accounts[0]?.usage?.windows?.[0]?.usedPercent, 3)
  assert.equal(gathered[0]?.accounts[1]?.usageError, 'rate limited')
  // And the rendered report still shows the readable account's real figure.
  assert.match(renderSubReport(gathered, NOON), /3%/)
})
/**
 * Command Code plan gating.
 *
 * A Go-plan key lists 105 models and answers `403 MODEL_NOT_IN_PLAN` for most of
 * them. Measured on one live Go key: quota windows untouched (5h 0/3, weekly 0/6),
 * monthly credits 10, purchased 0 — so the gate is the PLAN, not the quota, and the
 * reference's rule applies: any on-demand credit opens every model, otherwise a
 * model is offered only when its minimum plan is at or below the account's.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  COMMANDCODE_MODEL_PLANS,
  modelVisibleInPlan,
  parseCommandCodeOnDemandCredits,
  parseCommandCodeSubscription,
  planDisplayName,
  planTierWeight,
} from '../src/providers/commandcode-plan.js'
import {
  clearCommandCodeUnsupported,
  readCommandCodeUnsupported,
  recordCommandCodeUnsupported,
} from '../src/providers/commandcode-unsupported.js'

test('commandcode plans: ids map to a tier, longest prefix first', () => {
  assert.equal(planTierWeight('individual-go'), 0)
  assert.equal(planTierWeight('individual-goat'), 1)
  assert.equal(planTierWeight('individual-pro-v1'), 2)
  assert.equal(planTierWeight('individual-provider'), 3)
  assert.equal(planTierWeight('teams-pro'), 2)
  assert.equal(planTierWeight('something-else'), undefined)
  assert.equal(planDisplayName('individual-go'), 'Go')
})

test('commandcode plans: a Go account sees Go models and not Pro ones', () => {
  const go = { tierWeight: 0, onDemandCredits: 0 }
  // Both spellings exist in the vendored table.
  assert.equal(modelVisibleInPlan('moonshotai/Kimi-K3', go), true)
  assert.equal(modelVisibleInPlan('Qwen/Qwen3.8-Max', go), true)
  assert.equal(modelVisibleInPlan('claude-sonnet-5', go), false, 'table says Pro')
  assert.equal(modelVisibleInPlan('claude-fable-5', go), false, 'table says Provider')
  // A model the table has never heard of fails OPEN: the server stays the authority.
  assert.equal(modelVisibleInPlan('brand-new-model-2099', go), true)
})

test('commandcode plans: any on-demand credit opens every model', () => {
  const withCredits = { tierWeight: 0, onDemandCredits: 1 }
  assert.equal(modelVisibleInPlan('claude-fable-5', withCredits), true)
  // Unknown access (unread billing) also opens everything.
  assert.equal(modelVisibleInPlan('claude-fable-5', undefined), true)
  assert.equal(modelVisibleInPlan('claude-fable-5', { onDemandCredits: 0 }), true)
})

test('commandcode plans: billing answers are read without counting the monthly allowance', () => {
  const plan = parseCommandCodeSubscription({
    success: true,
    data: { planId: 'individual-go', status: 'active', priceId: 'price_x' },
  })
  assert.equal(plan.tierWeight, 0)
  assert.equal(plan.planName, 'Go')
  // Only purchased + free credits are on-demand; monthly is the subscription itself.
  assert.equal(parseCommandCodeOnDemandCredits({ credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 } }), 0)
  assert.equal(parseCommandCodeOnDemandCredits({ credits: { monthlyCredits: 10, purchasedCredits: 4, freeCredits: 2 } }), 6)
  // A cancelled subscription gets no tier, so nothing is hidden on its word.
  assert.equal(parseCommandCodeSubscription({ data: { planId: 'individual-go', status: 'canceled' } }).tierWeight, undefined)
})

test('commandcode plans: the table numbers its rows by plan', () => {
  const plans = new Set(Object.values(COMMANDCODE_MODEL_PLANS))
  assert.deepEqual([...plans].sort(), ['go', 'goat', 'pro', 'provider'])
  assert.ok(Object.keys(COMMANDCODE_MODEL_PLANS).length > 50)
})

test('commandcode refusals: a refused model is hidden for a week, per account', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-unsupported-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal((await readCommandCodeUnsupported('acct')).size, 0)
    await recordCommandCodeUnsupported('acct', 'claude-sonnet-5-5', 'MODEL_NOT_IN_PLAN')
    assert.equal((await readCommandCodeUnsupported('acct')).has('claude-sonnet-5-5'), true)
    assert.equal((await readCommandCodeUnsupported('other')).size, 0, 'refusals belong to the credential')
    const later = await readCommandCodeUnsupported('acct', Date.now() + 8 * 24 * 60 * 60 * 1000)
    assert.equal(later.has('claude-sonnet-5-5'), false, 'an upgrade picks it up again')
    await clearCommandCodeUnsupported('acct')
    assert.equal((await readCommandCodeUnsupported('acct')).size, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

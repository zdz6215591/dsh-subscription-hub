/**
 * Zed's bundled allowance: the LIVE API must win where it speaks.
 *
 * The user reported that the real-time figure was already correct, so these pin the
 * PRECEDENCE — the pricing-page fallback added alongside it must never overwrite a
 * value the API disclosed. The fallback exists only because the API is silent about
 * the bundle on some payloads.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { parseZedUsage } from '../src/providers/zed.js'
import { parseZedAllowances, planKeyOf, ZED_UNDOCUMENTED_ALLOWANCES } from '../src/providers/zed-allowance.js'

/** A student-plan payload with whatever allowance fields the test supplies. */
function studentPayload(usage: Record<string, unknown>): unknown {
  return {
    plan: {
      plan_v3: 'zed_student',
      subscription_period: { started_at: '2026-09-03T02:36:56Z', ended_at: '2026-10-03T00:00:00Z' },
      usage: { model_requests: { used: 0, limit: { limited: 0 } }, edit_predictions: { used: 0, limit: 'unlimited' }, ...usage },
    },
    organizations: [],
  }
}

test('a LIVE allowance WINS over the documented fallback', () => {
  // The regression this guards: the fallback must never overwrite what the API said.
  // `included` is read from the TOP level of the billing/plan record, which is where
  // the live payload carries it.
  const usage = parseZedUsage(studentPayload({ spent: 2.5, included: 7 }))
  const window = (usage.windows ?? []).find(w => w.scope === 'Hosted models')
  assert.notEqual(window, undefined, 'a window must still be produced')
  assert.equal(window!.limit, 7, 'the figure the API disclosed must be the one shown')
  assert.notEqual(window!.limit, ZED_UNDOCUMENTED_ALLOWANCES.student, 'the fallback must not overwrite a live value')
})

test('the fallback is used ONLY when the payload states no allowance', () => {
  // No included/limit anywhere: the documented Student bundle stands in, which is the
  // behaviour the user confirmed was correct for their account.
  const usage = parseZedUsage(studentPayload({ model_requests: { used: 0, limit: { limited: 0 } } }))
  const window = (usage.windows ?? []).find(w => w.scope === 'Hosted models')
  assert.equal(window?.limit, ZED_UNDOCUMENTED_ALLOWANCES.student)
})

test('a live SPEND with no live cap still yields the documented bundle as the cap', () => {
  const usage = parseZedUsage(studentPayload({ spent: 2.42 }))
  const window = (usage.windows ?? []).find(w => w.scope === 'Hosted models')
  assert.equal(window?.used, 2.42, 'the live spend is reported verbatim')
  assert.equal(window?.limit, ZED_UNDOCUMENTED_ALLOWANCES.student, 'the cap comes from the bundle figure')
  assert.equal(window?.remaining, 10 - 2.42)
})

test('a live SPEND LIMIT WINS over the documented bundle', () => {
  // A spending cap is also a live figure and must not be replaced by the bundle.
  const usage = parseZedUsage(studentPayload({ spent: 1, spend_limit: 25 }))
  const window = (usage.windows ?? []).find(w => w.scope === 'Hosted models')
  assert.equal(window?.limit, 25)
})

test('the page-derived allowance is NOT the subscription price', () => {
  // The trap the old constant fell into: Zed's page carries both `$10 per month` and
  // `$5 of tokens included` for Pro, and they differ.
  const page = '<div>Free forever. $0 forever. Pro Free Trial $10 per month Unlimited edit predictions $5 of tokens included Usage-based billing beyond $5</div>'
  const parsed = parseZedAllowances(page)
  assert.equal(parsed.pro, 5, 'Pro\'s allowance is the token bundle, not the $10/month price')
  assert.notEqual(parsed.pro, 10)
  assert.equal(parsed.free, 0)
})

test('an unrecognised page shape yields NO figure rather than a misattributed one', () => {
  // The measured shape is exactly one allowance phrase. Two means the layout changed,
  // and guessing which tier owns which is what put the figure on the wrong card before.
  assert.deepEqual(parseZedAllowances('a $5 of tokens included b $9 of tokens included'), {})
  assert.deepEqual(parseZedAllowances('<div>no allowance stated</div>'), {})
})

test('plan ids map onto the page words, and Student is recognised as undocumented', () => {
  assert.equal(planKeyOf('zed_pro'), 'pro')
  assert.equal(planKeyOf('token_based_zed_pro'), 'pro')
  assert.equal(planKeyOf('zed_student'), 'student')
  // Student is NOT on the page, so it must resolve through the documented table only.
  assert.equal(parseZedAllowances('<div>$5 of tokens included $0 forever</div>').student, undefined)
  assert.equal(ZED_UNDOCUMENTED_ALLOWANCES.student, 10)
})
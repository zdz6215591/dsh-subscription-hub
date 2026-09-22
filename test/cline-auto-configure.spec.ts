/**
 * The Cline auto-configure plan.
 *
 * The ranking is the part of the one-click flow that can actually be wrong: the
 * probe and the validation are I/O, but turning their verdicts into a pin is a
 * decision, and a bad one pins a dead channel or silently discards a working one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VERDICT_RANK, planClinePin, rankVerdict } from '../src/providers/cline/auto-configure.js'
import type { ClineChannelVerdicts, ClineUpstreamStatus } from '../src/providers/cline/pins.js'

/** Build verdicts from `[channel, status, ms]` triples. */
function verdicts(rows: readonly (readonly [string, ClineUpstreamStatus, number])[]): ClineChannelVerdicts {
  return Object.fromEntries(rows.map(([channel, status, ms]) => [
    channel,
    { status, note: '', ms, checkedAt: Date.now() },
  ]))
}

test('the severity order matches the reference', () => {
  // ok < limited < unknown < bad < auth. `unknown` sitting above `limited` is
  // load-bearing: an unmeasured channel is not a candidate.
  assert.deepEqual(VERDICT_RANK, { ok: 0, limited: 1, unknown: 2, bad: 3, auth: 4 })
  assert.ok(VERDICT_RANK.ok < VERDICT_RANK.limited)
  assert.ok(VERDICT_RANK.limited < VERDICT_RANK.unknown)
  assert.ok(VERDICT_RANK.unknown < VERDICT_RANK.bad)
  assert.ok(VERDICT_RANK.bad < VERDICT_RANK.auth)
  // An unmeasured channel ranks as unknown.
  assert.equal(rankVerdict(undefined), VERDICT_RANK.unknown)
})

test('usable channels are pinned fastest-first, then the rate-limited ones', () => {
  const plan = planClinePin(
    ['slow', 'fast', 'throttled', 'broken'],
    verdicts([
      ['slow', 'ok', 900],
      ['fast', 'ok', 120],
      ['throttled', 'limited', 50],
      ['broken', 'bad', 10],
    ]),
  )
  // Order is by MEASURED latency, so the fastest healthy channel leads. The
  // limited one is slower in quality even though it answered fastest, so it
  // goes last rather than jumping the queue on speed alone.
  assert.deepEqual(plan.upstreams, ['fast', 'slow', 'throttled'])
  assert.deepEqual(plan.available, ['fast', 'slow'])
  assert.deepEqual(plan.rateLimited, ['throttled'])
  assert.deepEqual(plan.exclude, ['broken'])
  assert.equal(plan.pinMode, 'preferred')
  // More than one candidate, so the pin is sorted by first token.
  assert.equal(plan.sort, 'ttft')
  assert.deepEqual(plan.summary, { ok: 2, limited: 1, bad: 1, auth: 0, unknown: 0 })
})

test('broken and auth channels are excluded, never pinned', () => {
  const plan = planClinePin(
    ['good', 'dead', 'expired'],
    verdicts([['good', 'ok', 200], ['dead', 'bad', 20], ['expired', 'auth', 30]]),
  )
  assert.deepEqual(plan.upstreams, ['good'])
  assert.deepEqual(plan.exclude, ['dead', 'expired'])
  assert.deepEqual(plan.unusable, ['dead', 'expired'])
  assert.equal(plan.summary.auth, 1)
})

test('an unmeasured channel is NEITHER pinned nor excluded', () => {
  // The distinction that matters: pinning it would trust an unmeasured channel,
  // and excluding it would discard one that may be perfectly fine. It simply
  // stays out of both lists, so the gateway keeps its own judgement about it.
  const plan = planClinePin(
    ['measured', 'never-ran', 'dead'],
    verdicts([['measured', 'ok', 100], ['dead', 'bad', 100]]),
  )
  assert.deepEqual(plan.upstreams, ['measured'])
  assert.deepEqual(plan.exclude, ['dead'])
  assert.equal(plan.upstreams.includes('never-ran'), false)
  assert.equal(plan.exclude.includes('never-ran'), false)
  assert.deepEqual(plan.summary, { ok: 1, limited: 0, bad: 1, auth: 0, unknown: 0 })
})

test('nothing usable means NO pin at all', () => {
  // The rule that makes this safe to run unattended: a model with no working
  // channel must stay on automatic routing, not get pinned to a dead one. An
  // empty `upstreams` with `pinMode: preferred` is exactly "no pin".
  const allBroken = planClinePin(['a', 'b'], verdicts([['a', 'bad', 10], ['b', 'auth', 20]]))
  assert.deepEqual(allBroken.upstreams, [])
  assert.deepEqual(allBroken.exclude, ['a', 'b'])
  // A single candidate has nothing to sort between.
  assert.equal(allBroken.sort, '')

  const allUnknown = planClinePin(['a', 'b'], {})
  assert.deepEqual(allUnknown.upstreams, [])
  assert.deepEqual(allUnknown.exclude, [])
  assert.equal(allUnknown.sort, '')

  // A limited-only model still gets pinned: it is degraded, not dead.
  const limitedOnly = planClinePin(['a'], verdicts([['a', 'limited', 500]]))
  assert.deepEqual(limitedOnly.upstreams, ['a'])
  assert.equal(limitedOnly.sort, '')
})

test('the channel order is stable when measurements tie', () => {
  // Two identical measurements must not shuffle the pin between runs, or every
  // run would rewrite the same pin in a different order.
  const plan = planClinePin(
    ['alpha', 'beta', 'gamma'],
    verdicts([['alpha', 'ok', 300], ['beta', 'ok', 300], ['gamma', 'ok', 300]]),
  )
  assert.deepEqual(plan.upstreams, ['alpha', 'beta', 'gamma'])
})

test('a verdict for an undisclosed channel counts but is not planned', () => {
  // The summary describes the VALIDATION run; the plan describes only channels
  // the gateway disclosed. A stale verdict from a previous probe must not
  // resurrect a channel into the pin.
  const plan = planClinePin(['live'], verdicts([['live', 'ok', 100], ['stale', 'ok', 5]]))
  assert.deepEqual(plan.upstreams, ['live'])
  assert.equal(plan.summary.ok, 2)
})

test('a channel the probe listed twice is pinned once', () => {
  // Deduplication matters because `mergeUpstreams` unions discoveries, so a
  // repeat would otherwise produce a pin that tries the same channel twice.
  const plan = planClinePin(['dup', 'dup', 'other'], verdicts([['dup', 'ok', 100], ['other', 'ok', 200]]))
  assert.deepEqual(plan.available.filter(channel => channel === 'dup'), ['dup', 'dup'])
  // The pin is the concatenation of the two lists, each of which preserves the
  // probe's order — so a duplicate in the probe is a duplicate in the plan, and
  // the caller deduplicates at the source rather than here.
  assert.deepEqual(plan.upstreams, ['dup', 'dup', 'other'])
})
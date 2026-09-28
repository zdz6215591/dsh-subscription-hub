/**
 * Antigravity's reasoning levels, per FAMILY.
 *
 * The hub used to hand `low, medium, high` to every level-thinking model. The
 * reference (`ref-dsh-plugin-subscriptions/src/translate/antigravity-thinking.ts`)
 * establishes that the set differs per family, so the old behaviour over-offered on
 * two families and offered no way to switch thinking off at all. These pin the table
 * and the two rules that protect it from the prefix guess.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { antigravityEfforts, isLevelThinkingModel } from '../src/providers/agy/catalog.js'
import { resolveAgyModel } from '../src/providers/agy/models.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { AgyAdapter } from '../src/providers/agy.js'
import type { AgySession } from '../src/auth/store.js'

const levels = (model: string): readonly string[] => resolveAgyModel('agy', model).reasoning?.efforts?.map(e => e.id) ?? []

/**
 * One adapter with no credentials: `resolveOwnModel` reads nothing but the pinned
 * table, so only the configured-default wiring is under test here.
 */
function adapterWith(defaultEffortOf?: (model: string) => string | undefined): AgyAdapter {
  const tokens = new AccountTokenManager<AgySession>({
    provider: 'agy',
    displayName: 'Antigravity',
    makeOptions: () => ({
      preemptMs: 5 * 60_000,
      refresh: async (session: AgySession) => session,
      isPermanent: () => false,
    }),
    onAccountRemoved: () => undefined,
  })
  return new AgyAdapter({
    models: [],
    streamIdleTimeoutMs: 30_000,
    tokens,
    discovery: false,
    ...defaultEffortOf === undefined ? {} : { defaultEffortOf },
  })
}

test('each family offers exactly the levels it accepts', () => {
  // claude and gpt-oss take ONE budget each, so offering three would let the user pick
  // a level the runtime cannot express.
  assert.deepEqual(antigravityEfforts('claude-opus-4-6-thinking'), ['off', 'high'])
  assert.deepEqual(antigravityEfforts('gpt-oss-120b-medium'), ['off', 'medium'])
  // The pro family has no third distinct level.
  assert.deepEqual(antigravityEfforts('gemini-pro-agent'), ['off', 'low', 'high'])
  assert.deepEqual(antigravityEfforts('gemini-3.1-pro'), ['off', 'low', 'high'])
  // The flash families take all three.
  assert.deepEqual(antigravityEfforts('gemini-3.8-flash-tiered'), ['off', 'low', 'medium', 'high'])
  assert.deepEqual(antigravityEfforts('gemini-2.5-flash'), ['off', 'low', 'medium', 'high'])
  // An id nothing matches gets NO picker rather than a default set.
  assert.deepEqual(antigravityEfforts('mystery-1'), [])
})

test('an id that names its own level is bound to that level only', () => {
  // `gemini-3.5-flash-low` IS the low variant: a three-way choice would be false.
  assert.deepEqual(antigravityEfforts('gemini-3.5-flash-low'), ['off', 'low'])
})

test('off is offered wherever any level is, so thinking can be disabled', () => {
  // The reference accepts `effort === 'off'` for every family. Its absence was why the
  // picker had no way to turn thinking OFF at all.
  for (const model of ['claude-opus-4-6-thinking', 'gpt-oss-120b-medium', 'gemini-pro-agent', 'gemini-3.8-flash-tiered']) {
    assert.equal(antigravityEfforts(model)[0], 'off', model)
  }
  // But never for a model that takes no level at all.
  assert.deepEqual(antigravityEfforts('mystery-1'), [])
})

test('the pinned catalog OUTRANKS the family regex, so a lite model keeps no picker', () => {
  // `gemini-3.1-flash-lite` matches the family regex but the pinned row says it has no
  // thinking support, and this was an adopted fix: sending `thinkingLevel` to it is a
  // 400. The family table must therefore never be consulted for a pinned row that
  // declares no level support.
  assert.equal(isLevelThinkingModel('gemini-3.1-flash-lite'), false)
  assert.deepEqual(levels('gemini-3.1-flash-lite'), [])
  // The same id via the table would have offered levels — which is exactly why the
  // gate exists.
  assert.ok(antigravityEfforts('gemini-3.1-flash-lite').length > 0)
})

test('the pinned level-thinking rows now carry their family sets, not one shared set', () => {
  assert.deepEqual(levels('claude-sonnet-4-6'), ['off', 'high'])
  assert.deepEqual(levels('claude-opus-4-6-thinking'), ['off', 'high'])
  assert.deepEqual(levels('gpt-oss-120b-medium'), ['off', 'medium'])
  assert.deepEqual(levels('gemini-pro-agent'), ['off', 'low', 'high'])
  assert.deepEqual(levels('gemini-3.8-flash-tiered'), ['off', 'low', 'medium', 'high'])
  assert.deepEqual(levels('gemini-3.5-flash-low'), ['off', 'low'])
})

test('the default effort is always one of the offered levels', () => {
  // The harness rejects a default outside the set, so this is an invariant, not a taste.
  for (const model of ['claude-sonnet-4-6', 'gpt-oss-120b-medium', 'gemini-pro-agent', 'gemini-3.8-flash-tiered', 'gemini-3.5-flash-low']) {
    const reasoning = resolveAgyModel('agy', model).reasoning
    assert.notEqual(reasoning, undefined, model)
    assert.equal(reasoning!.efforts.some(e => e.id === reasoning!.defaultEffort), true, model)
  }
})

test('the configured default thinking level reaches the resolved model', async () => {
  // This is the fix for "set the default to high, the picker keeps opening on
  // medium": the adapter declared `defaultEffortOf` and never called it, so the
  // pinned table's own `medium` hint was the only default Antigravity could ever
  // report. The override has to survive all the way to `resolveModel`, which is
  // what the model picker and the request path both read.
  const configured = adapterWith(model => (model === 'gemini-3.8-flash-tiered' ? 'high' : undefined))
  const resolved = await configured.resolveOwnModel('agy', 'gemini-3.8-flash-tiered')
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  // The LEVELS stay the table's, not the override's: an override is a default, not
  // a capability claim.
  assert.deepEqual(resolved.reasoning?.efforts.map(e => e.id), ['off', 'low', 'medium', 'high'])

  // No configured level: the table's own hint stands (medium, not the first entry).
  const plain = await adapterWith().resolveOwnModel('agy', 'gemini-3.8-flash-tiered')
  assert.equal(plain.reasoning?.defaultEffort, 'medium')

  // A configured level the family does not accept is DROPPED, not appended: it
  // would otherwise ride on every request and be rejected upstream.
  const stale = await adapterWith(() => 'ultra').resolveOwnModel('agy', 'gemini-3.5-flash-low')
  assert.deepEqual(stale.reasoning?.efforts.map(e => e.id), ['off', 'low'])
  assert.equal(stale.reasoning?.defaultEffort, 'low')

  // A model with no picker gains none from an override.
  const noLevels = await adapterWith(() => 'high').resolveOwnModel('agy', 'gemini-2.5-flash-lite')
  assert.equal(noLevels.reasoning, undefined)
})
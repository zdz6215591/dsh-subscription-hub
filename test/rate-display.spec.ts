/**
 * The two new cross-provider display rules.
 *
 * `rateSuffix` is shared by Qoder, CodeBuddy and Trae, and its edge cases are the
 * whole reason it exists: a multiplier of ZERO is a free model and must render,
 * while a route that publishes NO multiplier must render nothing rather than a
 * fabricated `x1`. Conflating those two is the mistake that makes a rate display
 * lie.
 *
 * `disambiguateNames` answers "which model is this?" for a row whose upstream name
 * omits its version — without inventing the version.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateSuffix } from '../src/providers/common.js'
import { disambiguateNames, normalizeQoderModels } from '../src/providers/qoder/catalog.js'

test('a rate renders as · x<n>', () => {
  assert.equal(rateSuffix(0.79), ' · x0.79')
  assert.equal(rateSuffix(1.4), ' · x1.4')
  assert.equal(rateSuffix(1.5), ' · x1.5')
  assert.equal(rateSuffix(5), ' · x5')
  assert.equal(rateSuffix(0.06), ' · x0.06')
})

test('ZERO is a value, not an absence: a free model shows x0', () => {
  // The trap: treating 0 as "no rate" would hide the cheapest row in the list.
  assert.equal(rateSuffix(0), ' · x0')
  assert.equal(rateSuffix(0.0), ' · x0')
})

test('no published rate renders NOTHING, never a stand-in x1', () => {
  // CommandCode and Cline publish absolute prices and no ratio at all; inventing
  // `x1` there would assert a baseline that does not exist upstream.
  assert.equal(rateSuffix(undefined), '')
  assert.equal(rateSuffix(Number.NaN), '')
  assert.equal(rateSuffix(Number.POSITIVE_INFINITY), '')
  assert.equal(rateSuffix(-1), '')
  assert.equal(rateSuffix(''), '')
  assert.equal(rateSuffix('  '), '')
})

test("the upstream's own preformatted string is not double-prefixed", () => {
  // CodeBuddy sends `"x0.29"`; a bare number from the same field still formats.
  assert.equal(rateSuffix('x0.29'), ' · x0.29')
  assert.equal(rateSuffix('x0.00'), ' · x0.00')
  assert.equal(rateSuffix('0.29'), ' · x0.29')
})

test('a display name that omits its version is labelled with the upstream key', () => {
  // Live case: Qoder publishes `DeepSeek-Flash` with no version while its own
  // sibling carries one, so the name alone cannot identify the model. The key is
  // appended rather than a version being guessed.
  const models = normalizeQoderModels({ assistant: [
    { key: 'dmodel', enable: true, display_name: 'DeepSeek-V4-Pro' },
    { key: 'dfmodel', enable: true, display_name: 'DeepSeek-Flash' },
  ] })
  const byId = new Map(models.map(model => [model.id, model.name]))
  assert.equal(byId.get('dfmodel'), 'DeepSeek-Flash (dfmodel)')
  // The sibling already identifies itself, so it is left exactly as upstream wrote it.
  assert.equal(byId.get('dmodel'), 'DeepSeek-V4-Pro')
})

test('names that version themselves are never touched', () => {
  const models = normalizeQoderModels({ assistant: [
    { key: 'gmodel', enable: true, display_name: 'GLM-5.3' },
    { key: 'gfmodel', enable: true, display_name: 'GLM-5.3-Flash' },
    { key: 'gm51model', enable: true, display_name: 'GLM-5.2' },
  ] })
  assert.deepEqual(models.map(model => model.name).sort(), ['GLM-5.2', 'GLM-5.3', 'GLM-5.3-Flash'])
})

test('a single-model family is left alone', () => {
  // `Auto` has no siblings, so there is no ambiguity to resolve.
  const models = normalizeQoderModels({ assistant: [{ key: 'auto', enable: true, display_name: 'Auto' }] })
  assert.equal(models[0]?.name, 'Auto')
})

test('a differently-versioned family is left alone even when it has siblings', () => {
  const models = normalizeQoderModels({ assistant: [
    { key: 'a', enable: true, display_name: 'Kimi-K3' },
    { key: 'b', enable: true, display_name: 'Kimi-K2.8-Preview' },
  ] })
  assert.deepEqual(models.map(model => model.name).sort(), ['Kimi-K2.8-Preview', 'Kimi-K3'])
})

test('disambiguation is idempotent and does not double-apply', () => {
  const models = normalizeQoderModels({ assistant: [
    { key: 'dmodel', enable: true, display_name: 'DeepSeek-V4-Pro' },
    { key: 'dfmodel', enable: true, display_name: 'DeepSeek-Flash' },
  ] })
  disambiguateNames(models)
  disambiguateNames(models)
  assert.equal(models.find(model => model.id === 'dfmodel')?.name, 'DeepSeek-Flash (dfmodel)')
})
/**
 * Absolute price display for the two routes that publish one.
 *
 * The routes that publish a MULTIPLIER show `· x0.79`; CommandCode and Cline
 * publish no ratio at all — only US dollars per million tokens — so they show
 * `· $in/$out` instead. Both rules share one property that has to be pinned: an
 * amount is either shown COMPLETELY or not at all, because a partial one still
 * reads as a complete pair and is therefore a lie rather than a gap.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRICE_UNIT_LEGEND, priceSuffix } from '../src/providers/common.js'
import { parseModelsDevEfforts, toClineModelInfo } from '../src/providers/cline/catalog.js'
import { resolveModelPrice } from '../src/stats/model-prices.js'
import type { InputModality } from '../src/providers/modality.js'

test('a published price renders as · $in/$out', () => {
  assert.equal(priceSuffix({ input: 2.5, output: 7.5 }), ' · $2.5/$7.5')
  assert.equal(priceSuffix({ input: 2, output: 10 }), ' · $2/$10')
  assert.equal(priceSuffix({ input: 0.435, output: 0.87 }), ' · $0.43/$0.87')
  assert.equal(priceSuffix({ input: 3, output: 15 }), ' · $3/$15')
})

test('an incomplete price renders NOTHING, never half a pair', () => {
  // A lone rate would still render as `$in/$out` and misreport the other one.
  assert.equal(priceSuffix(undefined), '')
  assert.equal(priceSuffix({ input: Number.NaN, output: 5 }), '')
  assert.equal(priceSuffix({ input: 5, output: Number.NaN }), '')
  assert.equal(priceSuffix({ input: Number.POSITIVE_INFINITY, output: 5 }), '')
  assert.equal(priceSuffix({ input: -1, output: 5 }), '')
})

test('a FREE model shows $0/$0 rather than disappearing', () => {
  // 0 is a published rate, not a missing one; hiding it would drop the cheapest
  // rows from the list.
  assert.equal(priceSuffix({ input: 0, output: 0 }), ' · $0/$0')
})

test('the unit legend states what the numbers count', () => {
  // The figures alone cannot carry "per 1M tokens" in a one-line row, so the
  // legend ships beside them as the model description.
  assert.match(PRICE_UNIT_LEGEND, /USD per 1M tokens/)
  assert.match(PRICE_UNIT_LEGEND, /input\/output/)
})

test('CommandCode prices resolve for the live catalog ids', () => {
  // These are real ids from the provider's own `/models` response. Only the
  // input/output pair the display uses is pinned: the cache rates are the table's
  // own business, and asserting numbers nothing renders would only make this
  // brittle (my first version of this test guessed them, and was wrong).
  const pair = (id: string): { input: number; output: number } | undefined => {
    const rates = resolveModelPrice(id)?.rates
    return rates === undefined ? undefined : { input: rates.input, output: rates.output }
  }
  assert.deepEqual(pair('claude-sonnet-5'), { input: 2, output: 10 })
  assert.deepEqual(pair('claude-opus-5'), { input: 5, output: 25 })
  // A vendor-prefixed id resolves through the slug candidates rather than by
  // exact match, which is how the real catalog ids arrive.
  const prefixed = pair('zai-org/GLM-5.3')
  assert.ok(prefixed !== undefined && prefixed.input > 0 && prefixed.output > 0, JSON.stringify(prefixed))
})

test('a served CommandCode id never renders half a price', () => {
  // The property the display actually depends on: not "the table is big" but "a
  // row either shows a complete pair or nothing".
  for (const id of ['claude-sonnet-5', 'claude-fable-5', 'claude-opus-5-5', 'MiniMaxAI/MiniMax-M2.5']) {
    const rates = resolveModelPrice(id)?.rates
    assert.ok(rates !== undefined, `${id} has no vendored price`)
    assert.ok(priceSuffix({ input: rates.input, output: rates.output }).startsWith(' · $'), id)
  }
})

test('Cline reads the price models.dev publishes beside the metadata it already read', () => {
  // The parser read `limit`, `modalities` and `reasoning_options` from this entry
  // and discarded `cost`; this asserts the sibling field is now kept.
  const registry = {
    'cline-pass': {
      models: {
        'cline-pass/qwen3.7-max': {
          reasoning: true,
          reasoning_options: [{ values: ['low', 'high'] }],
          limit: { context: 200_000, output: 32_000 },
          cost: { input: 2.5, output: 7.5, cache_read: 0.5 },
        },
      },
    },
  }
  const parsed = parseModelsDevEfforts('cline-pass/qwen3.7-max', registry)
  assert.deepEqual(parsed?.price, { input: 2.5, output: 7.5 })
  // The pre-existing reads still work — the price is an addition, not a swap.
  assert.equal(parsed?.contextWindow, 200_000)
  assert.deepEqual(parsed?.efforts, ['none', 'low', 'high'])
})

test('a models.dev entry with a partial cost contributes no price', () => {
  const registry = { 'cline-pass': { models: { 'cline-pass/x': { cost: { input: 1 } } } } }
  assert.equal(parseModelsDevEfforts('cline-pass/x', registry)?.price, undefined)
})

test('an entry with no cost block contributes no price but keeps its metadata', () => {
  const registry = { 'cline-pass': { models: { 'cline-pass/y': { limit: { context: 100_000 } } } } }
  const parsed = parseModelsDevEfforts('cline-pass/y', registry)
  assert.equal(parsed?.price, undefined)
  assert.equal(parsed?.contextWindow, 100_000)
})

test('a Cline row without a price shows its bare name', () => {
  const base = {
    id: 'cline-pass/x', name: 'X', contextWindow: 1, maxTokens: 1,
    input: ['text'] as InputModality[], reasoning: true, source: 'static' as const,
  }
  assert.equal(toClineModelInfo({ ...base }, 'cline').name, 'X')
  assert.equal(toClineModelInfo({ ...base, price: { input: 2, output: 6 } }, 'cline').name, 'X · $2/$6')
  // And the description appears only when there is a figure to explain.
  assert.equal(toClineModelInfo({ ...base }, 'cline').description, undefined)
  assert.equal(toClineModelInfo({ ...base, price: { input: 2, output: 6 } }, 'cline').description, PRICE_UNIT_LEGEND)
})
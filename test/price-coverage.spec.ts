/**
 * Price coverage for the models the subscription routes actually serve.
 *
 * The gap this file closes was reported as a symptom, not a bug report: on the
 * `commandcode` route some models showed no price and newly released ones never
 * did. The cause was that the vendored table is a SNAPSHOT of the vendor's
 * pricing page while the route serves a LIVE catalog, so every model the vendor
 * ships after a snapshot has no row — and a route with no row shows an empty
 * price cell. Nothing failed; the cell was just empty.
 *
 * Two guards, chosen so a regression is loud rather than silent:
 *
 * - Every id in {@link COMMANDCODE_PUBLISHED_MODELS} — the generated snapshot of
 *   the vendor's own model table, refreshed by `scripts/sync-commandcode-models.mjs`
 *   — must resolve to a price, EXCEPT for ids listed in {@link UNPRICED_BY_DESIGN}
 *   with the reason. A new upstream model therefore fails THIS test the moment the
 *   sync script adds it, instead of shipping an empty price cell.
 * - The wire ids the live catalog serves that the vendor's model table does not
 *   carry are pinned explicitly, with the disposition observed on 2026-09-29, so
 *   each one is a visible decision.
 *
 * Offline: no network, no credentials. The live observations are recorded as
 * literals, which is what makes them reviewable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceLabel } from '../src/providers/common.js'
import { resolveModelPrice } from '../src/stats/model-prices.js'
import { COMMANDCODE_PUBLISHED_MODELS } from '../src/providers/commandcode-models.js'

/**
 * Vendored ids that stay UNPRICED on purpose, with the reason.
 *
 * Both appear on the vendor's pricing page ONLY through a time-limited deal, and
 * the page is the plugin's only rate source. Its `deal` block says
 * `{"discountPercent":100,"free":true,"endsWhen":"while it lasts"}` with
 * `tiers[].rates` all zero, and the same page still carries those zeros for
 * `ling-3.0-flash-free` whose own `expires` date (2026-08-02) is already past —
 * so the zero describes a promotion, not a rate. Charging one would report real
 * spend as free the day the deal ends, which is exactly the fabricated-zero case
 * the table refuses: a wrong zero is worse than an absent price.
 */
const UNPRICED_BY_DESIGN: Readonly<Record<string, string>> = {
  'poolside/laguna-s-2.1-free': 'free-deal promo: the page publishes no rate, only a time-limited `deal` block',
  'inclusionai/ling-3.0-flash-sante:free': 'free-deal promo: same shape, and the page\'s own deal for it says "while it lasts"',
}

test('every model in the vendor\'s published table resolves to a price', () => {
  const missing = Object.keys(COMMANDCODE_PUBLISHED_MODELS)
    .filter(id => UNPRICED_BY_DESIGN[id] === undefined)
    .filter(id => resolveModelPrice(id).rates === undefined)
  // A failure here is not "the table is too small": it means upstream shipped a
  // model (or moved a rate) and nobody re-read the pricing page. Name them all so
  // one run reports every gap.
  assert.deepEqual(missing, [], `no price row for: ${missing.join(', ')}`)
})

test('the ids left unpriced on purpose are still exactly the ones with a reason', () => {
  for (const [id, reason] of Object.entries(UNPRICED_BY_DESIGN)) {
    assert.equal(resolveModelPrice(id).source, 'unpriced', `${id} is priced now — drop it from the list`)
    assert.equal(resolveModelPrice(id).rates, undefined, id)
    assert.equal(priceLabel(resolveModelPrice(id).rates), '', `${id}: no rate must render no label`)
    assert.ok(reason.length > 0, id)
  }
})

test('the live catalog ids the vendor\'s model table does not carry each have a verdict', () => {
  // Observed in `GET https://api.commandcode.ai/provider/v1/models` on 2026-09-29
  // (86 ids total), filtered to the ones absent from COMMANDCODE_PUBLISHED_MODELS.
  // Those are the ids the sync of the vendor's MODEL table cannot guard, so they
  // are pinned here by hand.
  const priced: readonly string[] = [
    // Added by the 2026-09-29 coverage audit from the pricing page, which the
    // catalog itself never carries a rate for (its records hold exactly
    // id/object/created/owned_by/name/context_length/supported_endpoints).
    'claude-sonnet-5-5',
    'gpt-6.1-sol',
    'deepseek/deepseek-v4.1-flash-fast',
  ]
  const unpriced: readonly string[] = [
    // Stealth previews: the page's only statement is a free `deal` block.
    'stealth/space-bunny-alpha',
    'stealth/pixel-canary',
    // A free-deal promo, same shape as the entries in UNPRICED_BY_DESIGN.
    'inclusionai/ling-3.1-flash:free',
  ]
  for (const id of priced) {
    const resolved = resolveModelPrice(id)
    assert.equal(resolved.source, 'catalog', `${id} must be priced`)
    assert.ok(resolved.price !== undefined, id)
  }
  for (const id of unpriced) {
    assert.equal(resolveModelPrice(id).source, 'unpriced', `${id} must stay unpriced`)
  }
})

test('a newly shipped model with no row is reported, not priced at zero', () => {
  // The shape of the reported symptom, pinned as a property: an id the table has
  // never seen contributes NO cost and reports that it is unpriced, so a savings
  // figure never absorbs an invented amount and the caller can label the gap.
  const unknown = resolveModelPrice('commandcode/model-shipped-after-this-snapshot')
  assert.equal(unknown.source, 'unpriced')
  assert.equal(unknown.rates, undefined)
})

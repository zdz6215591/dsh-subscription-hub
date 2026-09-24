/**
 * The governing rule, pinned in one place:
 *
 *   **An absent fact must render as ABSENT, never as a plausible default.**
 *
 * These tests exist because the opposite shipped and cost the user real trust: a
 * broken Trae directory fetch served eight hardcoded models, so a dead route
 * rendered exactly like a healthy one and the numbers on screen could not be
 * told apart from real ones. Each test below asserts an ABSENCE, which is why
 * most of them read as `undefined` / `[]` rather than as a value.
 *
 * The counterpart rule matters just as much: protocol mechanics (a retry, a
 * version header, a token-refresh guard) must stay, because removing those
 * breaks working code without removing any claim about a model. Nothing here
 * asserts on those.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import {
  normalizeQoderModels,
} from '../src/providers/qoder/catalog.js'
import { priceLabel } from '../src/providers/common.js'
import { priceUsage, resolveModelPrice } from '../src/stats/model-prices.js'
import { clineModel } from '../src/providers/cline/catalog.js'
import { fetchTraeModels } from '../src/providers/trae/catalog.js'
import type { FetchFn } from '../src/providers/common.js'
import type { AgySession } from '../src/auth/store.js'

/** A fetcher that answers every request with a 500, so nothing is discoverable. */
const nothingFetched: FetchFn = (() => Promise.resolve(new Response('{}', { status: 500 }))) as unknown as FetchFn

// ---------------------------------------------------------------------------
// 1. No discovery → no fabricated rows, and the absence is reported.
// ---------------------------------------------------------------------------

test('a Trae route with no discovery lists no models and reports why', async () => {
  const read = await fetchTraeModels('token', 'user', 'solo', undefined, nothingFetched)
  assert.deepEqual(read.models, [], 'an empty discovery must yield an empty roster')
  assert.notEqual(read.notFetched, undefined, 'the failure must be reported, not masked')
  assert.match(read.notFetched!.what, /no model roster/u)
  assert.ok(read.notFetched!.detail.length > 0, 'the reason must say which read failed')
})

test('no built-in catalog can be reached through the plugin surface', async () => {
  // `DEFAULT_MODELS` was the largest single source of fabricated rosters: every
  // adapter's failure branch served it because `resolveCatalog` never returned an
  // empty list. If it comes back, this fails.
  const plugin = await import('../src/index.js')
  assert.equal('DEFAULT_MODELS' in plugin, false)
})

test('an id no source described carries no capability at all', () => {
  // Cline keeps the id (dropping it would hide a model the user pays for) and
  // claims nothing about it. All three fields used to be invented.
  const unknown = clineModel('cline-pass/never-heard-of-it')
  assert.equal(unknown.name, 'Never Heard Of It', 'the display name is derived from the id, not invented')
  assert.equal(unknown.contextWindow, undefined)
  assert.equal(unknown.maxTokens, undefined)
  assert.equal(unknown.reasoning, undefined)
  assert.equal(unknown.efforts, undefined)
})

// ---------------------------------------------------------------------------
// 2. An unread capability is absent, not a default.
// ---------------------------------------------------------------------------

test('a Qoder model that declared no capacity reports no capacity', () => {
  const [model] = normalizeQoderModels({ assistant: [{ key: 'x', enable: true }] })
  assert.notEqual(model, undefined)
  assert.equal(model!.contextWindow, undefined, 'an unread window must be absent, not 180000')
  assert.equal(model!.maxTokens, undefined, 'an unread cap must be absent, not 32768')
})

test('a declared capacity is still reported verbatim', () => {
  // The rule removes GUESSES, not readings: a disclosed value must survive.
  const [model] = normalizeQoderModels({
    assistant: [{ key: 'x', enable: true, max_input_tokens: 262_144, max_output_tokens: 65_536 }],
  })
  assert.equal(model!.contextWindow, 262_144)
  assert.equal(model!.maxTokens, 65_536)
})

// ---------------------------------------------------------------------------
// 3. An unpriced model contributes no cost.
// ---------------------------------------------------------------------------

test('an unpriced model contributes no cost rather than a guessed one', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  const unlisted = priceUsage('some-model-nobody-prices', undefined, usage)
  assert.equal(unlisted.usd, 0, 'no published rate must contribute nothing')
  assert.equal(unlisted.priced, false)
  assert.equal(unlisted.unpriced, true)

  // A published row still prices, so the rule did not disable pricing itself.
  const listed = priceUsage('claude-sonnet-5', undefined, usage)
  assert.equal(listed.priced, true)
  assert.equal(listed.unpriced, false)
  assert.ok(listed.usd > 0)
})

test('a vendor-name substring no longer prices a model', () => {
  // This is the exact shape of the removed guess: `z-ai/glm-5.3-flashx` contains
  // `glm`, so the family rule charged GLM's own rates for a resold model.
  assert.equal(resolveModelPrice('z-ai/glm-5.3-flashx').source, 'unpriced')
  assert.equal(resolveModelPrice('z-ai/glm-5.3-flashx').rates, undefined)
  // And no half-price suffix is rendered for it either.
  assert.equal(priceLabel(resolveModelPrice('z-ai/glm-5.3-flashx').rates), '')
})

// ---------------------------------------------------------------------------
// 4. A route whose discovery FAILS serves no roster at all — including Agy, whose
//    fallback was the largest one left and is deliberately not deleted outright.
// ---------------------------------------------------------------------------

test('an Agy route with no discovery lists no models and reports why', async () => {
  const { AgyAdapter } = await import('../src/providers/agy.js')
  const { AccountTokenManager } = await import('../src/providers/accounts.js')
  const warnings: string[] = []
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
  const adapter = new AgyAdapter({
    models: [],
    streamIdleTimeoutMs: 30_000,
    tokens,
    discovery: true,
    onWarn: message => warnings.push(message),
    fetchFn: nothingFetched,
  })

  // No credential is stored, so there is nothing to discover FROM: the route must
  // report that rather than substituting the pinned catalog. Before this change it
  // returned twelve models here, which is what made a dead route look alive.
  const models = await adapter.listOwnModels('agy')
  assert.equal(models.length, 0, 'Agy must serve no roster when nothing was read')
  for (const id of ['gemini-3.8-flash-tiered', 'claude-sonnet-4-6']) {
    assert.equal(models.some(model => model.id === id), false, id + ' must not appear from a built-in list')
  }

  // The pinned catalog is NOT deleted: it remains the capability source for ids the
  // LIVE endpoint returns. Deleting it would drop a real disclosure, because Agy's
  // endpoint publishes no capabilities of its own.
  const { catalogModel, AGY_PUBLIC_MODELS } = await import('../src/providers/agy/catalog.js')
  assert.ok(AGY_PUBLIC_MODELS.length > 0, 'the pinned capability table must stay for live ids')
  const first = AGY_PUBLIC_MODELS[0]!
  assert.equal(catalogModel(first.id)?.contextLength, first.contextLength, 'a live id still resolves its pinned capability')
})
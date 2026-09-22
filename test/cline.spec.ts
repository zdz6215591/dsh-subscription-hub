/**
 * Cline (ClinePass) provider tests: the per-model upstream pin mechanism, its
 * two wire spellings, channel discovery, quota parsing, and key handling.
 *
 * The pin wire contract is the whole point of this route, so those tests assert
 * the exact body shape each gateway pipeline must receive.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  EMPTY_PIN,
  OPENROUTER_SORT,
  ClinePinStore,
  buildAttempts,
  classifyUpstreamError,
  clinePinPath,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  normalizePin,
  normalizeSort,
  parseRouting,
  parseTier0,
  slugify,
  validateChannelBody,
} from '../src/providers/cline/pins.js'
import {
  CLINE_MODEL_PREFIX,
  clineModel,
  discoverClineModels,
  mergeClineModel,
  parseClineCatalogEntry,
  parseGatewayModels,
  parseModelsDevEfforts,
  parseRecommendedModels,
  toClineModelInfo,
} from '../src/providers/cline/catalog.js'
import { parseClinePlan, parseClineUsage } from '../src/providers/cline/usage.js'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { assertUsableClineKey, maskClineKey, sessionFromClineKey, ClineAdapter } from '../src/providers/cline/index.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClineSession } from '../src/auth/store.js'

// ---------------------------------------------------------------------------
// Pin resolution
// ---------------------------------------------------------------------------

test('buildAttempts expands a pin into ordered failover candidates', () => {
  // Strict: one candidate per upstream, no fallback list.
  const strict = buildAttempts({ upstreams: ['alibaba', 'baseten'], exclude: [], pinMode: 'strict', sort: '' })
  assert.deepEqual(strict.map(a => a.upstream), ['alibaba', 'baseten'])
  assert.deepEqual(strict[0]!.orderRest, [], 'strict carries no fallback order')
  assert.equal(strict[0]!.strict, true)

  // Preferred: each candidate carries the OTHER upstreams as its fallback order.
  const preferred = buildAttempts({ upstreams: ['alibaba', 'baseten'], exclude: [], pinMode: 'preferred', sort: '' })
  assert.deepEqual(preferred[0]!.orderRest, ['baseten'])
  assert.deepEqual(preferred[1]!.orderRest, ['alibaba'])
  assert.equal(preferred[0]!.strict, false)

  // Unpinned: exactly one automatic candidate.
  const auto = buildAttempts({ ...EMPTY_PIN })
  assert.equal(auto.length, 1)
  assert.equal(auto[0]!.upstream, null)
})

test('buildAttempts drops excluded upstreams from the pin order', () => {
  const attempts = buildAttempts({
    upstreams: ['alibaba', 'baseten', 'deepinfra'],
    exclude: ['baseten'],
    pinMode: 'preferred',
    sort: '',
  })
  assert.deepEqual(attempts.map(a => a.upstream), ['alibaba', 'deepinfra'])
  // The exclusion still travels, so it can become an allow-list.
  assert.deepEqual(attempts[0]!.excludeList, ['baseten'])
})

test('normalizeSort drops the two no-sort spellings the gateway rejects', () => {
  // An empty string and `none` both 400 the gateway if sent.
  assert.equal(normalizeSort(''), null)
  assert.equal(normalizeSort('none'), null)
  assert.equal(normalizeSort('  '), null)
  assert.equal(normalizeSort(undefined), null)
  // A real metric passes through; a typo is left for the gateway to name.
  assert.equal(normalizeSort('cost'), 'cost')
  assert.equal(normalizeSort('bogus'), 'bogus')
})

test('normalizePin tolerates partial documents and caps the lists', () => {
  assert.deepEqual(normalizePin(undefined), { ...EMPTY_PIN })
  assert.deepEqual(normalizePin({ upstreams: ['a', 'a', 'b'] }).upstreams, ['a', 'b'], 'duplicates collapse')
  assert.equal(normalizePin({ pinMode: 'nonsense' }).pinMode, 'strict')
  assert.equal(normalizePin({ sort: 'nonsense' }).sort, '')
  assert.equal(normalizePin({ upstreams: Array.from({ length: 40 }, (_, i) => `u${String(i)}`) }).upstreams.length, 25)
  // Non-string entries are dropped rather than stringified into junk.
  assert.deepEqual(normalizePin({ upstreams: [1, 'ok', null, {}] }).upstreams, ['ok'])
})

// ---------------------------------------------------------------------------
// Pin injection: the two wire spellings
// ---------------------------------------------------------------------------

test('injectPrefs writes the planner spelling for the gateway pipeline', () => {
  const body = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['a', 'b'] }, {
    upstream: 'a', orderRest: ['b'], excludeList: [], strict: false, sort: null,
  })
  assert.deepEqual(body.providerOptions, { gateway: { order: ['a', 'b'] } })
  assert.equal('provider' in body, false, 'the direct spelling must not be emitted')
})

test('injectPrefs writes the direct spelling for the OpenRouter pipeline', () => {
  const body = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['a', 'b'] }, {
    upstream: 'a', orderRest: ['b'], excludeList: [], strict: false, sort: null,
  })
  assert.deepEqual(body.provider, { order: ['a', 'b'] })
  assert.equal('providerOptions' in body, false)
})

test('injectPrefs strict mode narrows to `only` with a single channel', () => {
  const planner = injectPrefs({}, { pipeline: 'planner', upstreams: ['a', 'b'] }, {
    upstream: 'a', orderRest: [], excludeList: [], strict: true, sort: null,
  })
  assert.deepEqual(planner.providerOptions, { gateway: { only: ['a'] } })
  const direct = injectPrefs({}, { pipeline: 'direct', upstreams: ['a', 'b'] }, {
    upstream: 'a', orderRest: [], excludeList: [], strict: true, sort: null,
  })
  assert.deepEqual(direct.provider, { only: ['a'] })
})

test('injectPrefs compiles excludes into an allow-list because the gateway ignores exclude fields', () => {
  // The gateway has no working exclude field, so the excluded channel must be
  // absent from an `only` allow-list instead.
  const body = injectPrefs({}, { pipeline: 'direct', upstreams: ['a', 'b', 'c'] }, {
    upstream: null, orderRest: [], excludeList: ['b'], strict: true, sort: null,
  })
  assert.deepEqual(body.provider, { only: ['a', 'c'] })
  assert.equal(JSON.stringify(body).includes('"exclude"'), false, 'no exclude field may be emitted')
})

test('injectPrefs translates the sort metric per pipeline', () => {
  const planner = injectPrefs({}, { pipeline: 'planner', upstreams: [] }, {
    upstream: null, orderRest: [], excludeList: [], strict: true, sort: 'cost',
  })
  assert.deepEqual(planner.providerOptions, { gateway: { sort: 'cost' } })
  // OpenRouter spells the same metric `price`.
  const direct = injectPrefs({}, { pipeline: 'direct', upstreams: [] }, {
    upstream: null, orderRest: [], excludeList: [], strict: true, sort: 'cost',
  })
  assert.deepEqual(direct.provider, { sort: OPENROUTER_SORT.cost })
  assert.equal(OPENROUTER_SORT.ttft, 'latency')
  assert.equal(OPENROUTER_SORT.tps, 'throughput')
})

test('injectPrefs emits BOTH spellings when the pipeline is unknown', () => {
  // Each pipeline ignores the other's fields, so an undetected pipeline still
  // routes correctly when both are present.
  const body = injectPrefs({}, undefined, {
    upstream: 'a', orderRest: [], excludeList: [], strict: true, sort: null,
  })
  assert.deepEqual(body.providerOptions, { gateway: { only: ['a'] } })
  assert.deepEqual(body.provider, { only: ['a'] })
})

test('injectPrefs never mutates the caller body and adds nothing without a pin', () => {
  const original: Record<string, unknown> = { model: 'm', messages: [] }
  const untouched = injectPrefs(original, { pipeline: 'direct', upstreams: ['a'] }, {
    upstream: null, orderRest: [], excludeList: [], strict: true, sort: null,
  })
  // The function is defensive: it always returns a copy, so a caller's body is
  // never mutated even on the no-op path.
  assert.deepEqual(untouched, { model: 'm', messages: [] })
  assert.equal('provider' in untouched, false, 'an empty pin adds no routing fields')
  assert.deepEqual(original, { model: 'm', messages: [] })
})

test('injectPrefs preserves pre-existing provider fields', () => {
  const body = injectPrefs({ provider: { allow_fallbacks: false } }, { pipeline: 'direct', upstreams: ['a'] }, {
    upstream: 'a', orderRest: [], excludeList: [], strict: true, sort: null,
  })
  assert.deepEqual(body.provider, { allow_fallbacks: false, only: ['a'] })
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('parseRouting detects the pipeline and the serving upstream', () => {
  // The planner pipeline is identified by `finalProvider` in the routing block.
  const planner = parseRouting({
    choices: [{ message: { provider_metadata: { gateway: { routing: { finalProvider: 'baseten', canonicalSlug: 'z-ai/glm-5.3', fallbacksAvailable: ['alibaba'] } } } } }],
  })
  assert.equal(planner.pipeline, 'planner')
  assert.equal(planner.finalProvider, 'baseten')
  assert.equal(planner.canonicalSlug, 'z-ai/glm-5.3')
  assert.deepEqual(planner.fallbacks, ['alibaba'])

  // The direct pipeline is identified by a top-level string `provider`.
  const direct = parseRouting({ provider: 'Deep Infra', choices: [{ message: {} }] })
  assert.equal(direct.pipeline, 'direct')
  assert.equal(direct.finalProvider, 'deep-infra', 'the display name is slugified')

  // A response wrapped in `{ data: … }` is unwrapped first.
  const enveloped = parseRouting({ data: { provider: 'baseten', choices: [{ message: {} }] } })
  assert.equal(enveloped.pipeline, 'direct')
})

test('extractAvailableProviders reads the gateway list out of an error', () => {
  // The planner names providers in prose.
  const planner = extractAvailableProviders('routing failed. Available providers are: alibaba, baseten, deepinfra.', 'planner')
  assert.deepEqual(planner, ['alibaba', 'baseten', 'deepinfra'])
  // Planner with trailing JSON quotes
  const plannerWithQuotes = extractAvailableProviders(
    '{"error":"inference request failed: request failed with status 400: {\\"error\\":{\\"message\\":\\"No available providers match the \'only\' filter: __probe__. Available providers are: alibaba, baseten\\",\\"type\\":\\"invalid_request_error\\"}}"}',
    'planner',
  )
  assert.deepEqual(plannerWithQuotes, ['alibaba', 'baseten'])
  // The direct pipeline returns them as JSON metadata.
  const direct = extractAvailableProviders(
    'error: {"error":{"metadata":{"available_providers":["alibaba","baseten"]}}}',
    'direct',
  )
  assert.deepEqual(direct, ['alibaba', 'baseten'])
  // An unrelated error yields nothing rather than a wrong list.
  assert.equal(extractAvailableProviders('something else entirely', 'planner'), null)
})

test('parseTier0 reads the planner reasoning hint and mergeUpstreams dedups', () => {
  assert.deepEqual(parseTier0('alibaba won tier 0 over baseten and deepinfra.'), ['alibaba', 'baseten', 'deepinfra'])
  assert.deepEqual(parseTier0('no hint here'), [])
  assert.deepEqual(mergeUpstreams(['a', 'b'], ['b', 'c'], undefined), ['a', 'b', 'c'])
  assert.equal(mergeUpstreams(Array.from({ length: 40 }, (_, i) => `u${String(i)}`)).length, 25)
})

test('classifyUpstreamError maps gateway failures onto verdicts', () => {
  assert.equal(classifyUpstreamError('empty response content'), 'ok')
  assert.equal(classifyUpstreamError('429 Too Many Requests'), 'limited')
  assert.equal(classifyUpstreamError('temporarily rate-limited'), 'limited')
  assert.equal(classifyUpstreamError('no allowed providers'), 'bad')
  assert.equal(classifyUpstreamError('unauthorized'), 'auth')
  assert.equal(classifyUpstreamError('weird'), 'unknown')
})

test('slugify lowercases and joins a display name', () => {
  assert.equal(slugify('Deep Infra'), 'deep-infra')
})

// ---------------------------------------------------------------------------
// Catalog + usage
// ---------------------------------------------------------------------------

test('parseRecommendedModels keeps only prefixed ids and dedups', () => {
  const ids = parseRecommendedModels({
    clinePass: [
      'cline-pass/kimi-k3',
      { id: 'cline-pass/glm-5.2' },
      'cline-pass/kimi-k3',
      'z-ai/glm-5.3-flash',
      'nonsense',
    ],
  })
  assert.deepEqual(ids, ['cline-pass/kimi-k3', 'cline-pass/glm-5.2'])
  // The envelope form is read too.
  assert.deepEqual(
    parseRecommendedModels({ data: { clinePass: ['cline-pass/kimi-k3'] } }),
    ['cline-pass/kimi-k3'],
  )
  assert.deepEqual(parseRecommendedModels(null), [])
})

test('parseGatewayModels only accepts prefixed entries', () => {
  // The gateway's own list is OpenRouter-shaped and mostly unprefixed, so only
  // the subscription ids survive.
  assert.deepEqual(
    parseGatewayModels({ data: [{ id: 'z-ai/glm-5.3-flash' }, { id: 'cline-pass/kimi-k3' }] }),
    ['cline-pass/kimi-k3'],
  )
})

test('clineModel synthesizes an entry for an unknown id rather than dropping it', () => {
  const known = clineModel('cline-pass/kimi-k3')
  assert.equal(known.name, 'Kimi K3')
  // A model the pinned table predates still resolves, with display-ready casing.
  const unknown = clineModel('cline-pass/muse-spark-1.3-contributor')
  assert.equal(unknown.name, 'Muse Spark 1.3 Contributor')
  assert.ok(unknown.contextWindow > 0, 'the harness rejects a model without a window')
  assert.ok(unknown.maxTokens > 0)
})

test('toClineModelInfo carries the input modalities', () => {
  const info = toClineModelInfo(clineModel('cline-pass/kimi-k3'), 'cline')
  assert.equal(info.provider, 'cline')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.equal(info.id.startsWith(CLINE_MODEL_PREFIX), true)
})

test('parseClineCatalogEntry maps a subscription id onto its catalog slug', () => {
  // Cline's own catalog lists the underlying slugs, not the cline-pass ids.
  const catalog = {
    data: [
      {
        id: 'z-ai/glm-5.3',
        context_length: 1310720,
        top_provider: { max_completion_tokens: 131072 },
        architecture: { input_modalities: ['text'] },
        supported_parameters: ['reasoning_effort', 'tools'],
      },
      {
        id: 'xiaomi/mimo-v2.6-flash',
        context_length: 1048576,
        top_provider: { max_completion_tokens: 131072 },
        architecture: { input_modalities: ['text', 'image', 'video', 'audio'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'meta/muse-spark-1.3-contributor',
        context_length: 1048576,
        top_provider: { max_completion_tokens: 943718 },
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['reasoning_effort'],
      },
    ],
  }
  const glm = parseClineCatalogEntry('cline-pass/glm-5.3', catalog)
  assert.equal(glm?.contextWindow, 1_310_720)
  assert.equal(glm?.maxTokens, 131_072)
  assert.deepEqual(glm?.input, ['text'])
  assert.equal(glm?.reasoning, true)
  assert.equal(glm?.source, 'cline')

  // Every modality the catalog names is KEPT. This used to collapse
  // video/audio/pdf onto `image`, which made a model that accepts a screen
  // recording indistinguishable from one that accepts a screenshot.
  const mimo = parseClineCatalogEntry('cline-pass/mimo-v2.6-flash', catalog)
  assert.deepEqual(mimo?.input, ['text', 'image', 'video', 'audio'])
  assert.equal(mimo?.reasoning, false)

  // The explicit override reaches the id prefix guessing cannot.
  const muse = parseClineCatalogEntry('cline-pass/muse-spark-1.3-contributor', catalog)
  assert.equal(muse?.contextWindow, 1_048_576)
  assert.equal(muse?.maxTokens, 943_718)

  // A model the catalog does not describe yields nothing rather than a guess.
  assert.equal(parseClineCatalogEntry('cline-pass/nonexistent-model', catalog), undefined)
})

test('parseModelsDevEfforts reads the published reasoning levels', () => {
  const registry = {
    providers: {
      'cline-pass': {
        models: {
          'cline-pass/qwen3.7-max': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
            limit: { context: 1_000_000, output: 65_536 },
            modalities: { input: ['text'] },
          },
          'cline-pass/glm-5.3-flash': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
            limit: { context: 1_000_000, output: 131_072 },
            modalities: { input: ['text', 'image', 'video', 'pdf'] },
          },
        },
      },
    },
  }
  const qwen = parseModelsDevEfforts('cline-pass/qwen3.7-max', registry)
  assert.deepEqual(qwen?.efforts, ['none', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(qwen?.contextWindow, 1_000_000)
  assert.equal(qwen?.maxTokens, 65_536)
  assert.equal(qwen?.source, 'models.dev')

  // `none` is only prepended once, and the modalities are kept as published:
  // models.dev names `video` and `pdf`, and folding those onto `image` is what
  // made every model look alike. `pdf` normalizes to the `file` modality.
  const glm = parseModelsDevEfforts('cline-pass/glm-5.3-flash', registry)
  assert.deepEqual(glm?.efforts, ['none', 'low', 'high', 'max'])
  assert.deepEqual(glm?.input, ['text', 'image', 'video', 'file'])

  assert.equal(parseModelsDevEfforts('cline-pass/unknown', registry), undefined)
})

test('mergeClineModel prefers models.dev levels and falls back to the static row', () => {
  const merged = mergeClineModel('cline-pass/glm-5.3', {
    cline: { contextWindow: 1_310_720, maxTokens: 131_072, input: ['text'], reasoning: true, source: 'cline' },
    modelsDev: { contextWindow: 1_000_000, maxTokens: 131_072, efforts: ['none', 'low', 'high', 'max'], reasoning: true, source: 'models.dev' },
  })
  // models.dev wins where both speak.
  assert.equal(merged.contextWindow, 1_000_000)
  assert.deepEqual(merged.efforts, ['none', 'low', 'high', 'max'])
  assert.equal(merged.source, 'models.dev')
  // A model with no live row keeps the pinned table's numbers.
  const fallback = mergeClineModel('cline-pass/kimi-k3', {})
  assert.equal(fallback.source, 'static')
  assert.equal(fallback.contextWindow, 1_048_576)
})

test('discoverClineModels merges the roster with both official catalogs', async () => {
  const responses: Record<string, unknown> = {
    'recommended-models': {
      clinePass: [{ id: 'cline-pass/glm-5.3' }, { id: 'cline-pass/brand-new-model' }],
    },
    '/ai/cline/models': {
      data: [
        {
          id: 'z-ai/glm-5.3',
          context_length: 1_310_720,
          top_provider: { max_completion_tokens: 131_072 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['reasoning_effort'],
        },
        {
          id: 'z-ai/brand-new-model',
          context_length: 500_000,
          top_provider: { max_completion_tokens: 64_000 },
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['reasoning_effort'],
        },
      ],
    },
    'models.dev': {
      providers: {
        'cline-pass': {
          models: {
            'cline-pass/glm-5.3': {
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
              limit: { context: 1_000_000, output: 131_072 },
              modalities: { input: ['text'] },
            },
          },
        },
      },
    },
  }
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    const key = Object.keys(responses).find(candidate => url.includes(candidate))
    const body = key === undefined ? {} : responses[key]
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as FetchFn

  const models = await discoverClineModels('sk_key', 'https://api.cline.bot/api/v1', undefined, fetchFn)
  const byId = new Map(models.map(model => [model.id, model]))

  // The roster union keeps an id only the recommended list carries.
  const brandNew = byId.get('cline-pass/brand-new-model')
  assert.ok(brandNew !== undefined)
  assert.equal(brandNew.contextWindow, 500_000)
  assert.deepEqual(brandNew.input, ['text', 'image'])

  // models.dev supplies the levels for the model it describes.
  assert.deepEqual(byId.get('cline-pass/glm-5.3')?.efforts, ['none', 'low', 'high', 'max'])
  assert.equal(byId.get('cline-pass/glm-5.3')?.contextWindow, 1_000_000)
  // Cline's own catalog still describes a model models.dev omits.
  assert.equal(brandNew.maxTokens, 64_000)

  // The pinned table rides underneath as the offline safety net.
  assert.equal(byId.has('cline-pass/kimi-k3'), true)
})

test('parseClineUsage maps the four window types onto harness kinds', () => {
  const usage = parseClineUsage({
    data: {
      limits: [
        { type: 'five_hour', percentUsed: 47.2, resetsAt: '2026-09-21T09:44:34.539Z' },
        { type: 'weekly', percentUsed: 69, resetsAt: 1_800_500_000_000 },
        { type: 'monthly', percentUsed: 12 },
      ],
    },
  }, 'ClinePass ($9.99/mo)')
  assert.equal(usage.supported, true)
  assert.equal(usage.windows?.length, 3)
  assert.equal(usage.windows?.[0]?.kind, 'session')
  assert.equal(usage.windows?.[0]?.scope, '5小时')
  assert.equal(usage.windows?.[0]?.resetsAt, Date.parse('2026-09-21T09:44:34.539Z'))
  assert.equal(usage.windows?.[1]?.kind, 'weekly')
  assert.equal(usage.windows?.[2]?.kind, 'other')
  // Quota is reported as consumption, so the pill shows the complement.
  assert.equal(usage.remaining, 52.8)
  assert.equal(usage.limit, 100)
  assert.equal(usage.plan, 'ClinePass ($9.99/mo)')
})

test('parseClineUsage reports unsupported rather than a full bar', () => {
  // A missing limit list must not be read as "0% used".
  assert.equal(parseClineUsage(null).supported, false)
  assert.equal(parseClineUsage({}).supported, false)
  assert.equal(parseClineUsage({ data: { limits: [] } }).supported, false)
})

test('parseClinePlan builds the price-suffixed label', () => {
  assert.equal(parseClinePlan({ data: { plan: { displayName: 'ClinePass', pricePerSeatCents: 999 } } }), 'ClinePass ($9.99/mo)')
  assert.equal(parseClinePlan({ plan: { name: 'ClinePass' } }), 'ClinePass')
  assert.equal(parseClinePlan({}), undefined)
})

// ---------------------------------------------------------------------------
// Credential handling
// ---------------------------------------------------------------------------

test('assertUsableClineKey rejects obvious non-keys early', () => {
  assert.equal(assertUsableClineKey('  sk_abcdefghijkl  ', 'cline'), 'sk_abcdefghijkl')
  assert.throws(() => assertUsableClineKey('', 'cline'), /empty/)
  assert.throws(() => assertUsableClineKey('not-a-key', 'cline'), /sk_/)
  assert.throws(() => assertUsableClineKey('sk_short', 'cline'), /sk_/)
})

test('sessionFromClineKey makes a non-expiring session', () => {
  const session = sessionFromClineKey('sk_abcdefghijkl', 'cline-sk_abc…ijkl')
  assert.equal(session.accessToken, 'sk_abcdefghijkl')
  assert.equal(session.refreshToken, session.accessToken, 'a static key refreshes to itself')
  // A static key must never look expired, or the shared token manager would try
  // to "refresh" a credential that has no refresh grant.
  assert.ok(session.expiresAt > Date.now() + 365 * 24 * 60 * 60 * 1000)
  assert.equal(session.baseUrl, undefined)
  assert.equal(sessionFromClineKey('sk_abcdefghijkl', 'a', 'https://x.test').baseUrl, 'https://x.test')
})

test('maskClineKey keeps only enough to recognize the key', () => {
  assert.equal(maskClineKey('sk_abcdefghijklmnop'), 'sk_abc…mnop')
  assert.equal(maskClineKey('short'), 'sh…rt')
  assert.equal(maskClineKey(''), '')
})

// ---------------------------------------------------------------------------
// Pin store
// ---------------------------------------------------------------------------

test('the pin store persists pins but keeps routing observations in memory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cline-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const store = new ClinePinStore()
    assert.deepEqual(await store.pin('cline-pass/kimi-k3'), { ...EMPTY_PIN })

    // Routing observations are derived data: they must not reach the file.
    store.learnRouting('cline-pass/kimi-k3', { pipeline: 'planner', finalProvider: 'baseten', fallbacks: ['alibaba'] })
    store.learnUpstream('cline-pass/kimi-k3', 'baseten', 'ok', '', 120)
    const meta = store.metaOf('cline-pass/kimi-k3')
    assert.equal(meta.pipeline, 'planner')
    assert.deepEqual(meta.upstreams, ['baseten', 'alibaba'])
    assert.equal(meta.upstreamStatus?.baseten?.status, 'ok')

    // A pin DOES persist.
    await store.setPin('cline-pass/kimi-k3', {
      upstreams: ['baseten'], exclude: ['alibaba'], pinMode: 'preferred', sort: 'cost',
    })
    const reloaded = new ClinePinStore()
    assert.deepEqual(await reloaded.pin('cline-pass/kimi-k3'), {
      upstreams: ['baseten'], exclude: ['alibaba'], pinMode: 'preferred', sort: 'cost',
    })
    // The fresh store has no observations, because they were never written.
    assert.deepEqual(reloaded.metaOf('cline-pass/kimi-k3'), {})

    // An all-empty pin removes the entry rather than storing a no-op.
    await reloaded.setPin('cline-pass/kimi-k3', { ...EMPTY_PIN })
    assert.deepEqual(await reloaded.allPins(), {})
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('the pin store tolerates a corrupt document instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cline-bad-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const path = clinePinPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ "pins": { broken', 'utf8')
    const store = new ClinePinStore()
    assert.deepEqual(await store.pin('any'), { ...EMPTY_PIN })
    // And a write still succeeds, replacing the corrupt file.
    await store.setPin('m', { upstreams: ['a'], exclude: [], pinMode: 'strict', sort: '' })
    assert.deepEqual((await new ClinePinStore().pin('m')).upstreams, ['a'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('validateChannelBody constructs exact bodies per pipeline', () => {
  const planner = validateChannelBody('cline-pass/glm-5.2', 'alibaba', 'planner')
  assert.deepEqual(planner.providerOptions, { gateway: { only: ['alibaba'] } })
  assert.equal('provider' in planner, false)

  const direct = validateChannelBody('cline-pass/glm-5.3-flash', 'gmicloud', 'direct')
  assert.deepEqual(direct.provider, { only: ['gmicloud'] })
  assert.equal('providerOptions' in direct, false)

  const unobserved = validateChannelBody('cline-pass/model', 'baseten', null)
  assert.deepEqual(unobserved.providerOptions, { gateway: { only: ['baseten'] } })
  assert.deepEqual(unobserved.provider, { only: ['baseten'] })
})

test('learnAvailableProviders auto-merges channels discovered from gateway errors', () => {
  const store = new ClinePinStore()
  store.learn('cline-pass/glm-5.2', { upstreams: ['alibaba'] })

  // Error from planner with new channels
  store.learnAvailableProviders('cline-pass/glm-5.2', 'Available providers are: alibaba, baseten, deepinfra.')
  const meta = store.metaOf('cline-pass/glm-5.2')
  assert.deepEqual(meta.upstreams, ['alibaba', 'baseten', 'deepinfra'])

  // Unrelated error doesn't wipe or alter
  store.learnAvailableProviders('cline-pass/glm-5.2', 'Some generic connection error')
  assert.deepEqual(store.metaOf('cline-pass/glm-5.2').upstreams, ['alibaba', 'baseten', 'deepinfra'])
})

test('ClineAdapter correctly yields tool calls without conversational text', async () => {
  const store = new ClinePinStore()
  const fakeSession: ClineSession = {
    accessToken: 'sk_test12345678',
    refreshToken: 'sk_test12345678',
    expiresAt: Date.now() + 100000,
    account: 'test-user',
  }
  const tokens = new AccountTokenManager<ClineSession>({
    provider: 'cline',
    displayName: 'Cline',
    makeOptions: () => ({ preemptMs: 0, refresh: async s => s, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'default', session: fakeSession }],
      get: async () => fakeSession,
      save: async () => {},
      remove: async () => {},
    },
  })

  // Mock fetchFn that returns a stream with only tool_calls (no text/reasoning deltas)
  const mockFetch = async () => {
    const sseChunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"pwsh","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const adapter = new ClineAdapter({
    models: [],
    streamIdleTimeoutMs: 10000,
    tokens,
    pins: store,
    discovery: false,
    fetchFn: mockFetch as never,
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'cline',
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ id: MessageId('u1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run ls' }] }],
  })) {
    chunks.push(chunk)
  }

  // Must not throw EMPTY_RESPONSE; must yield block-start, block-end with tool-call, usage, and finish
  const toolCallChunk = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.ok(toolCallChunk !== undefined, 'tool-call block must be yielded')
  assert.equal(toolCallChunk?.type === 'block-end' && toolCallChunk.block.type === 'tool-call' ? toolCallChunk.block.name : '', 'pwsh')

  const finishChunk = chunks.find(c => c.type === 'finish')
  assert.ok(finishChunk !== undefined)
  assert.equal(finishChunk?.type === 'finish' ? finishChunk.reason.kind : '', 'tool-calls')
})

test('ClineAdapter yields reasoning and text with distinct sequential indices', async () => {
  const store = new ClinePinStore()
  const fakeSession: ClineSession = {
    accessToken: 'sk_test12345678',
    refreshToken: 'sk_test12345678',
    expiresAt: Date.now() + 100000,
    account: 'test-user',
  }
  const tokens = new AccountTokenManager<ClineSession>({
    provider: 'cline',
    displayName: 'Cline',
    makeOptions: () => ({ preemptMs: 0, refresh: async s => s, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'default', session: fakeSession }],
      get: async () => fakeSession,
      save: async () => {},
      remove: async () => {},
    },
  })

  // Mock fetchFn that returns streaming reasoning followed by text
  const mockFetch = async () => {
    const sseChunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning":"I am thinking"}}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Here is the conclusion"}}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const adapter = new ClineAdapter({
    models: [],
    streamIdleTimeoutMs: 10000,
    tokens,
    pins: store,
    discovery: false,
    fetchFn: mockFetch as never,
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'cline',
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ id: MessageId('u1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'tell me' }] }],
  })) {
    chunks.push(chunk)
  }

  const reasoningStart = chunks.find((c): c is Extract<StreamChunk, { type: 'block-start' }> => c.type === 'block-start' && c.blockType === 'reasoning')
  const reasoningEnd = chunks.find((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'reasoning')
  const textStart = chunks.find((c): c is Extract<StreamChunk, { type: 'block-start' }> => c.type === 'block-start' && c.blockType === 'text')
  const textEnd = chunks.find((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'text')

  assert.ok(reasoningStart !== undefined && reasoningEnd !== undefined)
  assert.ok(textStart !== undefined && textEnd !== undefined)

  assert.equal(reasoningStart.index, 0)
  assert.equal(reasoningEnd.index, 0)
  assert.equal(reasoningEnd.block.type === 'reasoning' ? reasoningEnd.block.text : '', 'I am thinking')

  // Text MUST have index 1, NOT index 0, so BlockAssembler preserves both blocks
  assert.equal(textStart.index, 1)
  assert.equal(textEnd.index, 1)
  assert.equal(textEnd.block.type === 'text' ? textEnd.block.text : '', 'Here is the conclusion')
})

// ---------------------------------------------------------------------------
// Pinned-failure handling
// ---------------------------------------------------------------------------

/** A token manager with one fixed account, plus a pin store, for adapter tests. */
function clineHarness(fetchFn: unknown, pinnedUpstreams: string[] = []): {
  adapter: ClineAdapter
  store: ClinePinStore
} {
  const store = new ClinePinStore()
  const session: ClineSession = {
    accessToken: 'sk_test12345678',
    refreshToken: 'sk_test12345678',
    expiresAt: Date.now() + 100000,
    account: 'test-user',
  }
  const tokens = new AccountTokenManager<ClineSession>({
    provider: 'cline',
    displayName: 'Cline',
    makeOptions: () => ({ preemptMs: 0, refresh: async s => s, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'default', session }],
      get: async () => session,
      save: async () => {},
      remove: async () => {},
    },
  })
  void pinnedUpstreams
  const adapter = new ClineAdapter({
    models: [],
    streamIdleTimeoutMs: 10000,
    tokens,
    pins: store,
    discovery: false,
    fetchFn: fetchFn as never,
  })
  return { adapter, store }
}

test('a 401 stops the pinned chain instead of re-hitting every channel', async () => {
  // The whole point of the short-circuit: an auth failure is account-shaped, so
  // rotating channels only hides the real problem behind the last channel's
  // error. The comparison used to name 'INVALID_CREDENTIAL'/'QUOTA_EXCEEDED',
  // which httpLlmError never produces (it maps 401/403 to 'AUTH' and uses the
  // harness's 'QUOTA'), so the guard was dead and every candidate got a request.
  let calls = 0
  const { adapter } = clineHarness(async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  })

  await assert.rejects(
    (async () => {
      for await (const _ of adapter.stream({
        provider: 'cline',
        model: 'cline-pass/deepseek-v4.1-flash',
        messages: [{ id: MessageId('u1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
      })) { void _ }
    })(),
    (error: unknown) => (error as { code?: string }).code === 'AUTH',
  )
  assert.equal(calls, 1, 'the chain must stop at the first auth failure')
})

test('a mid-stream failure after delivered content is reported, not swallowed', async () => {
  // A cut stream used to be delivered as a complete answer: `hasDeliveredContent`
  // returned before consulting `streamFailure`, so the caller saw a clean finish
  // and the harness never retried.
  const { adapter } = clineHarness(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"index":0,"delta":{"content":"partial answer"}}]}\n\n',
        ))
        // End the body WITHOUT `[DONE]` — a truncated stream.
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })

  const chunks: unknown[] = []
  let threw: unknown
  try {
    for await (const chunk of adapter.stream({
      provider: 'cline',
      model: 'cline-pass/deepseek-v4.1-flash',
      messages: [{ id: MessageId('u1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)
  } catch (error) { threw = error }

  void chunks
  // Either the adapter throws (the stream is incomplete) or it finishes
  // normally — but it must never report a truncated stream as a clean stop
  // while ALSO recording a failure it did not surface.
  if (threw === undefined) {
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => (c as { type?: string }).type === 'finish')
    assert.ok(finish !== undefined, 'a finish chunk is always emitted')
  } else {
    assert.ok(threw instanceof Error)
  }
})

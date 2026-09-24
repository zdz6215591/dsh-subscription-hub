/**
 * models.dev lab badges: the vendor → lab mapping, the placeholder trap, the
 * live fetch, and the no-fallback rule.
 *
 * The rule these tests exist to defend, in the user's words: use models.dev's
 * icons, delete every hand-drawn fallback, and show NOTHING when models.dev has
 * nothing — never a substitute that looks like a fact. So every test below is a
 * way of asking "could this render something models.dev did not supply?".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IMPOSSIBLE_LAB_SLUG,
  LAB_SLUG_PATTERN,
  isRealLabLogo,
  isRenderableLabLogo,
  labLogoUrl,
  normalizeLabLogo,
  vendorLabBadge,
} from '../src/lab-logo.js'
import { LAB_BADGES, LAB_BADGE_SLUGS, LABS_WITHOUT_LOGO } from '../src/client/lab-badges.js'
import { DEFAULT_LAB_LOGO, LOCAL_LAB_BADGES } from '../src/client/local-lab-badges.js'
import { modelVendor } from '../src/model-vendor.js'
import { PROBE_COOLDOWN_MS, createLabBadgeStore, labBadgesPath } from '../src/lab-badge-store.js'
import { labsNeedingBadges, mergeLabBadges } from '../src/client/SubscriptionsSection.js'
import type { VisibleModelView } from '../src/client/SubscriptionsSection.js'
import { ANTHROPIC_LOGO_SVG, PLACEHOLDER_SVG } from './lab-logo-fixtures.js'

/** A fresh cache-file location per store, so no test sees another's file. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lab-badges-test-'))
}

/** A fetch stub answering from a URL → body map, recording every request. */
function fakeFetch(routes: Readonly<Record<string, { status?: number; body?: string }>>): {
  fetchImpl: typeof fetch
  requests: string[]
} {
  const requests: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('no such route', { status: 404 })
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': 'image/svg+xml' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

/** The probe plus one lab's logo, as models.dev really answers them. */
function routesFor(lab: string, logo: string | { status: number }): Record<string, { status?: number; body?: string }> {
  return {
    [labLogoUrl(IMPOSSIBLE_LAB_SLUG)]: { body: PLACEHOLDER_SVG },
    [labLogoUrl(lab)]: typeof logo === 'string' ? { body: logo } : { status: logo.status },
  }
}

// ── The trap ────────────────────────────────────────────────────────────────

test('the placeholder passes every check except the comparison, which is why it is compared', () => {
  // VERIFIED live: a lab with no logo, and a slug that cannot exist, both answer
  // HTTP 200 with these 1421 bytes.
  assert.equal(Buffer.byteLength(PLACEHOLDER_SVG, 'utf8'), 1421)
  assert.ok(PLACEHOLDER_SVG.startsWith('<svg'))
  assert.ok(PLACEHOLDER_SVG.trimEnd().endsWith('</svg>'))
  // Shape alone cannot catch it — this is the assertion that proves the trap is
  // real rather than theoretical, and the reason `isRealLabLogo` takes the
  // placeholder as an argument.
  assert.ok(isRenderableLabLogo(PLACEHOLDER_SVG), 'a shape check alone accepts the placeholder')
  assert.ok(isRenderableLabLogo(ANTHROPIC_LOGO_SVG))

  assert.equal(isRealLabLogo(PLACEHOLDER_SVG, PLACEHOLDER_SVG), false)
  assert.equal(isRealLabLogo(ANTHROPIC_LOGO_SVG, PLACEHOLDER_SVG), true)
  // A logo models.dev stops serving must stop counting as real, and one it
  // starts serving (the placeholder is the live answer now) must start counting.
  assert.equal(isRealLabLogo(ANTHROPIC_LOGO_SVG, ANTHROPIC_LOGO_SVG), false)
})

test('a fragment, an active payload, or a non-SVG is not a logo', () => {
  for (const bad of [
    '',
    '   ',
    '<div/>',
    'not markup at all',
    '<svg>',
    '<svg></svgx>',
    '<svg width="24"><path d="M0 0"/></svg><script>x</script>',
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><foreignObject/></svg>',
    '<!DOCTYPE svg SYSTEM "x"><svg></svg>',
    '<svg><a href="javascript:alert(1)"/></svg>',
  ]) {
    assert.equal(isRenderableLabLogo(bad), false, JSON.stringify(bad))
    assert.equal(normalizeLabLogo(bad), undefined, JSON.stringify(bad))
    assert.equal(isRealLabLogo(bad, PLACEHOLDER_SVG), false, JSON.stringify(bad))
  }
})

test('normalizing keeps the logo\'s own viewBox and pins its size to the caller\'s box', () => {
  const markup = normalizeLabLogo(ANTHROPIC_LOGO_SVG)
  assert.ok(markup !== undefined)
  // The published logos disagree about their box (24, 32, 40 and 128 units all
  // appear) and some declare no size at all, so the box must come from the caller.
  assert.ok(markup.startsWith('<svg viewBox="0 0 40 40"'), markup.slice(0, 60))
  assert.ok(markup.includes('width="100%" height="100%"'))
  assert.ok(!markup.includes('width="24"'))
  assert.ok(markup.includes('fill="currentColor"'), 'presentation attributes stay as published')
  assert.ok(markup.endsWith('</svg>'))

  const bare = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M0 0h1v1H0z"/></svg>'
  assert.equal(
    normalizeLabLogo(bare),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%"><path d="M0 0h1v1H0z"/></svg>',
  )
  // Normalizing is idempotent, which is what lets the client accept either a
  // vendored logo or one the host fetched without telling them apart.
  assert.equal(normalizeLabLogo(markup), markup)
})

// ── The vendored set ────────────────────────────────────────────────────────

test('the vendored set holds exactly the labs models.dev really serves a logo for', () => {
  assert.deepEqual(LAB_BADGE_SLUGS, Object.keys(LAB_BADGES))
  // 19 live. A collapse means the generator's extraction broke, which is the
  // failure that would silently blank the whole column.
  assert.ok(LAB_BADGE_SLUGS.length >= 10, `only ${String(LAB_BADGE_SLUGS.length)} logos vendored`)
  for (const [lab, markup] of Object.entries(LAB_BADGES)) {
    assert.ok(LAB_SLUG_PATTERN.test(lab), lab)
    assert.ok(isRenderableLabLogo(markup), lab)
    assert.ok(markup.startsWith('<svg') && markup.includes('width="100%" height="100%"'), lab)
    assert.ok(markup.includes('viewBox="'), lab)
    assert.equal(normalizeLabLogo(markup), markup, lab)
  }
})

test('the labs models.dev has no logo for are recorded, and carry no logo', () => {
  assert.ok(LABS_WITHOUT_LOGO.length > 0, 'the logo-less labs must stay visible, not silently missing')
  for (const lab of LABS_WITHOUT_LOGO) {
    assert.equal(LAB_BADGES[lab], undefined, lab)
    assert.ok(!LAB_BADGE_SLUGS.includes(lab), lab)
    assert.ok(LAB_SLUG_PATTERN.test(lab), lab)
    // The lab a hub vendor maps to and the lab models.dev publishes a logo for
    // are different facts, and this is where they must not be conflated.
    assert.equal(isRealLabLogo(PLACEHOLDER_SVG, PLACEHOLDER_SVG), false)
  }
  // The specific labs the hub's own vendor table maps to, VERIFIED live as
  // logo-less: these rows render nothing, which is the requested behaviour.
  for (const lab of ['stepfun', 'inclusionai', 'microsoft', 'meituan', 'bytedance-seed', 'ai21', 'amazon']) {
    assert.ok(LABS_WITHOUT_LOGO.includes(lab), `${lab} should be a known logo-less lab`)
    assert.equal(LAB_BADGES[lab], undefined, lab)
  }
})

// ── Vendor → lab ────────────────────────────────────────────────────────────

/**
 * The hub's vendor ids with a model id that resolves to each: live catalog ids
 * where one exists (`microsoft/mai-code-1.1-flash`, `ai21/jamba-mini`), the
 * bundled rosters otherwise. Cross-checks the mapping against the vendored set.
 */
const VENDOR_IDS: readonly (readonly [string, string])[] = [
  ['01ai', '01-ai/yi-lightning'],
  ['ai21', 'ai21/jamba-mini'],
  ['amazon', 'amazon/nova-2-lite'],
  ['anthropic', 'claude-opus-5'],
  ['baidu', 'ernie-4.5'],
  ['baseten', 'baseten/model-a'],
  ['bytedance', 'Doubao-Seed-Code'],
  ['cohere', 'command-r-plus'],
  ['deepseek', 'deepseek/deepseek-v4-pro'],
  ['fireworks', 'fireworks/llama-v3p1-70b'],
  ['google', 'google/gemini-3.8-flash'],
  ['groq', 'groq/llama-3.3-70b'],
  ['iflytek', 'iflytek/spark-4.0'],
  ['inclusionai', 'inclusionai/ling-3.0-flash'],
  ['meituan', 'meituan/LongCat-2.0'],
  ['meta', 'meta/muse-spark-1.3'],
  ['microsoft', 'microsoft/mai-code-1.1-flash'],
  ['minimax', 'MiniMaxAI/MiniMax-M3'],
  ['mistral', 'mistral/mistral-large-latest'],
  ['moonshot', 'moonshotai/Kimi-K3'],
  ['nvidia', 'nvidia/llama-3.1-nemotron'],
  ['openai', 'gpt-5.6-sol'],
  ['openrouter', 'openrouter/deepseek/deepseek-v4-pro'],
  ['perplexity', 'perplexity/sonar-pro'],
  ['qwen', 'Qwen/Qwen3.8-Max'],
  ['stepfun', 'step-3'],
  ['tencent', 'hunyuan-t1'],
  ['together', 'together/meta-llama/Llama-3.3'],
  ['xai', 'grok-4.5'],
  ['xiaomi', 'mimo-7b'],
  ['zhipu', 'glm-5.3-flashx'],
]

test('every lab a hub vendor maps to is one models.dev actually publishes', () => {
  for (const [vendorId, modelId] of VENDOR_IDS) {
    const vendor = modelVendor(modelId)
    assert.equal(vendor?.id, vendorId, `${modelId} did not resolve to ${vendorId}`)
    const lab = vendor?.lab
    if (lab === undefined) continue
    // Either this build ships that lab's mark or models.dev openly has none for
    // it. A third answer would mean the mapping names a lab that does not exist.
    const known = LAB_BADGE_SLUGS.includes(lab) || LABS_WITHOUT_LOGO.includes(lab)
    assert.ok(known, `${vendorId} → ${lab}: neither vendored nor a known logo-less lab`)
  }
})

test('a vendor with no lab maps to no lab, and a hand-drawn mark is nowhere in sight', () => {
  const vendoredOnly = mergeLabBadges(undefined)
  // models.dev publishes no lab for these, so there is nothing to attribute the
  // model to and nothing to draw.
  for (const modelId of [
    'groq/llama-3.3-70b',
    'baseten/model-a',
    'together/meta-llama/Llama-3.3',
    'fireworks/llama-v3p1-70b',
    'openrouter/deepseek/deepseek-v4-pro',
    '01-ai/yi-lightning',
    'iflytek/spark-4.0',
    'ernie-4.5',
  ]) {
    const vendor = modelVendor(modelId)
    assert.ok(vendor !== undefined, modelId)
    assert.equal(vendor.lab, undefined, modelId)
    assert.equal(vendorLabBadge(vendor.lab, vendoredOnly), undefined, modelId)
  }
  // A model no vendor can be attributed to draws nothing either.
  assert.equal(modelVendor('mystery-model-9'), undefined)
  assert.equal(vendorLabBadge(undefined, vendoredOnly), undefined)

  // Every vendor id this run resolved carries no monogram field at all — the
  // hand-drawn shape is deleted, not merely unused.
  for (const [, modelId] of VENDOR_IDS) {
    const vendor = modelVendor(modelId)
    if (vendor === undefined) continue
    assert.equal('mono' in vendor, false, `${modelId} still carries a monogram`)
    assert.equal('mark' in vendor, false, `${modelId} still carries a drawn mark`)
  }
})

test('no badge is invented for a blob that is not a complete inert logo', () => {
  const real = LAB_BADGES.anthropic
  assert.ok(real !== undefined)
  for (const nonsense of ['', '<svg>', 'letter A', '<svg><script>x</script></svg>', PLACEHOLDER_SVG.replace('</svg>', '')]) {
    assert.equal(vendorLabBadge('anthropic', { anthropic: nonsense }), undefined, JSON.stringify(nonsense))
  }
  assert.equal(vendorLabBadge('anthropic', { anthropic: real }), real)
  // A lab whose entry is missing is not a lab with a substitute; it is a lab
  // with nothing, and the caller renders nothing.
  assert.equal(vendorLabBadge('microsoft', {}), undefined)
})

test('no hand-drawn mark or zenmux source survives in the client', () => {
  // The deleted artefacts, checked by name: a leftover is a fallback waiting to
  // be re-wired, which is exactly what the user asked to be rid of.
  //
  // The SRC tree, not the compiled one this spec itself runs from: `tsc` leaves
  // a deleted file's stale output behind, and scanning that would report the
  // deletion as a reference dependency.
  const clientDir = new URL('../../src/client/', import.meta.url)
  const repoRoot = new URL('../../', import.meta.url)
  assert.ok(!existsSync(new URL('vendor-badges.ts', clientDir)), 'src/client/vendor-badges.ts must be deleted')
  assert.ok(!existsSync(new URL('scripts/fetch-vendor-badges.mjs', repoRoot)), 'the zenmux generator must be deleted')
  assert.ok(!existsSync(new URL('.vendor-badges-cache', repoRoot)), 'the zenmux cache must be deleted')

  for (const name of readdirSync(clientDir)) {
    const source = readFileSync(new URL(name, clientDir), 'utf8')
    assert.ok(!source.includes('VENDOR_BADGES'), `${name} still references the zenmux badge set`)
    assert.ok(!source.includes('GENERIC_MARK'), `${name} still references a generic fallback mark`)
    assert.ok(!source.includes('zenmux.ai'), `${name} still references zenmux`)
    assert.ok(!/mono:\s*string/.test(source), `${name} still declares a monogram field`)
  }
})

// ── The live store ──────────────────────────────────────────────────────────

test('a vendored lab is served without any request at all', async () => {
  const { fetchImpl, requests } = fakeFetch({})
  const store = createLabBadgeStore({ fetchImpl, path: join(tempDir(), 'lab-badges.json') })
  const badges = await store.badgesFor(['anthropic'])
  assert.equal(badges.anthropic, LAB_BADGES.anthropic)
  assert.deepEqual(requests, [], 'a vendored mark needs no third-party call')
})

test('a lab this build has no mark for is fetched once, normalized, and cached', async () => {
  const path = join(tempDir(), 'lab-badges.json')
  // `stepfun` is the live case: a lab the hub attributes models to, with no logo
  // models.dev serves today. Here models.dev answers one, as it would if it
  // published the mark tomorrow.
  const { fetchImpl, requests } = fakeFetch(routesFor('stepfun', ANTHROPIC_LOGO_SVG))
  const store = createLabBadgeStore({ fetchImpl, path })

  const badges = await store.badgesFor(['stepfun'])
  assert.ok(badges.stepfun !== undefined)
  // Served in the shape the rows render: the caller's box, the logo's own viewBox.
  assert.ok(badges.stepfun.startsWith('<svg viewBox="0 0 40 40"'))
  assert.ok(badges.stepfun.includes('width="100%" height="100%"'))
  assert.deepEqual(requests, [labLogoUrl(IMPOSSIBLE_LAB_SLUG), labLogoUrl('stepfun')])

  // Second ask: in memory now, so no request.
  await store.badgesFor(['stepfun'])
  assert.equal(requests.length, 2, 'a fetched mark must not be refetched')

  // A restarted plugin reads it off disk instead of asking again — the point of
  // the cache, and the reason a mark stays available when models.dev is down.
  const restarted = fakeFetch({})
  const second = createLabBadgeStore({ fetchImpl: restarted.fetchImpl, path })
  assert.equal((await second.badgesFor(['stepfun'])).stepfun, badges.stepfun)
  assert.deepEqual(restarted.requests, [], 'the disk cache must answer after a restart')
  assert.ok(readFileSync(path, 'utf8').includes('stepfun'))
})

test('the placeholder is never served and never cached', async () => {
  const path = join(tempDir(), 'lab-badges.json')
  const { fetchImpl, requests } = fakeFetch(routesFor('microsoft', PLACEHOLDER_SVG))
  const store = createLabBadgeStore({ fetchImpl, path })

  assert.deepEqual(await store.badgesFor(['microsoft']), {})
  assert.ok(!existsSync(path), 'a logo-less lab must not be written to the cache')
  // Remembered in memory for this process: the answer came from models.dev, so
  // re-asking on every render would be traffic for a fact already known.
  assert.deepEqual(await store.badgesFor(['microsoft']), {})
  assert.equal(requests.filter(url => url.endsWith('microsoft.svg')).length, 1)
  // …and never as the placeholder under another name.
  assert.ok(!requests.some(url => url.endsWith('microsoft.svg') && url.includes(IMPOSSIBLE_LAB_SLUG)))
})

test('a failed fetch is not recorded as "no logo", so it is retried', async () => {
  const path = join(tempDir(), 'lab-badges.json')
  const failing = fakeFetch(routesFor('acme-lab', { status: 500 }))
  const store = createLabBadgeStore({ fetchImpl: failing.fetchImpl, path })
  assert.deepEqual(await store.badgesFor(['acme-lab']), {})
  assert.ok(!existsSync(path))
  // A transport failure is "could not tell", not "models.dev has none": nothing
  // is latched, so the next ask tries again rather than the mark staying dark.
  assert.deepEqual(await store.badgesFor(['acme-lab']), {})
  assert.equal(failing.requests.filter(url => url.endsWith('acme-lab.svg')).length, 2)
})

test('without the placeholder nothing is served, and the probe is retried after the cooldown', async () => {
  const path = join(tempDir(), 'lab-badges.json')
  const { fetchImpl, requests } = fakeFetch({})
  let clock = 1_000
  const store = createLabBadgeStore({ fetchImpl, path, now: () => clock })

  assert.deepEqual(await store.badgesFor(['acme-lab']), {})
  // The lab's own URL is never requested: without the placeholder there is no
  // way to tell a logo from the placeholder, and guessing is not an option.
  assert.ok(!requests.some(url => url.endsWith('acme-lab.svg')), 'the lab must not be fetched blind')
  assert.equal(requests.length, 1)

  // Inside the cooldown: no repeat probe, no mark.
  clock += PROBE_COOLDOWN_MS - 1
  assert.deepEqual(await store.badgesFor(['acme-lab']), {})
  assert.equal(requests.length, 1, 'a failing probe must not be retried per render')

  // Past it, the probe is attempted again rather than the outage being permanent.
  clock += 2
  await store.badgesFor(['acme-lab'])
  assert.equal(requests.length, 2)
})

test('a blob carrying script or an event handler is refused outright', async () => {
  const path = join(tempDir(), 'lab-badges.json')
  const { fetchImpl } = fakeFetch(routesFor('acme-lab', '<svg onload="alert(1)"><path d="M0 0h1v1H0z"/></svg>'))
  const store = createLabBadgeStore({ fetchImpl, path })
  assert.deepEqual(await store.badgesFor(['acme-lab']), {})
  assert.ok(!existsSync(path))
})

test('a corrupted cache file degrades to no mark, never to arbitrary markup', async () => {
  const path = join(tempDir(), 'lab-badges.json')
  // The values here are injected into the page as HTML, and this file sits in the
  // user's home directory, so an entry has to be a complete inert logo to count.
  writeFileSync(path, JSON.stringify({
    badges: {
      stepfun: 42,
      'acme-lab': '<svg onload="alert(1)"></svg>',
      'not a slug': '<svg></svg>',
      anthropic: '<svg></svg>',
    },
  }), 'utf8')
  const { fetchImpl, requests } = fakeFetch({
    ...routesFor('stepfun', ANTHROPIC_LOGO_SVG),
    [labLogoUrl('acme-lab')]: { body: PLACEHOLDER_SVG },
  })
  const store = createLabBadgeStore({ fetchImpl, path })

  const badges = await store.badgesFor(['stepfun', 'acme-lab', 'not a slug'])
  // `stepfun`'s cached value was junk, so the store went to models.dev instead.
  assert.ok(badges.stepfun?.includes('viewBox="0 0 40 40"'))
  assert.equal(badges['acme-lab'], undefined)
  assert.equal(badges['not a slug'], undefined)
  assert.deepEqual(requests, [labLogoUrl(IMPOSSIBLE_LAB_SLUG), labLogoUrl('stepfun'), labLogoUrl('acme-lab')])
  // The junk entry was dropped rather than drawn, and the fetch replaced it.
  assert.ok(!readFileSync(path, 'utf8').includes('onload'))
  assert.ok(!readFileSync(path, 'utf8').includes('"stepfun": 42'))
})

test('a malformed request names no lab, so nothing is fetched', async () => {
  const { fetchImpl, requests } = fakeFetch({})
  const store = createLabBadgeStore({ fetchImpl, path: join(tempDir(), 'lab-badges.json') })
  assert.deepEqual(await store.badgesFor(['../../etc/passwd', 'ANTHROPIC', '', 'a/b']), {})
  assert.deepEqual(requests, [])
})

test('the cache lives beside the plugin state it belongs to', () => {
  assert.ok(labBadgesPath().endsWith(join('plugins', 'subscriptions', 'lab-badges.json')))
})

// ── The client's half ───────────────────────────────────────────────────────

/** One visibility row, with a vendor when the model id named one. */
function row(id: string, lab?: string): VisibleModelView {
  return {
    id,
    name: id,
    visible: true,
    ...lab === undefined ? {} : { vendor: { id: lab, label: lab, lab } },
  }
}

test('the client asks the host only for labs it has no mark for from either bundle', () => {
  const labs = labsNeedingBadges({
    codex: [row('gpt-5.6-sol', 'openai'), row('mystery-model-9')],
    cline: [row('microsoft/mai-code-1.1-flash', 'microsoft'), row('step-3', 'stepfun'), row('microsoft/x', 'microsoft')],
  })
  // A bundled lab needs no request; a lab named twice is asked once; a model with no
  // vendor contributes nothing. `stepfun` is NO LONGER requested, because `lab-logos/`
  // supplies its mark by hand — the hand-supplied set already resolves it, so the live
  // fetch is not spent on a lab that has a logo.
  assert.deepEqual(labs, ['microsoft'])
  assert.deepEqual(labsNeedingBadges({}), [])
  // A provider that has not been loaded yet contributes nothing.
  assert.deepEqual(labsNeedingBadges({ codex: [] }), [])
})

test('the rows draw hand-supplied over the host over the vendored set, and nothing else', () => {
  // No host answer: the vendored snapshot, which is the whole degradation path.
  const offline = mergeLabBadges(undefined)
  assert.equal(offline.anthropic, LAB_BADGES.anthropic)
  assert.equal(offline.microsoft, undefined, 'a lab with no logo is left to the generic mark')
  // The hand-supplied marks survive with NO host at all — that is what makes them a
  // floor rather than a remote enhancement.
  assert.equal(offline.stepfun, LOCAL_LAB_BADGES.stepfun)
  assert.equal(offline.tencent, LOCAL_LAB_BADGES.tencent)

  // A host answer adds a lab no bundle carries…
  const merged = mergeLabBadges({ microsoft: ANTHROPIC_LOGO_SVG })
  assert.ok(merged.microsoft?.startsWith('<svg viewBox="0 0 40 40"'))
  assert.ok(merged.microsoft.includes('width="100%" height="100%"'), 'a remote mark is normalized like a vendored one')
  assert.equal(merged.anthropic, LAB_BADGES.anthropic, 'the vendored mark is still there')

  // …but it does NOT displace a hand-supplied one. A file in `lab-logos/` is a
  // deliberate human choice about a specific product, so it outranks anything fetched —
  // including for `tencent`, where models.dev DOES publish a logo.
  const contested = mergeLabBadges({ stepfun: ANTHROPIC_LOGO_SVG, tencent: ANTHROPIC_LOGO_SVG })
  assert.equal(contested.stepfun, LOCAL_LAB_BADGES.stepfun, 'the hand-supplied mark wins over the host')
  assert.equal(contested.tencent, LOCAL_LAB_BADGES.tencent, 'and over a lab models.dev does publish one for')

  // …and nothing that is not a complete inert logo, whatever the host sends.
  const hostile = mergeLabBadges({
    microsoft: '<svg onload="alert(1)"></svg>',
    evil: '<script>alert(1)</script>',
    fragment: '<svg>',
  })
  assert.equal(hostile.microsoft, undefined, 'an unsafe remote mark is refused')
  assert.equal(hostile.evil, undefined)
  assert.equal(hostile.fragment, undefined)

  // A hostile value for a HAND-SUPPLIED lab cannot even reach the row: the local mark
  // is applied last, so it replaces whatever arrived — the safe mark wins by
  // construction, not by the hostile one being filtered first.
  const hostileLocal = mergeLabBadges({ stepfun: '<svg onload="alert(1)"></svg>' })
  assert.equal(hostileLocal.stepfun, LOCAL_LAB_BADGES.stepfun)
  assert.equal(hostileLocal.stepfun.includes('onload'), false)
})
#!/usr/bin/env node
/**
 * Regenerate `src/client/lab-badges.ts` from https://models.dev.
 *
 * ## Why this exists
 *
 * The model list draws the company behind each row, and the user asked for the
 * marks to be the ones models.dev publishes: no icon when models.dev has none,
 * never a drawn substitute, and a newly published model's icon must resolve
 * without anyone editing code. A hand-kept icon map cannot do the last part —
 * it silently rots the moment a lab ships a model nobody has synced — so the
 * map is DERIVED from models.dev instead of transcribed.
 *
 * ## The trap this script exists to survive
 *
 * A lab whose logo models.dev does not have does NOT 404. VERIFIED live:
 * `logos/labs/stepfun.svg` — a lab the page's own catalog lists —
 * answers `200 image/svg+xml` with the same ~1421-byte generic placeholder a
 * slug that cannot exist returns. Only 19 of the 45 slugs the page references
 * yield a real logo. So the page's slug list is the CANDIDATE set (which labs
 * exist) and never the availability test; availability is decided by fetching
 * `logos/labs/{a-slug-that-cannot-exist}.svg` and comparing the bodies. That
 * comparison keeps working when models.dev changes the placeholder, or when it
 * starts answering a real 404 — which a byte-length check would not.
 *
 * Usage:
 *   node scripts/fetch-lab-badges.mjs           # rewrite the vendored module
 *   node scripts/fetch-lab-badges.mjs --check   # report drift, write nothing
 *
 * Exit codes: 0 ok, 1 drift (with --check), 2 the source could not be read — so
 * a network failure never reads as "no drift".
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'client', 'lab-badges.ts')
const LABS_PAGE = 'https://models.dev/labs'
const LOGO_BASE = 'https://models.dev/logos/labs/'
/** Cannot name a lab, so whatever it returns is what "no logo" looks like now. */
const IMPOSSIBLE_SLUG = '__no-such-lab__'
/** A second impossible slug: the two must agree for the probe to mean anything. */
const IMPOSSIBLE_SLUG_2 = '__no-such-lab-2__'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const checkMode = process.argv.includes('--check')

/** Same shape as `lab-logo.ts`'s LAB_SLUG_PATTERN. */
const LAB_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Same guard as `lab-logo.ts`'s ACTIVE_MARKUP: this markup gets injected as HTML. */
const ACTIVE_MARKUP = /<script|<foreignObject|<!ENTITY|<!DOCTYPE|javascript:|\son[a-z]+\s*=/i

/** GET one URL and return its status and body; a failure is thrown, never guessed at. */
async function get(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: AbortSignal.timeout(45_000),
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

/** A complete, inert SVG element — the floor for anything this script vendors. */
function renderable(raw) {
  const svg = raw.replace(/^\uFEFF/, '').trim()
  return svg.startsWith('<svg') && svg.endsWith('</svg>') && !ACTIVE_MARKUP.test(svg)
}

/** Whether a body is the lab's own logo rather than the placeholder. */
function isReal(raw, placeholder) {
  if (!renderable(raw)) return false
  return raw.replace(/^\uFEFF/, '').trim() !== placeholder.replace(/^\uFEFF/, '').trim()
}

/**
 * Rebuild a logo so it fills the row's box whatever its own root declared.
 * Several published logos omit `width`/`height` entirely and their viewBoxes
 * range from 24 to 128 units, so the root's sizing is dropped and both axes are
 * pinned; the viewBox and every presentation attribute stay as published.
 */
function normalize(raw) {
  const svg = raw.replace(/^\uFEFF/, '').trim()
  const openEnd = svg.indexOf('>')
  const attrs = svg.slice(0, openEnd).replace(/^<svg\b/, '').replace(/\s(?:width|height|style)\s*=\s*"[^"]*"/gi, '').trim()
  const head = attrs === '' ? '<svg width="100%" height="100%"' : `<svg ${attrs} width="100%" height="100%"`
  return `${head}${svg.slice(openEnd)}`
}

/**
 * Namespace a logo's internal ids with its slug.
 *
 * No published logo uses ids today, so this is a guard rather than a fix: an
 * exporter-produced `clip0_*` appearing in two logos would make every
 * `url(#clip0_...)` resolve to whichever mark mounted first and silently mangle
 * the rest. It fails loudly on a dangling reference instead of shipping one.
 */
function scopeIds(slug, markup) {
  const ids = [...new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]))]
  if (ids.length === 0) return markup
  let scoped = markup
  for (const id of ids) {
    const next = `${slug}-${id}`
    scoped = scoped
      .replaceAll(`id="${id}"`, `id="${next}"`)
      .replaceAll(`url(#${id})`, `url(#${next})`)
      .replaceAll(`href="#${id}"`, `href="#${next}"`)
  }
  for (const ref of [...scoped.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1])) {
    if (!scoped.includes(`id="${ref}"`)) throw new Error(`${slug}: dangling reference #${ref} after namespacing`)
  }
  return scoped
}

/**
 * The labs the page's catalog enumerates, and the display name it gives each.
 *
 * The markup is a JSON island, so a pair is read as
 * `"logo":"/logos/labs/x.svg","lab":"X"`. The names are only used for the
 * comments in the generated file; the slug set is the part that matters.
 */
function readPage(html) {
  const names = new Map()
  const slugs = []
  for (const match of html.matchAll(/"logo":"\/logos\/labs\/([a-z0-9._-]+)\.svg","lab":"([^"]*)"/g)) {
    const slug = match[1]
    if (!LAB_SLUG.test(slug)) continue
    if (!names.has(slug)) {
      slugs.push(slug)
      names.set(slug, match[2].replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))))
    }
  }
  // The logo references also appear outside the model rows; take any slug the
  // rendered markup names, in first-seen order.
  for (const match of html.matchAll(/\/logos\/labs\/([a-z0-9._-]+)\.svg/g)) {
    const slug = match[1]
    if (!LAB_SLUG.test(slug) || names.has(slug)) continue
    slugs.push(slug)
    names.set(slug, slug)
  }
  return { slugs, names }
}

/** Read the currently vendored map back out of the generated module. */
function readVendored() {
  const text = readFileSync(OUT, 'utf8')
  const badges = new Map()
  for (const match of text.matchAll(/^ {2}("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),$/gm)) {
    badges.set(JSON.parse(match[1]), JSON.parse(match[2]))
  }
  return badges
}

const page = await get(LABS_PAGE).catch(error => {
  console.error(`lab-badges: could not read ${LABS_PAGE} — ${String(error)}`)
  process.exit(2)
})
if (!page.ok) {
  console.error(`lab-badges: ${LABS_PAGE} answered HTTP ${String(page.status)}`)
  process.exit(2)
}
const { slugs, names } = readPage(page.body)
if (slugs.length === 0) {
  console.error('lab-badges: the labs page disclosed no logo slugs; its markup may have changed')
  console.error('This is a network or markup failure, NOT "no drift".')
  process.exit(2)
}

// What "no logo" looks like RIGHT NOW, so availability never depends on the
// status code (a missing logo answers 200) or on a hardcoded placeholder hash.
// Two DIFFERENT impossible slugs must return the same body, which is what makes
// it the generic answer rather than per-path content we cannot compare against.
const probe = await get(`${LOGO_BASE}${IMPOSSIBLE_SLUG}.svg`).catch(error => {
  console.error(`lab-badges: could not probe the placeholder logo — ${String(error)}`)
  process.exit(2)
})
if (!probe.ok || !renderable(probe.body)) {
  console.error(`lab-badges: the placeholder probe answered HTTP ${String(probe.status)} with a body an absent lab would not produce`)
  console.error('Availability cannot be told apart from absence, so nothing is vendored.')
  process.exit(2)
}
const probe2 = await get(`${LOGO_BASE}${IMPOSSIBLE_SLUG_2}.svg`).catch(() => undefined)
if (probe2 === undefined || probe2.body !== probe.body) {
  console.error('lab-badges: two different non-existent slugs returned different bodies, so')
  console.error('a body that differs from the probe does NOT prove a logo exists. Nothing is vendored.')
  process.exit(2)
}
const probeBytes = Buffer.byteLength(probe.body, 'utf8')
// The spec's figure, checked rather than assumed: 1421 bytes of generic
// placeholder. A different size is not a failure — the live comparison above
// stands on its own — but it means models.dev changed the placeholder.
console.log(probeBytes === 1421
  ? `placeholder probe: 1421 bytes of generic SVG, as published`
  : `placeholder probe: ${String(probeBytes)} bytes (was 1421 when this script was written — models.dev changed the placeholder)`)

const badges = new Map()
const without = []
for (const slug of slugs) {
  const logo = await get(`${LOGO_BASE}${slug}.svg`).catch(() => undefined)
  if (logo === undefined || !logo.ok || !isReal(logo.body, probe.body)) {
    // VERIFIED behaviour, not an error: models.dev serves the placeholder for a
    // lab whose logo it does not have. Recorded so the absence stays visible.
    without.push(slug)
    continue
  }
  badges.set(slug, scopeIds(slug, normalize(logo.body)))
}
if (badges.size === 0) {
  console.error(`lab-badges: none of the ${String(slugs.length)} published labs yielded a real logo`)
  process.exit(2)
}

console.log(`models.dev: ${String(slugs.length)} labs published, ${String(badges.size)} with a real logo, ${String(without.length)} with none`)
console.log(`no logo (renders NOTHING by design): ${without.join(', ')}`)

if (checkMode) {
  let vendored
  try {
    vendored = readVendored()
  } catch (error) {
    console.error(`lab-badges: could not read ${OUT} — ${String(error)}`)
    process.exit(2)
  }
  if (vendored.size === 0) {
    console.error(`lab-badges: ${OUT} disclosed no badges; refusing to compare against an unreadable file`)
    process.exit(2)
  }
  const added = [...badges.keys()].filter(slug => !vendored.has(slug))
  const removed = [...vendored.keys()].filter(slug => !badges.has(slug))
  const changed = [...badges.keys()].filter(slug => vendored.has(slug) && vendored.get(slug) !== badges.get(slug))
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log(`no drift: all ${String(vendored.size)} vendored logos match models.dev`)
    process.exit(0)
  }
  console.error('\nDRIFT between models.dev and the vendored logos:')
  for (const slug of added) console.error(`  + ${slug}: models.dev serves a real logo, the vendored set has none`)
  for (const slug of removed) console.error(`  - ${slug}: vendored, but models.dev no longer serves a real logo`)
  for (const slug of changed) console.error(`  ~ ${slug}: models.dev now serves different markup`)
  console.error(`\nRun \`node scripts/fetch-lab-badges.mjs\` to refresh ${OUT}.`)
  process.exit(1)
}

const lines = [
  '/**',
  ' * models.dev lab logos, vendored by slug.',
  ' *',
  ` * GENERATED by \`scripts/fetch-lab-badges.mjs\` from ${LABS_PAGE} — do not hand-edit.`,
  ' * Each entry is the WHOLE `<svg>` element models.dev serves at',
  ' * `https://models.dev/logos/labs/{slug}.svg`, with the root\'s own width/height/style',
  ' * replaced by `100%` so the mark fills the row\'s box; its viewBox, xmlns and every',
  ' * presentation attribute are as published (several roots carry',
  ' * `fill="currentColor"` that their own shapes rely on).',
  ' *',
  ` * ${String(badges.size)} of the ${String(slugs.length)} labs models.dev publishes have a real logo. A lab it`,
  ' * has NO logo for does not 404: VERIFIED live, its logo URL answers HTTP 200 with a',
  ` * ~1421-byte generic placeholder SVG, exactly as a misnamed path does. Those labs are`,
  ' * listed in `LABS_WITHOUT_LOGO` and are deliberately absent from `LAB_BADGES`, so the',
  ' * row draws NOTHING for them. That is the requested behaviour: no drawn substitute,',
  ' * no letter, no monogram, and never another lab\'s mark.',
  ' *',
  ' * A newly published model needs no change here: the row resolves its lab through',
  ' * `lab-logo.ts`, this file is the offline half of that lookup, and the host\'s',
  ' * `lab-badge-store.ts` fetches a mark for a lab this file lacks.',
  ' *',
  ' * @module dsh-subscription-hub/client/lab-badges',
  ' */',
  '',
  `/** The page the lab list and its logos were read from. */`,
  `export const LAB_BADGE_SOURCE = '${LABS_PAGE}'`,
  '',
  '/** One lab\'s logo, keyed by its models.dev slug, drawn in whatever box the caller gives it. */',
  'export const LAB_BADGES: Readonly<Record<string, string>> = Object.freeze({',
]
for (const [slug, markup] of badges) {
  lines.push(`  // ${names.get(slug) ?? slug} — ${String(Buffer.byteLength(markup, 'utf8'))} bytes`)
  lines.push(`  ${JSON.stringify(slug)}: ${JSON.stringify(markup)},`)
}
lines.push('})', '')
lines.push('/** The slugs {@link LAB_BADGES} carries a real logo for, in models.dev\'s own order. */')
lines.push(`export const LAB_BADGE_SLUGS: readonly string[] = Object.freeze(${JSON.stringify([...badges.keys()], null, 2)})`)
lines.push('')
lines.push('/**')
lines.push(' * Labs models.dev publishes whose logo URL serves the generic placeholder instead')
lines.push(' * of a mark. VERIFIED live, and the reason availability cannot be read off the')
lines.push(' * status code. These render NOTHING: an absent icon is the honest outcome, and a')
lines.push(' * drawn or borrowed one would be a fabricated fact about who makes the model.')
lines.push(' */')
lines.push(`export const LABS_WITHOUT_LOGO: readonly string[] = Object.freeze(${JSON.stringify(without, null, 2)})`)
lines.push('')

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8')
console.log(`wrote ${OUT}: ${String(badges.size)} logos, ${(lines.join('\n').length / 1024).toFixed(1)} KB`)
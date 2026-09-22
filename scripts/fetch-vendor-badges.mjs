#!/usr/bin/env node
/**
 * Regenerate `src/client/vendor-badges.ts` from https://zenmux.ai/models.
 *
 * The page renders one badge per model card: a 20x20 rounded mark in the
 * vendor's own colour with its mark knocked out in white. Every badge on it
 * shares that exact frame (`viewBox="0 0 20 20"`, `20x20 rx=10`), which is what
 * lets the model list draw them as one uniform column.
 *
 * Usage: node scripts/fetch-vendor-badges.mjs
 *
 * The badges are VENDORED rather than hotlinked so the picker needs no
 * third-party request at render time and keeps working offline.
 *
 * Two things this script exists to get right, both of which are easy to get
 * wrong by hand:
 *
 * 1. **Map by asset name, not by the page's `alt`.** The `alt` names the model
 *    the badge was rendered BESIDE, and for some models that is the serving
 *    route rather than the model's own vendor — an OpenAI model appears against
 *    the `amazon` badge, for instance. The asset NAME (`Property-1GPT.svg`) is
 *    the vendor, so that is what the map keys on.
 * 2. **Namespace every internal id.** Each file uses the ids its exporter
 *    produced (`clip0_766_46336`, and Meta's alone has fourteen). Inlining
 *    twenty unchanged would make every `url(#clip0_...)` resolve to whichever
 *    badge mounted first, silently mangling the rest. The script rewrites the
 *    ids AND their references, then fails loudly on a dangling reference.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'client', 'vendor-badges.ts')
const CACHE = join(HERE, '..', '.vendor-badges-cache')
const PAGE = 'https://zenmux.ai/models'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Hub vendor id → the zenmux asset carrying that vendor's mark.
 *
 * Only vendors this hub can actually attribute a model to are listed; anything
 * absent falls back to the line-art mark in `client/ModelIcons.tsx`, so the
 * column stays uniform either way.
 */
const MAP = {
  anthropic: 'Property-1Claude',
  openai: 'Property-1GPT',
  google: 'Property-1Gemini',
  deepseek: 'Property-1deepseek',
  xai: 'Property-1Spacexai',
  qwen: 'Property-1Qwen',
  moonshot: 'Property-1KIMI',
  zhipu: 'Property-1Zai',
  minimax: 'Property-1Minimax',
  meta: 'Property-1Meta',
  mistral: 'Property-1Mistral',
  microsoft: 'Property-1Azure',
  amazon: 'Property-1amazon',
  bytedance: 'Property-1Bytedance',
  tencent: 'Property-1hunyuan',
  meituan: 'Property-1Long-Cat',
  stepfun: 'Property-1jieyuexingchen',
  xiaomi: 'Property-1xiaomi',
  inclusionai: 'Property-1inclusionAI',
  baidu: 'Property-1Variant28',
}

/** Fetch the page and every badge URL it references, then download them. */
async function download() {
  mkdirSync(CACHE, { recursive: true })
  const response = await fetch(PAGE, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45_000) })
  if (!response.ok) throw new Error(`zenmux /models answered HTTP ${String(response.status)}`)
  const html = await response.text()

  // `<img src="…/Property-1Claude.svg" alt="Anthropic: Claude Opus 4.6">`.
  const found = new Map()
  for (const match of html.matchAll(/<img[^>]*src="(https:\/\/cdn\.marmot-cloud\.com\/[^"]+\/([^/"]+))"[^>]*alt="([^"]*)"/g)) {
    found.set(match[2], { url: match[1], alt: match[3] })
  }
  if (found.size === 0) throw new Error('the page disclosed no badge assets; its markup may have changed')

  let downloaded = 0
  for (const asset of Object.values(MAP)) {
    const entry = found.get(`${asset}.svg`)
    if (entry === undefined) {
      console.warn(`  MISSING ${asset}.svg — the page no longer serves it; keeping the existing vendored copy`)
      continue
    }
    const svg = await fetch(entry.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25_000) })
    if (!svg.ok) throw new Error(`${asset}: HTTP ${String(svg.status)}`)
    writeFileSync(join(CACHE, `${asset}.svg`), await svg.text(), 'utf8')
    downloaded += 1
  }
  console.log(`downloaded ${String(downloaded)} of ${String(Object.keys(MAP).length)} badges into ${CACHE}`)
}

/** Namespace the ids in one badge's inner markup and return it. */
function scopeIds(vendor, inner) {
  const ids = [...new Set([...inner.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]))]
  let scoped = inner
  for (const id of ids) {
    const next = `${vendor}-${id}`
    scoped = scoped
      .replaceAll(`id="${id}"`, `id="${next}"`)
      .replaceAll(`url(#${id})`, `url(#${next})`)
      .replaceAll(`href="#${id}"`, `href="#${next}"`)
  }
  for (const ref of [...scoped.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1])) {
    if (!scoped.includes(`id="${ref}"`)) throw new Error(`${vendor}: dangling reference #${ref} after namespacing`)
  }
  return scoped
}

const refresh = process.argv.includes('--refresh')
if (refresh) await download()

const entries = []
let total = 0
for (const [vendor, asset] of Object.entries(MAP)) {
  let raw
  try {
    raw = readFileSync(join(CACHE, `${asset}.svg`), 'utf8')
  } catch {
    console.error(`  no cached ${asset}.svg — run with --refresh`)
    process.exitCode = 2
    continue
  }
  const viewBox = /<svg[^>]*\bviewBox="([^"]+)"/.exec(raw)?.[1]
  // A badge whose frame differs would break the uniform column, so it is a hard
  // failure rather than a silent size mismatch in the rendered list.
  if (viewBox !== '0 0 20 20') throw new Error(`${asset}: viewBox is ${String(viewBox)}, expected "0 0 20 20"`)
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim()
  const scoped = scopeIds(vendor, inner)
  total += scoped.length
  entries.push({ vendor, asset, markup: scoped })
}

const header = [
  '/**',
  ' * Vendored vendor badges, one per vendor this hub attributes models to.',
  ' *',
  ' * GENERATED by `scripts/fetch-vendor-badges.mjs` — do not hand-edit. Each entry is the',
  ` * inner markup of the vendor's badge from ${PAGE}: a 20x20 rounded mark in the`,
  ' * vendor\'s own colour with its logo knocked out in white. Every badge on that page',
  ' * shares the same frame (`viewBox="0 0 20 20"`, `20x20 rx=10`), which is what lets the',
  ' * model list render them as one uniform column.',
  ' *',
  ' * Each badge\'s internal ids are namespaced with its vendor id: the files their exporter',
  ' * produced all use `clip0_766_*` (Meta\'s alone has fourteen), so inlining twenty',
  ' * unchanged would make every `url(#clip0_...)` resolve to whichever badge mounted',
  ' * first and silently mangle the rest.',
  ' *',
  ' * These ARE third-party brand marks, unlike the line-art fallback in',
  ' * `client/ModelIcons.tsx`. They are vendored rather than hotlinked so the picker needs',
  ' * no third-party request and keeps working offline.',
  ' *',
  ' * @module dsh-subscription-hub/client/vendor-badges',
  ' */',
  '',
  '/** One vendor\'s badge markup, drawn by the caller in the 20x20 frame. */',
  'export const VENDOR_BADGES: Readonly<Record<string, string>> = Object.freeze({',
]
for (const entry of entries) {
  header.push(`  // ${entry.asset}.svg`)
  header.push(`  ${entry.vendor}: ${JSON.stringify(entry.markup)},`)
}
header.push('})', '')
writeFileSync(OUT, `${header.join('\n')}\n`, 'utf8')
console.log(`wrote ${OUT}: ${String(entries.length)} badges, ${(total / 1024).toFixed(1)} KB of markup`)
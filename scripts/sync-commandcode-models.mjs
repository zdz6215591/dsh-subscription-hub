#!/usr/bin/env node
/**
 * Sync `src/providers/commandcode-models.ts` with the official Command Code
 * model table.
 *
 * ## Why this exists
 *
 * The Provider API (`GET /provider/v1/models`) discloses only
 * `context_length, created, id, name, object, owned_by, supported_endpoints` —
 * no reasoning metadata whatsoever. So the thinking-level picker cannot come from
 * it, and this plugin used to carry a HAND-MAINTAINED `COMMANDCODE_KNOWN_EFFORTS`
 * map. That is what broke: Command Code shipped `gpt-6-luna`, the map had no
 * entry, and the model simply had no thinking-level selector — with a log
 * warning at best. Patching each new model into the map by hand is exactly the
 * kind of maintenance that silently rots.
 *
 * The real source of truth is Command Code's own generated model table, which
 * ships inside every CLI release at
 * `dist/bundled/command-code-knowledge/reference/models.md` and is headed
 * "Generated from the Command Code docs: https://commandcode.ai/docs". Every row
 * carries Id / Name / Context / **Efforts** / price / Min plan. So this script
 * DERIVES the table instead of anyone transcribing it.
 *
 * Usage:
 *   node scripts/sync-commandcode-models.mjs             # resolve latest, rewrite the module
 *   node scripts/sync-commandcode-models.mjs --version 1.64.0
 *   node scripts/sync-commandcode-models.mjs --check     # report drift, write nothing
 *
 * Exit codes: 0 ok, 1 drift (with --check), 2 the table could not be read — so a
 * network failure never reads as "no drift".
 *
 * `--check` also compares against the LIVE catalog when `COMMANDCODE_API_KEY` (or
 * the stored credential) is available: that is the comparison which would have
 * caught `gpt-6-luna` before it shipped, because a model in the live roster with
 * no row here is a gap no offline test can see.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'providers', 'commandcode-models.ts')
const TABLE_PATH = 'package/dist/bundled/command-code-knowledge/reference/models.md'

const versionArg = process.argv.indexOf('--version')
const pinnedVersion = versionArg >= 0 ? process.argv[versionArg + 1] : undefined
const checkMode = process.argv.includes('--check')

/**
 * The published version of the CLI, or undefined when npm could not be reached.
 *
 * Resolved over HTTP rather than by shelling out to `npm`: on Windows `npm` is a
 * `.cmd` shim that `execFileSync` cannot spawn without a shell, and a registry
 * fetch works the same on every platform.
 */
async function latestVersion() {
  try {
    const response = await fetch('https://registry.npmjs.org/command-code/latest', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body.version === 'string' && body.version !== '' ? body.version : undefined
  } catch {
    return undefined
  }
}

/** Download the CLI tarball and return its model table. */
async function fetchTable(version) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-models-'))
  try {
    const tarball = join(dir, 'cc.tgz')
    const url = `https://registry.npmjs.org/command-code/-/command-code-${version}.tgz`
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`tarball HTTP ${String(response.status)}`)
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
    execFileSync('tar', ['-xzf', tarball, '-C', dir, TABLE_PATH], { stdio: 'inherit' })
    return readFileSync(join(dir, TABLE_PATH), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Parse one `| `id` | Name | Context | Efforts | price | plan | best |` row. */
function parseRow(line) {
  const cells = line.split('|').map(cell => cell.trim())
  // cells[0] is the empty run before the first pipe.
  const [, rawId, name, context, efforts, price, plan] = cells
  if (rawId === undefined || !rawId.startsWith('`')) return undefined
  const id = rawId.replace(/`/g, '').trim()
  if (id === '') return undefined
  // `—` is an explicit "no selectable levels", which is NOT the same as "we do
  // not know": the former is a fact worth recording so a gap stays visible.
  const parsedEfforts = efforts === undefined || efforts === '—'
    ? []
    : efforts.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  return {
    id,
    name: name ?? '',
    context: context === undefined || context === '—' ? '' : context,
    efforts: parsedEfforts,
    price: price ?? '',
    plan: plan ?? '',
  }
}

/**
 * The model ids the LIVE catalog serves, or undefined when no credential is
 * available.
 *
 * Read from the environment first, then from the plugin's own auth store, so the
 * check can run on a machine where the user never exported the key.
 */
async function liveCatalogIds() {
  let key = process.env.COMMANDCODE_API_KEY
  if (key === undefined || key === '') {
    try {
      const store = JSON.parse(readFileSync(join(homedir(), '.dsh', 'plugins', 'subscriptions', 'auth.json'), 'utf8'))
      const account = Object.values(store?.commandcode?.accounts ?? {})[0]
      if (typeof account?.accessToken === 'string') key = account.accessToken
    } catch { /* no stored credential */ }
  }
  if (key === undefined || key === '') return undefined
  try {
    const response = await fetch('https://api.commandcode.ai/provider/v1/models', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'x-command-code-version': version },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const ids = rows.map(row => row?.id).filter(id => typeof id === 'string' && id !== '')
    return ids.length === 0 ? undefined : ids
  } catch {
    return undefined
  }
}

/** Every row of the table, in published order. */function parseTable(markdown) {
  const rows = []
  const seen = new Set()
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const row = parseRow(line)
    if (row === undefined || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

const version = pinnedVersion ?? await latestVersion()
if (version === undefined) {
  console.error('cc-models: could not resolve the CLI version from npm (offline?)')
  process.exit(2)
}

let markdown
try {
  markdown = await fetchTable(version)
} catch (error) {
  console.error(`cc-models: could not read the model table from command-code@${version} — ${String(error)}`)
  console.error('This is a network or packaging failure, NOT "no drift".')
  process.exit(2)
}

const rows = parseTable(markdown)
if (rows.length === 0) {
  console.error(`cc-models: command-code@${version} shipped no parseable model table`)
  process.exit(2)
}
if (!rows.some(row => row.id === 'gpt-6-luna')) {
  console.warn('cc-models: WARNING — gpt-6-luna is absent from the table; the parse may have drifted')
}

const efforts = rows.filter(row => row.efforts.length > 0)
console.log(`command-code@${version}: ${rows.length} models, ${efforts.length} with selectable efforts`)

if (checkMode) {
  const current = readFileSync(OUT, 'utf8')
  const missing = rows.filter(row => !current.includes(JSON.stringify(row.id)))
  if (missing.length > 0) {
    console.error(`\nDRIFT: ${missing.length} published model(s) are absent from ${OUT}:`)
    for (const row of missing) console.error(`  - ${row.id}  efforts=[${row.efforts.join(', ')}]`)
    process.exit(1)
  }
  console.log('no drift: every published model is vendored')

  // The comparison that would have caught `gpt-6-luna` BEFORE it shipped: a model
  // the live catalog serves with no row here. The published table comes from an
  // npm release and can lag the service by a release; the live roster cannot.
  const live = await liveCatalogIds()
  if (live === undefined) {
    console.log('live catalog: not checked (no COMMANDCODE_API_KEY and no stored credential)')
    process.exit(0)
  }
  const known = new Set(rows.map(row => row.id))
  const unlisted = live.filter(id => !known.has(id))
  if (unlisted.length > 0) {
    console.error(`\nDRIFT: ${String(unlisted.length)} model(s) in the LIVE catalog have no published row:`)
    for (const id of unlisted) console.error(`  - ${id}`)
    console.error('\nThe table lags the service by a CLI release; check for a newer command-code, then re-run.')
    process.exit(1)
  }
  console.log(`live catalog: all ${String(live.length)} served models are covered by the table`)
  process.exit(0)
}

const lines = [
  '/**',
  ' * The Command Code model table: context window, selectable thinking levels and',
  ' * minimum plan per model id.',
  ' *',
  ` * GENERATED by \`scripts/sync-commandcode-models.mjs\` from command-code@${version}`,
  ' * (`dist/bundled/command-code-knowledge/reference/models.md`, itself generated from',
  ' * https://commandcode.ai/docs) — do not hand-edit.',
  '',
  ' * ## Why a vendored table at all',
  ' *',
  ' * `GET /provider/v1/models` discloses only',
  ' * `context_length, created, id, name, object, owned_by, supported_endpoints` — it',
  ' * carries NO reasoning metadata, so the thinking-level picker cannot be derived',
  ' * from it. This table is the vendor\'s own published answer, which is why the plugin',
  ' * DERIVES it here instead of anyone transcribing new models by hand: a hand-kept map',
  ' * is what left `gpt-6-luna` with no selector at all.',
  ' *',
  ' * `efforts: []` is an EXPLICIT "this model has no selectable levels", not an unknown.',
  ' * The distinction is load-bearing: it is what lets a test tell "upstream added a model',
  ' * nobody synced" (absent from this file) from "upstream shipped a model with no level',
  ' * picker" (present with an empty list).',
  ' *',
  ' * The live catalog still wins for CONTEXT: it reports exact token counts and is',
  ' * current the moment a model ships, where this table rounds (`1.05M`).',
  ' *',
  ' * @module dsh-subscription-hub/providers/commandcode-models',
  ' */',
  '',
  `/** The CLI release this table was read from. */`,
  `export const COMMANDCODE_MODELS_VERSION = ${JSON.stringify(version)}`,
  '',
  '/** One model as the vendor publishes it. */',
  'export interface CommandCodePublishedModel {',
  '  /** Wire model id, exactly as the catalog spells it. */',
  '  name: string',
  '  /** Display context window, e.g. `1.05M`; the live catalog gives exact tokens. */',
  '  context: string',
  '  /** Selectable thinking levels, in the vendor\'s order; empty means none. */',
  '  efforts: readonly string[]',
  '  /** Minimum subscription plan, as published. */',
  '  plan: string',
  '}',
  '',
  '/** The published table, keyed by model id. */',
  'export const COMMANDCODE_PUBLISHED_MODELS: Readonly<Record<string, CommandCodePublishedModel>> = Object.freeze({',
]
for (const row of rows) {
  lines.push(`  // ${row.name}${row.plan === '' ? '' : ` · ${row.plan}`}${row.price === '' ? '' : ` · ${row.price}`}`)
  lines.push(`  ${JSON.stringify(row.id)}: Object.freeze({ name: ${JSON.stringify(row.name)}, context: ${JSON.stringify(row.context)}, efforts: Object.freeze(${JSON.stringify(row.efforts)}), plan: ${JSON.stringify(row.plan)} }),`)
}
lines.push('})', '')

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8')
console.log(`wrote ${OUT}`)
for (const id of ['gpt-6-luna', 'gpt-6-sol', 'deepseek/deepseek-v4-pro', 'claude-opus-5']) {
  const row = rows.find(entry => entry.id === id)
  console.log(`  ${id.padEnd(30)} efforts=[${(row?.efforts ?? ['<ABSENT>']).join(', ')}] context=${row?.context ?? '-'}`)
}
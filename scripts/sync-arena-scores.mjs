#!/usr/bin/env node
/**
 * Sync `src/model-agent-score.ts` with https://arena.ai/leaderboard/agent.
 *
 * The board renders entirely client-side and its API refuses direct requests, so
 * reading it needs a real browser. This drives an already-installed Chrome rather
 * than downloading one, which is why it is a developer script and not something
 * the plugin does at runtime.
 *
 * Usage:
 *   node scripts/sync-arena-scores.mjs           # print the rows it read + verify
 *   node scripts/sync-arena-scores.mjs --json    # machine-readable, for a diff
 *   node scripts/sync-arena-scores.mjs --check   # report drift against the module
 *
 * Exit codes: 0 ok, 1 drift (with --check), 2 the board could not be read (so a
 * network or bot-challenge failure never reads as "no drift").
 *
 * Requires `playwright-core` (a devDependency-free, on-demand install):
 *   npm i -D playwright-core
 * and Chrome, overridable with ARENA_CHROME.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const CHROME = process.env.ARENA_CHROME
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL_AGENT = 'https://arena.ai/leaderboard/agent'
const MODULE_PATH = new URL('../src/model-agent-score.ts', import.meta.url)

const checkMode = process.argv.includes('--check')
const jsonMode = process.argv.includes('--json')

/** Load playwright-core, which is only needed when this script actually runs. */
async function loadChromium() {
  try {
    const require = createRequire(import.meta.url)
    return (await import(require.resolve('playwright-core'))).chromium
  } catch {
    console.error('arena-sync: playwright-core is not installed. Run: npm i -D playwright-core')
    process.exit(2)
  }
}

/** Read the board's rows. Throws when the board could not be reached. */
async function readBoard() {
  const chromium = await loadChromium()
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 3200 } })
    // NOT `networkidle`: the page streams analytics beacons forever, so that
    // condition never settles. Wait for the table itself instead.
    await page.goto(URL_AGENT, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('table tr td', { timeout: 60_000 })
    await page.waitForTimeout(8_000)
    // Rows below the fold only exist after scrolling.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(2_500)

    const rows = await page.evaluate(() => {
      const percent = (text) => {
        const m = /(-?\d+(?:\.\d+)?)\s*%\s*(?:±\s*(\d+(?:\.\d+)?)\s*%)?/.exec(text)
        return m === null ? undefined : { score: Number(m[1]), ci: m[2] === undefined ? 0 : Number(m[2]) }
      }
      const out = []
      for (const tr of document.querySelectorAll('table tr')) {
        const cells = [...tr.querySelectorAll('td')]
        if (cells.length < 3) continue
        const net = percent(cells[2]?.textContent ?? '')
        if (net === undefined) continue
        const rankSpan = cells[0]?.querySelector('span')
        const rank = Number((rankSpan?.textContent ?? '').trim())
        // "AnthropicClaude Opus 5 (High)Anthropic · Proprietary" — the trailing
        // "<vendor> · <license>" is the tooltip; the head repeats the vendor.
        const modelCell = (cells[1]?.textContent ?? '').replace(/\s+/g, ' ').trim()
        const trailer = /([A-Za-z][A-Za-z.\- ]*?)\s*·\s*([^·]+)$/.exec(modelCell)
        const vendor = trailer?.[1]?.trim() ?? ''
        let name = (trailer === null ? modelCell : modelCell.slice(0, modelCell.lastIndexOf(trailer[0]))).trim()
        if (vendor !== '' && name.toLowerCase().startsWith(vendor.toLowerCase())) name = name.slice(vendor.length).trim()
        name = name.replace(/\s*[A-Za-z][A-Za-z.\- ]*\s*$/, m => (/^[A-Z][a-z]+\.[a-z]+$/.test(m.trim()) ? '' : m)).trim()
        out.push({ rank: Number.isFinite(rank) ? rank : undefined, name, vendor, score: net.score, ci: net.ci })
      }
      return out
    })
    if (rows.length === 0) throw new Error('the board rendered no rows')
    return rows
  } finally {
    await browser.close()
  }
}

/** Split rows into the self-consistent head and the anomalous tail. */
function splitVerified(rows) {
  const head = []
  for (const row of rows) {
    if (head.length > 0 && head[head.length - 1].score < row.score) break
    head.push(row)
  }
  return { head, tail: rows.slice(head.length) }
}

/** The keys the vendored module claims to carry. */
function moduleKeys() {
  const source = readFileSync(MODULE_PATH, 'utf8')
  return [...source.matchAll(/\{\s*key:\s*'([a-z0-9]+)'/g)].map(m => m[1])
}

const rows = await readBoard().catch((error) => {
  console.error(`arena-sync: could not read the board — ${String(error).split('\n')[0]}`)
  console.error('This is a network or bot-challenge failure, NOT "no drift".')
  process.exit(2)
})

const { head, tail } = splitVerified(rows)

if (jsonMode) {
  console.log(JSON.stringify({ url: URL_AGENT, readAt: new Date().toISOString(), verified: head, quarantined: tail }, null, 2))
} else {
  console.log(`read ${String(rows.length)} rows; ${String(head.length)} self-consistent, ${String(tail.length)} quarantined`)
  for (const row of head) {
    console.log(`  #${String(row.rank ?? '?').padEnd(3)} ${String(row.name).padEnd(32)} ${String(row.score).padStart(6)}% ±${row.ci}  ${row.vendor}`)
  }
  if (tail.length > 0) {
    console.log(`\n  QUARANTINED — rank order and score order disagree, so these are NOT vendored:`)
    for (const row of tail) console.log(`    #${String(row.rank ?? '?')} ${row.name} ${row.score}%`)
  }
}

if (checkMode) {
  const vendored = moduleKeys()
  const liveKeys = head.map(row => row.name.replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/[^a-z0-9]/g, ''))
  const missing = liveKeys.filter(key => !vendored.includes(key))
  if (missing.length > 0) {
    console.error(`\nDRIFT: ${String(missing.length)} verified live row(s) are absent from src/model-agent-score.ts:`)
    for (const key of [...new Set(missing)]) console.error(`  - ${key}`)
    process.exit(1)
  }
  console.log('\nno drift: every verified live row is vendored')
}
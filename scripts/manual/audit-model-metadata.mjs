/**
 * Audit every subscription provider's reasoning levels and context windows
 * against its own authoritative endpoint.
 *
 * This is the check to run whenever a provider's roster, windows, or thinking
 * levels are in question. It prints, per provider:
 *
 *   - `LIVE`  — what the provider's own catalog endpoint reports right now
 *   - `HUB`   — what this plugin would resolve (discovery + static fallback)
 *
 * and collects any row where the two disagree into a `PROBLEMS` list.
 *
 * Credentials are read from the hub's own store (`~/.dsh/plugins/subscriptions/auth.json`),
 * plus the per-CLI stores for codex. A provider with no stored credential is
 * reported as skipped rather than silently passing.
 *
 * Usage: node scripts/manual/audit-model-metadata.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const LIB = new URL('../../lib/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const sub = JSON.parse(readFileSync(join(home, '.dsh', 'plugins', 'subscriptions', 'auth.json'), 'utf8'))
const sessionOf = (provider) => {
  const accounts = sub[provider]?.accounts ?? {}
  return accounts[sub[provider]?.default] ?? accounts[Object.keys(accounts)[0]]
}
const load = (rel) => import(pathToFileURL(`${LIB}${rel}`).href)

const problems = []
const skipped = []
const note = (provider, message) => {
  problems.push(`[${provider}] ${message}`)
  console.log(`   !! ${message}`)
}
const skip = (provider, why) => {
  skipped.push(`[${provider}] ${why}`)
  console.log(`   -- skipped: ${why}`)
}

const section = (title) => { console.log(); console.log(`=== ${title} ===`) }
const row = (id, ctx, out, efforts, extra = '') =>
  ` ${String(id).padEnd(40)} ctx=${String(ctx ?? '?').padEnd(9)} out=${String(out ?? '?').padEnd(8)} efforts=${efforts === '' ? '-' : efforts}${extra}`

// ---------------------------------------------------------------------------
section('Cline  (official: /ai/cline/models + models.dev)')
// ---------------------------------------------------------------------------
{
  const { discoverClineModels, CLINE_MODEL_CATALOG } = await load('providers/cline/catalog.js')
  const s = sessionOf('cline')
  if (s === undefined) {
    skip('cline', 'no stored credential')
  } else {
    const live = await discoverClineModels(s.accessToken, 'https://api.cline.bot/api/v1')
    console.log(' LIVE:')
    for (const m of live) {
      console.log(row(m.id, m.contextWindow, m.maxTokens, (m.efforts ?? []).join('/'), `  [${m.source}]`))
    }
    // The static table only needs to agree with the live read where both speak.
    const liveById = new Map(live.map(m => [m.id, m]))
    for (const m of CLINE_MODEL_CATALOG) {
      const hit = liveById.get(m.id)
      if (hit === undefined) continue
      if (m.contextWindow !== hit.contextWindow) note('cline', `${m.id} ctx static=${m.contextWindow} vs live=${hit.contextWindow}`)
      if (m.maxTokens !== hit.maxTokens) note('cline', `${m.id} out static=${m.maxTokens} vs live=${hit.maxTokens}`)
      if (JSON.stringify(m.input) !== JSON.stringify(hit.input)) note('cline', `${m.id} input static=${JSON.stringify(m.input)} vs live=${JSON.stringify(hit.input)}`)
    }
    // models.dev is the authority the levels are read from; re-read it here so a
    // silent divergence between the two sources is visible.
    const registry = await fetch('https://models.dev/api.json').then(r => r.json()).catch(() => undefined)
    if (registry === undefined) {
      skip('cline/models.dev', 'registry unreachable')
    } else {
      for (const m of live) {
        const dev = registry?.providers?.['cline-pass']?.models?.[m.id]
        if (dev === undefined) continue
        const devEfforts = (dev.reasoning_options ?? []).flatMap(o => o.values ?? []).filter(v => v !== 'none').sort()
        const hubEfforts = (m.efforts ?? []).filter(e => e !== 'none').sort()
        if (JSON.stringify(devEfforts) !== JSON.stringify(hubEfforts)) {
          note('cline', `${m.id} efforts hub=${hubEfforts.join('/') || '-'} vs models.dev=${devEfforts.join('/') || '-'}`)
        }
        if (dev.limit?.context !== undefined && dev.limit.context !== m.contextWindow) {
          note('cline', `${m.id} ctx hub=${m.contextWindow} vs models.dev=${dev.limit.context}`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('Trae  (official: solo.trae.cn remote directory)')
// ---------------------------------------------------------------------------
{
  const { fetchRemoteModels, TRAE_FALLBACK_MODELS, fetchTraeModels, mergeTraeModels } = await load('providers/trae/catalog.js')
  const s = sessionOf('trae')
  if (s === undefined) {
    skip('trae', 'no stored credential')
  } else {
    const resolved = mergeTraeModels(await fetchTraeModels(s.accessToken, s.userId ?? '', 'solo'))
    const raw = await fetchRemoteModels(s.accessToken, undefined, async (url, init) => fetch(url, init))
    const rawById = new Map((raw ?? []).map(m => [m.id, m]))
    console.log(' LIVE:')
    for (const m of resolved) {
      console.log(row(m.id, m.contextWindow, m.maxTokens, (m.efforts ?? []).join('/'), m.wireConfigName ? `  wire=${m.wireConfigName}` : ''))
      const hit = rawById.get(m.id)
      if (hit === undefined) {
        if (m.wireConfigName === undefined) note('trae', `${m.id} not in the official directory`)
        continue
      }
      if (m.contextWindow !== hit.contextWindow) note('trae', `${m.id} ctx hub=${m.contextWindow} vs directory=${hit.contextWindow}`)
      if ((m.efforts ?? []).join('/') !== (hit.efforts ?? []).join('/')) {
        note('trae', `${m.id} efforts hub=${(m.efforts ?? []).join('/') || '-'} vs directory=${(hit.efforts ?? []).join('/') || '-'}`)
      }
      if (m.maxContextWindow !== hit.maxContextWindow) {
        note('trae', `${m.id} maxWindow hub=${m.maxContextWindow ?? '-'} vs directory=${hit.maxContextWindow ?? '-'}`)
      }
    }
    console.log(' STATIC:')
    for (const m of TRAE_FALLBACK_MODELS) {
      console.log(row(m.id, m.contextWindow, undefined, (m.efforts ?? []).join('/')))
      const hit = rawById.get(m.id)
      if (hit === undefined) continue
      if (m.contextWindow !== hit.contextWindow) note('trae', `static ${m.id} ctx=${m.contextWindow} vs directory=${hit.contextWindow}`)
      if ((m.efforts ?? []).join('/') !== (hit.efforts ?? []).join('/')) {
        note('trae', `static ${m.id} efforts=${(m.efforts ?? []).join('/') || '-'} vs directory=${(hit.efforts ?? []).join('/') || '-'}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('AGY  (pinned catalog + level-thinking map)')
// ---------------------------------------------------------------------------
{
  const { AGY_PUBLIC_MODELS, isLevelThinkingModel } = await load('providers/agy/catalog.js')
  for (const m of AGY_PUBLIC_MODELS) {
    const level = isLevelThinkingModel(m.id)
    console.log(row(m.id, m.contextLength, m.maxOutputTokens, level ? 'low/medium/high' : '', `  reasoning=${!!m.supportsReasoning} vision=${!!m.supportsVision}`))
    // A model that reasons internally without a level selector is CORRECT when
    // the upstream has no thinkingLevel axis for it (gemini-2.5-pro takes a
    // fixed thinking budget). The two states that are always wrong:
    if (level && m.supportsReasoning !== true) {
      note('agy', `${m.id} exposes a level selector but supportsReasoning is false`)
    }
    if (!level && m.thinking === 'level') {
      note('agy', `${m.id} is marked level-thinking but isLevelThinkingModel() is false`)
    }
  }
}

// ---------------------------------------------------------------------------
section('Codex  (live: chatgpt.com/backend-api/codex/models)')
// ---------------------------------------------------------------------------
{
  let token
  try {
    const auth = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'))
    token = auth.tokens?.access_token ?? auth.access_token
  } catch { /* no credential */ }
  if (token === undefined) {
    skip('codex', 'no CLI credential')
  } else {
    const url = 'https://chatgpt.com/backend-api/codex/models?client_version=0.153.4'
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!r.ok) {
      skip('codex', `catalog returned HTTP ${r.status} (the CLI token is expired — re-login to audit)`)
    } else {
      const json = await r.json()
      const models = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : []
      for (const m of models) {
        console.log(row(m.id, m.context_window, m.max_output_tokens, (m.reasoning?.efforts ?? []).map(e => e.id ?? e).join('/')))
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('Grok  (live: cli-chat-proxy.grok.com/v1/models)')
// ---------------------------------------------------------------------------
{
  const s = sessionOf('grok')
  if (s?.accessToken === undefined) {
    skip('grok', 'no stored credential')
  } else {
    const r = await fetch('https://cli-chat-proxy.grok.com/v1/models', { headers: { authorization: `Bearer ${s.accessToken}` } })
    if (!r.ok) {
      skip('grok', `catalog returned HTTP ${r.status}`)
    } else {
      const json = await r.json()
      for (const m of json?.data ?? []) {
        console.log(row(m.id, m.context_window, m.max_output_tokens ?? '-', (m.reasoning_efforts ?? []).map(e => e.value).join('/'), `  backend=${m.api_backend}`))
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('Copilot  (live: api.githubcopilot.com/models)')
// ---------------------------------------------------------------------------
{
  let token
  try {
    const hosts = JSON.parse(readFileSync(join(home, '.config', 'github-copilot', 'hosts.json'), 'utf8'))
    token = hosts['github.com']?.oauth_token
  } catch { /* no credential */ }
  if (token === undefined) {
    skip('copilot', 'no CLI credential')
  } else {
    const r = await fetch('https://api.githubcopilot.com/models', {
      headers: { authorization: `Bearer ${token}`, 'editor-version': 'vscode/1.107.0', 'editor-plugin-version': 'copilot/1.0.0' },
    })
    if (!r.ok) {
      skip('copilot', `catalog returned HTTP ${r.status}`)
    } else {
      const json = await r.json()
      for (const m of json?.data ?? []) {
        const limits = m.capabilities?.limits ?? {}
        const efforts = (m.capabilities?.supports?.reasoning_effort ?? []).map(e => e.id ?? e)
        console.log(row(m.id, limits.max_context_window_tokens, limits.max_output_tokens, efforts.join('/')))
      }
    }
  }
}

console.log()
console.log('=== SKIPPED ===')
if (skipped.length === 0) console.log(' (none)')
else for (const s of skipped) console.log(' ' + s)

console.log()
console.log('=== PROBLEMS ===')
if (problems.length === 0) console.log(' (none)')
else for (const p of problems) console.log(' ' + p)

process.exitCode = problems.length === 0 ? 0 : 1

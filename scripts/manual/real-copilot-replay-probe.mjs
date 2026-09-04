#!/usr/bin/env node
/**
 * Minimal-traffic probe against the REAL GitHub Copilot gateway for the
 * "Copilot Responses reasoning replay" path (CopilotAdapter +
 * CopilotResponsesItemNormalizer + include:['reasoning.encrypted_content']).
 *
 * Budget: at most ONE GET /models (skipped entirely when the production
 * durable catalog ~/.dsh/plugins/subscriptions/models.json already holds the
 * Copilot entries — its data came from the same live endpoint) plus ONE
 * POST /responses per phase-1 attempt (a stronger-prompt retry is allowed
 * only when the model refused the tool) plus ONE POST /responses for the
 * phase-2 replay. maxTokens is 800 on every generation. Nothing secret is
 * ever printed: no tokens, no headers, no blob contents — only field names,
 * lengths, and statuses. A proactive Copilot-token refresh (api.github.com,
 * not the LLM gateway) may fire and write back to the real auth store; that
 * is normal behavior.
 *
 * Phase 2 keeps the tools: the agent loop re-sends its tool list on every
 * round, and that is what keeps a dual-protocol model (gpt-5.4) on /responses
 * for the continuation — without tools the reroute rule (tools + effort)
 * does not fire and the request degrades to /chat/completions, where no
 * reasoning replay can ride at all.
 *
 * Env knobs:
 *   PROBE_EFFORT=<id>     reasoning effort (default: low; from the catalog)
 *   PROBE_LIVE_MODELS=1   force a live /models discovery (spends budget)
 *   PROBE_PHASE1_ONLY=1   stop after phase 1 (single-request mode)
 *   PROBE_SESSION=<id>    session id (default: probe-session)
 *
 * Usage: node scripts/manual/real-copilot-replay-probe.mjs
 */
import {
  CopilotAdapter,
  COPILOT_PREEMPT_MS,
  fetchCopilotModels,
  isCopilotPermanentRefreshError,
  refreshCopilot,
} from '../../lib/providers/copilot.js'
import { TokenManager } from '../../lib/providers/common.js'
import { catalogStore } from '../../lib/providers/catalog-store.js'
import { deleteSession, getSession, saveSession } from '../../lib/auth/store.js'

const BUDGET = Number(process.env.PROBE_BUDGET ?? 4) // hard cap on api.githubcopilot.com requests
const MAX_TOKENS = 800
const sessionId = process.env.PROBE_SESSION ?? 'probe-session' // branded ids are plain strings at runtime

// ---------------------------------------------------------------- fetch tap
// Records url/method/body of gateway calls (never headers) and tees the
// /responses SSE stream so the RAW `response.output_item.done` item shapes
// the gateway delivered are kept as direct evidence, beside the adapter's
// own capture path.
const realFetch = globalThis.fetch
const copilotCalls = [] // { path, method, body, status } — bodies held, never printed wholesale
const rawDoneItems = [] // shapes of done items from the CURRENT SSE stream
let sawTerminalEvent = false
function noteSseBlock(block) {
  const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
  if (data.length === 0) return
  let event
  try { event = JSON.parse(data) } catch { return }
  if (event.type === 'response.output_item.done' && event.item !== undefined) {
    const item = event.item
    rawDoneItems.push({
      type: item.type,
      idLen: typeof item.id === 'string' ? item.id.length : 0,
      encLen: typeof item.encrypted_content === 'string' ? item.encrypted_content.length : 0,
      summaryParts: Array.isArray(item.summary) ? item.summary.length : 0,
      status: typeof item.status === 'string' ? item.status : undefined,
      ...(item.type === 'function_call'
        ? { name: item.name, callIdLen: typeof item.call_id === 'string' ? item.call_id.length : 0 }
        : {}),
    })
  }
  if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
    sawTerminalEvent = true
  }
}
async function drainSse(branch) {
  const reader = branch.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        noteSseBlock(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
      }
    }
  } catch { /* evidence drain only */ }
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  let response = await realFetch(input, init)
  if (!url.startsWith('https://api.githubcopilot.com/')) return response
  if (copilotCalls.length >= BUDGET) throw new Error('probe budget exhausted')
  let body
  try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { body = undefined }
  copilotCalls.push({ path: new URL(url).pathname, method: init?.method ?? 'GET', body, status: response.status })
  if (new URL(url).pathname === '/responses' && response.body !== null) {
    const [forAdapter, forProbe] = response.body.tee()
    void drainSse(forProbe)
    response = new Response(forAdapter, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return response
}
const callsTo = path => copilotCalls.filter(call => call.path === path)

// ---------------------------------------------------- TokenManager (as src/)
const tokens = new TokenManager({
  displayName: 'GitHub Copilot',
  preemptMs: COPILOT_PREEMPT_MS,
  load: () => getSession('copilot'),
  save: session => saveSession('copilot', session),
  remove: () => deleteSession('copilot'),
  refresh: refreshCopilot,
  isPermanent: isCopilotPermanentRefreshError,
  onRemoved: () => {},
})

// ---------------------------------------------------------------- discovery
// The production durable catalog answers first (same live-gateway data, zero
// budget); a live /models fetch happens only when it is absent or forced.
const disk = process.env.PROBE_LIVE_MODELS === '1' ? undefined : await catalogStore('copilot').load().catch(() => undefined)
let models
let modelsSource
if (disk !== undefined && disk.models.length > 0) {
  models = disk.models
  modelsSource = `durable catalog (${models.length} models, discovered ${new Date(disk.at).toISOString()})`
} else {
  models = await fetchCopilotModels(await tokens.session())
  modelsSource = 'live GET /models'
}
const effortsOf = entry => entry.reasoning?.efforts?.map(effort => String(effort.id)) ?? []
const preferred = models.find(entry => entry.id === 'gpt-5.4' && effortsOf(entry).length > 0)
const responsesWithEfforts = models.filter(entry => entry.copilotWire === 'responses' && effortsOf(entry).length > 0)
const chosen = preferred ?? responsesWithEfforts[0]
  ?? models.find(entry => entry.copilotWire === 'responses') ?? models[0]
if (chosen === undefined) throw new Error('copilot catalog is empty')
const efforts = effortsOf(chosen)
const effort = process.env.PROBE_EFFORT !== undefined
  ? (efforts.includes(process.env.PROBE_EFFORT) || efforts.length === 0 ? process.env.PROBE_EFFORT : undefined)
  : (efforts.includes('low') ? 'low' : (chosen.copilotWire !== 'responses' && efforts.length > 0 ? efforts[0] : undefined))
if (process.env.PROBE_EFFORT !== undefined && effort === undefined) {
  throw new Error(`PROBE_EFFORT=${process.env.PROBE_EFFORT} is not advertised for ${chosen.id} (has: ${efforts.join(',') || 'none'})`)
}

// Seed the adapter's catalog cache as FRESH so its discovered() never spends
// a second /models request (budget); entries are the same live-gateway data.
const seededAt = Date.now()
const seedStore = {
  load: async () => ({ at: seededAt, models }),
  save: async () => {},
  clear: async () => {},
}
const warns = []
const adapter = new CopilotAdapter({
  models: [],
  streamIdleTimeoutMs: 300_000,
  tokens,
  discovery: true,
  onWarn: message => { warns.push(message) },
  catalogStore: seedStore,
})

// ------------------------------------------------------------------ helpers
const text = value => `"${String(value).slice(0, 80).replace(/\s+/g, ' ')}"`
async function generate(options) {
  rawDoneItems.length = 0
  sawTerminalEvent = false
  const blocks = []
  let finish
  try {
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason.kind
    }
  } catch (error) {
    return { blocks, finish, error: String(error.message ?? error), doneItems: [...rawDoneItems], sseTerminal: sawTerminalEvent }
  }
  return { blocks, finish, error: undefined, doneItems: [...rawDoneItems], sseTerminal: sawTerminalEvent }
}
const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}
const userMessage = prompt => ({
  id: 'probe-msg-1',
  role: 'user',
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'user' },
})
const baseOptions = prompt => ({
  provider: 'copilot',
  model: chosen.id,
  sessionId,
  maxTokens: MAX_TOKENS,
  tools: [weatherTool],
  ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  messages: [userMessage(prompt)],
})

// ------------------------------------------------------------------ phase 1
let phase1 = await generate(baseOptions("What's the weather in Paris? You MUST call the get_weather tool."))
let promptUsed = 'plain'
const toolCallsOf = result => result.blocks.filter(block => block.type === 'tool-call')
if (toolCallsOf(phase1).length === 0 && callsTo('/responses').length + callsTo('/chat/completions').length < BUDGET - 1) {
  promptUsed = 'forced'
  phase1 = await generate(baseOptions('What is the weather in Paris right now? You MUST call the get_weather tool first. Do NOT answer from your own knowledge; calling the tool is mandatory.'))
}
const reasoningBlock = phase1.blocks.find(block => block.type === 'reasoning')
const toolCalls = toolCallsOf(phase1)
const rawReasoningDone = phase1.doneItems.filter(item => item.type === 'reasoning')
const capturedScopes = adapter.replayByScope.size // >0 ⇔ some done reasoning item carried id + encrypted_content

// ------------------------------------------------------------------ phase 2
let phase2
let replay = { present: false }
let phase2Wire = 'skipped'
if (process.env.PROBE_PHASE1_ONLY !== '1' && toolCalls.length > 0
  && callsTo('/responses').length + callsTo('/chat/completions').length < BUDGET) {
  const assistant = {
    id: 'probe-msg-2',
    role: 'assistant',
    content: [...(reasoningBlock === undefined ? [] : [reasoningBlock]), ...toolCalls],
    source: { kind: 'model', provider: 'copilot', model: chosen.id },
  }
  const callId = toolCalls[0].id
  const toolResult = {
    id: 'probe-msg-3',
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text: 'Sunny, 18°C, light wind from the west.' }],
    }],
    source: { kind: 'tool', callId },
  }
  const before = copilotCalls.length
  // Tools stay in: the agent loop re-sends them every round, and they are
  // what keeps a dual-protocol model on /responses for the continuation.
  phase2 = await generate({
    provider: 'copilot',
    model: chosen.id,
    sessionId,
    maxTokens: MAX_TOKENS,
    tools: [weatherTool],
    system: 'Answer very briefly.',
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    messages: [userMessage("What's the weather in Paris? You MUST call the get_weather tool."), assistant, toolResult],
  })
  const phase2Calls = copilotCalls.slice(before)
  const onResponses = phase2Calls.find(call => call.path === '/responses')
  phase2Wire = onResponses !== undefined ? '/responses' : (phase2Calls[0]?.path ?? 'none')
  if (onResponses !== undefined) {
    const input = onResponses.body?.input ?? []
    const reasoningItems = input.filter(item => item?.type === 'reasoning')
    const lastReasoningIndex = reasoningItems.length > 0 ? input.lastIndexOf(reasoningItems.at(-1)) : -1
    const callIndex = input.findIndex(item => item?.type === 'function_call')
    replay = {
      present: reasoningItems.length > 0,
      items: reasoningItems.map(item => ({
        idLen: typeof item.id === 'string' ? item.id.length : 0,
        encLen: typeof item.encrypted_content === 'string' ? item.encrypted_content.length : 0,
        summaryParts: Array.isArray(item.summary) ? item.summary.length : 0,
        status: typeof item.status === 'string' ? item.status : undefined,
      })),
      adjacent: reasoningItems.length > 0 && callIndex === lastReasoningIndex + 1,
      include: Array.isArray(onResponses.body?.include) ? onResponses.body.include : [],
      status: onResponses.status,
    }
  }
}

// ------------------------------------------------------------------ summary
const lines = []
lines.push(`model: ${chosen.id} | catalog copilotWire=${chosen.copilotWire ?? 'n/a'} copilotResponses=${String(chosen.copilotResponses === true)} | efforts=[${efforts.join(',') || 'none'}] effort=${effort ?? 'none'} | models: ${modelsSource}`)
lines.push(`wire taken: ${callsTo('/responses').length > 0 ? 'POST /responses' : 'n/a'} | reroute=${chosen.copilotWire === 'chat-completions' && callsTo('/responses').length > 0 ? 'yes (auto)' : 'no'} | prompt=${promptUsed}`)
lines.push(`budget: ${copilotCalls.length}/${BUDGET} gateway calls -> ${copilotCalls.map(call => `${call.method} ${call.path}:${call.status}`).join(' | ') || 'none'}`)
const phase1Status = callsTo('/responses')[0]?.status ?? 'n/a'
lines.push(`phase1: ${phase1Status} HTTP | finish=${phase1.finish ?? 'error'} | reasoning-block=${reasoningBlock !== undefined ? `yes (${reasoningBlock.text.length} chars)` : 'no'} | tool-calls=${toolCalls.map(call => `${call.name}(id ${String(call.id).length}b)`).join(',') || 'none'}${phase1.error === undefined ? '' : ` | ERROR ${phase1.error.slice(0, 300)}`}`)
lines.push(`phase1 raw SSE done items: ${phase1.doneItems.map(item => `${item.type}{id:${item.idLen}b,enc:${item.encLen}b,summary:${item.summaryParts},status:${item.status ?? 'absent'}}`).join(' ; ') || 'none'} | terminal-event=${String(phase1.sseTerminal)}`)
lines.push(`capture: adapter replay scopes=${capturedScopes} -> gateway ${capturedScopes > 0 ? 'DID deliver id+encrypted_content on a reasoning done item' : 'delivered NO reasoning item with id+encrypted_content'} (raw reasoning done items: ${rawReasoningDone.length})`)
if (phase2 !== undefined) {
  if (replay.present || phase2Wire === '/responses') {
    lines.push(`phase2 wire=${phase2Wire} | replay request reasoning items=${replay.items.length} | fields: ${replay.items.map(item => `id(${item.idLen}b) enc(${item.encLen}b) summary(${item.summaryParts} parts) status=${item.status ?? 'absent'}`).join(' ; ') || 'NONE (nothing captured to replay)'} | adjacent-before-function_call=${String(replay.adjacent)} | include=[${replay.include.join(',')}]`)
  } else {
    lines.push(`phase2 wire=${phase2Wire} | replay structurally impossible on this wire (no tools+effort reroute; toChatMessages drops reasoning blocks)`)
  }
  const finalText = phase2.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
  lines.push(`phase2: ${replay.status ?? copilotCalls.at(-1)?.status ?? 'n/a'} HTTP | finish=${phase2.finish ?? 'error'}${phase2.error === undefined ? '' : ` | ERROR ${phase2.error.slice(0, 300)}`} | text=${text(finalText)}`)
} else {
  lines.push('phase2: skipped (PROBE_PHASE1_ONLY or no tool call captured or budget spent)')
}
let verdict
if (phase2 !== undefined && replay.present && replay.status !== undefined && replay.status >= 200 && replay.status < 300 && phase2.error === undefined) {
  verdict = '(a) FULL REPLAY ACCEPTED by the real gateway (reasoning item with encrypted_content replayed before its function_call; 2xx and the SSE stream ran to completion)'
} else if (phase2 !== undefined && phase2Wire === '/responses' && !replay.present && replay.status !== undefined && replay.status >= 200 && replay.status < 300) {
  verdict = '(b) gateway delivered no encrypted_content -> replay lazily degraded (phase-2 /responses request carried NO reasoning item; the no-replay path was accepted)'
} else if (phase2 !== undefined && replay.present) {
  verdict = `(c) gateway REJECTED the replay shape -> see phase2 ERROR above (HTTP ${String(replay.status)})`
} else if (phase2 !== undefined) {
  verdict = `partial: phase-2 request went to ${phase2Wire}; replay wire not exercised in this run`
} else {
  verdict = capturedScopes > 0
    ? 'phase-1 only: gateway DID deliver encrypted_content (replay would be attempted); acceptance not tested this run'
    : 'phase-1 only: gateway delivered NO encrypted_content -> replay would lazily degrade (b)'
}
lines.push(`VERDICT: ${verdict}`)
if (warns.length > 0) lines.push(`warns: ${warns.join(' | ').slice(0, 200)}`)
console.log(lines.join('\n'))

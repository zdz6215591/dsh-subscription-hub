/**
 * Model vendor attribution and Agent Arena score lookup.
 *
 * The rule both modules exist to enforce: a value appears only when it is known,
 * and an unknown model gets nothing rather than a plausible-looking guess. A
 * wrong company label or a score belonging to a different model is worse than a
 * blank, because the reader has no way to tell.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelVendor, vendorsOf } from '../src/model-vendor.js'
import { AGENT_SCORE_ROWS, agentScoreFor, agentScoreKey } from '../src/model-agent-score.js'

test('an owner segment is authoritative', () => {
  assert.equal(modelVendor('deepseek/deepseek-v4-pro')?.id, 'deepseek')
  assert.equal(modelVendor('Qwen/Qwen3.8-Max')?.id, 'qwen')
  assert.equal(modelVendor('moonshotai/Kimi-K3')?.id, 'moonshot')
  assert.equal(modelVendor('z-ai/glm-5.3')?.id, 'zhipu')
  assert.equal(modelVendor('meta/muse-spark-1.3')?.id, 'meta')
  assert.equal(modelVendor('google/gemini-3.8-flash')?.id, 'google')
  assert.equal(modelVendor('MiniMaxAI/MiniMax-M3')?.id, 'minimax')
  assert.equal(modelVendor('inclusionai/ling-3.0-flash')?.id, 'inclusionai')
  assert.equal(modelVendor('meituan/LongCat-2.0')?.id, 'meituan')
  // The owner's own spelling and case do not matter.
  assert.equal(modelVendor('DeepSeek/DeepSeek-V4-Pro')?.id, 'deepseek')
})

test('a bare id falls back to its family prefix', () => {
  assert.equal(modelVendor('claude-opus-5')?.label, 'Anthropic')
  assert.equal(modelVendor('claude-haiku-4-5-20251001')?.label, 'Anthropic')
  assert.equal(modelVendor('gpt-5.6-sol')?.label, 'OpenAI')
  assert.equal(modelVendor('gpt-5.4-mini')?.label, 'OpenAI')
  assert.equal(modelVendor('gemini-3.1-flash-lite')?.label, 'Google')
  assert.equal(modelVendor('grok-4.5')?.label, 'xAI')
  assert.equal(modelVendor('deepseek-v4.1-flash')?.label, 'DeepSeek')
  assert.equal(modelVendor('glm-5.3-flashx')?.label, 'Z.ai')
  assert.equal(modelVendor('Kimi-K2.7-Code')?.label, 'Moonshot AI')
  assert.equal(modelVendor('Doubao-Seed-Code')?.label, 'ByteDance')
})

test('a family prefix applies to a model behind an unknown owner segment', () => {
  // The owner is not a company this build knows, so the family still decides.
  assert.equal(modelVendor('some-gateway/glm-5.3')?.label, 'Z.ai')
  assert.equal(modelVendor('custom/deepseek-v4-pro')?.label, 'DeepSeek')
})

test('an unknown model gets NO vendor rather than a guess', () => {
  // This is the rule that matters: a wrong attribution is unverifiable to the
  // reader, so silence is the only honest answer.
  for (const id of ['mystery-model-9', 'internal/secret-llm', 'foo', 'a/b/c']) {
    assert.equal(modelVendor(id), undefined, id)
  }
  // Only the LAST segment names the model, and the FIRST names the owner, so a
  // nested id still resolves by family while the owner check never reads the
  // wrong part.
  assert.equal(modelVendor('mystery/gateway/claude-opus-5')?.label, 'Anthropic')
})

test('vendorsOf lists each vendor once, in first-seen order', () => {
  const vendors = vendorsOf([
    'deepseek/deepseek-v4-pro',
    'claude-opus-5',
    'deepseek/deepseek-v4-flash',
    'Qwen/Qwen3.8-Max',
    'mystery-model-9', // ignored
    'claude-sonnet-5',
  ])
  assert.deepEqual(vendors.map(v => v.id), ['deepseek', 'anthropic', 'qwen'])
})

test('the score key normalizes ids and board names alike', () => {
  // Owner segments, punctuation, case and parentheticals must all wash out, or
  // a real match would be missed.
  assert.equal(agentScoreKey('claude-opus-5'), 'claudeopus5')
  assert.equal(agentScoreKey('Claude Opus 5 (High)'), 'claudeopus5')
  assert.equal(agentScoreKey('DeepSeek V4 Pro (High) (0813)'), 'deepseekv4pro')
  assert.equal(agentScoreKey('deepseek-v4-pro'), 'deepseekv4pro')
  assert.equal(agentScoreKey('GPT 5.6 Sol (xHigh)'), 'gpt56sol')
  assert.equal(agentScoreKey('Qwen3.8 Flash Next'), 'qwen38flashnext')
})

test('a score resolves for the models this hub actually routes to', () => {
  const cases: [string, number][] = [
    // With no effort known, the base's BEST measured variant is shown, and the
    // returned score carries its own effort so the tooltip can disclose it.
    ['claude-opus-5', 10.25],
    ['claude-fable-5', 8.81],
    ['claude-opus-4-8', 8.19],
    ['claude-sonnet-5', 5.97],
    ['gpt-5.6-sol', 7.10],
    ['gpt-5.5', 2.67],                  // the board's unqualified row wins over (xHigh)
    ['gpt-5.4', 1.26],
    ['grok-4.5', 2.92],
    ['grok-4.6', 2.01],
    ['deepseek/deepseek-v4-pro', 4.14],
    ['deepseek/deepseek-v4.1-flash', 4.88],
    ['deepseek/deepseek-v4-flash', 1.80],
    ['google/gemini-3.8-flash', 4.71],
    ['z-ai/glm-5.3', 3.05],
    ['z-ai/glm-5.3-flashx', undefined as unknown as number], // not the same model as "GLM 5.3 Flash"
    ['moonshotai/Kimi-K3', 6.22],
    ['Qwen/Qwen3.8-Max', 3.30],
    ['meta/muse-spark-1.3', 4.20],
  ]
  for (const [id, expected] of cases) {
    const score = agentScoreFor(id)
    if (expected === undefined) {
      // The board's nearest name is `GLM 5.3 Flash`, a DIFFERENT model, so the
      // lookup must refuse rather than attribute another model's number.
      assert.equal(score, undefined, `${id} must not inherit GLM 5.3 Flash's score`)
      continue
    }
    assert.equal(score?.score, expected, id)
  }
})

test('an exact effort is preferred over the base row, and a mismatch is flagged', () => {
  // The board lists Claude Opus 5 twice, at (High) and (Max).
  const high = agentScoreFor('claude-opus-5', 'high')
  assert.equal(high?.score, 10.25)
  assert.equal(high?.effort, 'high')
  assert.equal(high?.effortMismatch, false)

  const max = agentScoreFor('claude-opus-5', 'max')
  assert.equal(max?.score, 10.16)
  assert.equal(max?.effortMismatch, false)

  // An effort the board did not measure falls back to a variant and SAYS SO,
  // rather than implying the number was measured at this setting.
  const low = agentScoreFor('claude-opus-5', 'low')
  assert.ok(low !== undefined)
  assert.equal(low.effortMismatch, true)
  assert.equal(low.score, 10.25) // the best variant

  // And with no effort known at all, a qualified row is STILL disclosed as a
  // variant: the reader is looking at a number measured at one specific setting.
  const unknown = agentScoreFor('claude-opus-5')
  assert.equal(unknown?.effort, 'high')
  assert.equal(unknown?.effortMismatch, true)
})

test('an unlisted model gets NO score rather than a nearest match', () => {
  for (const id of ['gpt-6', 'claude-opus-9', 'mystery/llm-1', 'Qwen/Qwen3.8-Flash', '']) {
    assert.equal(agentScoreFor(id), undefined, id)
  }
})

test('every vendored row is well formed and internally consistent', () => {
  const seen = new Set<string>()
  for (const row of AGENT_SCORE_ROWS) {
    assert.match(row.key, /^[a-z0-9]+$/, row.key)
    assert.ok(row.label.length > 0)
    assert.ok(Number.isFinite(row.score))
    assert.ok(row.ci >= 0)
    assert.ok(row.rank >= 1)
    assert.ok(row.vendor.length > 0)
    // Same key at different efforts is legal (Claude Opus 5); the same key AND
    // effort twice would be a transcription error.
    const identity = `${row.key}:${row.effort ?? ''}`
    assert.equal(seen.has(identity), false, `duplicate row ${identity}`)
    seen.add(identity)
  }
  // The board is sorted by rank, and the vendored head is its monotonic region:
  // rank order and score order must agree, or a row was transcribed wrongly.
  for (let i = 1; i < AGENT_SCORE_ROWS.length; i += 1) {
    const previous = AGENT_SCORE_ROWS[i - 1]!
    const current = AGENT_SCORE_ROWS[i]!
    assert.ok(previous.score >= current.score, `score order breaks at rank ${String(current.rank)}`)
    assert.ok(previous.rank < current.rank, `rank order breaks at ${String(current.rank)}`)
  }
  // Every row's key must be reachable through the public lookup.
  for (const row of AGENT_SCORE_ROWS) {
    const direct = agentScoreFor(row.label, row.effort)
    assert.ok(direct !== undefined, `unreachable row ${row.label}`)
  }
})

/**
 * Real ids, taken from the live catalogs observed while building this: Command
 * Code's `GET /provider/v1/models`, the bundled Codex/Claude/Grok/Copilot
 * rosters, and the Trae/Cline model lists. This is the check that matters — the
 * synthetic cases above prove the rules, this proves the rules meet the ids the
 * hub actually serves.
 */
const LIVE_IDS: readonly string[] = [
  // Command Code (live /provider/v1/models)
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash',
  'Qwen/Qwen3.8-Max', 'Qwen/Qwen3.8-Max-0902', 'Qwen/Qwen3.8-Plus', 'Qwen/Qwen3.8-Flash',
  'Qwen/Qwen3.8-Omni-Flash', 'Qwen/Qwen3.7-Max-Plus', 'Qwen/Qwen3.6-Max-Preview', 'Qwen/Qwen3.8-27B',
  'MiniMaxAI/MiniMax-M3', 'MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M2.5',
  'moonshotai/Kimi-K2.7-Code', 'moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.5',
  'meta/muse-spark-1.3', 'meta/muse-spark-1.2', 'meta/muse-spark-1.1',
  'google/gemini-3.8-flash', 'google/gemini-3.7-flash', 'google/gemini-3.6-flash',
  'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite', 'google/gemini-3.1-flash-lite',
  'z-ai/glm-5.3-flashx', 'inclusionai/ling-3.0-flash-sante:free', 'meituan/LongCat-2.0',
  'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-fable-5',
  'claude-haiku-4-5-20251001', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
  // Codex / Claude / Grok / Copilot rosters
  'gpt-5.6-codex', 'gpt-5.4-codex', 'grok-4.5', 'grok-4.6', 'grok-4', 'grok-code-fast-1',
  'claude-sonnet-4-6', 'claude-opus-4-7',
  // Trae and Cline lists
  'Doubao-Seed-Code', 'deepseek-v4.1-flash', 'GLM-5.3-Flash', 'Kimi-K2.7-Code', 'gemini-3.8-flash',
  'cline-pass/glm-5.3', 'cline-pass/kimi-k3', 'cline-pass/brand-new-model',
]

test('every live hub model id resolves to a vendor', () => {
  const unresolved = LIVE_IDS.filter(id => modelVendor(id) === undefined)
  // A brand-new gateway model with a novel family WOULD legitimately be
  // unresolved, so this asserts the known ones rather than "nothing may fail".
  assert.deepEqual(
    unresolved.filter(id => !id.startsWith('cline-pass/')),
    [],
    `unresolved live ids: ${unresolved.join(', ')}`,
  )
})

test('the live ids the board lists resolve to their board score', () => {
  const expected = LIVE_IDS.filter(id => agentScoreFor(id) !== undefined).length
  // Coverage is the point: a mis-keyed lookup would silently return nothing for
  // these flagship models, and the feature would look implemented but empty.
  assert.ok(expected >= 20, `only ${String(expected)} of ${String(LIVE_IDS.length)} live ids scored`)
  // Spot-check the exact figures end to end, through the real id shapes.
  assert.equal(agentScoreFor('deepseek/deepseek-v4-pro')?.score, 4.14)
  assert.equal(agentScoreFor('Qwen/Qwen3.8-Max')?.score, 3.30)
  assert.equal(agentScoreFor('google/gemini-3.8-flash')?.score, 4.71)
  assert.equal(agentScoreFor('claude-opus-5')?.score, 10.25)
  assert.equal(agentScoreFor('gpt-5.6-sol')?.score, 7.10)
  assert.equal(agentScoreFor('grok-4.5')?.score, 2.92)
  assert.equal(agentScoreFor('doubao-seed-code'), undefined) // not on the board
})
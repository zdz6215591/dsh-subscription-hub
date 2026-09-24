/**
 * Model vendor attribution.
 *
 * The rule this module exists to enforce: a vendor appears only when it is
 * known. A wrong company label is worse than a blank, because the reader has no
 * way to tell it is wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelVendor, modelVendorFor, vendorsOf } from '../src/model-vendor.js'

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
  assert.equal(modelVendor('some-gateway/glm-5.3')?.label, 'Z.ai')
  assert.equal(modelVendor('custom/deepseek-v4-pro')?.label, 'DeepSeek')
})

test('an unknown model gets NO vendor rather than a guess', () => {
  // This is the rule that matters: a wrong attribution is unverifiable to the
  // reader, so silence is the only honest answer.
  for (const id of ['mystery-model-9', 'internal/secret-llm', 'foo', 'a/b/c']) {
    assert.equal(modelVendor(id), undefined, id)
  }
  // The FIRST segment is the owner and the LAST is the model, so a nested id
  // still resolves by family without the owner check reading the wrong part.
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

/**
 * Real ids, taken from the live catalogs observed while building this: Command
 * Code's `GET /provider/v1/models`, the bundled Codex/Claude/Grok/Copilot
 * rosters, and the Trae/Cline model lists. The synthetic cases above prove the
 * rules; this proves the rules meet the ids the hub actually serves.
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
  // Spot-check the exact attributions the list will show.
  assert.equal(modelVendor('deepseek/deepseek-v4-pro')?.label, 'DeepSeek')
  assert.equal(modelVendor('Qwen/Qwen3.8-Max')?.label, 'Alibaba Qwen')
  assert.equal(modelVendor('google/gemini-3.8-flash')?.label, 'Google')
  assert.equal(modelVendor('claude-opus-5')?.label, 'Anthropic')
  assert.equal(modelVendor('gpt-5.6-sol')?.label, 'OpenAI')
  assert.equal(modelVendor('grok-4.5')?.label, 'xAI')
})

test('every vendor carries a distinct id, and a lab only when models.dev has one', () => {
  const ids = new Set<string>()
  for (const id of LIVE_IDS) {
    const vendor = modelVendor(id)
    if (vendor === undefined) continue
    assert.ok(vendor.label.length > 0)
    // The mark is models.dev's logo or there is none at all: the hand-drawn
    // monogram this used to carry is deleted, so nothing may reintroduce one.
    assert.equal('mono' in vendor, false, `${id} still carries a monogram`)
    if (vendor.lab !== undefined) assert.ok(/^[a-z0-9][a-z0-9._-]*$/.test(vendor.lab), `${id}: lab=${vendor.lab}`)
    // One vendor is one id, so the legend and the React keys stay stable.
    ids.add(vendor.id)
  }
  // The live roster spans several companies; a single-id result would mean the
  // owner table never matched and every row fell through to one family rule.
  assert.ok(ids.size >= 8, `only ${String(ids.size)} distinct vendors resolved`)
})

test('Tencent Hunyuan ids arrive BARE and still resolve to Tencent', () => {
  // CodeBuddy serves these with no owner segment and no `hunyuan` in the name, so the
  // `hunyuan` prefix rule never saw them and all three rows drew no Tencent mark. These
  // are real ids from that catalog.
  for (const [id, name] of [
    ['hy4-preview', 'Hy4 preview · x0.29'],
    ['hy3', 'Hy3 · x0.00'],
    ['hy3-x', 'Hy3 · x0.05'],
    ['hy3-paid', 'Hy3 Paid'],
  ]) {
    assert.equal(modelVendorFor(id, name)?.lab, 'tencent', `${id} must attribute to Tencent`)
  }
  // The versioned forms are keyed rather than a bare `hy`, which would sweep in ids that
  // are not Hunyuan at all.
  assert.equal(modelVendor('hype-model')?.lab, undefined)
})
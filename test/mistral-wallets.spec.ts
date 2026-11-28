/**
 * The two Mistral wallets, and the Vibe CLI's local key.
 *
 * Measured on one live account (plan `EDU`): two chat requests moved
 * `api_budget.usage_percentage` from 0.0003533 to 0.00077 and left `vibe_budget`
 * at 0. So an API/Studio key spends the pay-as-you-go wallet, while the plan
 * allowance is drawn by the key the Vibe CLI uses — the same conclusion the
 * reference project's changelog records.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MistralAdapter, sessionFromMistralKey } from '../src/providers/mistral.js'
import type { MistralAdapterOptions } from '../src/providers/mistral.js'
import { parseVibeEnv, readMistralVibeKey, vibeEnvPath } from '../src/providers/mistral-vibe.js'
import type { MistralSession } from '../src/auth/store.js'

const OPTIONS: GenerateOptions = {
  provider: 'mistral',
  model: 'mistral-large-2512',
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
} as never

function adapterWith(fetchFn: typeof fetch): MistralAdapter {
  const session = sessionFromMistralKey('test-key-0123456789', 'mistral-test')
  return new MistralAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    discovery: false,
    fetchFn: fetchFn as never,
    tokens: {
      session: async () => session,
      list: async () => [{ key: 'a', session, isDefault: true }],
      hasSession: async () => true,
    } as unknown as MistralAdapterOptions['tokens'],
  })
}

test('mistral: an empty API wallet is QUOTA, so a pool can switch accounts', async () => {
  // `billing_api_budget_exhausted` is the vendor's own wording for a drained wallet.
  const fetchFn = (async () => new Response(
    '{"error":{"code":"billing_api_budget_exhausted","message":"API budget exhausted"}}',
    { status: 402 },
  )) as unknown as typeof fetch
  await assert.rejects(
    (async () => {
      for await (const _chunk of adapterWith(fetchFn).stream(OPTIONS)) { /* drain */ }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, QUOTA_EXCEEDED_CODE, 'not HTTP_402: a quota code is what makes failover happen')
      assert.match(error.message, /budget exhausted \(402\)/)
      return true
    },
  )
})

test('mistral: the two wallets are labelled by what they are', () => {
  const usage = { supported: true, windows: [] as { scope?: string }[] }
  // Labels come from the parser; assert the wording so a reader is never told
  // "API budget" when the number is the pay-as-you-go wallet.
  const parsed = (async () => (await import('../src/providers/mistral.js')).mistralUsageFromBilling(
    { plan_name: 'EDU' },
    { vibe_budget: { usage_percentage: 0, initial_budget: 150 }, api_budget: { usage_percentage: 0.00077, initial_budget: 15 } },
  ))()
  void usage
  return parsed.then(result => {
    assert.equal(result.supported, true)
    if (!result.supported) return
    const scopes = (result.windows ?? []).map(window => window.scope)
    assert.deepEqual(scopes, ['Vibe allowance (plan)', 'API wallet (pay-as-you-go)'])
  })
})

test('mistral: the Vibe CLI key is read from its env file, not the environment', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-home-'))
  try {
    assert.equal(await readMistralVibeKey(home), undefined, 'no setup yet')
    mkdirSync(join(home, '.vibe'), { recursive: true })
    writeFileSync(vibeEnvPath(home), [
      '# vibe',
      'MISTRAL_API_KEY="mstrl_fromfile_0123456789"',
      'OTHER=value',
    ].join('\n'))
    assert.equal(await readMistralVibeKey(home), 'mstrl_fromfile_0123456789')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('mistral: env parsing accepts the three names the CLI uses and ignores the rest', () => {
  assert.equal(parseVibeEnv('VIBE_API_KEY=abc'), 'abc')
  assert.equal(parseVibeEnv('MISTRAL_VIBE_KEY=def'), 'def')
  assert.equal(parseVibeEnv('MISTRAL_API_KEY=ghi'), 'ghi')
  assert.equal(parseVibeEnv('SOMETHING_ELSE=jkl'), undefined)
  assert.equal(parseVibeEnv('#MISTRAL_API_KEY=commented'), undefined)
  assert.equal(parseVibeEnv('MISTRAL_API_KEY='), undefined)
})

test('mistral: a Vibe key session is labelled apart from a pasted one', () => {
  const vibe: MistralSession = sessionFromMistralKey('mstrl_vibe_0123456789', 'mistral-vibe-mstr…6789')
  assert.match(vibe.account, /^mistral-vibe-/)
  const studio = sessionFromMistralKey('mstrl_studio_0123456789', 'mistral-mstr…6789')
  assert.equal(vibe.account === studio.account, false)
})

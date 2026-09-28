/**
 * The Freebuff route: the pinned model table, the two credential shapes, the
 * balance mapping, the error table, and the web protocol's SSE translator.
 *
 * Every assertion traces to the Rust reference this route was ported from
 * (`ref-freebuff2api`), cited by file:line in the modules themselves — the
 * effort ladder and its clamp, the paused ids, the published context windows,
 * the two session payload spellings, the `concurrency_busy` retry window, and the
 * eleven web event types are all things that reference documents.
 */

import './keep-alive.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, MessageId, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FreebuffSession, ProviderId } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ModelEntry } from '../src/providers/common.js'
import { FreebuffAdapter } from '../src/providers/freebuff.js'
import {
  FREEBUFF_LADDER_FULL,
  FREEBUFF_LADDER_MUSE,
  FREEBUFF_LADDER_STANDARD,
  FREEBUFF_MODELS,
  FREEBUFF_MODEL_CONTEXT_WINDOWS,
  FREEBUFF_PAUSED_MODEL_IDS,
  freebuffEffortFor,
  freebuffEfforts,
  freebuffModel,
  freebuffRoster,
  isFreebuffPaused,
} from '../src/providers/freebuff/catalog.js'
import {
  FREEBUFF_API_BASE,
  FREEBUFF_CHAT_PATH,
  FREEBUFF_CONCURRENCY_BUSY_RETRY_MS,
  FREEBUFF_QUEUE_RETRY_MS,
  FREEBUFF_SESSION_COOKIE,
  FREEBUFF_WEB_BASE,
  FREEBUFF_WEB_CHAT_PATH,
  freebuffBodyRefusal,
  freebuffChatBody,
  freebuffChatHeaders,
  freebuffChatUrl,
  freebuffCredentialKind,
  freebuffErrorEnvelope,
  freebuffEffortBodyField,
  freebuffGuardStream,
  freebuffInstanceId,
  freebuffResponseError,
  freebuffSessionHeaders,
  freebuffSessionUnauthenticated,
  freebuffWebBody,
  freebuffWebPrompt,
  freebuffWebToChatCompletions,
  freebuffWireFor,
  FREEBUFF_WEB_EVENT_TYPES,
  parseFreebuffUpstreamModels,
} from '../src/providers/freebuff/client.js'
import {
  freebuffDerivedModelBudget,
  freebuffModelAdmissions,
  freebuffQuotaWarnings,
  freebuffUsageFromQuota,
  fetchFreebuffUsage,
  parseFreebuffQuota,
} from '../src/providers/freebuff/usage.js'
import {
  freebuffCredentialOf,
  freebuffSessionFromPaste,
  freebuffSessionOf,
  freebuffTrimCookieString,
  isFreebuffPermanentRefreshError,
  parseFreebuffPaste,
  refreshFreebuffSession,
  validateFreebuffCredential,
} from '../src/providers/freebuff-session.js'

/** The model ids the standard `low/high/max` ladder serves (`src/models.rs:128-331`). */
const STANDARD_LADDER_IDS = [
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-max',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-pro-max',
  'stealth/ox-alpha',
]

/** The models with NO ladder: `reasoning_effort` must be REMOVED from the body. */
const NO_LADDER_IDS = [
  'upstage/solar-pro4',
  'minimax/minimax-m3',
  'mimo/mimo-v2.5',
  'crof/kimi-k3-eco',
  'z-ai/glm-5.2',
]

test('freebuff: the three ladders are the reference constants, verbatim', () => {
  assert.deepEqual([...FREEBUFF_LADDER_STANDARD], ['low', 'high', 'max'])
  assert.deepEqual([...FREEBUFF_LADDER_FULL], ['low', 'medium', 'high', 'xhigh', 'max'])
  // The muse ladder has no `max`, which is why a request for it clamps DOWN.
  assert.deepEqual([...FREEBUFF_LADDER_MUSE], ['minimal', 'low', 'medium', 'high', 'xhigh'])
})

test('freebuff: every table row carries exactly the ladder the reference assigns it', () => {
  assert.equal(FREEBUFF_MODELS.length, 20, 'the reference lists twenty hardcoded models')
  for (const id of STANDARD_LADDER_IDS) {
    assert.deepEqual(freebuffEfforts(id), FREEBUFF_LADDER_STANDARD, `${id} ladder`)
  }
  for (const id of [
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-luna-es',
    'openai/gpt-5.6-luna-max',
    'google/gemini-3.1-flash-lite',
    'google/gemini-3.5-flash-lite',
    'google/gemini-3.8-flash',
    'anthropic/claude-fable-5',
  ]) {
    assert.deepEqual(freebuffEfforts(id), FREEBUFF_LADDER_FULL, `${id} ladder`)
  }
  for (const id of ['meta/muse-spark-1.2-contributor', 'meta/muse-spark-1.3-contributor']) {
    assert.deepEqual(freebuffEfforts(id), FREEBUFF_LADDER_MUSE, `${id} ladder`)
  }
  for (const id of NO_LADDER_IDS) {
    assert.equal(freebuffEfforts(id), undefined, `${id} must declare no ladder`)
  }
})

test('freebuff: the ladder value is sent unchanged when it is in the ladder', () => {
  assert.equal(freebuffEffortFor('z-ai/glm-5.3-flash', 'high'), 'high')
  assert.equal(freebuffEffortFor('z-ai/glm-5.3-flash', 'low'), 'low')
  assert.equal(freebuffEffortFor('google/gemini-3.1-flash-lite', 'xhigh'), 'xhigh')
  assert.equal(freebuffEffortFor('meta/muse-spark-1.2-contributor', 'minimal'), 'minimal')
})

test('freebuff: max/xhigh/high clamp to the ladder LAST entry', () => {
  // The GLM ladder stops at `max`, so `xhigh` cannot survive.
  assert.equal(freebuffEffortFor('z-ai/glm-5.3-flash', 'xhigh'), 'max')
  // The muse ladder stops at `xhigh`, so `max` clamps DOWN — the reference pins
  // this exact case in its own test (`src/router.rs:286-289`).
  assert.equal(freebuffEffortFor('meta/muse-spark-1.2-contributor', 'max'), 'xhigh')
  // `high` IS in the full ladder, so it survives there; on the standard one it is
  // also present. Neither is a clamp — this asserts the branch does not fire.
  assert.equal(freebuffEffortFor('openai/gpt-5.6-luna', 'high'), 'high')
})

test('freebuff: minimal/low clamp to the ladder FIRST entry', () => {
  // The full ladder starts at `low`, so `minimal` clamps up onto it.
  assert.equal(freebuffEffortFor('openai/gpt-5.6-luna', 'minimal'), 'low')
  assert.equal(freebuffEffortFor('google/gemini-3.5-flash-lite', 'low'), 'low')
})

test('freebuff: any other string clamps to the ladder FIRST entry', () => {
  assert.equal(freebuffEffortFor('z-ai/glm-5.3-flash', 'turbo'), 'low')
  assert.equal(freebuffEffortFor('meta/muse-spark-1.2-contributor', 'turbo'), 'minimal')
  // The comparison is case-insensitive, so `Max` is the RUNG, not an unknown word.
  assert.equal(freebuffEffortFor('z-ai/glm-5.3-flash', 'Max'), 'max')
})

test('freebuff: no ladder means the field is REMOVED, never sent as null', () => {
  for (const id of NO_LADDER_IDS) {
    assert.equal(freebuffEffortFor(id, 'high'), undefined, `${id} must omit the field`)
    assert.deepEqual(freebuffEffortBodyField(id, 'high'), {}, `${id} body patch is empty`)
  }
  // An id the table does not describe gets no field either.
  assert.deepEqual(freebuffEffortBodyField('nonexistent/model', 'high'), {})
  // And a ladder model with NO requested level omits the field too: there is
  // nothing to clamp, so there is nothing to send.
  assert.deepEqual(freebuffEffortBodyField('z-ai/glm-5.3-flash', undefined), {})
  assert.deepEqual(freebuffEffortBodyField('z-ai/glm-5.3-flash', 'high'), { reasoning_effort: 'high' })
})

test('freebuff: paused ids stay in the table but never reach the roster', () => {
  for (const id of FREEBUFF_PAUSED_MODEL_IDS) {
    assert.equal(freebuffModel(id)?.available, false, `${id} must be identifiable as paused`)
    assert.equal(isFreebuffPaused(id), true)
  }
  const offered = freebuffRoster().map(model => model.id)
  assert.equal(offered.length, FREEBUFF_MODELS.length - FREEBUFF_PAUSED_MODEL_IDS.length)
  for (const id of FREEBUFF_PAUSED_MODEL_IDS) {
    assert.equal(offered.includes(id), false, `${id} must not be offered`)
  }
  assert.equal(offered.includes('z-ai/glm-5.3-flash'), true)
})

test('freebuff: only the vendor-published context windows are declared', () => {
  assert.deepEqual(FREEBUFF_MODEL_CONTEXT_WINDOWS, {
    'minimax/minimax-m3': 524_288,
    'deepseek/deepseek-v4-flash': 1_048_576,
    'deepseek/deepseek-v4-pro': 1_048_576,
    'openai/gpt-5.6-luna': 1_000_000,
    'openai/gpt-5.6-luna-es': 372_000,
    'meta/muse-spark-1.2-contributor': 1_000_000,
    'stealth/ox-alpha': 1_000_000,
    'z-ai/glm-5.3-flash': 1_000_000,
    'upstage/solar-pro4': 500_000,
  })
  assert.equal(freebuffModel('z-ai/glm-5.3-flash')?.contextWindow, 1_000_000)
  // A paused model keeps the window it was published with: pausing is about
  // availability, not about what the vendor documented.
  assert.equal(freebuffModel('minimax/minimax-m3')?.contextWindow, 524_288)
})

test('freebuff: every other model declares NO context window', () => {
  const published = new Set(Object.keys(FREEBUFF_MODEL_CONTEXT_WINDOWS))
  for (const model of FREEBUFF_MODELS) {
    if (published.has(model.id)) continue
    assert.equal(model.contextWindow, undefined, `${model.id} must declare no window`)
  }
  // Spot-check the ones a reader would most expect to see a number for.
  for (const id of ['google/gemini-3.1-flash-lite', 'openai/gpt-5.6-luna-max', 'anthropic/claude-fable-5',
    'crof/kimi-k3-eco', 'mimo/mimo-v2.5', 'meta/muse-spark-1.3-contributor', 'z-ai/glm-5.2']) {
    assert.equal(freebuffModel(id)?.contextWindow, undefined, id)
  }
})

test('freebuff: quota parsing reads the camelCase web spelling', () => {
  const quota = parseFreebuffQuota({
    accessTier: 'free',
    freebucks: {
      balance: 12.5,
      daily: { limit: 100, spent: 30, remaining: 70, resetAt: '2026-09-28T07:00:00.000Z' },
      planId: 'plan_free',
      prices: { 'z-ai/glm-5.3-flash': 0 },
    },
    subscription: { tierId: 'pro_trial' },
    rateLimitsByModel: {
      'z-ai/glm-5.3-flash': { limit: 6, recentCount: 1, resetAt: '2026-09-28T00:00:00Z', poolLabel: 'reward' },
    },
    countryCode: 'US',
  })
  assert.notEqual(quota, undefined)
  assert.equal(quota?.accessTier, 'free')
  assert.equal(quota?.tierId, 'pro_trial')
  assert.equal(quota?.freebucks?.daily?.remaining, 70)
  assert.equal(quota?.rateLimitsByModel?.['z-ai/glm-5.3-flash']?.recentCount, 1)
})

test('freebuff: quota parsing also reads the snake_case spelling the reference emits', () => {
  const quota = parseFreebuffQuota({
    access_tier: 'pro',
    freebucks: { daily: { limit: 50, spent: 10, remaining: 40 } },
    rate_limits_by_model: { 'openai/gpt-5.6-luna': { limit: 3, recentCount: 3 } },
    country_code: 'DE',
    country_block_reason: 'region unavailable',
  })
  assert.equal(quota?.accessTier, 'pro')
  assert.equal(quota?.countryCode, 'DE')
  assert.equal(quota?.rateLimitsByModel?.['openai/gpt-5.6-luna']?.limit, 3)
})

test('freebuff: a body with neither access tier nor credits is not an account', () => {
  // `/api/auth/session` answers 200 with `{}` for a credential nobody honours
  // (`src/api.rs:5606-5616`), so the body — not the status — decides.
  assert.equal(freebuffSessionUnauthenticated({}), true)
  assert.equal(freebuffSessionUnauthenticated({ accessTier: null }), true)
  assert.equal(freebuffSessionUnauthenticated({ accessTier: 'free' }), false)
  assert.equal(freebuffSessionUnauthenticated({ freebucks: { balance: 0 } }), false)
  assert.equal(parseFreebuffQuota({}), undefined)
})

test('freebuff: usage maps onto one daily credit window', () => {
  const warnings: string[] = []
  const usage = freebuffUsageFromQuota({
    accessTier: 'free',
    tierId: 'pro_trial',
    freebucks: {
      daily: { limit: 100, spent: 30, remaining: 70, resetAt: '2026-09-28T07:00:00.000Z' },
    },
  }, { onWarn: message => warnings.push(message) })
  assert.equal(usage.supported, true)
  assert.equal(usage.unit, 'credits', 'the provider-level pair is counted in credits')
  assert.equal(usage.remaining, 70)
  assert.equal(usage.limit, 100)
  assert.equal(usage.plan, 'pro_trial')
  assert.equal(usage.windows?.length, 1)
  const window = usage.windows?.[0]
  assert.equal(window?.kind, 'other')
  assert.equal(window?.scope, 'daily')
  assert.equal(window?.unit, 'credits')
  assert.equal(window?.used, 30)
  assert.equal(window?.remaining, 70)
  assert.equal(window?.limit, 100)
  assert.equal(window?.usedPercent, 30)
  assert.equal(window?.resetsAt, Date.parse('2026-09-28T07:00:00.000Z'))
  assert.deepEqual(warnings, [])
})

test('freebuff: an absent field stays absent in the usage mapping', () => {
  const usage = freebuffUsageFromQuota({ accessTier: 'free', freebucks: { daily: { remaining: 5 } } })
  const window = usage.windows?.[0]
  assert.equal(window?.remaining, 5)
  assert.equal(window?.limit, undefined, 'no limit was disclosed, so none is claimed')
  assert.equal(window?.used, undefined)
  assert.equal(window?.resetsAt, undefined, 'no reset instant was disclosed, so none is predicted')
  assert.equal(window?.usedPercent, 0, 'there is no cap to be a percentage of')
  assert.equal(usage.remaining, 5)
  assert.equal(usage.limit, undefined)
  assert.equal(usage.plan, 'free', 'the access tier is the only plan label disclosed')
})

test('freebuff: a read with no credit block reports no usage rather than zeroes', () => {
  assert.deepEqual(freebuffUsageFromQuota({ accessTier: 'free' }), { supported: false })
  assert.deepEqual(freebuffUsageFromQuota({ freebucks: { daily: {} } }), { supported: false })
})

test('freebuff: countryBlockReason is a warning, never a fabricated window', () => {
  const quota = {
    accessTier: 'free',
    countryCode: 'RU',
    countryBlockReason: 'service not available in your region',
  }
  const warnings = freebuffQuotaWarnings(quota)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /blocked \(RU\)/)
  assert.match(warnings[0] ?? '', /service not available in your region/)
  const seen: string[] = []
  const usage = freebuffUsageFromQuota(quota, { onWarn: message => seen.push(message) })
  assert.equal(seen.length, 1)
  assert.equal(usage.supported, false, 'a block is not an allowance')
  assert.equal(usage.windows, undefined)
})

test('freebuff: the per-model budget is a labelled DERIVATION of two disclosed fields', () => {
  const quota = parseFreebuffQuota({
    accessTier: 'free',
    freebucks: {
      daily: { limit: 100, spent: 30, remaining: 70 },
      prices: { 'gpt-luna': 7, 'free-model': 0, 'unlimited': 5 },
    },
    rateLimitsByModel: {
      'gpt-luna': { limit: 6, recentCount: 2 },
      'free-model': { limit: 6, recentCount: 0 },
    },
  })
  assert.notEqual(quota, undefined)
  const budget = freebuffDerivedModelBudget(quota ?? {})
  // 70 / 7 = 10 by credits, 6 - 2 = 4 by admission → the smaller wins.
  assert.deepEqual(budget['gpt-luna'], { price: 7, byCreditRemaining: 10, byLimitRemaining: 4, usableToday: 4 })
  // A zero price is unbounded by credits (-1), as the reference's `-1` means.
  assert.equal(budget['free-model']?.byCreditRemaining, -1)
  assert.equal(budget['free-model']?.usableToday, 6)
  // No admission row → unbounded there, so the credit arithmetic decides.
  assert.equal(budget['unlimited']?.byLimitRemaining, -1)
  assert.equal(budget['unlimited']?.usableToday, 14)
  // The derivation never leaks into the disclosed usage shape.
  const usage = freebuffUsageFromQuota(quota ?? {})
  assert.deepEqual(Object.keys(usage).sort(), ['limit', 'plan', 'remaining', 'supported', 'unit', 'windows'])
})

test('freebuff: the per-model admission rows are reported exactly as disclosed', () => {
  const quota = parseFreebuffQuota({
    accessTier: 'free',
    freebucks: { daily: { remaining: 1 } },
    rateLimitsByModel: { m: { limit: 6, recentCount: 6, poolLabel: 'reward', resetAt: '2026-09-28T00:00:00Z' } },
  })
  const admissions = freebuffModelAdmissions(quota ?? {})
  assert.deepEqual(admissions.m, { limit: 6, recentCount: 6, poolLabel: 'reward', resetAt: '2026-09-28T00:00:00Z' })
})

test('freebuff: a balance read that is refused reports no usage and says why', async () => {
  const warnings: string[] = []
  const unauthorized = await fetchFreebuffUsage(
    { accessToken: 'token-value-abcdefghij' },
    async () => new Response('', { status: 401 }),
    undefined,
    { onWarn: message => warnings.push(message) },
  )
  assert.deepEqual(unauthorized, { supported: false })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /refused the stored credential/)
})

test('freebuff: a balance read that succeeds is mapped, per wire', async () => {
  const calls: string[] = []
  const cookie = `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`
  const usage = await fetchFreebuffUsage(
    { accessToken: 'sess-value-123456', cookie },
    async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({
        accessTier: 'free',
        freebucks: { daily: { limit: 100, spent: 0, remaining: 100, resetAt: '2026-09-28T07:00:00Z' } },
      }), { status: 200 })
    },
  )
  assert.deepEqual(calls, [`${FREEBUFF_WEB_BASE}/api/web/freebuff-session`])
  assert.equal(usage.supported, true)
  assert.equal(usage.remaining, 100)
})

test('freebuff: a Bearer credential rides the desktop API for both chat and balance', () => {
  assert.equal(freebuffCredentialKind({ accessToken: 'bearer-token-value' }), 'bearer')
  assert.equal(freebuffWireFor({ accessToken: 'bearer-token-value' }), 'chat-completions')
  assert.equal(freebuffChatUrl('chat-completions'), `${FREEBUFF_API_BASE}${FREEBUFF_CHAT_PATH}`)
  assert.equal(freebuffChatUrl('web'), `${FREEBUFF_WEB_BASE}${FREEBUFF_WEB_CHAT_PATH}`)
})

test('freebuff: a cookie-only credential rides the web protocol', () => {
  const cookie = `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`
  assert.equal(freebuffCredentialKind({ accessToken: 'sess-value-123456', cookie }), 'cookie')
  assert.equal(freebuffWireFor({ accessToken: 'sess-value-123456', cookie }), 'web')
  // A whole cookie string pasted into the token field is still a cookie credential:
  // this is exactly the shape the reference's importer stores (`src/import.rs:352-378`).
  assert.equal(freebuffCredentialKind({ accessToken: cookie }), 'cookie')
  // A credential with neither secret cannot be routed.
  assert.equal(freebuffCredentialKind({ accessToken: '' }), undefined)
  assert.throws(() => freebuffWireFor({ accessToken: '' }), (error: unknown) =>
    error instanceof LlmError && error.code === 'MISSING_CREDENTIAL')
})

test('freebuff: headers follow the two protocols', () => {
  const desktop = freebuffChatHeaders({ accessToken: 'tok' }, 'chat-completions')
  assert.equal(desktop.authorization, 'Bearer tok')
  assert.equal(desktop['user-agent'], 'ai-sdk/openai-compatible/1.0.25/codebuff')
  assert.equal(desktop.cookie, undefined, 'no cookie on the desktop path')
  const web = freebuffChatHeaders({ accessToken: 'tok', cookie: `${FREEBUFF_SESSION_COOKIE}=abc` }, 'web')
  assert.equal(web.cookie, `${FREEBUFF_SESSION_COOKIE}=abc`)
  assert.equal(web.origin, FREEBUFF_WEB_BASE)
  assert.equal(web.referer, `${FREEBUFF_WEB_BASE}/chat`)
  assert.notEqual(web['x-freebuff-instance-id'], undefined)
  // The desktop balance read needs the include-unused flag or the response omits
  // every per-model row (`src/upstream.rs:145-146`).
  const session = freebuffSessionHeaders({ accessToken: 'tok' }, 'chat-completions', { heartbeat: true })
  assert.equal(session['x-freebuff-multi-session'], '1')
  assert.equal(session['x-freebuff-include-unused-rate-limits'], '1')
  assert.equal(session['x-freebuff-heartbeat'], '1')
  assert.equal(session['x-freebuff-instance-id'], freebuffInstanceId('tok'))
})

test('freebuff: the instance id is stable per credential and differs across accounts', () => {
  const first = freebuffInstanceId(`${FREEBUFF_SESSION_COOKIE}=aaa`)
  const again = freebuffInstanceId(`other=1; ${FREEBUFF_SESSION_COOKIE}=aaa`)
  const second = freebuffInstanceId(`${FREEBUFF_SESSION_COOKIE}=bbb`)
  assert.equal(first, again, 'same session token, same id')
  assert.notEqual(first, second, 'different accounts must not share a fingerprint')
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('freebuff: the desktop body carries the effort field and the metadata block', () => {
  const body = freebuffChatBody({
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'xhigh',
    credential: 'tok',
  })
  assert.equal(body.reasoning_effort, 'max', 'the clamp reaches the body')
  assert.equal(body.stream, true)
  assert.equal(body.model, 'z-ai/glm-5.3-flash')
  const metadata = body.codebuff_metadata as Record<string, unknown>
  assert.equal(metadata.cost_mode, 'free')
  assert.equal(typeof metadata.client_id, 'string')
  assert.equal(metadata.freebuff_instance_id, freebuffInstanceId('tok'))
  // The reference always injects a run id it obtained from its own agent-run
  // bootstrap (`src/upstream.rs:294`); this route does not run that bootstrap, so
  // the field is absent rather than invented.
  assert.equal(metadata.run_id, undefined)
  // And a no-ladder model has no effort key at all.
  const solar = freebuffChatBody({ model: 'upstage/solar-pro4', messages: [], reasoningEffort: 'high', credential: 'tok' })
  assert.equal('reasoning_effort' in solar, false)
})

test('freebuff: the web body is the other shape entirely', () => {
  const body = freebuffWebBody({
    model: 'z-ai/glm-5.3-flash',
    content: 'hello',
    credential: `${FREEBUFF_SESSION_COOKIE}=abc`,
    reasoningEffort: 'high',
  })
  assert.equal(body.content, 'hello')
  assert.equal(body.threadId, null, 'a fresh web thread is named null, not omitted')
  assert.equal(body.reasoningEffort, 'high', 'the level rides under the web spelling')
  assert.deepEqual(body.images, [])
  assert.deepEqual(body.attachments, [])
  const gravity = body.gravity as { user_data?: Record<string, unknown> }
  assert.match(String(gravity.user_data?.visitor_id), /^gruid_[0-9a-f]{32}$/)
  assert.match(String(gravity.user_data?.session_id), /^gr_sess_[0-9a-f]{32}$/)
  assert.equal(body.reasoning_effort, undefined, 'the snake_case spelling is the desktop one')
})

test('freebuff: 429 concurrency_busy is a rate limit with the reference 2s window', async () => {
  const error = await freebuffResponseError(
    429,
    new Headers(),
    JSON.stringify({ error: { message: 'too many concurrent requests to upstream, retry later', code: 'concurrency_busy' } }),
    'freebuff chat-completions',
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.status, 429)
  const delay = error.failure.providerRetryAfterMs ?? 0
  assert.ok(
    delay >= FREEBUFF_CONCURRENCY_BUSY_RETRY_MS - 100 && delay <= FREEBUFF_CONCURRENCY_BUSY_RETRY_MS + 100,
    `expected about ${String(FREEBUFF_CONCURRENCY_BUSY_RETRY_MS)}ms, got ${String(delay)}`,
  )
})

test('freebuff: a 429 with only plural wording still discloses a wait', async () => {
  const error = await freebuffResponseError(429, new Headers(), 'Too Many Requests', 'freebuff web')
  assert.equal(error.code, 'RATE_LIMIT')
  const delay = error.failure.providerRetryAfterMs ?? 0
  assert.ok(delay >= 59_000 && delay <= 61_000, `expected about a minute, got ${String(delay)}`)
  // The generic `retry-after` header is honoured when no provider field competes.
  // The shared classifier adds the hub's own reset grace on top of the header's
  // 7 s (`waitFromReset`, `src/providers/rate-limit.ts`), which is exactly why
  // this route's reader is consulted FIRST on a 429: its own field names the
  // window, while the header names a floor.
  const fromHeader = await freebuffResponseError(429, new Headers({ 'retry-after': '7' }), '', 'freebuff chat-completions')
  assert.equal(fromHeader.code, 'RATE_LIMIT')
  const headerDelay = fromHeader.failure.providerRetryAfterMs ?? 0
  assert.ok(headerDelay >= 8_900 && headerDelay <= 9_100, `expected about 9s, got ${String(headerDelay)}`)
})

test('freebuff: 401 is AUTH and 500 is SERVER', async () => {
  const unauthorized = await freebuffResponseError(401, new Headers(), '', 'freebuff web')
  assert.equal(unauthorized.code, 'AUTH')
  const server = await freebuffResponseError(503, new Headers(), 'boom', 'freebuff web')
  assert.equal(server.code, 'SERVER')
})

test('freebuff: a 200 error envelope is refused in the upstream own words', () => {
  const body = JSON.stringify({
    error: { message: 'Model "stealth/ox-alpha" is paused for free mode', code: 'free_mode_invalid_agent_model' },
  })
  const refusal = freebuffBodyRefusal(body, 200, 'freebuff chat-completions')
  assert.notEqual(refusal, undefined)
  assert.match(refusal?.message ?? '', /paused for free mode/)
  assert.equal(refusal?.code, 'HTTP_404', 'a withdrawn model is a wrong-model answer, not a server fault')
  assert.equal(refusal?.failure.status, 200)

  // The Anthropic-shaped envelope is the same refusal.
  const anthropicShaped = freebuffErrorEnvelope({
    type: 'error',
    error: { type: 'api_error', message: 'upstream exploded', code: 'concurrency_busy' },
  })
  assert.deepEqual(anthropicShaped, { message: 'upstream exploded', code: 'concurrency_busy' })
})

test('freebuff: a bare text code in a 200 body is also a refusal', () => {
  const waiting = freebuffBodyRefusal('waiting_room_queued', 200, 'freebuff web')
  assert.equal(waiting?.code, 'RATE_LIMIT')
  const delay = waiting?.failure.providerRetryAfterMs ?? 0
  assert.ok(delay >= FREEBUFF_QUEUE_RETRY_MS - 100 && delay <= FREEBUFF_QUEUE_RETRY_MS + 100)

  const unauthorized = freebuffBodyRefusal('{"message":"session expired"}', 200, 'freebuff web')
  assert.equal(unauthorized?.code, 'AUTH')
})

test('freebuff: model OUTPUT is never mistaken for a refusal', () => {
  // A real stream frame carries `choices`, and the first token of an answer could
  // be anything — including the words the text rules match on.
  const frame = 'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"rate limit"},"finish_reason":null}]}\n\n'
  assert.equal(freebuffBodyRefusal(frame, 200, 'freebuff chat-completions'), undefined)
  assert.equal(freebuffBodyRefusal('{"choices":[{"delta":{"content":"unauthorized"}}]}', 200, 'freebuff x'), undefined)
  // The web protocol's events carry a `type` tag instead of `choices`, and the
  // same words can appear inside a delta's own text.
  assert.equal(
    freebuffBodyRefusal('data: {"type":"delta","text":"the rate limit was reached"}\n\n', 200, 'freebuff web'),
    undefined,
  )
  assert.equal(
    freebuffBodyRefusal('data: {"type":"reasoning_delta","text":"session expired"}\n\n', 200, 'freebuff web'),
    undefined,
  )
  // But a web body that really is an error envelope is still refused.
  assert.notEqual(
    freebuffBodyRefusal('data: {"type":"error","error":{"message":"session expired"}}\n\n', 200, 'freebuff web'),
    undefined,
  )
})

test('freebuff: the guard turns a 200 refusal into a thrown error, not an empty stream', async () => {
  const body = new Response(JSON.stringify({ error: { message: 'free mode is unavailable right now' } })).body
  assert.notEqual(body, null)
  const guarded = freebuffGuardStream(body as ReadableStream<Uint8Array>, { label: 'freebuff web', status: 200 })
  await assert.rejects(
    async () => await new Response(guarded).text(),
    (error: unknown) => error instanceof LlmError && /free mode is unavailable right now/.test(error.message),
  )
})

test('freebuff: a real stream passes the guard through untouched', async () => {
  const sse = [
    'data: {"type":"delta","text":"hi"}\n\n',
    'data: {"type":"done"}\n\n',
  ].join('')
  const guarded = freebuffGuardStream(new Response(sse).body as ReadableStream<Uint8Array>, {
    label: 'freebuff web',
    status: 200,
  })
  const translated = freebuffWebToChatCompletions(guarded, { label: 'freebuff web' })
  const text = await new Response(translated).text()
  assert.match(text, /"content":"hi"/)
  assert.match(text, /data: \[DONE\]/)
})

test('freebuff web: the event vocabulary is the reference enum', () => {
  // `src/web_protocol.rs:95-162` names twelve `type` tags (plus an `#[serde(other)]`
  // catch-all), which is the "eleven-ish event types" the protocol is described by.
  assert.deepEqual([...FREEBUFF_WEB_EVENT_TYPES], [
    'meta', 'title', 'reasoning_delta', 'delta', 'suggestions', 'agent_start',
    'agent_tool', 'agent_tool_done', 'agent_delta', 'agent_finish', 'button', 'done',
  ])
})

/** One chunk of a translated web stream, as the choices of a chat-completions chunk. */
interface TranslatedChoice {
  index: number
  delta: Record<string, unknown>
  finish_reason: string | null
}

/** The choices a translated web stream carried, in order. */
function translatedChunks(text: string): TranslatedChoice[] {
  return text.split('\n\n')
    .filter(line => line.startsWith('data:') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice('data:'.length).trim()) as { choices: TranslatedChoice[] })
    .map(chunk => chunk.choices[0] as TranslatedChoice)
}

/** The upstream event field shape of one of Freebuff's own server-side tool calls. */
function upstreamToolEvent(id: string, name: string): string {
  return `data: ${JSON.stringify({ type: 'agent_tool', agentId: 'a1', toolCallId: id, toolName: name, label: 'searching' })}\n\n`
}

/** The once-per-stream warning a dropped upstream-only tool call produces. */
const UPSTREAM_TOOL_WARNING =
  'freebuff: upstream ran its own tool "web_search"; this route does not forward upstream-only tool calls'

test('freebuff web: the upstream events translate into OpenAI chat chunks', async () => {
  const sse = [
    'data: {"type":"meta","threadId":"thread-1","model":"z-ai/glm-5.3-flash","accessTier":"free"}\n\n',
    'data: {"type":"reasoning_delta","text":"thinking"}\n\n',
    'data: {"type":"delta","text":"Hello"}\n\n',
    'data: {"type":"agent_start","agentId":"a1","agentType":"researcher","name":"researcher","prompt":"p"}\n\n',
    'data: {"type":"agent_delta","agentId":"a1","text":" world"}\n\n',
    'data: {"type":"agent_tool_done","toolCallId":"t1"}\n\n',
    'data: {"type":"suggestions","toolCallId":"t1","followups":[{"prompt":"p","label":"l"}]}\n\n',
    'data: {"type":"button"}\n\n',
    'data: {"type":"agent_finish","agentId":"a1"}\n\n',
    'data: {"type":"done"}\n\n',
  ].join('')
  const threads: string[] = []
  const translated = freebuffWebToChatCompletions(new Response(sse).body as ReadableStream<Uint8Array>, {
    label: 'freebuff web',
    onThread: id => threads.push(id),
  })
  const text = await new Response(translated).text()
  const chunks = translatedChunks(text)
  assert.deepEqual(threads, ['thread-1'])
  // Chunks come out in the reference's per-event order — reasoning, then content
  // — and every event the reference ignores produces nothing at all.
  const deltas = chunks.map(chunk => chunk.delta).filter(delta => Object.keys(delta).length > 0)
  assert.deepEqual(deltas, [
    { reasoning_content: 'thinking' },
    { content: 'Hello' },
    // `agent_delta` carries tool-produced prose and must reach content, not be
    // dropped; its leading space is content, not padding.
    { content: ' world' },
  ])
  assert.equal(chunks.at(-1)?.finish_reason, 'stop')
  assert.equal(text.endsWith('data: [DONE]\n\n'), true)
})

test('freebuff web: an upstream-only tool call never becomes a harness tool call', async () => {
  // The LIVE shape (2026-09-28): four of Freebuff's OWN server-side `web_search`
  // calls inside one turn, `arguments:"{}"` because upstream never streams them,
  // around the answer text — the turn upstream would have us finish `tool_calls`.
  // Those blocks are what made DSH try to run a tool it has no handler for.
  const warnings: string[] = []
  const sse = [
    'data: {"type":"meta","threadId":"t-live"}\n\n',
    upstreamToolEvent('53r53sozGTI', 'web_search'),
    'data: {"type":"delta","text":"The date is"}\n\n',
    upstreamToolEvent('53sB45Py0FM', 'web_search'),
    upstreamToolEvent('53sLKSLm0S4', 'web_search'),
    'data: {"type":"delta","text":" today."}\n\n',
    upstreamToolEvent('53sRinCshao', 'web_search'),
    'data: {"type":"done"}\n\n',
  ].join('')
  const text = await new Response(freebuffWebToChatCompletions(
    new Response(sse).body as ReadableStream<Uint8Array>,
    { label: 'freebuff web', onWarn: message => warnings.push(message) },
  )).text()
  const chunks = translatedChunks(text)
  assert.equal(text.includes('tool_calls'), false, 'no tool-call delta may reach the harness')
  assert.equal(text.includes('call_53r53sozGTI'), false, 'not even the id')
  // The answer still streams, in order and intact.
  const deltas = chunks.map(chunk => chunk.delta).filter(delta => Object.keys(delta).length > 0)
  assert.deepEqual(deltas, [{ content: 'The date is' }, { content: ' today.' }])
  assert.equal(chunks.at(-1)?.finish_reason, 'stop', 'a normal completion, not a harness tool-call finish')
  assert.equal(text.endsWith('data: [DONE]\n\n'), true)
  assert.deepEqual(warnings, [UPSTREAM_TOOL_WARNING], 'exactly ONE warning for four upstream tool calls')
})

test('freebuff web: a turn of nothing but upstream tool events still finishes cleanly', async () => {
  // The whole turn is Freebuff's own server-side work: no text delta at all. What
  // must NOT happen is a `tool-call` block (dangling forever, waiting for a result
  // nobody sends) or a `tool_calls` finish telling the harness to go run one.
  const warnings: string[] = []
  const sse = [
    'data: {"type":"meta","threadId":"t-only"}\n\n',
    upstreamToolEvent('53r53sozGTI', 'web_search'),
    upstreamToolEvent('53sB45Py0FM', 'web_search'),
    'data: {"type":"done"}\n\n',
  ].join('')
  const text = await new Response(freebuffWebToChatCompletions(
    new Response(sse).body as ReadableStream<Uint8Array>,
    { label: 'freebuff web', onWarn: message => warnings.push(message) },
  )).text()
  // Exactly one choice reaches the wire: the terminal chunk, then the sentinel.
  // (One layer up, `streamChatCompletions` maps a completed answer with NO content
  // at all to its own `EMPTY_RESPONSE` finish — harness-wide behaviour for an
  // empty answer, not a dangling tool call. This route's part is the normal `stop`
  // chunk asserted here, and the adapter-level test below covers the text case.)
  assert.deepEqual(translatedChunks(text), [{ index: 0, delta: {}, finish_reason: 'stop' }])
  assert.equal(text.endsWith('data: [DONE]\n\n'), true)
  assert.deepEqual(warnings, [UPSTREAM_TOOL_WARNING])
})

test('freebuff web: an upstream EOF without done still terminates the stream', async () => {
  const sse = 'data: {"type":"delta","text":"partial"}\n\n'
  const translated = freebuffWebToChatCompletions(new Response(sse).body as ReadableStream<Uint8Array>, {
    label: 'freebuff web',
  })
  const text = await new Response(translated).text()
  assert.match(text, /"finish_reason":"stop"/)
  assert.equal(text.endsWith('data: [DONE]\n\n'), true)
})

test('freebuff web: an in-band error envelope errors the stream with its own words', async () => {
  const sse = 'data: {"error":{"message":"session expired","code":"unauthorized"}}\n\n'
  const translated = freebuffWebToChatCompletions(new Response(sse).body as ReadableStream<Uint8Array>, {
    label: 'freebuff web',
  })
  await assert.rejects(
    async () => await new Response(translated).text(),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH' && /session expired/.test(error.message),
  )
})

test('freebuff web: the prompt flattener follows the reference rendering', () => {
  assert.equal(freebuffWebPrompt([{ role: 'user', text: 'just this' }]), 'just this')
  assert.equal(freebuffWebPrompt([
    { role: 'system', text: 'be terse' },
    { role: 'user', text: 'one' },
    { role: 'assistant', text: 'two' },
    { role: 'tool', text: 'three' },
  ]), '[系统指令]\nbe terse\n\n[用户]\none\n\n[助手]\ntwo\n\n[工具结果]\nthree')
  // A single non-system message is sent VERBATIM, with no role label.
  assert.equal(freebuffWebPrompt([
    { role: 'system', text: 'be terse' },
    { role: 'user', text: 'only' },
  ]), '[系统指令]\nbe terse\n\nonly')
  assert.equal(freebuffWebPrompt([{ role: 'assistant', text: 'no user turn' }]), undefined)
  assert.equal(freebuffWebPrompt([{ role: 'user', text: '   ' }]), undefined)
  assert.equal(freebuffWebPrompt([]), undefined)
})

test('freebuff web: a tool call and its result are labelled, not dropped', () => {
  // `[工具结果]` is the reference's own label for a tool result on this wire
  // (`src/web_threads.rs:242`); `[工具调用]` is this route's addition, so the
  // assistant half of the exchange keeps the result's antecedent.
  assert.equal(freebuffWebPrompt([
    { role: 'user', text: 'read the readme' },
    { role: 'assistant', text: 'On it.' },
    { role: 'tool-call', text: 'read_file: {"path":"README.md"}' },
    { role: 'tool', text: '# hello' },
    { role: 'user', text: 'what is its first line?' },
  ]), '[用户]\nread the readme\n\n[助手]\nOn it.\n\n[工具调用]\nread_file: {"path":"README.md"}'
    + '\n\n[工具结果]\n# hello\n\n[用户]\nwhat is its first line?')
})

test('freebuff: a pasted Bearer token parses', () => {
  const parsed = parseFreebuffPaste('Bearer abcdefghijklmnopqrst')
  assert.deepEqual(parsed, { kind: 'bearer', token: 'abcdefghijklmnopqrst' })
  // A bare token is what a user copies out of the header's value side.
  assert.deepEqual(parseFreebuffPaste('abcdefghijklmnopqrst'), { kind: 'bearer', token: 'abcdefghijklmnopqrst' })
  // The same header inside a curl command.
  const fromCurl = parseFreebuffPaste(`curl 'https://www.codebuff.com/api/v1/chat/completions' -H 'authorization: Bearer zzzzzzzzzzzzzzzz'`)
  assert.equal(fromCurl.kind, 'bearer')
  assert.equal(fromCurl.token, 'zzzzzzzzzzzzzzzz')
})

test('freebuff: a pasted cookie string parses into the trimmed session cookie', () => {
  const pasted = `__Host-next-auth.csrf-token=csrf123; ${FREEBUFF_SESSION_COOKIE}=sess-token-value-1234; `
    + '__Secure-next-auth.callback-url=https%3A%2F%2Ffreebuff.com; _ga=GA1.1.999'
  const parsed = parseFreebuffPaste(pasted)
  assert.equal(parsed.kind, 'cookie')
  assert.equal(parsed.token, 'sess-token-value-1234')
  // The reference reduces a cookie header to these three cookies, session token
  // FIRST (`src/import.rs:352-378`), and drops the analytics cookie.
  assert.equal(parsed.cookie, `${FREEBUFF_SESSION_COOKIE}=sess-token-value-1234; __Host-next-auth.csrf-token=csrf123; `
    + '__Secure-next-auth.callback-url=https%3A%2F%2Ffreebuff.com')
  assert.equal(parsed.cookie?.includes('_ga='), false)
  assert.equal(freebuffTrimCookieString('nothing here'), undefined)
})

test('freebuff: junk does not become a credential', () => {
  for (const junk of ['', '   ', 'hello world', 'short', '{"cookies":[]}']) {
    assert.throws(() => parseFreebuffPaste(junk), (error: unknown) =>
      error instanceof LlmError && error.code === 'MISSING_CREDENTIAL', `input: ${JSON.stringify(junk)}`)
  }
})

test('freebuff: a HAR document yields the credential it recorded', () => {
  const har = JSON.stringify({
    log: {
      entries: [{
        request: {
          headers: [
            { name: 'accept', value: '*/*' },
            { name: 'authorization', value: 'Bearer har-token-value-9876' },
          ],
        },
      }],
    },
  })
  assert.deepEqual(parseFreebuffPaste(har), { kind: 'bearer', token: 'har-token-value-9876' })
})

test('freebuff: the roster file parser takes declared ids and skips agent names', () => {
  const source = [
    "export const FREE_AGENTS = {",
    "  'base2-free': new Set([",
    "    'z-ai/glm-5.3-flash',",
    "    'openai/gpt-5.6-luna',",
    "    SHARED_MODELS,",
    "  ]),",
    "  'file-picker': ['google/gemini-3.1-flash-lite'],",
    "}",
  ].join('\n')
  assert.deepEqual(parseFreebuffUpstreamModels(source), [
    'z-ai/glm-5.3-flash',
    'openai/gpt-5.6-luna',
    'google/gemini-3.1-flash-lite',
  ])
})

/** A token manager over an in-memory account map. */
function tokensOf(sessions: Map<string, FreebuffSession>, refresh?: (session: FreebuffSession) => Promise<FreebuffSession>) {
  const defaultKey = [...sessions.keys()][0] ?? ''
  return new AccountTokenManager<FreebuffSession>({
    provider: 'freebuff' as ProviderId,
    displayName: 'Freebuff',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: refresh ?? (current => Promise.resolve(current)),
      isPermanent: isFreebuffPermanentRefreshError,
    }),
    io: {
      list: () => Promise.resolve([...sessions.entries()].map(([key, session]) => ({ key, session }))),
      get: account => Promise.resolve(sessions.get(account ?? defaultKey)),
      save: (account, session) => {
        sessions.set(account, session)
        return Promise.resolve()
      },
      remove: account => {
        sessions.delete(account)
        return Promise.resolve()
      },
    },
  })
}

const SESSION: FreebuffSession = {
  accessToken: 'bearer-token-value-1234',
  refreshToken: 'bearer-token-value-1234',
  expiresAt: Date.now() + 3_600_000,
  account: 'someone@example.com',
}

function adapterOf(options: Partial<ConstructorParameters<typeof FreebuffAdapter>[0]> = {}) {
  const sessions = new Map<string, FreebuffSession>([['someone@example.com', SESSION]])
  return {
    sessions,
    adapter: new FreebuffAdapter({
      models: [] as ModelEntry[],
      streamIdleTimeoutMs: 5_000,
      tokens: tokensOf(sessions),
      discovery: false,
      ...options,
    }),
  }
}

test('freebuff adapter: identity and the pinned roster', async () => {
  const { adapter } = adapterOf()
  assert.deepEqual(adapter.providerInfo('freebuff'), { id: 'freebuff', name: 'Freebuff' })
  const models = await adapter.listOwnModels('freebuff')
  assert.equal(models.length, freebuffRoster().length)
  const ids = models.map(model => model.id)
  for (const paused of FREEBUFF_PAUSED_MODEL_IDS) {
    assert.equal(ids.includes(paused), false, `${paused} must not be offered`)
  }
  assert.equal(ids.includes('z-ai/glm-5.3-flash'), true)
  // A model list without a session is nothing, like every other route here.
  const empty = adapterOf()
  empty.sessions.clear()
  assert.deepEqual(await empty.adapter.listOwnModels('freebuff'), [])
})

test('freebuff adapter: capabilities come from the pin, and nowhere else', async () => {
  const { adapter } = adapterOf()
  const glm = await adapter.resolveOwnModel('freebuff', 'z-ai/glm-5.3-flash')
  assert.equal(glm.context?.contextWindow, 1_000_000)
  assert.deepEqual(glm.reasoning?.efforts.map(effort => effort.id), ['low', 'high', 'max'])
  // A no-ladder model advertises NO levels: the picker must not offer a level the
  // request path would then strip.
  const solar = await adapter.resolveOwnModel('freebuff', 'upstage/solar-pro4')
  assert.equal(solar.context?.contextWindow, 500_000)
  assert.equal(solar.reasoning, undefined)
  // An id the table does not describe gets NO declared capability at all.
  const unknown = await adapter.resolveOwnModel('freebuff', 'someone/new-model')
  assert.equal(unknown.context, undefined)
  assert.equal(unknown.reasoning, undefined)
  assert.equal(unknown.name, 'someone/new-model')
})

test('freebuff adapter: a configured default effort is folded into the ladder', async () => {
  const { adapter } = adapterOf({ defaultEffortOf: () => 'high' })
  const glm = await adapter.resolveOwnModel('freebuff', 'z-ai/glm-5.3-flash')
  assert.equal(glm.reasoning?.defaultEffort, 'high')
  // A configured level the ladder does not carry is dropped, not appended: the
  // ladder is the upstream's own truth about what the model accepts.
  const muse = adapterOf({ defaultEffortOf: () => 'max' })
  const spark = await muse.adapter.resolveOwnModel('freebuff', 'meta/muse-spark-1.2-contributor')
  assert.deepEqual(spark.reasoning?.efforts.map(effort => effort.id), ['minimal', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(spark.reasoning?.defaultEffort, undefined)
})

test('freebuff adapter: a failed roster top-up is reported, and the pin is still served', async () => {
  const { adapter } = adapterOf({
    discovery: true,
    fetchFn: async () => new Response('nope', { status: 500 }),
  })
  const models = await adapter.listOwnModels('freebuff')
  assert.equal(models.length, freebuffRoster().length, 'the pinned half is served regardless')
  const reason = adapter.notFetchedReason('freebuff')
  assert.notEqual(reason, undefined)
  assert.match(reason?.what ?? '', /pinned model table/)
  assert.match(reason?.detail ?? '', /500/)
  adapter.clearAccountCatalog()
  assert.equal(adapter.notFetchedReason('freebuff'), undefined)
})

test('freebuff adapter: a successful top-up adds ids with no declared capabilities', async () => {
  const { adapter } = adapterOf({
    discovery: true,
    fetchFn: async () => new Response("'base2-free': ['newvendor/new-model', 'z-ai/glm-5.3-flash'],"),
  })
  const models = await adapter.listOwnModels('freebuff')
  const ids = models.map(model => model.id)
  assert.equal(ids.includes('newvendor/new-model'), true)
  assert.equal(ids.filter(id => id === 'z-ai/glm-5.3-flash').length, 1, 'a pinned id is not duplicated')
  const added = await adapter.resolveOwnModel('freebuff', 'newvendor/new-model')
  assert.equal(added.context, undefined)
  assert.equal(added.reasoning, undefined)
})

/** Options for one streamed call. */
function generateOptions(model: string, signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'freebuff',
    model,
    messages: [{
      id: MessageId('m-1'),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }],
    ...signal === undefined ? {} : { signal },
  }
}

/** Collect every chunk a stream produces. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('freebuff adapter: a Bearer session streams through the desktop protocol', async () => {
  const requests: { url: string, body: string, authorization: string | undefined }[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: String(input),
        body: String(init?.body ?? ''),
        authorization: headers.get('authorization') ?? undefined,
      })
      return new Response([
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { status: 200 })
    },
  })
  const options = { ...generateOptions('z-ai/glm-5.3-flash'), reasoningEffort: ReasoningEffortId('high') }
  const chunks = await collect(adapter.streamAccount(options, [...sessions.keys()][0] as string))
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'hi')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, `${FREEBUFF_API_BASE}${FREEBUFF_CHAT_PATH}`)
  assert.equal(requests[0]?.authorization, `Bearer ${SESSION.accessToken}`)
  assert.equal((JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>).reasoning_effort, 'high')
})

test('freebuff adapter: a cookie session streams through the web protocol', async () => {
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  const urls: string[] = []
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    fetchFn: async (input) => {
      urls.push(String(input))
      return new Response([
        'data: {"type":"meta","threadId":"t-9"}\n\n',
        'data: {"type":"delta","text":"from the web"}\n\n',
        'data: {"type":"done"}\n\n',
      ].join(''), { status: 200 })
    },
  })
  const chunks = await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), 'cookie-account'))
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'from the web')
  assert.deepEqual(urls, [`${FREEBUFF_WEB_BASE}${FREEBUFF_WEB_CHAT_PATH}`])
})

test('freebuff adapter: upstream-only tool calls never reach the harness', async () => {
  // The end-to-end shape of the reported breakage: the web wire tells the harness
  // Freebuff ran `web_search`, the harness tries to run a tool it never declared
  // (and has no handler for), and the turn breaks. Nothing may reach it.
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  const warnings: string[] = []
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    onWarn: message => warnings.push(message),
    fetchFn: async () => new Response([
      'data: {"type":"meta","threadId":"t-live"}\n\n',
      upstreamToolEvent('53r53sozGTI', 'web_search'),
      'data: {"type":"delta","text":"The date is"}\n\n',
      upstreamToolEvent('53sB45Py0FM', 'web_search'),
      'data: {"type":"delta","text":" today."}\n\n',
      'data: {"type":"done"}\n\n',
    ].join(''), { status: 200 }),
  })
  const chunks = await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), 'cookie-account'))
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'The date is today.', 'the answer text is intact')
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.equal(blocks.some(block => block.type === 'tool-call'), false, 'no tool-call block, so nothing dangles')
  // The turn ends with a finish of its own, and it is NOT the harness's
  // `tool-calls` reason — that is what would leave DSH waiting for a result.
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason), [{ kind: 'stop' }])
  assert.deepEqual(warnings, [UPSTREAM_TOOL_WARNING])
})

test('freebuff adapter: the web protocol refuses an image rather than dropping it', async () => {
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  let called = false
  // A mounted attachment store, so `resolveImages` gets past its own
  // missing-service check and the refusal under test is the one that fires.
  const attachments = {
    readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) }),
  } as unknown as AttachmentStore
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    resolveAttachments: () => attachments,
    fetchFn: async () => {
      called = true
      return new Response('', { status: 200 })
    },
  })
  const options: GenerateOptions = {
    ...generateOptions('z-ai/glm-5.3-flash'),
    messages: [{
      id: MessageId('m-img'),
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', attachment: { attachmentId: AttachmentId('a-1'), mediaType: 'image/png', bytes: 12, width: 2, height: 2 } },
      ],
      source: { kind: 'user' },
    }],
  }
  await assert.rejects(
    async () => await collect(adapter.streamAccount(options, 'cookie-account')),
    (error: unknown) => error instanceof LlmError && /cannot carry images/.test(error.message),
  )
  assert.equal(called, false, 'the refusal happens before any upstream call')
})

test('freebuff adapter: a turn that declares tools is refused on the web wire', async () => {
  // The live-reported defect: with a cookie credential the harness's tool schemas
  // never reached upstream, the model answered as a plain chat assistant, and
  // every local capability (file read/write, shell, glob/grep) silently vanished.
  // The wire cannot carry them (see the client module doc), so the turn is refused
  // instead of downgraded.
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  let called = false
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    fetchFn: async () => {
      called = true
      return new Response('data: {"type":"delta","text":"plain answer"}\n\ndata: {"type":"done"}\n\n', { status: 200 })
    },
  })
  const options: GenerateOptions = {
    ...generateOptions('z-ai/glm-5.3-flash'),
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
  }
  await assert.rejects(
    async () => await collect(adapter.streamAccount(options, 'cookie-account')),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED'
      && /cannot carry tools/.test(error.message)
      && /no `tools` field/.test(error.message)
      && /1 tool schema/.test(error.message),
  )
  assert.equal(called, false, 'the refusal happens before any upstream call')
  // A turn WITHOUT tools still streams: the refusal is scoped to tool-declaring
  // turns, and plain chat on this wire is unaffected.
  const web = await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), 'cookie-account'))
  assert.equal(called, true)
  assert.equal(web.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'plain answer')
})

test('freebuff adapter: a tool turn rides the web prompt as labelled text', async () => {
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  const bodies: Record<string, unknown>[] = []
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    fetchFn: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response('data: {"type":"delta","text":"ok"}\n\ndata: {"type":"done"}\n\n', { status: 200 })
    },
  })
  const options: GenerateOptions = {
    ...generateOptions('z-ai/glm-5.3-flash'),
    messages: [
      {
        id: MessageId('m-1'),
        role: 'user',
        content: [{ type: 'text', text: 'read the readme' }],
        source: { kind: 'user' },
      },
      {
        id: MessageId('m-2'),
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read_file', arguments: '{"path":"README.md"}' }],
        source: { kind: 'model', provider: 'freebuff', model: 'z-ai/glm-5.3-flash' },
      },
      {
        id: MessageId('m-3'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call_1'),
          content: [{ type: 'text', text: '# hello' }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call_1') },
      },
      {
        id: MessageId('m-4'),
        role: 'user',
        content: [{ type: 'text', text: 'what is its first line?' }],
        source: { kind: 'user' },
      },
    ],
  }
  const chunks = await collect(adapter.streamAccount(options, 'cookie-account'))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'ok')
  const body = bodies[0] ?? {}
  assert.equal(
    body.content,
    '[用户]\nread the readme\n\n[工具调用]\nread_file: {"path":"README.md"}\n\n[工具结果]\n# hello'
    + '\n\n[用户]\nwhat is its first line?',
  )
  assert.equal('tools' in body, false, 'the web body has no tools field to put schemas in')
  assert.equal(body.threadId, null)
})

test('freebuff adapter: a legacy tool-result block inside a user message is kept', async () => {
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  const bodies: Record<string, unknown>[] = []
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    fetchFn: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response('data: {"type":"delta","text":"ok"}\n\ndata: {"type":"done"}\n\n', { status: 200 })
    },
  })
  const options: GenerateOptions = {
    ...generateOptions('z-ai/glm-5.3-flash'),
    messages: [
      {
        id: MessageId('m-1'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call_1'),
          content: [{ type: 'text', text: '# hello' }],
        }],
        source: { kind: 'user' },
      },
      {
        id: MessageId('m-2'),
        role: 'user',
        content: [{ type: 'text', text: 'what is its first line?' }],
        source: { kind: 'user' },
      },
    ],
  }
  await collect(adapter.streamAccount(options, 'cookie-account'))
  assert.equal(
    bodies[0]?.content,
    '[工具结果]\n# hello\n\n[用户]\nwhat is its first line?',
    'the tool result inside the block reaches the prompt instead of vanishing',
  )
})

test('freebuff adapter: the desktop wire carries tools and tool turns unchanged', async () => {
  let body: Record<string, unknown> = {}
  const { adapter, sessions } = adapterOf({
    fetchFn: async (_input, init) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response([
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { status: 200 })
    },
  })
  const options: GenerateOptions = {
    ...generateOptions('z-ai/glm-5.3-flash'),
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
    messages: [
      {
        id: MessageId('m-1'),
        role: 'user',
        content: [{ type: 'text', text: 'read the readme' }],
        source: { kind: 'user' },
      },
      {
        id: MessageId('m-2'),
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read_file', arguments: '{"path":"README.md"}' }],
        source: { kind: 'model', provider: 'freebuff', model: 'z-ai/glm-5.3-flash' },
      },
      {
        id: MessageId('m-3'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call_1'),
          content: [{ type: 'text', text: '# hello' }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call_1') },
      },
    ],
  }
  await collect(adapter.streamAccount(options, [...sessions.keys()][0] as string))
  // The desktop body forwards the caller's tools unchanged (the reference passes
  // the inbound body through, `src/api.rs:2707-2708`), and the tool exchange is
  // native here: `tool_calls` on the assistant turn, `role:"tool"` for the result.
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  }])
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'read the readme' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '# hello' },
  ])
})

test('freebuff adapter: a 401 from upstream is an AUTH failure', async () => {
  const { adapter, sessions } = adapterOf({ fetchFn: async () => new Response('', { status: 401 }) })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH' && error.failure.status === 401,
  )
})

test('freebuff adapter: a 200 refusal surfaces the upstream own words', async () => {
  const { adapter, sessions } = adapterOf({
    fetchFn: async () => new Response(JSON.stringify({
      error: { message: 'free mode is paused for this account', code: 'free_mode_invalid' },
    }), { status: 200 }),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError && /free mode is paused for this account/.test(error.message),
  )
})

test('freebuff: session validation accepts a credential and reports its plan', async () => {
  const identity = await validateFreebuffCredential({ accessToken: 'token-value' }, async () =>
    new Response(JSON.stringify({
      accessTier: 'free',
      freebucks: { daily: { limit: 10, remaining: 7 }, planId: 'plan_free' },
    }), { status: 200 }))
  assert.equal(identity.token, 'token-value')
  // Precedence is the reference's: `subscription.tierId`, then `freebucks.planId`,
  // then the access tier (`src/api.rs:5660-5670` reads the subscription first).
  assert.equal(identity.plan, 'plan_free')
})

test('freebuff: a refused session validation is AUTH and therefore permanent', async () => {
  const refusal = async () => new Response('', { status: 401 })
  await assert.rejects(
    async () => await validateFreebuffCredential({ accessToken: 'token-value' }, refusal),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH' && isFreebuffPermanentRefreshError(error),
  )
  // A server fault says nothing about the credential, so it is NOT permanent.
  await assert.rejects(
    async () => await validateFreebuffCredential({ accessToken: 'token-value' }, async () => new Response('', { status: 503 })),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER' && !isFreebuffPermanentRefreshError(error),
  )
  assert.equal(isFreebuffPermanentRefreshError(new Error('nope')), false)
})

test('freebuff: a paste becomes a session only after the upstream honours it', async () => {
  const calls: string[] = []
  const session = await freebuffSessionFromPaste(
    `Bearer pasted-token-value-123456`,
    async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ accessTier: 'free', freebucks: { daily: { remaining: 3 } } }), { status: 200 })
    },
  )
  assert.equal(session.accessToken, 'pasted-token-value-123456')
  assert.equal(session.refreshToken, session.accessToken)
  assert.equal(session.plan, 'free')
  assert.equal(session.cookie, undefined)
  assert.equal(session.expiresAt > Date.now(), true)
  assert.deepEqual(calls, [`${FREEBUFF_API_BASE}/api/v1/freebuff/session`])
})

test('freebuff: a cookie paste validates, names the account, and survives a refresh', async () => {
  const cookie = `${FREEBUFF_SESSION_COOKIE}=sess-token-123456`
  const session = await freebuffSessionFromPaste(cookie, async (input) => {
    const url = String(input)
    if (url.includes('/api/auth/session')) {
      return new Response(JSON.stringify({ user: { email: 'person@example.com' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ accessTier: 'free', freebucks: { daily: { remaining: 3 } } }), { status: 200 })
  })
  assert.equal(session.cookie, cookie)
  assert.equal(session.account, 'person@example.com')
  const refreshed = await refreshFreebuffSession(
    { ...session, expiresAt: 0 },
    async () => new Response(JSON.stringify({ accessTier: 'free', freebucks: { daily: { remaining: 2 } } }), { status: 200 }),
  )
  assert.equal(refreshed.expiresAt > Date.now(), true)
  assert.equal(refreshed.account, 'person@example.com')
  assert.equal(refreshed.cookie, cookie)
  assert.deepEqual(freebuffCredentialOf(refreshed), { accessToken: session.accessToken, cookie })
})

test('freebuff: a cookie credential that lost its cookie header is not stored', () => {
  assert.throws(() => freebuffSessionOf({ kind: 'cookie', token: 'abc' }, { token: 'abc' }), (error: unknown) =>
    error instanceof LlmError && error.code === 'MALFORMED_RESPONSE')
})

/**
 * The Freebuff route: the pinned model table, the Bearer credential shape and its
 * refusal paths, the balance mapping, the error table, the CLI credential
 * import/login, and the desktop request bootstrap (session admission + agent
 * run) that every turn goes through.
 *
 * Every assertion traces to a source: the Rust reference this route was ported
 * from (`ref-freebuff2api`, cited by file:line in the modules themselves), or the
 * official Freebuff CLI's own shipped code, which is where the session headers,
 * the metadata fields and the model → free-agent table come from.
 */

import './keep-alive.js'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  FREEBUFF_CLI_CREDENTIALS_FILE,
  freebuffCliCredentialPaths,
  freebuffCliFailureMessage,
  freebuffCliFingerprintId,
  importFreebuffCliCredential,
  parseFreebuffCliCredentials,
  startFreebuffCliLogin,
} from '../src/providers/freebuff-cli.js'
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
  FREEBUFF_CLI_CODE_PATH,
  FREEBUFF_CLI_STATUS_PATH,
  FREEBUFF_CONCURRENCY_BUSY_RETRY_MS,
  FREEBUFF_LOGIN_BASE,
  FREEBUFF_QUEUE_RETRY_MS,
  FREEBUFF_SESSION_ADMISSION_PATH,
  FREEBUFF_SESSION_ATTEMPT_PATH,
  FREEBUFF_SESSION_COOKIE,
  FREEBUFF_TIMEZONE_HEADER,
  freebuffAgentFor,
  freebuffAssertDesktopCredential,
  freebuffBodyRefusal,
  freebuffChatBody,
  freebuffChatHeaders,
  freebuffChatUrl,
  freebuffCliCodeUrl,
  freebuffCliStatusUrl,
  freebuffCookieRefusal,
  freebuffCredentialKind,
  freebuffErrorEnvelope,
  freebuffEffortBodyField,
  freebuffGuardStream,
  freebuffInstanceUuid,
  freebuffResponseError,
  freebuffRunBody,
  freebuffRunUrl,
  freebuffSessionAdmissionUrl,
  freebuffSessionAttemptUrl,
  freebuffSessionHeaders,
  freebuffSessionStatus,
  freebuffSessionStatusError,
  freebuffSessionUnauthenticated,
  freebuffSessionUrl,
  freebuffTextError,
  parseFreebuffRunId,
  parseFreebuffUpstreamModels,
} from '../src/providers/freebuff/client.js'
import {
  FREEBUFF_CLAIM_PREEMPT_MS,
  freebuffClaimOf,
  freebuffForgetClaim,
  freebuffMintInstanceId,
  freebuffReadInstanceId,
  freebuffRecordClaim,
  freebuffResetClaims,
} from '../src/providers/freebuff/claim.js'
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
  freebuffSessionFromBearer,
  freebuffSessionFromPaste,
  freebuffSessionOf,
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

test('freebuff: a balance read that succeeds is mapped, on the Bearer wire', async () => {
  const calls: string[] = []
  const usage = await fetchFreebuffUsage(
    { accessToken: 'bearer-token-value' },
    async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({
        accessTier: 'free',
        freebucks: { daily: { limit: 100, spent: 0, remaining: 100, resetAt: '2026-09-28T07:00:00Z' } },
      }), { status: 200 })
    },
  )
  // Live 2026-09-28: this exact URL answers the balance for a free CLI Bearer with
  // no cookie involved.
  assert.deepEqual(calls, [`${FREEBUFF_API_BASE}/api/v1/freebuff/session`])
  assert.equal(usage.supported, true)
  assert.equal(usage.remaining, 100)
})

test('freebuff: a cookie credential is refused by name, and its usage is not read', async () => {
  const cookie = `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`
  assert.equal(freebuffCredentialKind({ accessToken: 'sess-value-123456', cookie }), 'cookie')
  assert.equal(freebuffCredentialKind({ accessToken: cookie }), 'cookie')
  assert.throws(() => freebuffAssertDesktopCredential({ accessToken: cookie }), (error: unknown) =>
    error instanceof LlmError && error.code === 'UNSUPPORTED' && /cookie credentials are no longer accepted/.test(error.message))
  // A whole cookie string in the TOKEN field is refused too: extracting its
  // session-token value and replaying it as a Bearer is the shape the upstream
  // answers with a ban-shaped 403.
  assert.throws(() => parseFreebuffPaste(cookie), (error: unknown) =>
    error instanceof LlmError && error.code === 'UNSUPPORTED')
  // The balance read does not go out at all for one.
  const urls: string[] = []
  const warnings: string[] = []
  const usage = await fetchFreebuffUsage(
    { accessToken: cookie },
    async (input) => { urls.push(String(input)); return new Response('{}', { status: 200 }) },
    undefined,
    { onWarn: message => warnings.push(message) },
  )
  assert.deepEqual(usage, { supported: false })
  assert.deepEqual(urls, [])
  assert.equal(warnings.length, 1)
  // A credential with neither secret cannot be routed and says which to get.
  assert.equal(freebuffCredentialKind({ accessToken: '' }), undefined)
  assert.throws(() => freebuffAssertDesktopCredential({ accessToken: '' }), (error: unknown) =>
    error instanceof LlmError && error.code === 'MISSING_CREDENTIAL')
})

test('freebuff: the chat headers are the desktop protocol, with no cookie anywhere', () => {
  const desktop = freebuffChatHeaders({ accessToken: 'tok' })
  assert.equal(desktop.authorization, 'Bearer tok')
  assert.equal(desktop['user-agent'], 'ai-sdk/openai-compatible/1.0.25/codebuff')
  assert.equal(desktop.cookie, undefined)
  assert.equal(desktop.origin, undefined, 'the web origin header is gone with that wire')
  assert.equal(freebuffChatUrl(), `${FREEBUFF_API_BASE}${FREEBUFF_CHAT_PATH}`)
  assert.equal(freebuffSessionUrl(), `${FREEBUFF_API_BASE}/api/v1/freebuff/session`)
  assert.equal(freebuffSessionAdmissionUrl(), `${FREEBUFF_API_BASE}${FREEBUFF_SESSION_ADMISSION_PATH}`)
  assert.equal(freebuffRunUrl(), `${FREEBUFF_API_BASE}/api/v1/agent-runs`)
})

test('freebuff: the session GET carries the CLI header set the balance read needs', () => {
  const instanceId = freebuffMintInstanceId()
  const get = freebuffSessionHeaders({ credential: { accessToken: 'tok' }, method: 'GET', instanceId, timezone: 'Asia/Shanghai' })
  assert.equal(get[FREEBUFF_TIMEZONE_HEADER], 'Asia/Shanghai')
  assert.equal(get.authorization, 'Bearer tok')
  assert.equal(get['x-freebuff-multi-session'], '1')
  assert.equal(get['x-freebuff-purchase-continuity'], '1')
  // Without this one the answer omits every per-model row (CLI `CV`, GET branch;
  // `src/upstream.rs:145-146`).
  assert.equal(get['x-freebuff-include-unused-rate-limits'], '1')
  assert.equal(get['x-freebuff-heartbeat'], '1', 'the CLI heartbeats on the session GET')
  assert.equal(get['x-freebuff-instance-id'], instanceId)
  assert.equal(get['x-freebuff-model'], undefined, 'only a POST names the model')
  assert.equal(get['x-freebuff-desktop-attempt-id'], undefined, 'that one is POST/DELETE only')
})

test('freebuff: the session POST carries the model, the attempt id and the wallet limit', () => {
  const instanceId = freebuffMintInstanceId()
  const post = freebuffSessionHeaders({
    credential: { accessToken: 'tok' },
    method: 'POST',
    instanceId,
    model: 'stealth/space-bunny-alpha',
    timezone: 'UTC',
  })
  assert.equal(post['x-freebuff-model'], 'stealth/space-bunny-alpha')
  assert.equal(post['x-freebuff-wallet-spend-limit'], '0')
  // The CLI sends the bare uuid here, and the prefixed id as the instance header.
  assert.equal(post['x-freebuff-desktop-attempt-id'], freebuffInstanceUuid(instanceId))
  assert.equal(post['x-freebuff-instance-id'], instanceId)
  assert.equal(post['x-freebuff-heartbeat'], undefined, 'the heartbeat is the GET branch')
  assert.equal(post['x-freebuff-include-unused-rate-limits'], undefined)
  // A takeover names the instance the slot is being taken from.
  const takeover = freebuffSessionHeaders({
    credential: { accessToken: 'tok' },
    method: 'POST',
    instanceId,
    takeoverInstanceId: 'uuid-elsewhere',
  })
  assert.equal(takeover['x-freebuff-takeover-instance-id'], 'uuid-elsewhere')
})

test('freebuff: the instance id is a FRESH cli: UUID v4 per attempt, never derived from the credential', () => {
  const first = freebuffMintInstanceId()
  const again = freebuffMintInstanceId()
  // One attempt id is one session START: the upstream retires it for good once
  // the attempt is over (`purchase_claim_released` / `admission_attempt_closed`),
  // so it must never be reused. That is the CLI's own `wr()`.
  assert.notEqual(first, again, 'a minted instance id is new every time')
  // A REAL uuid v4 shape, VARIANT nibble included. Live 2026-09-28 the admission
  // endpoint answered `400 {"error":"invalid_attempt_id"}` to a value that had the
  // version nibble but no variant nibble, so this is not cosmetic.
  assert.match(first, /^cli:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(freebuffInstanceUuid(first), first.slice(4))
  assert.equal(freebuffInstanceUuid('8fe895f8-43fc-4f4a-41e3-971277cdf538'), undefined,
    'a server-assigned id has no cli: prefix, which is what turns off surface/multi_session')
})

test('freebuff: the claim store hands the SAME instance back while it is live, and drops it after', () => {
  freebuffResetClaims()
  const token = 'claim-token-aaa'
  assert.equal(freebuffClaimOf(token), undefined, 'a credential with no admission has no claim')
  const minted = freebuffMintInstanceId()
  assert.equal(freebuffRecordClaim(token, {
    instanceId: minted,
    model: 'stealth/space-bunny-alpha',
    expiresAt: Date.now() + 3_600_000,
  }), true)
  // Same instance, same model, same end: the next turn re-admits THIS attempt
  // instead of minting a second one (a second one is refused with
  // `purchase_capacity` while this one is live — reproduced live).
  const stored = freebuffClaimOf(token)
  assert.equal(stored?.instanceId, minted)
  assert.equal(stored?.model, 'stealth/space-bunny-alpha')
  assert.ok((stored?.expiresAt ?? 0) > Date.now())
  // The claim is per credential: another account never sees it.
  assert.equal(freebuffClaimOf('claim-token-bbb'), undefined)
  // A reply about a DIFFERENT attempt must not drop this claim...
  freebuffForgetClaim(token, freebuffMintInstanceId())
  assert.notEqual(freebuffClaimOf(token), undefined)
  // ...but the claim's own instance, or a blanket call, does.
  freebuffForgetClaim(token, minted)
  assert.equal(freebuffClaimOf(token), undefined)
  freebuffRecordClaim(token, { instanceId: minted, model: 'm' })
  freebuffForgetClaim(token)
  assert.equal(freebuffClaimOf(token), undefined)
})

test('freebuff: a claim inside the reference preempt window is over, not reusable', () => {
  freebuffResetClaims()
  const token = 'claim-token-preempt'
  const now = 1_000_000
  freebuffRecordClaim(token, {
    instanceId: freebuffMintInstanceId(),
    model: 'stealth/space-bunny-alpha',
    expiresAt: now + FREEBUFF_CLAIM_PREEMPT_MS,
  }, now)
  // `ref-freebuff2api/src/session.rs:120-121` reuses a session only while
  // `now + 5s < expires`; at the boundary the claim is over.
  assert.equal(freebuffClaimOf(token, now), undefined)
  assert.equal(freebuffClaimOf(token, now - 1), undefined, 'and it was forgotten, not merely filtered')
  // One tick earlier it is still usable.
  freebuffRecordClaim(token, {
    instanceId: freebuffMintInstanceId(),
    model: 'stealth/space-bunny-alpha',
    expiresAt: now + FREEBUFF_CLAIM_PREEMPT_MS + 2,
  }, now)
  assert.notEqual(freebuffClaimOf(token, now), undefined)
})

test('freebuff: a read speaks for the live claim, or for a throwaway attempt', () => {
  freebuffResetClaims()
  const token = 'claim-token-read'
  const held = freebuffMintInstanceId()
  freebuffRecordClaim(token, { instanceId: held, model: 'stealth/space-bunny-alpha', expiresAt: Date.now() + 3_600_000 })
  // The heartbeat/balance GET must name the instance the claim holds, which is
  // what keeps that claim alive (the CLI heartbeats its own instance).
  assert.equal(freebuffReadInstanceId(token), held)
  freebuffForgetClaim(token)
  const minted = freebuffReadInstanceId(token)
  assert.match(minted, /^cli:[0-9a-f-]{36}$/)
  assert.notEqual(minted, held)
  assert.equal(freebuffClaimOf(token), undefined, 'a read never creates a claim')
})

test('freebuff: a server-assigned instance id is not recorded as a claim', () => {
  freebuffResetClaims()
  // The CLI draws the same line: `wJA` records only a `cli:`-prefixed instance
  // (a legacy, server-assigned id is the single-session wire, whose attempt
  // headers do not exist).
  assert.equal(freebuffRecordClaim('claim-token-legacy', {
    instanceId: '8fe895f8-43fc-4f4a-41e3-971277cdf538',
    model: 'stealth/space-bunny-alpha',
  }), false)
  assert.equal(freebuffClaimOf('claim-token-legacy'), undefined)
})

test('freebuff: every free model maps to its own free agent', () => {
  // The pair free mode validates. `base2-free` is only the CLI's own fallback.
  assert.equal(freebuffAgentFor('stealth/space-bunny-alpha'), 'base2-free-space-bunny-alpha')
  assert.equal(freebuffAgentFor('z-ai/glm-5.3-flash'), 'base2-free-glm-5-3-flash')
  assert.equal(freebuffAgentFor('mimo/mimo-v2.5'), 'base2-free-mimo')
  assert.equal(freebuffAgentFor('some/unknown-model'), 'base2-free')
  assert.deepEqual(freebuffRunBody('base2-free-space-bunny-alpha'), {
    action: 'START',
    agentId: 'base2-free-space-bunny-alpha',
    ancestorRunIds: [],
  })
  assert.equal(parseFreebuffRunId({ runId: 'run-1' }), 'run-1')
  assert.equal(parseFreebuffRunId({ run_id: 'run-2' }), 'run-2', 'the reference accepts both spellings')
  assert.equal(parseFreebuffRunId({}), undefined)
})

test('freebuff: the desktop body carries the run id, the cli identity and the effort', () => {
  const instanceId = freebuffMintInstanceId()
  const body = freebuffChatBody({
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'xhigh',
    instanceId,
    runId: 'run-abc',
  })
  assert.equal(body.reasoning_effort, 'max', 'the clamp reaches the body')
  assert.equal(body.stream, true)
  assert.equal(body.model, 'z-ai/glm-5.3-flash')
  const metadata = body.codebuff_metadata as Record<string, unknown>
  assert.equal(metadata.cost_mode, 'free')
  assert.equal(typeof metadata.client_id, 'string')
  // The ADMITTED attempt, passed through verbatim — not recomputed here: the chat
  // must name the same instance the run was started for.
  assert.equal(metadata.freebuff_instance_id, instanceId)
  // The upstream refuses a body without one: `400 No runId found in request body`.
  assert.equal(metadata.run_id, 'run-abc')
  // The two fields the cli: prefix turns on (the CLI's `OJA`).
  assert.equal(metadata.freebuff_multi_session, '1')
  assert.equal(metadata.surface, 'cli')
  // The CLI's own free-mode spelling of the level.
  assert.equal(metadata.freebuff_reasoning_effort, 'max')
  // And a no-ladder model has no effort key at all, in either spelling.
  const solar = freebuffChatBody({
    model: 'upstage/solar-pro4',
    messages: [],
    reasoningEffort: 'high',
    instanceId,
    runId: 'run-abc',
  })
  assert.equal('reasoning_effort' in solar, false)
  assert.equal((solar.codebuff_metadata as Record<string, unknown>).freebuff_reasoning_effort, undefined)
})

test('freebuff: a non-cli instance id would drop the surface fields, and ours never is one', () => {
  // The metadata builder takes the instance it is given, so this asserts the
  // instance and the gate agree: `cli:` present → surface declared.
  const instance = freebuffMintInstanceId()
  assert.notEqual(freebuffInstanceUuid(instance), undefined)
  const metadata = freebuffChatBody({ model: 'mimo/mimo-v2.5', messages: [], instanceId: instance, runId: 'r' })
    .codebuff_metadata as Record<string, unknown>
  assert.equal(metadata.surface, 'cli')
  assert.equal(metadata.freebuff_multi_session, '1')
})

/**
 * The live bytes this route's session lifecycle is written against.
 *
 * Recorded 2026-09-29 against `https://www.codebuff.com` with the free
 * credential from `~/.config/manicode/credentials.json` and the free model
 * `stealth/space-bunny-alpha` (price 0). Every one of these was a real answer to
 * a real request; the probe scripts are the ones this fix was verified with.
 */
const LIVE_ADMISSION_RELEASED = JSON.stringify({
  status: 'purchase_claim_released',
  accessTier: 'limited',
  desktopSessionCounts: { premium: 0, unlimited: 0 },
  desktopPurchases: [],
  desktopRefunds: [],
})
const LIVE_ADMISSION_ACTIVE = JSON.stringify({
  status: 'active',
  accessTier: 'limited',
  instanceId: 'cli:4de1aab8-9544-4519-991d-13f9abe05476',
  model: 'stealth/space-bunny-alpha',
  admittedAt: '2026-09-29T00:40:22.188Z',
  expiresAt: '2026-09-29T01:40:22.188Z',
  remainingMs: 3600000,
  countryCode: 'US',
  countryBlockReason: 'anonymous_network',
  ipPrivacySignals: null,
})
const LIVE_ATTEMPT_CLOSED = JSON.stringify({
  error: 'admission_attempt_closed',
  message: 'This session start was cancelled before it finished. Start again to open a new session.',
})
const LIVE_ATTEMPT_ENDED = JSON.stringify({
  status: 'ended',
  desktopAttemptId: '4de1aab8-9544-4519-991d-13f9abe05476',
  refundReceiptId: '78fc7242-ff36-491e-80c0-77c9ad647871',
  freebucksRefundPending: true,
})
const LIVE_SLOT_HELD = JSON.stringify({
  status: 'purchase_capacity',
  accessTier: 'limited',
  requestedModel: 'stealth/space-bunny-alpha',
  currentInstanceId: 'cli:d3f6d4d6-7dcc-4399-87b9-ec75b42a8f37',
  concurrency: 'slot-bound',
  slotLimit: 1,
  desktopSessionCounts: { premium: 1, unlimited: 0, nextExpiryAt: '2026-09-29T02:10:22.188Z' },
  desktopPurchases: [{
    model: 'stealth/space-bunny-alpha',
    expiresAt: '2026-09-29T01:40:22.188Z',
    holderInstanceId: 'cli:d3f6d4d6-7dcc-4399-87b9-ec75b42a8f37',
  }],
  desktopRefunds: [],
})
const LIVE_RELEASED_WITH_HOLDER = JSON.stringify({
  status: 'purchase_claim_released',
  accessTier: 'limited',
  desktopSessionCounts: { premium: 1, unlimited: 0, nextExpiryAt: '2026-09-29T02:10:22.188Z' },
  desktopPurchases: [{
    model: 'stealth/space-bunny-alpha',
    expiresAt: '2026-09-29T01:40:22.188Z',
    holderInstanceId: 'cli:d3f6d4d6-7dcc-4399-87b9-ec75b42a8f37',
  }],
  desktopRefunds: [],
})

test('freebuff: a released attempt is RETIRED — a fresh attempt is the way out, never a retry of the same id', () => {
  // The exact bytes of the reported failure: the account's slot is FREE
  // (`premium: 0`, no purchases at all), so this is about the dead attempt, not
  // capacity — which is why replacing the attempt is the right move and why
  // re-POSTing it would repeat forever.
  const reading = freebuffSessionStatus(JSON.parse(LIVE_ADMISSION_RELEASED) as unknown, 409, 'freebuff desktop session admission', {
    body: LIVE_ADMISSION_RELEASED,
    attempt: 'cli:be2239fd-b67f-4b2e-a882-1988e6b05484',
  })
  assert.equal(reading.verdict, 'retired')
  assert.equal(reading.status, 'purchase_claim_released')
  assert.equal(reading.error?.code, 'HTTP_409')
  assert.match(reading.error?.message ?? '', /purchase_claim_released/)
  assert.match(reading.error?.message ?? '', /RELEASED that session start/)
  assert.match(reading.error?.message ?? '', /cli:be2239fd-b67f-4b2e-a882-1988e6b05484/)
  // The remedy is the CLI's own, quoted: «This session was released. Choose a
  // model to start a new session.»
  assert.match(reading.error?.message ?? '', /Choose a model to start a new session/)
  assert.match(reading.error?.message ?? '', /\/end-session/)
  // A cancelled attempt is the same conclusion, with the server's own words.
  const closed = freebuffSessionStatus(JSON.parse(LIVE_ATTEMPT_CLOSED) as unknown, 409, 'label', { body: LIVE_ATTEMPT_CLOSED })
  assert.equal(closed.verdict, 'retired')
  assert.equal(closed.status, 'admission_attempt_closed')
  assert.match(closed.error?.message ?? '', /CANCELLED that session start/)
  assert.match(closed.error?.message ?? '', /cancelled before it finished/)
})

test('freebuff: a retired attempt that a FRESH one also fails is reported as the account state it is', () => {
  const reading = freebuffSessionStatus(JSON.parse(LIVE_ADMISSION_RELEASED) as unknown, 409, 'label', {
    body: LIVE_ADMISSION_RELEASED,
    attempt: 'cli:aaaaaaaa-1111-4222-8333-444444444444',
    freshAttemptTried: 'cli:bbbbbbbb-1111-4222-8333-444444444444',
  })
  assert.match(reading.error?.message ?? '', /already opened a NEW attempt \(cli:bbbbbbbb-1111-4222-8333-444444444444\)/)
  assert.match(reading.error?.message ?? '', /nothing local is stale/)
})

test('freebuff: a held slot names the holder and is NOT retried with a fresh attempt', () => {
  // Live bytes: a fresh attempt while another claim was live. The holder is
  // named, so the reader can see whose session it is and what to ask for.
  const reading = freebuffSessionStatus(JSON.parse(LIVE_SLOT_HELD) as unknown, 409, 'freebuff desktop session admission', {
    body: LIVE_SLOT_HELD,
    attempt: 'cli:ac0fc8d7-462c-445e-869f-37317ab83676',
  })
  assert.equal(reading.verdict, 'slot-held')
  assert.equal(reading.error?.code, 'HTTP_409')
  assert.match(reading.error?.message ?? '', /only free slot/)
  assert.match(reading.error?.message ?? '', /holder instance cli:d3f6d4d6-7dcc-4399-87b9-ec75b42a8f37/)
  assert.match(reading.error?.message ?? '', /model stealth\/space-bunny-alpha/)
  assert.match(reading.error?.message ?? '', /slotLimit 1/)
  assert.match(reading.error?.message ?? '', /\/end-session/)
  assert.match(reading.error?.message ?? '', /ask this route for stealth\/space-bunny-alpha/)
})

test('freebuff: every status the CLI distinguishes gets a verdict, and the state is named', () => {
  const verdictOf = (payload: Record<string, unknown>, status = 409): string => {
    const body = JSON.stringify(payload)
    return freebuffSessionStatus(payload, status, 'label', { body }).verdict
  }
  assert.equal(verdictOf({ status: 'active' }, 200), 'active')
  assert.equal(verdictOf({ status: 'purchase_claim_released' }), 'retired')
  assert.equal(verdictOf({ error: 'admission_attempt_closed' }), 'retired')
  assert.equal(verdictOf({ status: 'none' }, 200), 'no-claim')
  assert.equal(verdictOf({ status: 'ended' }, 200), 'no-claim')
  assert.equal(verdictOf({ status: 'superseded' }, 200), 'no-claim')
  assert.equal(verdictOf({ status: 'purchase_capacity' }), 'slot-held')
  assert.equal(verdictOf({ status: 'premium_slot_taken' }), 'slot-held')
  assert.equal(verdictOf({ status: 'purchase_in_use' }), 'slot-held')
  assert.equal(verdictOf({ status: 'queued', position: 4 }, 200), 'wait')
  assert.equal(verdictOf({ status: 'waiting_room_queued' }, 200), 'wait')
  assert.equal(verdictOf({ status: 'rate_limited' }, 429), 'wait')
  assert.equal(verdictOf({ status: 'spend_limited' }, 429), 'wait')
  assert.equal(verdictOf({ status: 'ip_capped' }, 429), 'wait')
  assert.equal(verdictOf({ status: 'model_locked' }), 'refused')
  assert.equal(verdictOf({ status: 'model_unavailable' }), 'refused')
  assert.equal(verdictOf({ status: 'first_tab_discount_changed' }), 'refused')
  assert.equal(verdictOf({ status: 'consent_required' }), 'refused')
  assert.equal(verdictOf({ status: 'banned' }, 403), 'refused')
  assert.equal(verdictOf({ status: 'country_blocked' }, 403), 'refused')
  // Only `active` is a session.
  assert.equal(freebuffSessionStatus({ status: 'active' }, 200, 'label').error, undefined)
})

test('freebuff: each refusal carries the remedy in the user own terms, not an HTTP status', () => {
  const messageOf = (payload: Record<string, unknown>, status = 409): string => {
    const body = JSON.stringify(payload)
    return freebuffSessionStatus(payload, status, 'label', { body }).error?.message ?? ''
  }
  // The model binding: the CLI's own words, plus what to do here.
  const locked = messageOf({ status: 'model_locked', requestedModel: 'z-ai/glm-5.3-flash', currentModel: 'mimo/mimo-v2.5' })
  assert.match(locked, /already in an active session on mimo\/mimo-v2.5/)
  assert.match(locked, /\/end-session/)
  assert.match(locked, /Sessions end on their own after 1 hour/)
  assert.equal(freebuffSessionStatus({ status: 'model_locked' }, 409, 'label').error?.code, 'HTTP_404')
  // A withdrawn/unavailable model is a wrong-model condition, not a rate limit.
  const unavailable = messageOf({ status: 'model_unavailable', requestedModel: 'stealth/ox-alpha', withdrawn: true })
  assert.match(unavailable, /stealth\/ox-alpha is not available/)
  assert.match(unavailable, /WITHDRAWN/)
  assert.match(unavailable, /Pick another free model/)
  // The discount/consent states need a human; the route spends nothing.
  const discount = messageOf({ status: 'first_tab_discount_changed' })
  assert.match(discount, /Review the model menu and choose again/)
  assert.match(discount, /sends the discount flag as 0/)
  const consent = messageOf({ status: 'consent_required', walletConsent: { walletSpend: 12 } })
  assert.match(consent, /wallet spend confirmed \(12 Freebucks\)/)
  assert.match(consent, /x-freebuff-wallet-spend-limit: 0/)
  // Rate limits say what to wait for.
  const spent = messageOf({ status: 'spend_limited', freebucks: { daily: { resetAt: '2026-09-29T16:00:00.000Z' } } }, 429)
  assert.match(spent, /Freebucks are spent for today \(they reset at 2026-09-29T16:00:00.000Z\)/)
  assert.equal(freebuffSessionStatus({ status: 'spend_limited' }, 429, 'label').error?.code, 'RATE_LIMIT')
  const capped = messageOf({ status: 'ip_capped' }, 429)
  assert.match(capped, /VPN\/proxy/)
  assert.equal(freebuffSessionStatus({ status: 'ip_capped' }, 429, 'label').error?.code, 'RATE_LIMIT')
  const limited = messageOf({ status: 'rate_limited' }, 429)
  assert.match(limited, /rate-limited/)
  // A banned/country-blocked account is terminal, and says so.
  const banned = messageOf({ status: 'country_blocked', countryBlockReason: 'anonymous_network' }, 403)
  assert.match(banned, /reports this account as country_blocked \(anonymous_network\)/)
  assert.match(banned, /No retry here will change that/)
  assert.equal(freebuffSessionStatus({ status: 'banned' }, 403, 'label').error?.code, 'UNSUPPORTED')
  // A status with no session at all still names the state and the way out.
  const none = messageOf({ status: 'none' }, 200)
  assert.match(none, /answered status "none"/)
  assert.match(none, /Start a session in the Freebuff CLI/)
  // A non-JSON body must not become a TypeError, whatever the status — and an
  // unrecognized failure keeps the hub's own classification (`SERVER` for a 5xx).
  const garbage = freebuffSessionStatus(undefined, 502, 'label', { body: '<html>nope</html>' })
  assert.equal(garbage.status, '')
  assert.equal(garbage.error?.code, 'SERVER')
  assert.match(garbage.error?.message ?? '', /did not answer an active session \(HTTP 502\): <html>nope<\/html>/)
  assert.equal(freebuffSessionStatus(undefined, 200, 'label', { body: 'nope' }).error?.code, 'MALFORMED_RESPONSE')
})

test('freebuff: free_mode_cli_required is reported as UNSUPPORTED with the ban warning', () => {
  const error = freebuffTextError(403, JSON.stringify({
    error: 'free_mode_cli_required',
    message: 'Free mode is only available through the freebuff CLI. Install it with `npm i -g freebuff`, then run '
      + '`freebuff`. Calling the API directly is not supported and may get your account banned.',
  }), 'freebuff desktop')
  assert.equal(error?.code, 'UNSUPPORTED')
  assert.match(error?.message ?? '', /may get your account banned/)
  assert.match(error?.message ?? '', /gates free mode to its official CLI/)
})

test('freebuff: a taken free slot is reported with the upstream status and a remedy', () => {
  const text = JSON.stringify({
    status: 'purchase_capacity',
    concurrency: 'slot-bound',
    slotLimit: 1,
    currentInstanceId: '8fe895f8-43fc-4f4a-41e3-971277cdf538',
  })
  const error = freebuffTextError(409, text, 'freebuff desktop session admission')
  assert.equal(error?.code, 'HTTP_409')
  assert.match(error?.message ?? '', /holds this account's only free slot/)
  // The status-based reader reaches the same conclusion from a 200 body.
  const fromStatus = freebuffSessionStatusError(JSON.parse(text) as unknown, 409, 'label')
  assert.equal(fromStatus?.code, 'HTTP_409')
  assert.equal(freebuffSessionStatusError({ status: 'active' }, 200, 'label'), undefined)
  const queued = freebuffSessionStatusError({ status: 'queued', position: 3 }, 200, 'label')
  assert.equal(queued?.code, 'RATE_LIMIT')
  assert.match(queued?.message ?? '', /waiting room/)
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
  const error = await freebuffResponseError(429, new Headers(), 'Too Many Requests', 'freebuff desktop')
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
  const unauthorized = await freebuffResponseError(401, new Headers(), '', 'freebuff desktop')
  assert.equal(unauthorized.code, 'AUTH')
  const server = await freebuffResponseError(503, new Headers(), 'boom', 'freebuff desktop')
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
  const waiting = freebuffBodyRefusal('waiting_room_queued', 200, 'freebuff desktop')
  assert.equal(waiting?.code, 'RATE_LIMIT')
  const delay = waiting?.failure.providerRetryAfterMs ?? 0
  assert.ok(delay >= FREEBUFF_QUEUE_RETRY_MS - 100 && delay <= FREEBUFF_QUEUE_RETRY_MS + 100)

  const unauthorized = freebuffBodyRefusal('{"message":"session expired"}', 200, 'freebuff desktop')
  assert.equal(unauthorized?.code, 'AUTH')
})

test('freebuff: model OUTPUT is never mistaken for a refusal', () => {
  // A real stream frame carries `choices`, and the first token of an answer could
  // be anything — including the words the text rules match on.
  const frame = 'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"rate limit"},"finish_reason":null}]}\n\n'
  assert.equal(freebuffBodyRefusal(frame, 200, 'freebuff chat-completions'), undefined)
  assert.equal(freebuffBodyRefusal('{"choices":[{"delta":{"content":"unauthorized"}}]}', 200, 'freebuff x'), undefined)
  // The desktop protocol's frames also carry `usage` and `object`, and a frame
  // whose model output is reasoning text matches the same words.
  assert.equal(
    freebuffBodyRefusal('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"the rate limit was reached"}}],"usage":null}\n\n', 200, 'freebuff desktop'),
    undefined,
  )
  // But a body that really is an error envelope is still refused.
  assert.notEqual(
    freebuffBodyRefusal('data: {"error":{"message":"session expired"}}\n\n', 200, 'freebuff desktop'),
    undefined,
  )
})

test('freebuff: the guard turns a 200 refusal into a thrown error, not an empty stream', async () => {
  const body = new Response(JSON.stringify({ error: { message: 'free mode is unavailable right now' } })).body
  assert.notEqual(body, null)
  const guarded = freebuffGuardStream(body as ReadableStream<Uint8Array>, { label: 'freebuff desktop', status: 200 })
  await assert.rejects(
    async () => await new Response(guarded).text(),
    (error: unknown) => error instanceof LlmError && /free mode is unavailable right now/.test(error.message),
  )
})

test('freebuff: a real stream passes the guard through untouched', async () => {
  const sse = [
    'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ].join('')
  const guarded = freebuffGuardStream(new Response(sse).body as ReadableStream<Uint8Array>, {
    label: 'freebuff desktop',
    status: 200,
  })
  const text = await new Response(guarded).text()
  assert.equal(text, sse, 'a real stream is byte-for-byte untouched')
})

test('freebuff: a pasted Bearer token parses', () => {
  assert.equal(parseFreebuffPaste('Bearer abcdefghijklmnopqrst'), 'abcdefghijklmnopqrst')
  // A bare token is what a user copies out of the header's value side.
  assert.equal(parseFreebuffPaste('abcdefghijklmnopqrst'), 'abcdefghijklmnopqrst')
  // The same header inside a curl command.
  const fromCurl = parseFreebuffPaste(`curl 'https://www.codebuff.com/api/v1/chat/completions' -H 'authorization: Bearer zzzzzzzzzzzzzzzz'`)
  assert.equal(fromCurl, 'zzzzzzzzzzzzzzzz')
})

test('freebuff: a pasted cookie string is refused, with the reason attached', () => {
  const pasted = `__Host-next-auth.csrf-token=csrf123; ${FREEBUFF_SESSION_COOKIE}=sess-token-value-1234; `
    + '__Secure-next-auth.callback-url=https%3A%2F%2Ffreebuff.com; _ga=GA1.1.999'
  assert.throws(() => parseFreebuffPaste(pasted), (error: unknown) =>
    error instanceof LlmError
    && error.code === 'UNSUPPORTED'
    && /no `tools` field/.test(error.message)
    && /Import from Freebuff CLI/.test(error.message))
  // Even a lone session-token pair, which is the shape a user copies out of
  // DevTools, is refused — not silently replayed as a Bearer.
  assert.throws(() => parseFreebuffPaste(`${FREEBUFF_SESSION_COOKIE}=sess-token-value-1234`), (error: unknown) =>
    error instanceof LlmError && error.code === 'UNSUPPORTED')
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
  assert.equal(parseFreebuffPaste(har), 'har-token-value-9876')
  // A HAR whose only credential is a cookie is NOT a credential here: the
  // session-token marker is what makes it one, and it is refused by name.
  const cookieHar = JSON.stringify({
    log: { entries: [{ request: { headers: [{ name: 'cookie', value: `${FREEBUFF_SESSION_COOKIE}=abc123` }] } }] },
  })
  assert.throws(() => parseFreebuffPaste(cookieHar), (error: unknown) =>
    error instanceof LlmError && error.code === 'UNSUPPORTED')
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
  // No claim may leak from one case into the next: it would make the admission
  // instance id (and therefore what each test asserts) depend on test order.
  freebuffResetClaims()
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

/** The CLI's own free-agent/mode pairs, as the admission answer spells them. */
/**
 * The default admission answer: what the upstream really sends, which is the
 * attempt it was handed echoed back (live 2026-09-29: `"instanceId":"cli:<the id
 * we sent>"`). A `server-assigned` id is the legacy single-session wire and is
 * covered on its own below.
 */
function admissionEcho(headers: Headers): Response {
  return admissionActiveFor(headers.get('x-freebuff-instance-id') ?? 'server-assigned')
}
const RUN_ANSWER = JSON.stringify({ runId: 'run-1' })

/** One OpenAI-shaped SSE answer, as the desktop wire sends it. */
const DESKTOP_SSE = [
  'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('')

/** One request the adapter made, whatever it was. */
interface MadeRequest {
  url: string
  method: string
  body: string
  headers: Headers
}

/** The admission answer for a given attempt, as the upstream echoes it back. */
function admissionActiveFor(instanceId: string, model = 'stealth/space-bunny-alpha'): Response {
  return new Response(JSON.stringify({
    status: 'active',
    accessTier: 'limited',
    instanceId,
    model,
    admittedAt: '2026-09-29T00:40:22.188Z',
    expiresAt: '2026-09-29T01:40:22.188Z',
    remainingMs: 3_600_000,
  }), { status: 200 })
}

/**
 * A fetcher that answers the CLI bootstrap and the chat, recording every request.
 *
 * The bootstrap is answered from the constants above unless the test overrides a
 * leg, which is how the refusal paths are driven without inventing a shape. The
 * admission override is called with the number of admission calls already made,
 * so a test can answer the first attempt one way and the retry another.
 */
function bootstrapFetch(
  requests: MadeRequest[],
  overrides: {
    admission?: (call: number, headers: Headers) => Response
    attempt?: () => Response
    run?: () => Response
    chat?: () => Response
  } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let admissionCalls = 0
  return (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      headers,
    })
    if (url.endsWith('/api/v1/freebuff/session/attempt')) {
      // The CLI's own release confirmation (`releaseSlot` requires `ended`).
      return Promise.resolve(overrides.attempt?.() ?? new Response(LIVE_ATTEMPT_ENDED, { status: 200 }))
    }
    if (url.endsWith('/api/v1/freebuff/session/admission')) {
      const call = admissionCalls
      admissionCalls += 1
      return Promise.resolve(overrides.admission?.(call, headers) ?? admissionEcho(headers))
    }
    if (url.endsWith('/api/v1/agent-runs')) {
      return Promise.resolve(overrides.run?.() ?? new Response(RUN_ANSWER, { status: 200 }))
    }
    return Promise.resolve(overrides.chat?.() ?? new Response(DESKTOP_SSE, { status: 200 }))
  }
}

test('freebuff adapter: a turn bootstraps the session and the run, then streams', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({ fetchFn: bootstrapFetch(requests) })
  const chunks = await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hi')

  // The sequence is the CLI's own: admit, start a run, chat.
  assert.deepEqual(requests.map(request => request.url), [
    `${FREEBUFF_API_BASE}${FREEBUFF_SESSION_ADMISSION_PATH}`,
    `${FREEBUFF_API_BASE}/api/v1/agent-runs`,
    `${FREEBUFF_API_BASE}${FREEBUFF_CHAT_PATH}`,
  ])
  assert.deepEqual(requests.map(request => request.method), ['POST', 'POST', 'POST'])
  for (const request of requests) {
    assert.equal(request.headers.get('authorization'), `Bearer ${SESSION.accessToken}`)
  }
  // The admission is bound to the MODEL and to a FRESH cli: attempt — one session
  // start, minted here, never derived from the credential.
  const admission = requests[0]
  assert.equal(admission?.headers.get('x-freebuff-model'), 'stealth/space-bunny-alpha')
  const attempt = admission?.headers.get('x-freebuff-instance-id') ?? ''
  assert.match(attempt, /^cli:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(admission?.headers.get('x-freebuff-desktop-attempt-id'), attempt.slice(4),
    'the attempt id header is the instance uuid (`CV`: `L[QJA] = D`)')
  assert.equal(admission?.headers.get('x-freebuff-wallet-spend-limit'), '0')
  assert.equal(admission?.headers.get('x-freebuff-multi-session'), '1')
  // The run is started for the MODEL-SPECIFIC free agent, which is what free mode
  // validates; the generic `base2-free` is the reference's fallback and would be
  // refused for this model.
  assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), {
    action: 'START',
    agentId: 'base2-free-space-bunny-alpha',
    ancestorRunIds: [],
  })
  // And the chat carries the run id plus the cli identity.
  const chat = JSON.parse(requests[2]?.body ?? '{}') as Record<string, unknown>
  assert.equal(chat.model, 'stealth/space-bunny-alpha')
  // This model has no effort ladder, so the field is absent rather than guessed.
  assert.equal('reasoning_effort' in chat, false)
  const metadata = chat.codebuff_metadata as Record<string, unknown>
  assert.equal(metadata.run_id, 'run-1')
  assert.equal(metadata.freebuff_instance_id, attempt, 'the chat speaks for the attempt that was admitted')
  assert.equal(metadata.surface, 'cli')
  assert.equal(metadata.freebuff_multi_session, '1')
  assert.equal(metadata.cost_mode, 'free')
})

test('freebuff adapter: a RELEASED attempt is replaced with a fresh one and the turn goes through', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      admission: call => call === 0
        ? new Response(LIVE_ADMISSION_RELEASED, { status: 409 })
        : new Response(JSON.stringify({
            ...JSON.parse(LIVE_ADMISSION_ACTIVE) as Record<string, unknown>,
            // A real answer echoes the attempt that was sent (live 2026-09-29).
            instanceId: 'cli:11111111-2222-4333-8444-555555555555',
          }), { status: 200 }),
    }),
  })
  // The state the real failure was reported from: the attempt this account is
  // pinned to has been released upstream, and every POST with it answers
  // `409 purchase_claim_released` forever.
  freebuffRecordClaim(SESSION.accessToken, {
    instanceId: 'cli:be2239fd-b67f-4b2e-a882-1988e6b05484',
    model: 'stealth/space-bunny-alpha',
    expiresAt: Date.now() + 3_600_000,
  })
  const chunks = await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hi')

  const admissions = requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission'))
  assert.equal(admissions.length, 2, 'the retired attempt is retried ONCE, with a fresh attempt id')
  const first = admissions[0]?.headers.get('x-freebuff-instance-id') ?? ''
  const second = admissions[1]?.headers.get('x-freebuff-instance-id') ?? ''
  assert.equal(first, 'cli:be2239fd-b67f-4b2e-a882-1988e6b05484', 'the released attempt is what the turn started from')
  assert.notEqual(second, first, 'a fresh attempt id is the whole point: the released one is dead for good')
  assert.match(second, /^cli:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // The chat speaks for the attempt the upstream ACCEPTED — the instance it
  // echoed, which is the CLI's own rule (`g.instanceId` becomes the session's).
  const chat = JSON.parse(requests.at(-1)?.body ?? '{}') as Record<string, unknown>
  assert.equal((chat.codebuff_metadata as Record<string, unknown>).freebuff_instance_id, 'cli:11111111-2222-4333-8444-555555555555')
})

test('freebuff adapter: a server-assigned instance follows the upstream, and is not carried into the next turn', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    // The legacy single-session wire: the server assigns the instance instead of
    // echoing a `cli:` one. The CLI follows it for the current session
    // (`g.instanceId`) but does not record it as a resumable claim (`wJA`).
    fetchFn: bootstrapFetch(requests, {
      admission: () => new Response(
        JSON.stringify({ status: 'active', accessTier: 'limited', instanceId: '8fe895f8-43fc-4f4a-41e3-971277cdf538' }),
        { status: 200 },
      ),
    }),
  })
  const account = [...sessions.keys()][0] as string
  await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), account))
  const firstChat = JSON.parse(requests.find(request => request.url.endsWith('/api/v1/chat/completions'))?.body ?? '{}') as Record<string, unknown>
  assert.equal(
    (firstChat.codebuff_metadata as Record<string, unknown>).freebuff_instance_id,
    '8fe895f8-43fc-4f4a-41e3-971277cdf538',
    'the turn speaks for the instance the upstream assigned',
  )
  assert.equal((firstChat.codebuff_metadata as Record<string, unknown>).surface, undefined,
    'no cli: prefix means no cli surface fields')
  await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), account))
  const admissions = requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission'))
  assert.equal(admissions.length, 2)
  assert.match(admissions[1]?.headers.get('x-freebuff-instance-id') ?? '', /^cli:/,
    'the next turn mints its own attempt again, because that id is not a claim')
})

test('freebuff adapter: a release that a fresh attempt cannot fix is reported as the state, with the remedy', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      admission: () => new Response(LIVE_ADMISSION_RELEASED, { status: 409 }),
    }),
  })
  freebuffRecordClaim(SESSION.accessToken, {
    instanceId: 'cli:be2239fd-b67f-4b2e-a882-1988e6b05484',
    model: 'stealth/space-bunny-alpha',
    expiresAt: Date.now() + 3_600_000,
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError
      && error.code === 'HTTP_409'
      && /purchase_claim_released/.test(error.message)
      && /already opened a NEW attempt/.test(error.message)
      && /Choose a model to start a new session/.test(error.message),
  )
  assert.equal(requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission')).length, 2,
    'exactly one retry — never a loop against a refused state')
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/chat/completions')), false)
})

test('freebuff adapter: a cancelled attempt is replaced the same way', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      admission: call => call === 0
        ? new Response(LIVE_ATTEMPT_CLOSED, { status: 409 })
        : new Response('{"status":"active","accessTier":"limited"}', { status: 200 }),
    }),
  })
  const chunks = await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string))
  assert.equal(chunks.length > 0, true)
  assert.equal(requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission')).length, 2)
})

test('freebuff adapter: the second turn re-admits the SAME attempt — no permanent burn', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      // The upstream echoes the attempt it admitted, which is what a real answer
      // does (live 2026-09-29: `"instanceId":"cli:<the one we sent>"`).
      admission: (_call, headers) => admissionActiveFor(headers.get('x-freebuff-instance-id') ?? ''),
    }),
  })
  const account = [...sessions.keys()][0] as string
  await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), account))
  await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), account))

  const admissions = requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission'))
  assert.equal(admissions.length, 2, 'one admission per turn')
  const first = admissions[0]?.headers.get('x-freebuff-instance-id')
  const second = admissions[1]?.headers.get('x-freebuff-instance-id')
  // The CLI keeps ONE instance for the session's life and heartbeats it; the
  // re-admission of a live instance is idempotent upstream, so the second turn
  // must not mint a third attempt (a second live attempt is refused with
  // `purchase_capacity` — reproduced live).
  assert.equal(second, first)
  assert.equal(requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/attempt')).length, 0,
    'nothing is released while the claim is the same model')
  assert.equal(requests.filter(request => request.url.endsWith('/api/v1/chat/completions')).length, 2)
})

test('freebuff adapter: a MODEL change ends the held claim first, then admits a fresh attempt', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      admission: (_call, headers) => admissionActiveFor(
        headers.get('x-freebuff-instance-id') ?? '',
        headers.get('x-freebuff-model') ?? '',
      ),
    }),
  })
  const account = [...sessions.keys()][0] as string
  await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), account))
  await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), account))

  const released = requests.find(request => request.url.endsWith('/api/v1/freebuff/session/attempt'))
  assert.equal(released?.method, 'DELETE', 'the CLI’s own releaseSlot() is a DELETE to …/session/attempt')
  const admissions = requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission'))
  const first = admissions[0]?.headers.get('x-freebuff-instance-id')
  const second = admissions[1]?.headers.get('x-freebuff-instance-id')
  assert.equal(released?.headers.get('x-freebuff-instance-id'), first, 'the DELETE names the claim being released')
  assert.notEqual(second, first, 'a session binds one model, so the switch opens a new attempt (the CLI’s `J=wr()`)')
  // And the release happens BEFORE the new attempt, because a new attempt minted
  // while the old claim is live is refused with `purchase_capacity`.
  assert.deepEqual(requests.map(request => request.url.replace(`${FREEBUFF_API_BASE}`, '')), [
    `${FREEBUFF_SESSION_ADMISSION_PATH}`,
    '/api/v1/agent-runs',
    `${FREEBUFF_CHAT_PATH}`,
    `${FREEBUFF_SESSION_ATTEMPT_PATH}`,
    `${FREEBUFF_SESSION_ADMISSION_PATH}`,
    '/api/v1/agent-runs',
    `${FREEBUFF_CHAT_PATH}`,
  ])
})

test('freebuff adapter: a release the upstream does not confirm refuses the model switch, in the CLI own words', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      admission: (_call, headers) => admissionActiveFor(
        headers.get('x-freebuff-instance-id') ?? '',
        headers.get('x-freebuff-model') ?? '',
      ),
      attempt: () => new Response('{"status":"purchase_capacity"}', { status: 409 }),
    }),
  })
  const account = [...sessions.keys()][0] as string
  await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), account))
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), account)),
    (error: unknown) => error instanceof LlmError
      && error.code === 'HTTP_409'
      && /could not end the stealth\/space-bunny-alpha session/.test(error.message)
      && /the switch to z-ai\/glm-5\.3-flash was not applied/.test(error.message)
      && /\/end-session/.test(error.message),
  )
  // No second admission was attempted: without the release there is no room for it.
  assert.equal(requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission')).length, 1)
})

test('freebuff adapter: a held slot is NOT retried with a fresh attempt, and names the holder', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      admission: () => new Response(LIVE_SLOT_HELD, { status: 409 }),
    }),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError
      && error.code === 'HTTP_409'
      && /only free slot/.test(error.message)
      && /holder instance cli:d3f6d4d6-7dcc-4399-87b9-ec75b42a8f37/.test(error.message),
  )
  // ONE POST: a fresh attempt against a held slot is refused the same way (live
  // 2026-09-29, `purchase_capacity` naming the holder), so retrying would only
  // hammer the upstream.
  assert.equal(requests.filter(request => request.url.endsWith('/api/v1/freebuff/session/admission')).length, 1)
  // Nothing downstream of the admission was attempted.
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/chat/completions')), false)
  // And a held slot is never "released": the route must not end a session it does
  // not own (the CLI's remedy for this state is an interactive takeover).
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/freebuff/session/attempt')), false)
})

test('freebuff adapter: a run bootstrap without a runId is a malformed answer, not a chat', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, { run: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError && error.code === 'MALFORMED_RESPONSE' && /runId/.test(error.message),
  )
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/chat/completions')), false)
})

test('freebuff adapter: a cookie session never reaches the wire', async () => {
  const requests: MadeRequest[] = []
  const sessions = new Map<string, FreebuffSession>([['cookie-account', {
    accessToken: 'sess-value-123456',
    refreshToken: 'sess-value-123456',
    expiresAt: Date.now() + 3_600_000,
    cookie: `${FREEBUFF_SESSION_COOKIE}=sess-value-123456`,
  }]])
  const adapter = new FreebuffAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(sessions),
    discovery: false,
    fetchFn: bootstrapFetch(requests),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), 'cookie-account')),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED'
      && /cookie credentials are no longer accepted/.test(error.message),
  )
  assert.deepEqual(requests, [], 'not one request goes out for a cookie credential')
})

test('freebuff adapter: the desktop body carries tools and tool turns unchanged', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({ fetchFn: bootstrapFetch(requests) })
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
  const body = JSON.parse(requests.at(-1)?.body ?? '{}') as Record<string, unknown>
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

test('freebuff adapter: an image rides the desktop body inline', async () => {
  const requests: MadeRequest[] = []
  // A mounted attachment store, so `resolveImages` gets past its own
  // missing-service check and the image under test is the one that is carried.
  const attachments = {
    readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) }),
  } as unknown as AttachmentStore
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests),
    resolveAttachments: () => attachments,
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
  await collect(adapter.streamAccount(options, [...sessions.keys()][0] as string))
  const body = JSON.parse(requests.at(-1)?.body ?? '{}') as { messages: { content: unknown }[] }
  const content = body.messages[0]?.content
  assert.equal(Array.isArray(content), true, 'the desktop protocol takes content PARTS, images included')
})

test('freebuff adapter: a 401 from upstream is an AUTH failure', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, { chat: () => new Response('', { status: 401 }) }),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH' && error.failure.status === 401,
  )
})

test('freebuff adapter: a 200 refusal surfaces the upstream own words', async () => {
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      chat: () => new Response(JSON.stringify({
        error: { message: 'free mode is paused for this account', code: 'free_mode_invalid' },
      }), { status: 200 }),
    }),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('z-ai/glm-5.3-flash'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError && /free mode is paused for this account/.test(error.message),
  )
})

test('freebuff adapter: the free_mode_cli_required gate reaches the caller verbatim', async () => {
  // The live 2026-09-28 answer for a real free CLI credential, byte for byte.
  const requests: MadeRequest[] = []
  const { adapter, sessions } = adapterOf({
    fetchFn: bootstrapFetch(requests, {
      chat: () => new Response(JSON.stringify({
        error: 'free_mode_cli_required',
        message: 'Free mode is only available through the freebuff CLI. Install it with `npm i -g freebuff`, then run '
          + '`freebuff`. Calling the API directly is not supported and may get your account banned.',
      }), { status: 403 }),
    }),
  })
  await assert.rejects(
    async () => await collect(adapter.streamAccount(generateOptions('stealth/space-bunny-alpha'), [...sessions.keys()][0] as string)),
    (error: unknown) => error instanceof LlmError
      && error.code === 'UNSUPPORTED'
      && /may get your account banned/.test(error.message),
  )
})

test('freebuff: session validation accepts a credential and reports its plan', async () => {
  const requests: MadeRequest[] = []
  const identity = await validateFreebuffCredential({ accessToken: 'token-value' }, (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: '', headers: new Headers(init?.headers) })
    return Promise.resolve(new Response(JSON.stringify({
      accessTier: 'free',
      freebucks: { daily: { limit: 10, remaining: 7 }, planId: 'plan_free' },
    }), { status: 200 }))
  })
  assert.equal(identity.token, 'token-value')
  // Precedence is the reference's: `subscription.tierId`, then `freebucks.planId`,
  // then the access tier (`src/api.rs:5660-5670` reads the subscription first).
  assert.equal(identity.plan, 'plan_free')
  // And the validation IS the quota read: one GET, with the CLI keepalive flags.
  assert.deepEqual(requests.map(request => request.url), [`${FREEBUFF_API_BASE}/api/v1/freebuff/session`])
  assert.equal(requests[0]?.headers.get('x-freebuff-heartbeat'), '1')
  assert.equal(requests[0]?.headers.get('x-freebuff-include-unused-rate-limits'), '1')
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
    'Bearer pasted-token-value-123456',
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

test('freebuff: an import supplies the display name the endpoint does not return', async () => {
  const session = await freebuffSessionFromBearer('cli-token-value-123456', async () => new Response(JSON.stringify({
    accessTier: 'limited',
    freebucks: { daily: { limit: 25, spent: 15, remaining: 10 } },
  }), { status: 200 }), undefined, { account: 'person@example.com' })
  assert.equal(session.account, 'person@example.com')
  assert.equal(session.plan, 'limited')
  // A refresh re-validates and keeps the identity it cannot re-read.
  const refreshed = await refreshFreebuffSession(
    { ...session, expiresAt: 0 },
    async () => new Response(JSON.stringify({ accessTier: 'limited', freebucks: { daily: { remaining: 9 } } }), { status: 200 }),
  )
  assert.equal(refreshed.expiresAt > Date.now(), true)
  assert.equal(refreshed.account, 'person@example.com')
  assert.deepEqual(freebuffCredentialOf(refreshed), { accessToken: session.accessToken })
})

// ---------- the CLI credential import and the CLI's own browser login ----------

/** A home directory with a CLI credential file, for discovery tests. */
function tempHome(contents: string | undefined): { home: string, cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'freebuff-cli-'))
  const dir = join(home, '.config', 'manicode')
  mkdirSync(dir, { recursive: true })
  if (contents !== undefined) writeFileSync(join(dir, FREEBUFF_CLI_CREDENTIALS_FILE), contents, 'utf8')
  return { home, cleanup: () => { rmSync(home, { recursive: true, force: true }) } }
}

test('freebuff CLI: the credential path is the launcher\'s own convention', () => {
  assert.deepEqual(freebuffCliCredentialPaths('/home/tester', {}), [
    join('/home/tester', '.config', 'manicode', 'credentials.json'),
  ])
  // Windows is NOT special-cased: the launcher computes the same
  // `.config/manicode` under `os.homedir()` on every platform, which is why a
  // check for a Windows-style path would look in the wrong place.
  assert.deepEqual(freebuffCliCredentialPaths('C:\\Users\\tester', {}), [
    'C:\\Users\\tester\\.config\\manicode\\credentials.json',
  ])
  // And the documented override wins when set, without hiding the default.
  assert.deepEqual(freebuffCliCredentialPaths('/home/tester', { MANICODE_CONFIG_DIR: '/opt/manicode' }), [
    join('/opt/manicode', 'credentials.json'),
    join('/home/tester', '.config', 'manicode', 'credentials.json'),
  ])
})

test('freebuff CLI: the credential file parses to its DEFAULT entry', () => {
  const parsed = parseFreebuffCliCredentials(JSON.stringify({
    default: {
      id: '9aadeb0d-86d1-4272-8fa7-8661bfb7617c',
      name: 'dai pingshui',
      email: 'person@example.com',
      authToken: 'x'.repeat(36),
      fingerprintId: 'enhanced-abc',
      fingerprintHash: 'hash',
    },
    work: { email: 'other@example.com', authToken: 'y'.repeat(36) },
  }))
  assert.equal(parsed?.entry.email, 'person@example.com')
  assert.equal(parsed?.entry.authToken, 'x'.repeat(36))
  assert.equal(parsed?.entry.fingerprintId, 'enhanced-abc')
  // Every profile is reported, so the import can say it took `default` alone.
  assert.deepEqual(parsed?.profiles, ['default', 'work'])
  // The CLI's schema requires email AND authToken; a file missing either is not a
  // credential, and a file with no `default` is a named-profile file.
  assert.equal(parseFreebuffCliCredentials(JSON.stringify({ default: { authToken: 'z'.repeat(36) } })), undefined)
  assert.equal(parseFreebuffCliCredentials(JSON.stringify({ work: { email: 'a@b.c', authToken: 'z'.repeat(36) } })), undefined)
  assert.equal(parseFreebuffCliCredentials('not json'), undefined)
  assert.equal(parseFreebuffCliCredentials('[]'), undefined)
})

test('freebuff CLI: the import reads the file, validates the token and stores the email', async () => {
  const { home, cleanup } = tempHome(JSON.stringify({
    default: { email: 'person@example.com', authToken: 'cli-token-value-123456' },
  }))
  try {
    const urls: string[] = []
    const session = await importFreebuffCliCredential(async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ accessTier: 'limited', freebucks: { planId: 'free' } }), { status: 200 })
    }, undefined, { homeDir: home, env: {} })
    assert.equal(session.accessToken, 'cli-token-value-123456')
    assert.equal(session.account, 'person@example.com')
    // The import validates before storing: one read, against the balance endpoint.
    assert.deepEqual(urls, [`${FREEBUFF_API_BASE}/api/v1/freebuff/session`])
  } finally {
    cleanup()
  }
})

test('freebuff CLI: a second profile is imported as `default` alone, and says so', async () => {
  const { home, cleanup } = tempHome(JSON.stringify({
    default: { email: 'person@example.com', authToken: 'cli-token-value-123456' },
    work: { email: 'other@example.com', authToken: 'other-token-value-123456' },
  }))
  try {
    const warnings: string[] = []
    const session = await importFreebuffCliCredential(
      async () => new Response(JSON.stringify({ accessTier: 'limited' }), { status: 200 }),
      undefined,
      { homeDir: home, env: {}, onWarn: message => warnings.push(message) },
    )
    assert.equal(session.account, 'person@example.com', 'the default entry is the one imported')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /2 profiles \(default, work\)/)
    assert.match(warnings[0] ?? '', /imported `default` only/)
  } finally {
    cleanup()
  }
})

test('freebuff CLI: a missing or unusable file names every probed path', async () => {
  const { home, cleanup } = tempHome(undefined)
  try {
    const probed = freebuffCliCredentialPaths(home, {})
    await assert.rejects(
      async () => await importFreebuffCliCredential(async () => new Response('{}', { status: 200 }), undefined, { homeDir: home, env: {} }),
      (error: unknown) => error instanceof LlmError
        && error.code === 'MISSING_CREDENTIAL'
        && error.message.includes(probed[0] ?? '')
        && /Run `freebuff` and log in/.test(error.message),
    )
  } finally {
    cleanup()
  }
  // A file that exists but holds no usable entry reports that too.
  const broken = tempHome('{}')
  try {
    await assert.rejects(
      async () => await importFreebuffCliCredential(async () => new Response('{}', { status: 200 }), undefined, { homeDir: broken.home, env: {} }),
      (error: unknown) => error instanceof LlmError
        && error.code === 'MISSING_CREDENTIAL'
        && /no usable `default` entry/.test(error.message),
    )
  } finally {
    broken.cleanup()
  }
  // And the refusal names the ways to get one instead.
  const message = freebuffCliFailureMessage(['C:\\a\\credentials.json'])
  assert.match(message, /C:\\a\\credentials\.json/)
  assert.match(message, /`freebuff` and log in/)
  assert.match(message, /Sign in/)
})

test('freebuff CLI: the login code/status flow is the CLI\'s polling one', async () => {
  const calls: { url: string, method: string, body: string }[] = []
  let polls = 0
  const login = await startFreebuffCliLogin({
    fingerprintId: 'codebuff-cli-abcdefgh',
    pollMs: 0,
    timeoutMs: 5_000,
    fetchFn: async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      if (url === freebuffCliCodeUrl()) {
        return new Response(JSON.stringify({
          loginUrl: 'https://freebuff.com/cli/login?code=abc',
          fingerprintHash: 'hash-1',
          expiresAt: '2026-09-28T12:00:00.000Z',
        }), { status: 200 })
      }
      if (url.includes('/api/auth/cli/status')) {
        polls += 1
        // The first poll is "not finished yet": a 200 whose body carries no `user`.
        if (polls === 1) return new Response('{}', { status: 200 })
        // The second carries the credential, exactly as the CLI reads it.
        return new Response(JSON.stringify({
          user: { id: 'u-1', email: 'person@example.com', authToken: 'cli-token-value-123456' },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ accessTier: 'limited' }), { status: 200 })
    },
  })
  assert.equal(login.authorizeUrl, 'https://freebuff.com/cli/login?code=abc')
  assert.equal(login.probe.fingerprintHash, 'hash-1')
  const session = await login.session
  assert.equal(session.accessToken, 'cli-token-value-123456')
  assert.equal(session.account, 'person@example.com')
  assert.equal(calls[0]?.url, freebuffCliCodeUrl())
  assert.equal(calls[0]?.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { fingerprintId: 'codebuff-cli-abcdefgh' })
  // The status poll carries the CLI's own query set, and the credential read
  // follows it.
  assert.equal(calls[1]?.url, freebuffCliStatusUrl(login.probe))
  assert.match(calls[1]?.url ?? '', /fingerprintId=codebuff-cli-abcdefgh/)
  assert.match(calls[1]?.url ?? '', /fingerprintHash=hash-1/)
  assert.match(calls[1]?.url ?? '', /expiresAt=2026-09-28T12%3A00%3A00.000Z/)
  assert.equal(calls[2]?.url, freebuffCliStatusUrl(login.probe))
  assert.equal(calls[3]?.url, `${FREEBUFF_API_BASE}/api/v1/freebuff/session`)
})

test('freebuff CLI: a login URL request that is refused does not start a poll', async () => {
  let calls = 0
  await assert.rejects(
    async () => await startFreebuffCliLogin({
      fingerprintId: 'codebuff-cli-abcdefgh',
      fetchFn: async () => { calls += 1; return new Response('nope', { status: 500 }) },
    }),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER'
      && /the CLI login URL request failed/.test(error.message),
  )
  assert.equal(calls, 1)
})

test('freebuff CLI: the fingerprint is the CLI fallback shape, not a fabricated device id', () => {
  const fingerprint = freebuffCliFingerprintId(() => Buffer.from('0123456789ab', 'hex'))
  assert.match(fingerprint, /^codebuff-cli-[A-Za-z0-9_-]{8}$/)
  // Deterministic for a fixed draw, which is what makes it testable; the real
  // call draws fresh randomness each time.
  assert.equal(fingerprint, freebuffCliFingerprintId(() => Buffer.from('0123456789ab', 'hex')))
  assert.notEqual(fingerprint, freebuffCliFingerprintId(() => Buffer.from('ba9876543210', 'hex')))
})

test('freebuff CLI: a login the user cancels rejects instead of hanging', async () => {
  const login = await startFreebuffCliLogin({
    fingerprintId: 'codebuff-cli-abcdefgh',
    pollMs: 5_000,
    fetchFn: async (input) => String(input) === freebuffCliCodeUrl()
      ? new Response(JSON.stringify({ loginUrl: 'https://freebuff.com/x', fingerprintHash: 'h' }), { status: 200 })
      : new Response('{}', { status: 200 }),
  })
  login.close()
  await assert.rejects(async () => await login.session, (error: unknown) =>
    error instanceof Error && error.message === 'login cancelled')
})

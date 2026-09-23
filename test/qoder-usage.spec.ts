/**
 * The quota, plan and status reads, and their projection onto `ProviderUsage`.
 *
 * Golden fixtures ported from the reference's `tests/qoder/usage.test.ts`. The
 * two behaviours most worth pinning are the ones the reference had to discover
 * live: the organization package reports a `cap` and a `remaining` but no
 * `total` (so the total is derived), and `percentage` arrives as a 0–1 ratio
 * (so `0.03` means 3%). Both would otherwise render a bar that is off by a
 * hundredfold or short of its cap.
 */

import './keep-alive.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { QoderAuthService } from '../src/providers/qoder/auth.js'
import {
  normalizeQoderExpiresAt,
  normalizeQoderPlan,
  normalizeQoderQuota,
  normalizeQoderStatus,
  qoderProviderUsage,
  QoderUsageReader,
} from '../src/providers/qoder/usage.js'
import type { QoderAccountInfo } from '../src/providers/qoder/usage.js'

function usageFetch(handlers: Record<string, (input: URL | Request, init?: RequestInit) => Promise<Response>>): typeof fetch {
  return (async (input: URL | Request, init?: RequestInit) => {
    const url = String(input)
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) return handler(input, init)
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch
}

const tokenExchange = (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify({ token: 'jt-quota-test', expires_in: 3_600_000 }), { status: 200 }))
const userInfo = (id = 'user-123', name = 'Qoder Dev', email = 'dev@qoder.sh'): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify({ id, name, email })))

test('QoderUsageReader reads subscriber profile and quota usage, and caches within TTL', async () => {
  let quotaCalls = 0
  const diagnostics: string[] = []
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => tokenExchange(),
    '/userinfo': () => userInfo(),
    '/quota/usage': () => {
      quotaCalls++
      return Promise.resolve(new Response(
        JSON.stringify({
          userId: 'user-123',
          userType: 'teams',
          totalUsagePercentage: 0.03,
          isQuotaExceeded: false,
          expiresAt: 1790756471159,
          userQuota: {
            total: 3000.0,
            used: 84.0,
            remaining: 2916.0,
            percentage: 0.03,
            unit: 'credits',
          },
          orgResourcePackage: {
            used: 0.0,
            remaining: 3000.0,
            percentage: 0.0,
            unit: 'credits',
            cap: 3000.0,
            available: true,
          },
        }),
        { status: 200 },
      ))
    },
  })

  const authService = new QoderAuthService({
    fetchFn: fetchMock,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({
    authService,
    fetchFn: fetchMock,
    ttlMs: 60_000,
    logger: {
      debug: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
    },
  })

  const first = await reader.readAccount('pt-test')
  assert.equal(first.profile.id, 'user-123')
  assert.equal(first.profile.name, 'Qoder Dev')
  assert.equal(first.profile.email, 'dev@qoder.sh')
  assert.equal(first.usage?.userQuota?.total, 3000)
  assert.equal(first.usage?.userQuota?.used, 84)
  assert.equal(first.usage?.userQuota?.remaining, 2916)
  assert.equal(first.usage?.userQuota?.percentage, 3)
  // The organization package reports a cap and no total.
  assert.equal(first.usage?.orgResourcePackage?.total, 3000)
  assert.equal(first.usage?.orgResourcePackage?.used, 0)
  assert.equal(first.usage?.orgResourcePackage?.remaining, 3000)
  assert.equal(first.usage?.expiresAt, new Date(1790756471159).toISOString())
  assert.equal(first.usage?.isQuotaExceeded, false)
  assert.equal(quotaCalls, 1)
  assert.match(diagnostics.join('\n'), /account\.usage/u)

  // Cache hit
  const second = await reader.readAccount('pt-test')
  assert.equal(second, first)
  assert.equal(quotaCalls, 1)

  // Force refresh
  const third = await reader.readAccount('pt-test', { force: true })
  assert.equal(quotaCalls, 2)
  assert.equal(third.profile.name, 'Qoder Dev')
})

test('QoderUsageReader maps the credit packages onto the hub usage shape', async () => {
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => tokenExchange(),
    '/userinfo': () => userInfo(),
    '/quota/usage': () => Promise.resolve(new Response(JSON.stringify({
      userQuota: { total: 3000, used: 84, remaining: 2916, percentage: 0.03, unit: 'credits' },
      addOnQuota: { total: 100, used: 100, remaining: 0, unit: 'credits' },
      orgResourcePackage: { cap: 3000, used: 0, remaining: 3000, unit: 'credits' },
      expiresAt: 1790756471159,
    }))),
    '/user/plan': () => Promise.resolve(new Response(JSON.stringify({ user_type: 'pro', plan_tier_name: 'Pro' }))),
    '/user/status': () => Promise.resolve(new Response(JSON.stringify({ featureSwitches: { allow_byok: 1 } }))),
  })
  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })

  const usage = qoderProviderUsage(await reader.readAccount('pt-mapped'))
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'Pro')
  assert.deepEqual(usage.windows, [
    { kind: 'other', scope: 'plan', usedPercent: 3, remaining: 2916, limit: 3000, used: 84, resetsAt: 1790756471159 },
    { kind: 'other', scope: 'org', usedPercent: 0, remaining: 3000, limit: 3000, used: 0, resetsAt: 1790756471159 },
    { kind: 'other', scope: 'add-on', usedPercent: 100, remaining: 0, limit: 100, used: 100, resetsAt: 1790756471159 },
  ])
  assert.equal(usage.remaining, 5916)
  assert.equal(usage.limit, 6100)
})

test('qoderProviderUsage clamps a wild upstream percentage rather than rendering past the bar', () => {
  const account: QoderAccountInfo = {
    profile: { id: 'u', name: 'U', email: '' },
    usage: { userQuota: { total: 10, used: 40, remaining: 0, percentage: 400, unit: 'credits' } },
    updatedAt: new Date().toISOString(),
  }
  assert.equal(qoderProviderUsage(account).windows?.[0]?.usedPercent, 100)
})

test('qoderProviderUsage reports unsupported when there is nothing to show', () => {
  assert.deepEqual(qoderProviderUsage({ profile: { id: 'u', name: 'U', email: '' }, updatedAt: '' }), { supported: false })
  assert.deepEqual(qoderProviderUsage({
    profile: { id: 'u', name: 'U', email: '' },
    usage: {},
    updatedAt: '',
  }), { supported: false })
})

test('QoderUsageReader surfaces quota failures and does not cache them', async () => {
  let quotaCalls = 0
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => tokenExchange(),
    '/userinfo': () => userInfo('user-456', 'Error Case', 'error@qoder.sh'),
    '/quota/usage': () => {
      quotaCalls++
      return Promise.resolve(new Response(JSON.stringify({ message: 'Internal Server Error' }), { status: 500 }))
    },
  })

  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })

  await assert.rejects(reader.readAccount('pt-error-test'), (error: Error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'SERVER')
    assert.equal(error.failure.status, 500)
    return true
  })
  await assert.rejects(reader.readAccount('pt-error-test'))
  // Each attempt costs one quota read plus the retry helper's single retry.
  assert.equal(quotaCalls, 4)
})

test('QoderUsageReader propagates caller cancellation and does not cache the partial account', async () => {
  let quotaCalls = 0
  let quotaCanSucceed = false
  let notifyUsageStarted: (() => void) | undefined
  const usageStarted = new Promise<void>(resolve => { notifyUsageStarted = resolve })
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => Promise.resolve(new Response(JSON.stringify({ token: 'jt-abort-test', expires_in: 3_600_000 }))),
    '/userinfo': () => Promise.resolve(new Response(JSON.stringify({ id: 'user-abort', name: 'Abort Case' }))),
    '/quota/usage': (_input, init) => {
      quotaCalls++
      if (quotaCanSucceed) {
        return Promise.resolve(new Response(JSON.stringify({ userQuota: { total: 10, used: 1, remaining: 9, unit: 'credits' } })))
      }
      notifyUsageStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    },
  })
  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })
  const controller = new AbortController()
  const request = reader.readAccount('pt-abort-test', { signal: controller.signal })
  await usageStarted
  controller.abort()

  await assert.rejects(request, (error: Error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'ABORTED')
    return true
  })

  quotaCanSucceed = true
  const retry = await reader.readAccount('pt-abort-test')
  assert.equal(retry.usage?.userQuota?.remaining, 9)
  assert.equal(quotaCalls, 2)
})

test('QoderUsageReader bounds a stalled quota request with its own timeout', async () => {
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => Promise.resolve(new Response(JSON.stringify({ token: 'jt-timeout-test', expires_in: 3_600_000 }))),
    '/userinfo': () => Promise.resolve(new Response(JSON.stringify({ id: 'user-timeout', name: 'Timeout Case' }))),
    '/quota/usage': (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true })
    }),
  })
  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock, timeoutMs: 5 })

  await assert.rejects(reader.readAccount('pt-timeout-test'), (error: Error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
})

test('QoderUsageReader shares a concurrent quota cache miss', async () => {
  let quotaCalls = 0
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => Promise.resolve(new Response(JSON.stringify({ token: 'jt-shared' }))),
    '/userinfo': () => Promise.resolve(new Response(JSON.stringify({ id: 'user-shared' }))),
    '/quota/usage': async () => {
      quotaCalls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return new Response(JSON.stringify({ userQuota: { total: 10, used: 1, remaining: 9 } }))
    },
  })
  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })

  const [first, second] = await Promise.all([
    reader.readAccount('pt-shared'),
    reader.readAccount('pt-shared'),
  ])
  assert.equal(quotaCalls, 1)
  assert.equal(first, second)
})

test('QoderUsageReader reads subscriber plan and user status with machine fingerprint headers', async () => {
  let statusHeaders: Record<string, string> | undefined
  let planHeaders: Record<string, string> | undefined
  let quotaHeaders: Record<string, string> | undefined
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => Promise.resolve(new Response(JSON.stringify({ token: 'jt-plan-test', expires_in: 3_600_000 }))),
    '/userinfo': () => Promise.resolve(new Response(JSON.stringify({ id: 'user-plan-1', email: 'pro@qoder.sh', name: 'Pro Dev' }))),
    '/quota/usage': (_input, init) => {
      quotaHeaders = init?.headers as Record<string, string>
      return Promise.resolve(new Response(JSON.stringify({ userQuota: { total: 100, used: 20, remaining: 80, unit: 'credits' } })))
    },
    '/user/plan': (_input, init) => {
      planHeaders = init?.headers as Record<string, string>
      return Promise.resolve(new Response(JSON.stringify({
        user_type: 'pro',
        plan_tier_name: 'Pro',
        is_personal_version: false,
        is_highest_tier: true,
        start_date: 1700000000000,
        end_date: 1735689600000,
        organization: {
          org_id: 'org-456',
          org_name: 'DeepSeek Harness Team',
          role_name: 'Owner',
          is_suspended: false,
          can_manage_subscriptions: true,
          resource_package_feature_enabled: true,
        },
        feature_allowed: {
          quest: true,
          wiki: true,
          code_review: true,
        },
      })))
    },
    '/user/status': (_input, init) => {
      statusHeaders = init?.headers as Record<string, string>
      return Promise.resolve(new Response(JSON.stringify({
        featureSwitches: { allow_byok: 2 },
        teamSwitches: { allow_byok: 2 },
        isPrivacyPolicyModifiable: true,
      })))
    },
  })

  const authService = new QoderAuthService({
    fetchFn: fetchMock,
    resolveMachineId: () => 'umid-fingerprint-test',
  })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })

  const account = await reader.readAccount('pt-full-test')
  assert.equal(account.profile.name, 'Pro Dev')
  assert.equal(account.plan?.userType, 'pro')
  assert.equal(account.plan?.planTierName, 'Pro')
  assert.equal(account.plan?.isPersonalVersion, false)
  assert.equal(account.plan?.isHighestTier, true)
  assert.equal(account.plan?.organization?.orgName, 'DeepSeek Harness Team')
  assert.equal(account.plan?.organization?.isSuspended, false)
  assert.equal(account.plan?.featureAllowed?.codeReview, true)
  assert.equal(account.plan?.startDate, new Date(1700000000000).toISOString())

  assert.equal(account.status?.allowByok, 2)
  assert.equal(account.status?.teamAllowByok, 2)
  assert.equal(account.status?.isPrivacyPolicyModifiable, true)

  assert.equal(planHeaders?.authorization, 'Bearer jt-plan-test')
  assert.equal(statusHeaders?.authorization, 'Bearer jt-plan-test')
  assert.equal(statusHeaders?.['Cosy-MachineToken'], 'umid-fingerprint-test')
  assert.equal(statusHeaders?.['Cosy-MachineType'], 'host')
  assert.equal(planHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(statusHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(quotaHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(planHeaders?.['cosy-clienttype'], '5')
  assert.equal(statusHeaders?.['cosy-clienttype'], '5')
  assert.equal(quotaHeaders?.['cosy-clienttype'], '5')
})

test('QoderUsageReader degrades gracefully when plan or status endpoint returns error', async () => {
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => Promise.resolve(new Response(JSON.stringify({ token: 'jt-degrade-test', expires_in: 3_600_000 }))),
    '/userinfo': () => Promise.resolve(new Response(JSON.stringify({ id: 'user-deg', email: 'deg@qoder.sh', name: 'Degrading Dev' }))),
    '/quota/usage': () => Promise.resolve(new Response(JSON.stringify({ userQuota: { total: 50, used: 10, remaining: 40, unit: 'credits' } }))),
    '/user/plan': () => Promise.resolve(new Response(JSON.stringify({ error: 'Plan service unavailable' }), { status: 503 })),
    '/user/status': () => Promise.resolve(new Response(JSON.stringify({ error: 'Status not found' }), { status: 404 })),
  })

  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-deg' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })

  const account = await reader.readAccount('pt-degrade-test')
  assert.equal(account.profile.name, 'Degrading Dev')
  assert.equal(account.usage?.userQuota?.remaining, 40)
  assert.equal(account.plan, undefined)
  assert.equal(account.status, undefined)
  // The plan/status degradation does not blank the card.
  assert.equal(qoderProviderUsage(account).supported, true)
})

test('QoderUsageReader re-exchanges a job token the upstream rejects, once', async () => {
  let exchanges = 0
  let usageCalls = 0
  const fetchMock = usageFetch({
    '/jobToken/exchange': () => {
      exchanges++
      return Promise.resolve(new Response(JSON.stringify({ token: `jt-${exchanges}`, expires_in: 3_600_000 })))
    },
    '/userinfo': () => Promise.resolve(new Response(JSON.stringify({ id: `user-${exchanges}` }))),
    '/quota/usage': () => {
      usageCalls++
      return Promise.resolve(usageCalls === 1
        ? new Response('', { status: 401 })
        : new Response(JSON.stringify({ userQuota: { total: 300, used: 0, remaining: 300 } })))
    },
  })
  const authService = new QoderAuthService({ fetchFn: fetchMock, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetchFn: fetchMock })

  const account = await reader.readAccount('pt-reauth')
  assert.equal(usageCalls, 2)
  assert.equal(exchanges, 2)
  assert.equal(account.usage?.userQuota?.total, 300)
})

test('the quota normalizer reads a bare cap, a bare ratio, and a missing unit', () => {
  assert.deepEqual(normalizeQoderQuota({ cap: 500, used: 100 }), {
    total: 500, used: 100, remaining: 400, percentage: 20, unit: 'credits',
  })
  // Already a percentage, not a ratio: a total of 1 cannot disambiguate, so the
  // value is trusted as-is.
  assert.equal(normalizeQoderQuota({ total: 1, used: 1, percentage: 0.5 })?.percentage, 0.5)
  assert.equal(normalizeQoderQuota({ total: 10, used: 5, unit: '' })?.unit, 'credits')
  assert.equal(normalizeQoderQuota(undefined), undefined)
})

test('the plan and status normalizers accept both the snake and camel spellings', () => {
  assert.equal(normalizeQoderPlan({ userType: 'pro', planTierName: 'Pro' })?.planTierName, 'Pro')
  assert.equal(normalizeQoderPlan({ user_type: 'pro' }), undefined)
  // A personal account with no organization block is the personal version.
  assert.equal(normalizeQoderPlan({ user_type: 'pro', plan_tier_name: 'Pro' })?.isPersonalVersion, true)
  assert.equal(normalizeQoderStatus({ feature_switches: { allowByok: '2' } })?.allowByok, 2)
  // An object that discloses nothing still normalizes (defaulting allowByok to
  // 0); only a non-object is unusable.
  assert.deepEqual(normalizeQoderStatus({}), { allowByok: 0, raw: {} })
  assert.equal(normalizeQoderStatus('nope'), undefined)
})

test('the expiry normalizer accepts epoch milliseconds and date strings only', () => {
  assert.equal(normalizeQoderExpiresAt(1790756471159), new Date(1790756471159).toISOString())
  assert.equal(normalizeQoderExpiresAt('2047-03-01T00:00:00Z'), '2047-03-01T00:00:00.000Z')
  assert.equal(normalizeQoderExpiresAt(0), undefined)
  assert.equal(normalizeQoderExpiresAt('not a date'), undefined)
  assert.equal(normalizeQoderExpiresAt(undefined), undefined)
})

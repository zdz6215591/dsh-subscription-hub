/**
 * The PAT → job-token lifecycle.
 *
 * Four properties are pinned here, each one a defect if lost: the exchange
 * happens ONCE per (region, PAT) however many callers ask; a departing waiter
 * cannot cancel the exchange the others are still waiting on; a caller's own
 * cancellation settles promptly and DOES abort an unobserved exchange; and the
 * diagnostics never carry the credential.
 */

import './keep-alive.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QoderAuthService } from '../src/providers/qoder/auth.js'
import { LlmError } from '@deepseek-ai/dsh-llm'

test('QoderAuthService exchanges once, resolves identity, and caches credentials', async () => {
  let exchangeCalls = 0
  let userInfoCalls = 0
  let exchangeHeaders: Record<string, string> | undefined
  let userInfoHeaders: Record<string, string> | undefined
  const fetchMock = async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      exchangeCalls++
      exchangeHeaders = init?.headers as Record<string, string>
      assert.deepEqual(JSON.parse(String(init?.body)), { personal_token: 'pt-test-token' })
      return new Response(JSON.stringify({ token: 'jt-token', expires_in: 3_600_000 }), { status: 200 })
    }
    if (url.includes('/userinfo')) {
      userInfoCalls++
      userInfoHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'user-999', email: 'user@qoder.sh', name: 'Subscriber' }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const service = new QoderAuthService({
    fetchFn: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })

  const first = await service.getCredentials('pt-test-token')
  const second = await service.getCredentials('pt-test-token')
  assert.equal(first.authToken, 'jt-token')
  assert.equal(first.userID, 'user-999')
  assert.equal(first.email, 'user@qoder.sh')
  assert.equal(second, first)
  assert.equal(exchangeCalls, 1)
  assert.equal(userInfoCalls, 1)
  // The unsigned OpenAPI routes carry the plain identity headers, not the COSY set.
  assert.equal(exchangeHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(exchangeHeaders?.['cosy-clienttype'], '5')
  assert.equal(exchangeHeaders?.['cosy-version'], '1.0.1')
  assert.equal(userInfoHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(userInfoHeaders?.['cosy-clienttype'], '5')
  assert.equal(userInfoHeaders?.authorization, 'Bearer jt-token')
})

test('QoderAuthService exchanges again once the cached token enters its preempt window', () => {
  let exchangeCalls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      exchangeCalls++
      // Two minutes of life is inside the five-minute preempt window.
      return new Response(JSON.stringify({ token: `jt-${exchangeCalls}`, expires_in: 120_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-short' }))
  }
  const service = new QoderAuthService({ fetchFn: fetchMock as typeof fetch, resolveMachineId: () => 'machine-test' })
  return service.getCredentials('pt-short').then(async (first) => {
    const second = await service.getCredentials('pt-short')
    assert.equal(exchangeCalls, 2)
    assert.notEqual(first.authToken, second.authToken)
  })
})

test('QoderAuthService shares one exchange between concurrent callers', async () => {
  let exchangeCalls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      exchangeCalls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ token: 'jt-shared', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-shared' }))
  }
  const service = new QoderAuthService({
    fetchFn: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const credentials = await Promise.all([
    service.getCredentials('pt-shared'),
    service.getCredentials('pt-shared'),
    service.getCredentials('pt-shared'),
  ])
  assert.equal(exchangeCalls, 1)
  assert.ok(credentials.every(value => value.authToken === 'jt-shared'))
})

test('QoderAuthService aborts a caller and the unobserved exchange', async () => {
  let providerAborted = false
  const fetchMock = (_input: URL | Request, init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      providerAborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
  const service = new QoderAuthService({ fetchFn: fetchMock as typeof fetch })
  const controller = new AbortController()
  const request = service.getCredentials('pt-abort', controller.signal)
  controller.abort()
  await assert.rejects(request, (error: Error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'ABORTED')
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(providerAborted, true)
})

test('one departing waiter does not cancel the exchange its sibling is waiting on', async () => {
  let providerAborted = false
  const fetchMock = async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      init?.signal?.addEventListener('abort', () => { providerAborted = true }, { once: true })
      await new Promise(resolve => setTimeout(resolve, 30))
      return new Response(JSON.stringify({ token: 'jt-shared', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-shared' }))
  }
  const service = new QoderAuthService({ fetchFn: fetchMock as typeof fetch, resolveMachineId: () => 'machine-test' })
  const leaving = new AbortController()
  const first = service.getCredentials('pt-two', leaving.signal)
  const second = service.getCredentials('pt-two')
  leaving.abort()
  await assert.rejects(first, (error: Error) => error instanceof LlmError && error.code === 'ABORTED')
  assert.equal(providerAborted, false)
  const winner = await second
  assert.equal(winner.authToken, 'jt-shared')
})

test('QoderAuthService rejects a missing PAT with the hub code, before any I/O', async () => {
  let calls = 0
  const service = new QoderAuthService({
    fetchFn: (async () => { calls++; return new Response('{}') }) as typeof fetch,
  })
  await assert.rejects(service.getCredentials(''), (error: Error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    return true
  })
  assert.equal(calls, 0)
})

test('QoderAuthService rejects missing identity without leaking provider bodies', async () => {
  const diagnostics: string[] = []
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-secret', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ email: 'secret@example.com', token: 'pt-secret' }))
  }
  const service = new QoderAuthService({
    fetchFn: fetchMock as typeof fetch,
    logger: {
      debug: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
      error: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
    },
  })
  await assert.rejects(service.getCredentials('pt-secret'), (error: Error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'AUTH')
    assert.ok(!error.message.includes('pt-secret'))
    assert.ok(!error.message.includes('secret@example.com'))
    return true
  })
  assert.doesNotMatch(diagnostics.join('\n'), /pt-secret|secret@example\.com/)
  assert.match(diagnostics.join('\n'), /auth\.exchange/)
  assert.match(diagnostics.join('\n'), /auth\.user-info/)
})

test('QoderAuthService targets region-specific OpenAPI endpoints and caches separately', async () => {
  const requests: string[] = []
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/jobToken/exchange')) {
      const isChina = url.includes('openapi.qoder.com.cn')
      return new Response(JSON.stringify({
        token: isChina ? 'jt-china' : 'jt-global',
        expires_in: 3_600_000,
      }))
    }
    if (url.includes('/userinfo')) {
      const isChina = url.includes('openapi.qoder.com.cn')
      return new Response(JSON.stringify({
        id: isChina ? 'user-cn' : 'user-global',
        name: isChina ? 'CN User' : 'Global User',
      }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const globalService = new QoderAuthService({
    fetchFn: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    region: 'global',
  })
  const chinaService = new QoderAuthService({
    fetchFn: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    region: 'china',
  })

  const globalCreds = await globalService.getCredentials('pt-test')
  assert.equal(globalCreds.authToken, 'jt-global')
  assert.equal(globalCreds.userID, 'user-global')
  assert.ok(requests.some(url => url.includes('openapi.qoder.sh/api/v1/jobToken/exchange')))

  const chinaCreds = await chinaService.getCredentials('pt-test')
  assert.equal(chinaCreds.authToken, 'jt-china')
  assert.equal(chinaCreds.userID, 'user-cn')
  assert.ok(requests.some(url => url.includes('openapi.qoder.com.cn/api/v1/jobToken/exchange')))
})

test('QoderAuthService honors expires_at over expires_in when both are present', async () => {
  let calls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      calls++
      return new Response(JSON.stringify({
        token: `jt-${calls}`,
        // Already inside the preempt window, so the very next read re-exchanges.
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        expires_in: 3_600_000,
      }))
    }
    return new Response(JSON.stringify({ id: 'user-exp' }))
  }
  const service = new QoderAuthService({ fetchFn: fetchMock as typeof fetch, resolveMachineId: () => 'machine-test' })
  await service.getCredentials('pt-exp')
  await service.getCredentials('pt-exp')
  assert.equal(calls, 2)
})

test('QoderAuthService classifies malformed exchange JSON as a transport failure', async () => {
  const service = new QoderAuthService({
    fetchFn: (async () => new Response('{')) as typeof fetch,
  })
  await assert.rejects(service.getCredentials('pt-malformed'), (error: Error) => (
    error instanceof LlmError && error.code === 'TRANSPORT'
  ))
})

test('QoderAuthService classifies a refusal status and never echoes the PAT', async () => {
  const service = new QoderAuthService({
    fetchFn: (async () => new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 })) as typeof fetch,
  })
  await assert.rejects(service.getCredentials('pt-refused'), (error: Error) => (
    error instanceof LlmError && error.code === 'AUTH' && error.failure.status === 401
  ))
})

test('exchangeFresh bypasses the cache and replaces it', async () => {
  let calls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      calls++
      return new Response(JSON.stringify({ token: `jt-${calls}`, expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: `user-${calls}` }))
  }
  const service = new QoderAuthService({ fetchFn: fetchMock as typeof fetch, resolveMachineId: () => 'machine-test' })
  const cached = await service.getCredentials('pt-fresh')
  assert.equal(cached.authToken, 'jt-1')
  const fresh = await service.exchangeFresh('pt-fresh')
  assert.equal(fresh.authToken, 'jt-2')
  // The replacement is what the next cached read sees.
  const after = await service.getCredentials('pt-fresh')
  assert.equal(after.authToken, 'jt-2')
  assert.equal(calls, 2)
})

test('clear drops one account, or all of them', async () => {
  let calls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      calls++
      return new Response(JSON.stringify({ token: `jt-${calls}`, expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-clear' }))
  }
  const service = new QoderAuthService({ fetchFn: fetchMock as typeof fetch, resolveMachineId: () => 'machine-test' })
  await service.getCredentials('pt-a')
  await service.getCredentials('pt-b')
  assert.equal(calls, 2)
  service.clear('pt-a')
  await service.getCredentials('pt-b')
  assert.equal(calls, 2)
  await service.getCredentials('pt-a')
  assert.equal(calls, 3)
  service.clear()
  await service.getCredentials('pt-b')
  assert.equal(calls, 4)
})

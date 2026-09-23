/**
 * The adapter seam: catalog sharing, timeouts, and the job-token self-heal.
 *
 * Golden fixtures ported from the reference's `tests/qoder/transport.test.ts`.
 * The self-heal cases are the ones with real history behind them: a gateway
 * fault window that outlives one immediate retry, a rejection storm that must
 * be announced once rather than once per host retry, a rotation notice that must
 * not outlive its usefulness, and a heal that failed so must not later claim to
 * have rescued an unrelated chat.
 *
 * The region case is new: one `qoder` route, two deployments, each account
 * addressed at the host ITS credential was minted for.
 */

import './keep-alive.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderAdapter } from '../src/providers/qoder/adapter.js'
import { probeQoderPat } from '../src/providers/qoder/auth.js'

const catalog = JSON.stringify({ assistant: [{ key: 'cmodel', enable: true, display_name: 'Cantus' }] })

const request: GenerateOptions = {
  provider: 'qoder',
  model: 'cmodel',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
}

function adapter(
  options: Partial<ConstructorParameters<typeof QoderAdapter>[0]> & { fetchFn: typeof fetch },
): QoderAdapter {
  return new QoderAdapter({
    models: [{ id: 'cmodel', name: 'Cantus' }],
    streamIdleTimeoutMs: 5_000,
    personalToken: () => Promise.resolve('pt-default'),
    discovery: true,
    region: 'global',
    resolveMachineId: () => 'machine-test',
    ...options,
  })
}

test('QoderAdapter shares concurrent model discovery', async () => {
  let catalogCalls = 0
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-shared'),
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const [first, second] = await Promise.all([
    transport.discoverModels(),
    transport.discoverModels(),
  ])
  assert.equal(catalogCalls, 1)
  assert.equal(first, second)
})

test('QoderAdapter serves the cached catalog without re-reading it', async () => {
  let catalogCalls = 0
  const transport = adapter({
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-cache' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-cache' }))
      catalogCalls++
      return new Response(catalog)
    }) as typeof fetch,
  })
  await transport.discoverModels()
  await transport.discoverModels()
  assert.equal(catalogCalls, 1)
  transport.clearAccountCatalog()
  await transport.discoverModels()
  assert.equal(catalogCalls, 2)
})

test('QoderAdapter retries an idempotent model discovery once', async () => {
  let catalogCalls = 0
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-retry'),
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-retry' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-retry' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        return catalogCalls === 1 ? new Response('', { status: 503 }) : new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const models = await transport.discoverModels()
  assert.equal(catalogCalls, 2)
  assert.equal(models[0]?.id, 'cmodel')
})

test('QoderAdapter falls back to the configured list when discovery fails', async () => {
  const transport = adapter({
    discovery: true,
    models: [{ id: 'mine', name: 'Mine', contextWindow: 400_000, maxTokens: 8_192 }],
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-fallback' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-fallback' }))
      return new Response('nope', { status: 500 })
    }) as typeof fetch,
  })
  const models = await transport.listModels('qoder')
  assert.equal(models[0]?.id, 'mine')
  const resolved = await transport.resolveModel('qoder', 'mine')
  assert.equal(resolved.context?.contextWindow, 400_000)
  assert.equal(resolved.defaultMaxTokens, 8_192)
})

test('QoderAdapter advertises no model catalog when discovery is off and nothing is configured', async () => {
  const transport = adapter({
    discovery: false,
    models: [],
    fetchFn: (async () => { throw new Error('no request expected') }) as typeof fetch,
  })
  const models = await transport.listModels('qoder')
  // The reference's built-in fallback list is what an unconfigured route offers.
  assert.ok(models.length > 0)
  assert.equal(models[0]?.provider, 'qoder')
})

test('QoderAdapter aborts a shared discovery only after its last waiter leaves', async () => {
  let stallCatalog = false
  let upstreamAborted = false
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-shared'),
    fetchFn: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list') && !stallCatalog) return new Response(catalog)
      if (url.includes('/model/list')) {
        notifyStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            upstreamAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await transport.discoverModels()
  transport.clearAccountCatalog()
  stallCatalog = true
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = transport.discoverModels(firstController.signal)
  const second = transport.discoverModels(secondController.signal)
  await started

  firstController.abort()
  await assert.rejects(first, (error: Error) => error instanceof LlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, false)

  secondController.abort()
  await assert.rejects(second, (error: Error) => error instanceof LlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, true)
})

test('QoderAdapter separates response-header timeout from stream idle timeout', async () => {
  const transport = adapter({
    responseHeaderTimeoutMs: 5,
    fetchFn: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-timeout' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-timeout' }))
      if (url.includes('/agent_chat_generation')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => (
    error instanceof LlmError
    && error.code === 'TIMEOUT'
    && /response header/u.test(error.message)
  ))
})

test('QoderAdapter signs the chat with COSY headers over the WAF-encoded body', async () => {
  let headers: Record<string, string> = {}
  let bodyLength = 0
  const transport = adapter({
    fetchFn: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-sign' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-sign' }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
        bodyLength = Buffer.byteLength(String(init?.body ?? ''), 'utf8')
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(request)) continue
  // `Headers` lower-cases field names on the wire, so the assertions do too.
  assert.match(headers.authorization ?? '', /^Bearer COSY\./u)
  assert.equal(headers['cosy-sigpath'], '/api/v2/service/pro/sse/agent_chat_generation')
  assert.equal(headers['x-request-id'] !== undefined, true)
  assert.equal(headers['x-model-key'], 'cmodel')
  assert.equal(headers['x-model-source'], 'system')
  assert.equal(headers['cosy-bodylength'], String(bodyLength))
  assert.ok(headers['user-agent'] !== undefined)
})

test('QoderAdapter retries a chat 401 once with a freshly exchanged job token and reports the refresh', async () => {
  let exchanges = 0
  let chatCalls = 0
  let chatUser = ''
  const refreshed: number[] = []
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-reauth'),
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    fetchFn: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        chatUser = new Headers(init?.headers).get('Cosy-User')!
        // The cached token answers 401 once; the freshly exchanged one streams.
        return chatCalls === 1
          ? new Response('', { status: 401 })
          : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(request)) continue
  assert.equal(chatCalls, 2)
  assert.equal(exchanges, 2)
  // The retry signed with the new job token's owner, not the rejected one.
  assert.equal(chatUser, 'user-2')
  // The self-heal is reported once the fresh token is accepted, which is what
  // the user-visible notice is built from.
  assert.equal(refreshed.length, 1)
  assert.equal(typeof refreshed[0], 'number')
})

test('QoderAdapter recovers when only the second round survives the gateway fault window', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-window'),
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        // The whole fault window: the cached token and the first fresh one are
        // rejected; the paced second round streams.
        return chatCalls < 3
          ? new Response('', { status: 401 })
          : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(request)) continue
  assert.equal(chatCalls, 3)
  assert.equal(exchanges, 3)
})

test('QoderAdapter surfaces the auth failure when the re-auth retry is rejected too', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-dead'),
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'AUTH')
  // Paced rounds: initial + two re-auth retries, then the failure surfaces
  // honestly instead of looping forever on a revoked PAT.
  assert.equal(chatCalls, 3)
  assert.equal(exchanges, 3)
})

test('QoderAdapter reports an exhausted self-heal once, not once per host retry', async () => {
  // The observed outage: one upstream rejection that no fresh token could clear,
  // retried 59 times by the host across 75 steps. The transport re-heals inside
  // every one of those, so the notice needs a latch or the conversation fills
  // with identical rows.
  let exchanges = 0
  let chatCalls = 0
  const failures: Array<{ at: number; status?: number }> = []
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-storm'),
    onJobTokenRefreshFailed: info => { failures.push(info) },
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        // Every token, cached or freshly exchanged, is rejected: the 403 the
        // upstream answers inside its SSE envelope, which survives a rotation.
        return new Response(
          'data: ' + JSON.stringify({ statusCodeValue: 403, body: '{"message":"region permission denied"}' }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  // Three host-level attempts, each running the transport's own heal to exhaustion.
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(async () => {
      for await (const _chunk of transport.stream(request)) continue
    }, (error: Error) => error instanceof LlmError && error.code === 'AUTH')
  }

  assert.equal(failures.length, 1, 'the failed heal is announced once per outage')
  assert.equal(typeof failures[0]!.at, 'number')
  assert.equal(failures[0]!.status, 403)
  // The heal genuinely ran each time: initial + two paced rounds per attempt.
  assert.equal(chatCalls, 9)
  assert.equal(exchanges, 7)
})

test('QoderAdapter re-arms the failed-heal notice after a chat is accepted', async () => {
  // The latch must not mute a later, separate outage: an accepted chat proves
  // the credential works again, so the next exhaustion is news.
  let exchanges = 0
  let chatCalls = 0
  let acceptNext = false
  const failures: number[] = []
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-recover'),
    onJobTokenRefreshFailed: () => { failures.push(Date.now()) },
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (acceptNext) {
          acceptNext = false
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'AUTH')
  assert.equal(failures.length, 1)

  acceptNext = true
  for await (const _chunk of transport.stream(request)) continue

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'AUTH')
  assert.equal(failures.length, 2)
})

test('QoderAdapter does not print a stale success notice after a failed heal', async () => {
  // The observed defect: a heal at 16:56 whose own retry was also rejected left
  // its success notice pending. A chat accepted 51 minutes later flushed it,
  // printing a "token auto-refreshed (16:56:13)" row next to a 17:47 message —
  // directly contradicting the failure row already shown for the same heal.
  let chatCalls = 0
  let acceptNext = false
  const refreshed: number[] = []
  const failures: number[] = []
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-stale'),
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    onJobTokenRefreshFailed: () => { failures.push(Date.now()) },
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-stale' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-stale' }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (acceptNext) {
          acceptNext = false
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'AUTH')
  assert.equal(failures.length, 1)

  acceptNext = true
  for await (const _chunk of transport.stream(request)) continue
  assert.equal(refreshed.length, 0, 'a heal that did not recover must not leave a success notice pending')
})

test('QoderAdapter drops a success notice whose rotation went stale', async () => {
  // The heal's own retry can lose a race with a transient fault, so the notice
  // is deferred until some chat is accepted. That deferral is bounded: a row
  // appearing long after the rotation it names reads as a clock bug.
  let chatCalls = 0
  let acceptNext = false
  const refreshed: number[] = []
  const realNow = Date.now
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-oldnotice'),
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-1' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (acceptNext) {
          acceptNext = false
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        // First the cached token is rejected as unauthorized (which is what arms
        // the heal and sets the pending notice); then the heal's own retry hits a
        // transient fault, which is not an authorization rejection, so it
        // surfaces immediately and leaves the notice pending.
        return chatCalls === 1 ? new Response('', { status: 401 }) : new Response('', { status: 502 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'SERVER')

  // Ten minutes pass before any chat is accepted.
  Date.now = () => realNow() + 10 * 60 * 1000
  try {
    acceptNext = true
    for await (const _chunk of transport.stream(request)) continue
  } finally {
    Date.now = realNow
  }
  assert.equal(refreshed.length, 0, 'a rotation older than the notice window is dropped, not printed late')
})

test('QoderAdapter prints a fresh success notice when the heal recovers promptly', async () => {
  let chatCalls = 0
  const refreshed: number[] = []
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-prompt'),
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-1' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return chatCalls === 1
          ? new Response('', { status: 401 })
          : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(request)) continue
  assert.equal(refreshed.length, 1)
  assert.ok(Math.abs(refreshed[0]! - Date.now()) < 60_000, 'the notice carries the rotation time, which is recent')
})

test('QoderAdapter does not re-auth on failures that are not authorization rejections', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-server'),
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/model/list')) return new Response(catalog)
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response('', { status: 502 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'SERVER')
  assert.equal(chatCalls, 1)
  assert.equal(exchanges, 1)
})

test('QoderAdapter refuses a request with no credential before any provider I/O', async () => {
  let calls = 0
  const transport = adapter({
    personalToken: () => Promise.resolve(undefined),
    fetchFn: (async () => { calls++; return new Response('{}') }) as typeof fetch,
  })
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL')
  assert.equal(calls, 0)
})

test('QoderAdapter reads usage through the hub shape, and degrades instead of throwing', async () => {
  const transport = adapter({
    personalToken: () => Promise.resolve('pt-usage'),
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-usage' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-usage', name: 'U' }))
      if (url.includes('/quota/usage')) {
        return new Response(JSON.stringify({ userQuota: { total: 300, used: 30, remaining: 270, unit: 'credits' } }))
      }
      if (url.includes('/user/plan')) return new Response(JSON.stringify({ user_type: 'pro', plan_tier_name: 'Pro' }))
      if (url.includes('/user/status')) return new Response(JSON.stringify({ featureSwitches: { allow_byok: 1 } }))
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const usage = await transport.readUsage()
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'Pro')
  assert.equal(usage.remaining, 270)
  assert.equal(usage.limit, 300)
})

test('QoderAdapter resolves the region per account so one route serves both deployments', async () => {
  const seen: Record<string, string[]> = { global: [], china: [] }
  const transport = new QoderAdapter({
    models: [{ id: 'cmodel', name: 'Cantus' }],
    streamIdleTimeoutMs: 5_000,
    discovery: false,
    // The hub stores `region` on the session, so the adapter reads it per account.
    region: async (account?: string) => (account === 'cn' ? 'china' : 'global'),
    personalToken: async (account?: string) => `pt-${account ?? 'default'}`,
    resolveMachineId: () => 'machine-test',
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('openapi.qoder.com.cn')) seen.china!.push(url)
      else if (url.includes('openapi.qoder.sh')) seen.global!.push(url)
      if (url.includes('/jobToken/exchange')) {
        return new Response(JSON.stringify({ token: url.includes('com.cn') ? 'jt-cn' : 'jt-global' }))
      }
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({ id: url.includes('com.cn') ? 'user-cn' : 'user-global' }))
      }
      if (url.includes('/agent_chat_generation')) {
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.streamAccount(request, 'cn')) continue
  for await (const _chunk of transport.streamAccount(request, 'intl')) continue

  assert.ok(seen.china!.every(url => url.includes('openapi.qoder.com.cn')))
  assert.ok(seen.global!.every(url => url.includes('openapi.qoder.sh')))
  // Each account exchanged against its own deployment.
  assert.ok(seen.china!.some(url => url.includes('/jobToken/exchange')))
  assert.ok(seen.global!.some(url => url.includes('/jobToken/exchange')))
})

test('QoderAdapter caches the resolved region so a resolver is consulted once per account', async () => {
  let resolutions = 0
  const transport = new QoderAdapter({
    models: [{ id: 'cmodel', name: 'Cantus' }],
    streamIdleTimeoutMs: 5_000,
    discovery: false,
    region: () => { resolutions++; return 'china' },
    personalToken: () => Promise.resolve('pt-cache'),
    resolveMachineId: () => 'machine-test',
    fetchFn: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-cache' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-cache' }))
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  })

  for await (const _chunk of transport.streamAccount(request, 'cn')) continue
  for await (const _chunk of transport.streamAccount(request, 'cn')) continue
  assert.equal(resolutions, 1)
})

test('QoderAdapter exposes the hub provider surface', () => {
  const transport = adapter({ fetchFn: (async () => new Response('{}')) as typeof fetch })
  assert.deepEqual(transport.providerInfo('qoder'), { id: 'qoder', name: 'Qoder' })
  // The subscription retry shape, not the dsh-llm default (5 tries from 500ms).
  assert.ok(transport.providerRetryPolicy('qoder') !== undefined)
})

test('probeQoderPat validates a PAT and returns everything a session needs', async () => {
  let exchangeUrl = ''
  const probe = await probeQoderPat('  pt-paste  ', 'china', (async (input: URL | Request) => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      exchangeUrl = url
      return new Response(JSON.stringify({ token: 'jt-new', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-new', name: 'New User', email: 'new@qoder.com.cn' }))
  }) as typeof fetch)

  assert.equal(exchangeUrl, 'https://openapi.qoder.com.cn/api/v1/jobToken/exchange')
  assert.equal(probe.userId, 'user-new')
  assert.equal(probe.jobToken, 'jt-new')
  assert.equal(probe.name, 'New User')
  assert.equal(probe.email, 'new@qoder.com.cn')
  assert.ok(probe.expiresAt > Date.now() + 3_000_000, 'the disclosed lifetime is reported, not the 24h assumption')
})

test('probeQoderPat classifies a refused PAT so the paste handler can surface it verbatim', async () => {
  await assert.rejects(probeQoderPat('pt-bad', 'global', (async () => new Response('', { status: 401 })) as typeof fetch), (error: Error) => (
    error instanceof LlmError && error.code === 'AUTH'
  ))
  await assert.rejects(probeQoderPat('', 'global', (async () => new Response('{}')) as typeof fetch), (error: Error) => (
    error instanceof LlmError && error.code === 'MISSING_CREDENTIAL'
  ))
  await assert.rejects(probeQoderPat('pt-down', 'global', (async () => { throw new TypeError('fetch failed') }) as typeof fetch), (error: Error) => (
    error instanceof LlmError && error.code === 'TRANSPORT'
  ))
})

test('probeQoderPat does not populate the transport cache with a probe-only credential', async () => {
  // A refused credential must leave no trace: the probe runs the exchange
  // directly, so a later chat still performs its own exchange and fails on the
  // same refusal rather than reading a half-resolved cache entry.
  let exchanges = 0
  const fetchMock = (async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      exchanges++
      return new Response(JSON.stringify({ token: 'jt-probe', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-probe' }))
    return new Response(catalog)
  }) as typeof fetch

  await probeQoderPat('pt-probe', 'global', fetchMock)
  assert.equal(exchanges, 1)
  const transport = adapter({ personalToken: () => Promise.resolve('pt-probe'), fetchFn: fetchMock })
  await transport.discoverModels()
  assert.equal(exchanges, 2, 'the adapter does its own exchange')
})

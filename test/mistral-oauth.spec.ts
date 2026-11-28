/**
 * The reverse-engineered Mistral sign-in.
 *
 * Everything here is checked against the captured exchange, not against a guess:
 *
 *   POST /api/vibe/sign-in  {"code_challenge":"…","code_challenge_method":"S256"}
 *     → {"process_id","sign_in_url","poll_url","expires_at"}
 *   GET  <poll_url>          → {"status":"pending"}   … then a terminal answer
 *
 * Two traps that cost a round of probing: the two PKCE fields live at the TOP level
 * of the body (nesting them under `payload` is answered with a 422 naming exactly
 * those fields), and the first poll body is a 20-byte status object, not the
 * credential.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MISTRAL_CONSOLE_BASE,
  classifyPollPayload,
  createPkcePair,
  parseStartedSignIn,
  pollMistralSignIn,
  startMistralSignIn,
} from '../src/providers/mistral-oauth.js'
import type { FetchFn } from '../src/providers/common.js'

const START_BODY = {
  process_id: '64e5e4c4-4544-4fa1-8466-a1a9df4088c9',
  sign_in_url: 'https://console.mistral.ai/codestral/cli/authenticate?process_id=64e5&complete_token=liYe',
  poll_url: 'https://console.mistral.ai/api/vibe/sign-in/poll/BY37alsx5j4L2Fqe9ulEsaoVmwmEtWwH',
  expires_at: '2026-11-28T12:47:29.718465+00:00',
}

test('mistral oauth: the PKCE pair is RFC 7636 shaped', () => {
  const pair = createPkcePair()
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43,128}$/)
  // The challenge is base64url of the SHA-256 digest: no padding, no '+', no '/'.
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(pair.verifier, pair.challenge)
})

test('mistral oauth: the start call sends the PKCE fields at the top level', async () => {
  let seen: { url: string; body: Record<string, unknown>; method?: string } | undefined
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      ...init?.method === undefined ? {} : { method: init.method },
    }
    return new Response(JSON.stringify(START_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as FetchFn

  const started = await startMistralSignIn(fetchFn)
  assert.equal(seen?.url, `${MISTRAL_CONSOLE_BASE}/api/vibe/sign-in`)
  assert.equal(seen?.method, 'POST')
  assert.equal(seen?.body.code_challenge_method, 'S256')
  assert.match(String(seen?.body.code_challenge), /^[A-Za-z0-9_-]{43}$/)
  // The trap: a nested `payload` is answered with 422 naming these fields.
  assert.equal(seen?.body.payload, undefined)
  assert.equal(started.processId, START_BODY.process_id)
  assert.equal(started.signInUrl, START_BODY.sign_in_url)
  assert.equal(started.expiresAt, Date.parse(START_BODY.expires_at))
})

test('mistral oauth: a start answer missing its fields fails loudly', () => {
  assert.throws(() => parseStartedSignIn({ process_id: 'x' }, 'v'), /did not return a process id/)
  assert.throws(() => parseStartedSignIn(null, 'v'), /did not return a process id/)
})

test('mistral oauth: the measured pending body keeps the poll going', () => {
  // 20 bytes, exactly what the captured response carried.
  assert.equal('{"status":"pending"}'.length, 20)
  assert.deepEqual(classifyPollPayload({ status: 'pending' }), { kind: 'pending' })
  assert.deepEqual(classifyPollPayload({}), { kind: 'pending' })
})

test('mistral oauth: a terminal answer is read defensively', () => {
  const withKey = classifyPollPayload({ status: 'complete', api_key: 'mstrl_frompoll_0123456789' })
  assert.equal(withKey.kind, 'ready')
  if (withKey.kind === 'ready') {
    assert.equal(withKey.key, 'mstrl_frompoll_0123456789')
    assert.deepEqual(withKey.fields, ['status', 'api_key'])
  }
  const withCode = classifyPollPayload({ status: 'complete', code: 'abc123' })
  assert.equal(withCode.kind, 'ready')
  if (withCode.kind === 'ready') {
    assert.equal(withCode.code, 'abc123')
    assert.equal(withCode.key, undefined)
  }
  // A JWT is not an API key: it must not be adopted as one.
  const jwt = classifyPollPayload({ status: 'complete', access_token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' })
  assert.equal(jwt.kind, 'failed')
  assert.deepEqual(classifyPollPayload({ status: 'denied' }), { kind: 'failed', reason: 'denied' })
})

test('mistral oauth: polling stops on the first terminal answer', async () => {
  const bodies = [{ status: 'pending' }, { status: 'pending' }, { status: 'complete', api_key: 'mstrl_afterpoll_0123456789' }]
  let calls = 0
  const fetchFn = (async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)]
    calls++
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as FetchFn
  const result = await pollMistralSignIn(fetchFn, {
    processId: 'p',
    signInUrl: 'u',
    pollUrl: 'poll',
    expiresAt: Date.now() + 60_000,
    verifier: 'v',
  }, { intervalMs: 1, timeoutMs: 5_000, sleep: async () => {} })
  assert.equal(calls, 3)
  assert.equal(result.kind, 'ready')
  if (result.kind === 'ready') assert.equal(result.key, 'mstrl_afterpoll_0123456789')
})

test('mistral oauth: an expired sign-in ends instead of polling forever', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ status: 'pending' }), { status: 200 })) as unknown as FetchFn
  const result = await pollMistralSignIn(fetchFn, {
    processId: 'p',
    signInUrl: 'u',
    pollUrl: 'poll',
    expiresAt: Date.now() + 10,
    verifier: 'v',
  }, { intervalMs: 1, timeoutMs: 5, sleep: async () => {} })
  assert.equal(result.kind, 'failed')
  if (result.kind === 'failed') assert.match(result.reason, /timed out/)
})

test('mistral oauth: a 404 from the poll is terminal, a 500 is retried', async () => {
  let calls = 0
  const fetchFn = (async () => {
    calls++
    return calls === 1 ? new Response('', { status: 500 }) : new Response('{"status":"complete"}', { status: 404 })
  }) as unknown as FetchFn
  const result = await pollMistralSignIn(fetchFn, {
    processId: 'p',
    signInUrl: 'u',
    pollUrl: 'poll',
    expiresAt: Date.now() + 60_000,
    verifier: 'v',
  }, { intervalMs: 1, timeoutMs: 2_000, sleep: async () => {} })
  assert.equal(calls, 2, 'the 500 was retried, the 404 was not')
  assert.equal(result.kind, 'failed')
})

/**
 * Qoder login: the pasted-PAT → session mapping, and the region discovery.
 *
 * The region is the interesting part. Qoder runs two deployments and a token
 * minted on one is refused by the other, yet the hub serves both from ONE route —
 * so the region has to be established from the token itself rather than asked
 * for. These tests drive that with an injected fetcher, so no network is needed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { QODER_REGIONS, parseQoderPaste, qoderSessionFromPaste } from '../src/providers/qoder-session.js'

/** The exchange endpoint per region, as `endpoints.ts` builds it. */
const EXCHANGE = {
  global: 'https://openapi.qoder.sh/api/v1/jobToken/exchange',
  china: 'https://openapi.qoder.com.cn/api/v1/jobToken/exchange',
}
const USERINFO = {
  global: 'https://openapi.qoder.sh/api/v1/userinfo',
  china: 'https://openapi.qoder.com.cn/api/v1/userinfo',
}

/**
 * A fetcher that accepts the token on exactly the listed regions and refuses it
 * everywhere else, recording every call so the test can assert what was tried.
 */
function regionAwareFetch(accepts: readonly ('global' | 'china')[], options: { fails?: 'throw' } = {}): {
  fetchFn: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (options.fails === 'throw') throw new TypeError('fetch failed')
    const region = url.includes('.com.cn') ? 'china' : 'global'
    if (!accepts.includes(region)) {
      return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: `job-${region}`, expires_in: 7_200_000 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ id: `uid-${region}`, name: `User ${region}`, email: 'u@example.com' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

test('a bare token is tried global first and its region is recorded', async () => {
  const { fetchFn, calls } = regionAwareFetch(['global'])
  const session = await qoderSessionFromPaste('pat-abc', fetchFn)
  assert.equal(session.region, 'global')
  assert.equal(session.refreshToken, 'pat-abc')
  assert.equal(session.accessToken, 'job-global')
  assert.equal(session.userId, 'uid-global')
  assert.equal(session.account, 'User global')
  assert.ok(session.expiresAt > Date.now())
  // One exchange and one identity read, both against the global deployment.
  assert.equal(calls.length, 2)
  assert.ok(calls.every(url => !url.includes('.com.cn')), JSON.stringify(calls))
})

test('a China token is found without the user naming the region', async () => {
  // THE POINT. Without this the user would have to know which deployment their
  // token belongs to, and choosing wrong reads as "your token is bad".
  const { fetchFn, calls } = regionAwareFetch(['china'])
  const session = await qoderSessionFromPaste('pat-cn', fetchFn)
  assert.equal(session.region, 'china')
  assert.equal(session.accessToken, 'job-china')
  assert.equal(session.userId, 'uid-china')
  // Global was refused first, then China accepted.
  assert.ok(calls.some(url => url.includes(EXCHANGE.global)))
  assert.ok(calls.some(url => url.includes(EXCHANGE.china)))
})

test('an explicit prefix pins the region and skips the other deployment', async () => {
  for (const [word, region] of [['china', 'china'], ['cn', 'china'], ['global', 'global'], ['intl', 'global']] as const) {
    const { fetchFn, calls } = regionAwareFetch([region])
    const session = await qoderSessionFromPaste(`${word}: pat-x`, fetchFn)
    assert.equal(session.region, region, word)
    // Only ONE deployment was contacted, which is what makes the prefix useful
    // when the network is slow or one deployment is down.
    const hosts = new Set(calls.map(url => (url.includes('.com.cn') ? 'china' : 'global')))
    assert.deepEqual([...hosts], [region], word)
  }
})

test('the prefix parse accepts the words a user would actually reach for', () => {
  assert.deepEqual(parseQoderPaste('  pat-only  '), { pat: 'pat-only' })
  assert.deepEqual(parseQoderPaste('china:pat'), { pat: 'pat', region: 'china' })
  assert.deepEqual(parseQoderPaste('CN : pat'), { pat: 'pat', region: 'china' })
  assert.deepEqual(parseQoderPaste('global:pat'), { pat: 'pat', region: 'global' })
  assert.deepEqual(parseQoderPaste('INTL:pat'), { pat: 'pat', region: 'global' })
  // A token that merely CONTAINS a colon is not split: only the four known words
  // are treated as a prefix, so a `scheme:secret` token survives intact.
  assert.deepEqual(parseQoderPaste('user:abc123'), { pat: 'user:abc123' })
  assert.deepEqual(parseQoderPaste('v2:china:pat'), { pat: 'v2:china:pat' })
  assert.deepEqual(parseQoderPaste(''), { pat: '' })
})

test('empty input is rejected as a missing credential, before any request', async () => {
  const { fetchFn, calls } = regionAwareFetch(['global'])
  for (const input of ['', '   ', 'china:', 'global:  ']) {
    await assert.rejects(
      qoderSessionFromPaste(input, fetchFn),
      (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
      input,
    )
  }
  assert.deepEqual(calls, [], 'no request may be sent for empty input')
})

test('a token refused by BOTH deployments reports that it tried both', async () => {
  const { fetchFn, calls } = regionAwareFetch([])
  await assert.rejects(
    qoderSessionFromPaste('bad-pat', fetchFn),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'AUTH')
      // The message must say both were tried, or a China user reads it as "my
      // token is broken" instead of "this token is genuinely refused".
      assert.match(error.message, /both the global .* and China .* deployments/)
      // And it names the escape hatch.
      assert.match(error.message, /global:.*china:/)
      return true
    },
  )
  // Both deployments were actually contacted.
  const hosts = new Set(calls.map(url => (url.includes('.com.cn') ? 'china' : 'global')))
  assert.deepEqual([...hosts].sort(), ['china', 'global'])
})

test('a pinned region that refuses the token blames that deployment only', async () => {
  const { fetchFn } = regionAwareFetch(['global'])
  await assert.rejects(
    qoderSessionFromPaste('china:bad', fetchFn),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /the china deployment/)
      assert.doesNotMatch(error.message, /both/)
      return true
    },
  )
})

test('a transport failure is NOT reported as a rejected credential', async () => {
  // The distinction that matters: "we could not ask" must never read as "your
  // token is bad", or a user re-mints a perfectly good PAT.
  const { fetchFn } = regionAwareFetch([], { fails: 'throw' })
  await assert.rejects(
    qoderSessionFromPaste('pat', fetchFn),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.notEqual(error.code, 'AUTH')
      assert.equal(error.code, 'TRANSPORT')
      return true
    },
  )
})

test('the region list is the two deployments, global first', () => {
  // Global first is the tie-break when a token somehow works on both, and it is
  // the deployment most tokens are minted against.
  assert.deepEqual([...QODER_REGIONS], ['global', 'china'])
})

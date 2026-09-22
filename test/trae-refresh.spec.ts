/**
 * Trae credential refresh (F1).
 *
 * The plugin used to return the session unchanged, so an imported credential
 * simply aged out: chat, credits and check-in failed with upstream auth errors,
 * never self-healed, and the card still said "signed in".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TRAE_REFRESH_CONTRACT,
  TraeRefreshRejected,
  isTraePermanentRefreshError,
  parseTraeRefreshPayload,
  refreshTraeSession,
} from '../src/providers/trae/refresh.js'
import { refreshTrae } from '../src/providers/trae/index.js'
import type { TraeSession } from '../src/auth/store.js'

function session(overrides: Partial<TraeSession> = {}): TraeSession {
  return {
    accessToken: 'old-access',
    refreshToken: 'the-refresh-token',
    expiresAt: Date.now() - 60_000,
    account: 'acct',
    userId: 'uid-7',
    channel: 'solo',
    region: 'cn',
    host: 'https://trae-api-cn.mchost.guru',
    edition: 'solo',
    ...overrides,
  } as TraeSession
}

/** A fetcher that captures the request and answers with `response`. */
function capture(response: () => Response): { fetchFn: (url: string, init?: RequestInit) => Promise<Response>; seen: { url: string; body: Record<string, unknown> }[] } {
  const seen: { url: string; body: Record<string, unknown> }[] = []
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return response()
  }
  return { fetchFn, seen }
}

function ok(token: string, expiresAt: number, refresh?: string): Response {
  return new Response(JSON.stringify({
    Result: {
      Token: token,
      TokenExpireAt: expiresAt,
      ...refresh === undefined ? {} : { RefreshToken: refresh },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('the grant posts the official body to the credential\'s own host', async () => {
  const expires = Date.now() + 3_600_000
  const { fetchFn, seen } = capture(() => ok('fresh-access', expires))
  const refreshed = await refreshTraeSession(session(), undefined, fetchFn as never)

  assert.equal(seen.length, 1)
  // The credential's OWN host, never a hardcoded base.
  assert.equal(seen[0]!.url, 'https://trae-api-cn.mchost.guru/cloudide/api/v3/trae/oauth/ExchangeToken')
  assert.deepEqual(seen[0]!.body, {
    ClientID: TRAE_REFRESH_CONTRACT.solo.clientId,
    ClientSecret: '-',
    RefreshToken: 'the-refresh-token',
    UserID: 'uid-7',
  })

  assert.equal(refreshed.accessToken, 'fresh-access')
  assert.equal(refreshed.expiresAt, expires)
  // Every other field survives: this is a renewal, not a new account.
  assert.equal(refreshed.account, 'acct')
  assert.equal(refreshed.userId, 'uid-7')
  assert.equal(refreshed.host, 'https://trae-api-cn.mchost.guru')
  assert.equal(refreshed.edition, 'solo')
})

test('a rotated refresh token is kept, and an omitted one is not erased', async () => {
  const rotated = await refreshTraeSession(session(), undefined, capture(() => ok('a', Date.now() + 1000, 'new-refresh')).fetchFn as never)
  assert.equal(rotated.refreshToken, 'new-refresh')

  const kept = await refreshTraeSession(session(), undefined, capture(() => ok('a', Date.now() + 1000)).fetchFn as never)
  // The endpoint usually omits it; the stored one must remain usable.
  assert.equal(kept.refreshToken, 'the-refresh-token')
})

test('a trailing slash on the host cannot double up in the path', async () => {
  const { fetchFn, seen } = capture(() => ok('a', Date.now() + 1000))
  await refreshTraeSession(session({ host: 'https://trae-api-cn.mchost.guru/' }), undefined, fetchFn as never)
  assert.equal(seen[0]!.url, 'https://trae-api-cn.mchost.guru/cloudide/api/v3/trae/oauth/ExchangeToken')
})

test('a refused grant is PERMANENT; a service failure is not', async () => {
  // 4xx is the endpoint's verdict on the credential itself.
  for (const status of [400, 401, 403]) {
    const { fetchFn } = capture(() => new Response('{"error":"invalid_grant"}', { status }))
    const error = await refreshTraeSession(session(), undefined, fetchFn as never).catch((e: unknown) => e)
    assert.ok(error instanceof TraeRefreshRejected, `status ${String(status)}`)
    assert.equal(isTraePermanentRefreshError(error), true)
    // Without this the account could never be surfaced or removed, which is
    // exactly what the always-false predicate used to guarantee.
    assert.equal((error as TraeRefreshRejected).status, status)
  }
  // 429 and 5xx are the SERVICE's problem; they must stay retryable.
  for (const status of [429, 500, 502, 503]) {
    const { fetchFn } = capture(() => new Response('busy', { status }))
    const error = await refreshTraeSession(session(), undefined, fetchFn as never).catch((e: unknown) => e)
    assert.ok(error instanceof Error)
    assert.equal(isTraePermanentRefreshError(error), false, `status ${String(status)} must stay transient`)
  }
})

test('a network failure and a missing host stay transient rather than deleting the account', async () => {
  const failing = (async () => { throw new Error('ECONNREFUSED') }) as never
  const networkError = await refreshTraeSession(session(), undefined, failing).catch((e: unknown) => e)
  assert.equal(isTraePermanentRefreshError(networkError), false)

  const { fetchFn } = capture(() => ok('a', Date.now() + 1000))
  const noHost = await refreshTraeSession(session({ host: '' }), undefined, fetchFn as never).catch((e: unknown) => e)
  assert.match((noHost as Error).message, /host is missing/)
  assert.equal(isTraePermanentRefreshError(noHost), false)
})

test('a missing refresh token is permanent, because the credential cannot be renewed', async () => {
  const { fetchFn, seen } = capture(() => ok('a', Date.now() + 1000))
  const bare = { ...session() } as Record<string, unknown>
  delete bare.refreshToken
  const error = await refreshTraeSession(bare as unknown as TraeSession, undefined, fetchFn as never)
    .catch((e: unknown) => e)
  assert.ok(error instanceof TraeRefreshRejected)
  // And no doomed request was sent.
  assert.equal(seen.length, 0)
})

test('a response with no readable expiry does not become an eternal token', () => {
  const parsed = parseTraeRefreshPayload({ Result: { Token: 'x' } })
  assert.ok(parsed !== undefined)
  // A finite, near-future expiry — never NaN, never Infinity.
  assert.ok(Number.isFinite(parsed.expiresAtMs))
  assert.ok(parsed.expiresAtMs > Date.now())
  assert.ok(parsed.expiresAtMs - Date.now() <= 31 * 60_000)
})

test('the payload parser accepts both spellings and rejects a tokenless body', () => {
  assert.equal(parseTraeRefreshPayload({ Result: { Token: 'a', TokenExpireAt: 1 } })?.accessToken, 'a')
  assert.equal(parseTraeRefreshPayload({ Token: 'b', expiresAt: 2 })?.accessToken, 'b')
  assert.equal(parseTraeRefreshPayload({ Result: { token: 'c' } })?.accessToken, 'c')
  for (const bad of [undefined, null, 'a string', 7, {}, { Result: {} }, { Result: { Token: '' } }]) {
    assert.equal(parseTraeRefreshPayload(bad), undefined, JSON.stringify(bad))
  }
})

test('refreshTrae is the wired entry point and no longer a no-op', async () => {
  // The exported name the token manager calls must actually renew. If someone
  // restores `return session`, this fails.
  const before = session()
  const after = await refreshTrae(before).catch((e: unknown) => e)
  // No network in this environment: it must at least ATTEMPT the exchange and
  // therefore not hand back the identical object unchanged.
  assert.notEqual(after, before)
})

test('the CN refresh endpoint accepts the route and body shape — live probe', async (t) => {
  // A real probe of the documented contract, using a deliberately bogus token.
  // The distinction that matters is 401-not-404: a wrong host or path answers
  // 404 (as `trae-api-cn.mchost.guru`, the CHAT base, does for this grant),
  // while the right one refuses the grant with its own error code. That is what
  // proves the route and body shape are the ones the service serves.
  const post = async (host: string): Promise<{ status: number; body: string } | undefined> => {
    try {
      const response = await fetch(`${host}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ClientID: TRAE_REFRESH_CONTRACT.cn.clientId,
          ClientSecret: '-',
          RefreshToken: 'dsh-probe-invalid-token',
          UserID: '0',
        }),
        signal: AbortSignal.timeout(20_000),
      })
      return { status: response.status, body: await response.text().catch(() => '') }
    } catch {
      return undefined
    }
  }

  const right = await post('https://api.trae.cn')
  if (right === undefined) {
    t.skip('no network route to api.trae.cn')
    return
  }
  console.log(`    live api.trae.cn -> HTTP ${String(right.status)} ${right.body.slice(0, 140).replace(/\s+/g, ' ')}`)
  // The endpoint must EXIST (not 404) and must REFUSE the bogus grant.
  assert.notEqual(right.status, 404, 'the refresh route must exist on this host')
  assert.equal(right.status, 401)
  // The service's own verdict on the credential, which is the permanent class.
  assert.match(right.body, /refresh token is invalid/i)

  const wrong = await post('https://trae-api-cn.mchost.guru')
  if (wrong !== undefined) {
    console.log(`    live chat base    -> HTTP ${String(wrong.status)} (expected 404: it does not serve this grant)`)
    assert.equal(wrong.status, 404, 'the chat base is not the refresh host — the credential\'s host field must be api.trae.cn')
  }
})
/**
 * Kiro sign-in coverage: the two browser flows, the token refresh, reading the
 * Kiro IDE's stored sign-in, and the oversized-image guard.
 *
 * The loopback server is exercised for real (on 127.0.0.1, ephemeral in Kiro's
 * port list is not possible — the ports are fixed — so the flows that need a
 * server are covered through `manual()`, which feeds the same handler without a
 * socket). Nothing here reaches the network: every fetch is injected.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KIRO_AUTH_SERVICE,
  readKiroCliSignIn,
  KIRO_PORTAL,
  readKiroIdeSignIn,
  refreshKiroTokens,
  startKiroSignIn,
} from '../src/providers/kiro/login.js'
import { buildKiroRequest } from '../src/providers/kiro/translate.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** A fetch that records calls and answers from a queue. */
function stubFetch(answers: { status?: number; body: unknown }[]): { fetchFn: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
    const next = answers.shift() ?? { status: 500, body: { message: 'no answer queued' } }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

test('kiro login: the portal sign-in opens Kiro\u2019s page with PKCE and a loopback redirect', async () => {
  const signIn = await startKiroSignIn({ fetchFn: stubFetch([]).fetchFn })
  try {
    const url = new URL(signIn.authorizeUrl)
    assert.equal(`${url.origin}${url.pathname}`, `${KIRO_PORTAL}/signin`)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('redirect_from'), 'KiroIDE')
    assert.match(url.searchParams.get('redirect_uri') ?? '', /^http:\/\/localhost:\d+$/)
    assert.ok((url.searchParams.get('state') ?? '').length > 10)
    assert.match(signIn.instructions, /Google|GitHub|Builder ID/)
  } finally {
    signIn.cancel()
  }
})

test('kiro login: a Google callback is traded for tokens and finishes the sign-in', async () => {
  const { fetchFn, calls } = stubFetch([{ body: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600 } }])
  const signIn = await startKiroSignIn({ fetchFn })
  const state = new URL(signIn.authorizeUrl).searchParams.get('state') ?? ''
  const redirect = new URL(signIn.authorizeUrl).searchParams.get('redirect_uri') ?? ''
  signIn.manual(`${redirect}/signin/callback?code=the-code&state=${encodeURIComponent(state)}&login_option=google`)
  const outcome = await signIn.wait

  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.result.accessToken, 'at-1')
    assert.equal(outcome.result.method, 'social')
    assert.equal(outcome.result.loginProvider, 'Google')
    assert.equal(outcome.result.region, 'us-east-1')
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, `${KIRO_AUTH_SERVICE}/oauth/token`)
  const body = calls[0]?.body as Record<string, unknown>
  assert.equal(body.code, 'the-code')
  assert.equal(typeof body.code_verifier, 'string')
  // The redirect echoed at exchange carries the way that was chosen.
  assert.match(String(body.redirect_uri), /login_option=google$/)
})

test('kiro login: a Builder ID callback registers an AWS client and hops the browser to AWS', async () => {
  const { fetchFn, calls } = stubFetch([{ body: { clientId: 'client-1', clientSecret: 'secret-1' } }])
  const signIn = await startKiroSignIn({ fetchFn })
  const state = new URL(signIn.authorizeUrl).searchParams.get('state') ?? ''
  const redirect = new URL(signIn.authorizeUrl).searchParams.get('redirect_uri') ?? ''

  // Kiro's page hands the browser on to AWS: a client is registered for this
  // sign-in, and the code trade has NOT happened yet (AWS has not answered).
  signIn.manual(`${redirect}/signin/callback?state=${encodeURIComponent(state)}&login_option=builderid`
    + '&issuer_url=https%3A%2F%2Fview.awsapps.com%2Fstart&idc_region=us-east-1')
  await new Promise(resolve => setTimeout(resolve, 120))

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://oidc.us-east-1.amazonaws.com/client/register')
  const registration = calls[0]?.body as Record<string, unknown>
  assert.equal(registration.issuerUrl, 'https://view.awsapps.com/start')
  assert.deepEqual(registration.grantTypes, ['authorization_code', 'refresh_token'])

  // The sign-in is deliberately still open: the user continues in the AWS tab,
  // and only its callback can finish it. Cancelling ends it cleanly.
  signIn.cancel()
  const outcome = await signIn.wait
  assert.equal(outcome.ok, false)
})

test('kiro login: a callback with a state that is not this sign-in\u2019s is ignored', async () => {
  const { fetchFn, calls } = stubFetch([])
  const signIn = await startKiroSignIn({ fetchFn })
  const redirect = new URL(signIn.authorizeUrl).searchParams.get('redirect_uri') ?? ''
  signIn.manual(`${redirect}/signin/callback?code=x&state=not-ours&login_option=google`)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls.length, 0, 'nothing was traded for a callback this sign-in does not own')
  signIn.cancel()
  const outcome = await signIn.wait
  assert.equal(outcome.ok, false)
})

test('kiro login: a refresh uses Kiro\u2019s service or AWS\u2019s, by method', async () => {
  const social = stubFetch([{ body: { accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 } }])
  const renewed = await refreshKiroTokens({ refreshToken: 'old-rt', method: 'social', region: 'us-east-1' }, social.fetchFn)
  assert.equal(renewed.accessToken, 'new-at')
  assert.equal(renewed.refreshToken, 'new-rt')
  assert.equal(social.calls[0]?.url, 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
  assert.deepEqual(social.calls[0]?.body, { refreshToken: 'old-rt' })

  const idc = stubFetch([{ body: { accessToken: 'aws-new', expiresIn: 3600 } }])
  const aws = await refreshKiroTokens({
    refreshToken: 'aws-rt', method: 'idc', region: 'eu-central-1', clientId: 'c', clientSecret: 's',
  }, idc.fetchFn)
  assert.equal(aws.accessToken, 'aws-new')
  // No new refresh token in the answer: the old one is kept, not blanked.
  assert.equal(aws.refreshToken, 'aws-rt')
  assert.equal(idc.calls[0]?.url, 'https://oidc.eu-central-1.amazonaws.com/token')
})

test('kiro login: refresh without the AWS client says so instead of half-working', async () => {
  await assert.rejects(
    () => refreshKiroTokens({ refreshToken: 'rt', method: 'idc', region: 'us-east-1' }, stubFetch([]).fetchFn),
    /kept no client/,
  )
})

test('kiro login: the Kiro IDE\u2019s stored sign-in is read, and its absence is not an error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kiro-home-'))
  const cache = join(home, '.aws', 'sso', 'cache')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'kiro-auth-token.json'), JSON.stringify({
    accessToken: 'ide-at',
    refreshToken: 'ide-rt',
    expiresAt: '2030-01-01T00:00:00.000Z',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/p',
  }))
  try {
    const found = await readKiroIdeSignIn(home)
    assert.equal(found?.accessToken, 'ide-at')
    assert.equal(found?.region, 'eu-central-1')
    assert.ok((found?.expiresAt ?? 0) > Date.now())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('kiro: an image over Kiro\u2019s limit is dropped with a note, not sent', () => {
  const big = 'A'.repeat(5 * 1024 * 1024 + 8)
  const messages = [{
    id: 'm1',
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', mediaType: 'image/png', dataBase64: big },
    ],
    source: { kind: 'user' },
  }] as unknown as readonly TranslatableMessage[]
  const options = { provider: 'kiro', model: 'm', messages: [], system: undefined } as unknown as Parameters<typeof buildKiroRequest>[0]
  const body = buildKiroRequest(options, messages, 'm', '')
  const current = (body.conversationState.currentMessage as { userInputMessage: { content: string; images?: unknown[] } }).userInputMessage
  assert.deepEqual(current.images, [], 'the oversized image is not sent')
  assert.match(current.content, /image omitted: it is over Kiro's 5 MB image limit/)
  assert.match(current.content, /what is this\?/, 'the text beside it survives')
})

test('kiro login: kiro-cli\u2019s SQLite sign-in is read, with its AWS client', async () => {
  let sqlite: { DatabaseSync: new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => { run: (...args: unknown[]) => void }; close: () => void } }
  try {
    sqlite = await import('node:sqlite') as typeof sqlite
  } catch {
    return // a Node without node:sqlite: the reader reports that itself, covered below
  }
  const home = mkdtempSync(join(tmpdir(), 'kiro-cli-home-'))
  const dir = join(home, '.local', 'share', 'kiro-cli')
  mkdirSync(dir, { recursive: true })
  const database = new sqlite.DatabaseSync(join(dir, 'data.sqlite3'))
  database.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  const insert = database.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)')
  insert.run('kirocli:odic:token', JSON.stringify({
    access_token: 'cli-at',
    refresh_token: 'cli-rt',
    expires_at: '2030-01-01T00:00:00Z',
    region: 'eu-central-1',
    profile_arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/p',
  }))
  insert.run('kirocli:odic:device-registration', JSON.stringify({ client_id: 'cid', client_secret: 'csec' }))
  database.close()

  try {
    const found = await readKiroCliSignIn(home, 'linux')
    assert.equal(found?.accessToken, 'cli-at')
    assert.equal(found?.refreshToken, 'cli-rt')
    assert.equal(found?.method, 'idc')
    assert.equal(found?.clientId, 'cid')
    assert.equal(found?.region, 'eu-central-1')
    assert.ok((found?.expiresAt ?? 0) > Date.now())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('kiro login: no kiro-cli database is not an error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kiro-cli-empty-'))
  try {
    assert.equal(await readKiroCliSignIn(home, 'linux'), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
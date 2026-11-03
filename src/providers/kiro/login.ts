/**
 * Kiro sign-in: the browser flow, the token refresh, and reading a local sign-in.
 *
 * Kiro's own sign-in page (`app.kiro.dev/signin`) is the front door for ALL FOUR
 * ways in — Google, GitHub, AWS Builder ID and IAM Identity Center — because the
 * page itself picks the way and reports it back as `login_option` on the
 * callback. So this route starts one flow and does not ask the user to choose:
 *
 *   GET app.kiro.dev/signin?state=…&code_challenge=…&redirect_uri=http://localhost:<port>&redirect_from=KiroIDE
 *     → 302 http://localhost:<port>/signin/callback?code=…&state=…&login_option=google|github
 *       → POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token   (code + verifier)
 *     → 302 http://localhost:<port>/signin/callback?state=…&login_option=builderid|awsidc&issuer_url=…&idc_region=…
 *       → register an AWS OIDC client, 302 the browser on to AWS's /authorize
 *         → http://127.0.0.1:<port>/oauth/callback?code=…&state=…
 *           → POST https://oidc.<region>.amazonaws.com/token            (code + verifier + client)
 *
 * The two AWS ways therefore cost a SECOND round trip, and the loopback server
 * has to answer both stages — which is why this flow has its own small server
 * instead of sharing the generic `OAuthFlowManager` (that one hands back a code
 * and nothing else, and the portal stage has to hop onwards).
 *
 * A user whose browser is on another machine can paste the full address of the
 * tab it ended on: `manual()` feeds the same handler, so the sign-in finishes
 * here without that page ever loading locally.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Kiro's sign-in page and the auth service behind it. */
export const KIRO_PORTAL = 'https://app.kiro.dev'
export const KIRO_AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev'
/** AWS's personal-account sign-in issuer. */
export const KIRO_BUILDER_ID_START = 'https://view.awsapps.com/start'
/** Scopes every Kiro client asks for. */
export const KIRO_SCOPES: readonly string[] = Object.freeze([
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
])
/** Ports Kiro's page is allowed to come back to. */
export const KIRO_CALLBACK_PORTS: readonly number[] = Object.freeze([3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153])
/** How long one sign-in may take. */
export const KIRO_SIGNIN_TIMEOUT_MS = 180_000
/** The IDE's own user agent on the auth service. */
const IDE_UA = 'Kiro-Desktop/0.2.13 (darwin; arm64)'

/** AWS region shape, so a page cannot name one that is not a region. */
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/

/** The ways Kiro's page can come back with. */
const KIRO_WAYS = new Set(['google', 'github', 'builderid', 'awsidc', 'internal', 'external_idp'])

/** One finished sign-in, as this route stores it. */
export interface KiroSignInResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** `social` (Google/GitHub) or `idc` (Builder ID / Identity Center). */
  method: 'social' | 'idc'
  /** `Google` | `Github` | `BuilderId` | `Enterprise` | `Internal`. */
  loginProvider: string
  region: string
  profileArn?: string
  clientId?: string
  clientSecret?: string
}

/** A sign-in in progress. */
export interface KiroSignIn {
  /** Where to send the browser. */
  authorizeUrl: string
  /** What to tell the user to do. */
  instructions: string
  /** Resolves when the sign-in finishes or fails. */
  wait: Promise<{ ok: true; result: KiroSignInResult } | { ok: false; error: string }>
  /** Feed the full address of the tab the sign-in ended on (remote browser). */
  manual: (address: string) => void
  /** Abort and free the port. */
  cancel: () => void
}

/** POST JSON to Kiro's auth service or AWS's sign-in. */
async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': IDE_UA },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error_description?: string; message?: string; error?: string }
      detail = parsed.error_description ?? parsed.message ?? parsed.error ?? text
    } catch {
      // Keep the raw body.
    }
    throw new Error(`Kiro refused the sign-in (${response.status}): ${detail.slice(0, 200)}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

/** Epoch ms from a token answer's `expiresIn` seconds. */
function expiryOf(seconds: unknown): number {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 3600
  return Date.now() + value * 1000
}

/** Which display name a `login_option` maps to. */
function providerName(option: string): string {
  switch (option) {
    case 'google': return 'Google'
    case 'github': return 'Github'
    case 'builderid': return 'BuilderId'
    case 'awsidc': return 'Enterprise'
    case 'internal': return 'Internal'
    default: return option
  }
}

/** A tiny HTML page for the loopback tab. */
function page(ok: boolean, title: string, detail: string): string {
  const safe = detail.replace(/[<>&]/g, '')
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<title>${ok ? 'Signed in' : 'Sign-in failed'}</title></head>`
    + `<body style="font-family:sans-serif"><h1>${title}</h1><p>${safe}</p>`
    + (ok ? '<p>You can close this tab and return to DeepSeek Harness.</p>' : '')
    + '</body></html>'
}

/** Bind the first free port from Kiro's list, on 127.0.0.1. */
async function listenFirstFree(onRequest: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  for (const port of KIRO_CALLBACK_PORTS) {
    const server = createServer(onRequest)
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => { resolve(false) })
      server.listen(port, '127.0.0.1', () => { resolve(true) })
    })
    if (bound) return { server, port }
    server.close()
  }
  throw new Error("every port Kiro's sign-in comes back to is busy; close another Kiro sign-in and try again")
}

/**
 * Start a browser sign-in.
 *
 * @param options - fetch to use (injected for tests) and an optional AWS/BUI
 *   shortcut: `builderid`/`enterprise` skip Kiro's page and go straight to AWS.
 * @returns the sign-in handle.
 */
export async function startKiroSignIn(options: {
  fetchFn?: typeof fetch
  direct?: { method: 'builderid' | 'enterprise'; startUrl?: string; region?: string }
} = {}): Promise<KiroSignIn> {
  const fetchFn = options.fetchFn ?? fetch
  const state = randomBytes(24).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  /** AWS stage facts, once the portal (or the direct shortcut) has chosen it. */
  let aws: { region: string; clientId: string; clientSecret: string; provider: string; state: string; verifier: string } | undefined
  let stage: 'portal' | 'aws' | 'over' = 'portal'
  let busy = false
  let settle: (value: { ok: true; result: KiroSignInResult } | { ok: false; error: string }) => void = () => undefined
  const wait = new Promise<{ ok: true; result: KiroSignInResult } | { ok: false; error: string }>((resolve) => { settle = resolve })
  let port = 0

  const finish = (value: { ok: true; result: KiroSignInResult } | { ok: false; error: string }): void => {
    if (stage === 'over') return
    stage = 'over'
    settle(value)
  }

  /** Register an AWS client and build the authorize URL the browser hops to. */
  const startAws = async (option: string, issuerUrl: string, region: string): Promise<string> => {
    const registration = await postJson(fetchFn, `https://oidc.${region}.amazonaws.com/client/register`, {
      clientName: 'Kiro IDE',
      clientType: 'public',
      scopes: KIRO_SCOPES,
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: ['http://127.0.0.1/oauth/callback'],
      issuerUrl,
    })
    const clientId = registration.clientId
    const clientSecret = registration.clientSecret
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
      throw new Error('AWS registered no client for this sign-in')
    }
    const awsState = randomBytes(24).toString('base64url')
    const awsVerifier = randomBytes(48).toString('base64url')
    aws = {
      region,
      clientId,
      clientSecret,
      provider: providerName(option),
      state: awsState,
      verifier: awsVerifier,
    }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: `http://127.0.0.1:${port}/oauth/callback`,
      scopes: KIRO_SCOPES.join(','),
      state: awsState,
      code_challenge: createHash('sha256').update(awsVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    })
    stage = 'aws'
    busy = false
    return `https://oidc.${region}.amazonaws.com/authorize?${query.toString()}`
  }

  /** Handle one callback, from the loopback server or a pasted address. */
  const handle = async (url: URL): Promise<{ status: number; body: string; redirect?: string }> => {
    const notOurs = { status: 404, body: page(false, "This link isn't from this sign-in", 'Start the sign-in again.') }
    if (stage === 'over') return { status: 404, body: page(false, 'This sign-in is over', 'Start it again.') }
    const got = url.searchParams.get('state') ?? ''
    const portal = got === state
    const fromAws = stage === 'aws' && aws !== undefined && got === aws.state
    if (!portal && !fromAws) return notOurs
    if (busy) return { status: 409, body: page(false, 'Already finishing', 'This sign-in is finishing already.') }
    const failure = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (failure !== null && failure !== '') {
      finish({ ok: false, error: failure })
      return { status: 200, body: page(false, "Sign-in didn't finish", failure) }
    }
    try {
      if (fromAws) {
        if (url.pathname !== '/oauth/callback') return notOurs
        const code = url.searchParams.get('code')
        if (code === null || code === '') {
          finish({ ok: false, error: 'AWS sent back no code' })
          return { status: 200, body: page(false, "Sign-in didn't finish", 'AWS sent back no code') }
        }
        busy = true
        const answer = await postJson(fetchFn, `https://oidc.${aws!.region}.amazonaws.com/token`, {
          clientId: aws!.clientId,
          clientSecret: aws!.clientSecret,
          grantType: 'authorization_code',
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
          code,
          codeVerifier: aws!.verifier,
        })
        const accessToken = answer.accessToken
        if (typeof accessToken !== 'string' || accessToken === '') throw new Error('AWS sent back no token')
        finish({
          ok: true,
          result: {
            accessToken,
            refreshToken: typeof answer.refreshToken === 'string' ? answer.refreshToken : '',
            expiresAt: expiryOf(answer.expiresIn),
            method: 'idc',
            loginProvider: aws!.provider,
            region: aws!.region,
            clientId: aws!.clientId,
            clientSecret: aws!.clientSecret,
          },
        })
      } else {
        const option = url.searchParams.get('login_option') ?? ''
        if (option === 'google' || option === 'github') {
          const code = url.searchParams.get('code')
          if (code === null || code === '') throw new Error("Kiro's page sent back no code")
          busy = true
          // The redirect_uri must be the exact address Kiro sent the browser to,
          // which carries the way that was chosen.
          const redirectUri = `http://localhost:${port}${url.pathname}?login_option=${option}`
          const answer = await postJson(fetchFn, `${KIRO_AUTH_SERVICE}/oauth/token`, {
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          })
          const accessToken = answer.accessToken
          if (typeof accessToken !== 'string' || accessToken === '') throw new Error('Kiro sent back no token')
          finish({
            ok: true,
            result: {
              accessToken,
              refreshToken: typeof answer.refreshToken === 'string' ? answer.refreshToken : '',
              expiresAt: expiryOf(answer.expiresIn),
              method: 'social',
              loginProvider: providerName(option),
              region: 'us-east-1',
              ...typeof answer.profileArn === 'string' && answer.profileArn !== '' ? { profileArn: answer.profileArn } : {},
            },
          })
        } else if (option === 'builderid' || option === 'awsidc' || option === 'internal') {
          // The AWS ways: the page names the issuer and the region AWS lives in.
          const issuer = url.searchParams.get('issuer_url') ?? ''
          const region = url.searchParams.get('idc_region') ?? ''
          if (issuer === '' || region === '') throw new Error("Kiro's page didn't say where to sign in at AWS")
          if (!AWS_REGION.test(region)) throw new Error("Kiro's page named a region AWS does not have")
          if (!/^https:\/\//i.test(issuer)) throw new Error("Kiro's page named an AWS sign-in that is not an https address")
          busy = true
          const next = await startAws(option, issuer, region)
          return { status: 302, body: '', redirect: next }
        } else if (option === 'external_idp') {
          throw new Error("a company's own identity provider cannot be signed in to here; sign in with `kiro-cli login` and use the import instead")
        } else {
          throw new Error(`Kiro's page came back with a sign-in this plugin does not know (${JSON.stringify(option)})`)
        }
      }
      busy = false
      return { status: 200, body: page(true, "You're signed in", 'Kiro is connected.') }
    } catch (error) {
      busy = false
      const message = error instanceof Error ? error.message : String(error)
      finish({ ok: false, error: message })
      return { status: 200, body: page(false, "Sign-in didn't finish", message) }
    }
  }

  const { server, port: bound } = await listenFirstFree((request, response) => {
    void (async () => {
      response.setHeader('Connection', 'close')
      const url = new URL(request.url ?? '/', `http://localhost:${bound}`)
      if (url.pathname !== '/oauth/callback' && url.pathname !== '/signin/callback') {
        response.writeHead(404).end()
        return
      }
      const answer = await handle(url)
      if (answer.redirect !== undefined) {
        response.writeHead(answer.status, { Location: answer.redirect }).end()
        return
      }
      response.writeHead(answer.status, { 'Content-Type': 'text/html; charset=utf-8' }).end(answer.body)
    })()
  })
  port = bound

  const timer = setTimeout(() => {
    finish({ ok: false, error: 'the sign-in timed out' })
  }, KIRO_SIGNIN_TIMEOUT_MS)
  timer.unref?.()

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    // A late reload is told the sign-in is over rather than hanging the tab.
    setTimeout(() => { server.close() }, 2_000).unref?.()
  }
  void wait.then(close)

  let authorizeUrl: string
  let instructions: string
  if (options.direct !== undefined) {
    // A caller that already knows which AWS way it wants skips Kiro's page.
    const issuerUrl = options.direct.method === 'enterprise'
      ? String(options.direct.startUrl ?? '').trim()
      : KIRO_BUILDER_ID_START
    if (options.direct.method === 'enterprise' && !/^https:\/\//i.test(issuerUrl)) {
      finish({ ok: false, error: "enter an organization Start URL beginning with https://" })
      throw new Error("enter an organization Start URL beginning with https://")
    }
    const region = String(options.direct.region ?? 'us-east-1').trim()
    if (!AWS_REGION.test(region)) {
      finish({ ok: false, error: 'enter a valid AWS region' })
      throw new Error('enter a valid AWS region')
    }
    authorizeUrl = await startAws(options.direct.method, issuerUrl, region)
    instructions = 'Complete the AWS sign-in in your browser, then come back here.'
  } else {
    const query = new URLSearchParams({
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: `http://localhost:${port}`,
      redirect_from: 'KiroIDE',
    })
    authorizeUrl = `${KIRO_PORTAL}/signin?${query.toString()}`
    instructions = 'Sign in with Google, GitHub, AWS Builder ID or IAM Identity Center on Kiro\u2019s page.'
  }

  return {
    authorizeUrl,
    instructions,
    wait,
    manual: (address: string) => {
      void (async () => {
        let url: URL
        try {
          url = new URL(address.trim())
        } catch {
          finish({ ok: false, error: 'that is not an address; paste the full URL of the page the sign-in ended on' })
          return
        }
        const answer = await handle(url)
        // A pasted address that wants to hop to AWS is followed by the browser,
        // not here: the sign-in stays open and the user continues in the tab.
        if (answer.redirect !== undefined) return
      })()
    },
    cancel: () => {
      finish({ ok: false, error: 'the sign-in was cancelled' })
      server.close()
    },
  }
}

/**
 * Refresh a sign-in's tokens.
 *
 * Google/GitHub refresh on Kiro's auth service; Builder ID and Identity Center
 * refresh through AWS's OIDC token endpoint with the client registered at
 * sign-in time.
 *
 * @param session - the stored session.
 * @param fetchFn - fetch to use.
 * @returns the renewed fields (a new refresh token replaces the old one).
 */
export async function refreshKiroTokens(
  session: { refreshToken: string; method?: string; region?: string; clientId?: string; clientSecret?: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const region = session.region ?? 'us-east-1'
  if (session.method === 'idc') {
    if (session.clientId === undefined || session.clientSecret === undefined) {
      throw new Error('this Builder ID / Identity Center sign-in kept no client; sign in again')
    }
    const answer = await postJson(fetchFn, `https://oidc.${region}.amazonaws.com/token`, {
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      refreshToken: session.refreshToken,
      grantType: 'refresh_token',
    })
    const accessToken = answer.accessToken
    if (typeof accessToken !== 'string' || accessToken === '') throw new Error('AWS sent back no token on refresh')
    return {
      accessToken,
      refreshToken: typeof answer.refreshToken === 'string' && answer.refreshToken !== '' ? answer.refreshToken : session.refreshToken,
      expiresAt: expiryOf(answer.expiresIn),
    }
  }
  const answer = await postJson(fetchFn, `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`, {
    refreshToken: session.refreshToken,
  })
  const accessToken = answer.accessToken
  if (typeof accessToken !== 'string' || accessToken === '') throw new Error('Kiro sent back no token on refresh')
  return {
    accessToken,
    refreshToken: typeof answer.refreshToken === 'string' && answer.refreshToken !== '' ? answer.refreshToken : session.refreshToken,
    expiresAt: expiryOf(answer.expiresIn),
  }
}

/** A sign-in read off this machine. */
export interface LocalKiroSignIn {
  accessToken: string
  refreshToken: string
  expiresAt: number
  region?: string
  profileArn?: string
  /** How it refreshes: social (Kiro service) or idc (AWS OIDC). */
  method?: 'social' | 'idc'
  /** Display name of the way it was signed in. */
  loginProvider?: string
  /** AWS OIDC client, idc only. */
  clientId?: string
  clientSecret?: string
  /** Where it was read from, for the card's account label. */
  source: string
}

/** Where kiro-cli keeps its SQLite database, per platform. */
export function kiroCliDatabasePath(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'kiro-cli', 'data.sqlite3')
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  return join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3')
}

/**
 * Read kiro-cli's sign-in from its SQLite database.
 *
 * kiro-cli stores its credentials in `auth_kv` as `kirocli:<kind>:token` →
 * JSON. Three kinds exist, and each maps to a different refresh path, so the
 * kind decides `method` here exactly as it does at sign-in time:
 *
 *   - `social`  — Google/GitHub; refreshes on Kiro's auth service;
 *   - `odic`    — AWS Builder ID / Identity Center; refreshes through AWS OIDC
 *                 and needs the client from `kirocli:odic:device-registration`;
 *   - `external-idp` — a company's own IdP, which this route does NOT refresh.
 *
 * The database is opened READ-ONLY, and a Node without `node:sqlite` says so
 * instead of pretending there is no sign-in: the difference matters, because one
 * means "sign in", the other means "this runtime cannot read it".
 *
 * @param home - user home directory (injected for tests).
 * @param platform - platform to resolve the path for.
 * @returns the sign-in, or undefined when kiro-cli is not signed in.
 */
export async function readKiroCliSignIn(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<LocalKiroSignIn | undefined> {
  const path = kiroCliDatabasePath(home, platform)
  try {
    const { existsSync } = await import('node:fs')
    if (!existsSync(path)) return undefined
  } catch {
    return undefined
  }
  let database: { prepare: (sql: string) => { get: (key: string) => { value?: unknown } | undefined }; close: () => void }
  try {
    const sqlite = await import('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => typeof database }
    database = new sqlite.DatabaseSync(path, { readOnly: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`kiro: kiro-cli's sign-in lives in SQLite and this Node has no node:sqlite (${detail}); use the Kiro IDE or paste an API key`)
  }
  try {
    const read = (key: string): Record<string, unknown> | undefined => {
      const row = database.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key)
      if (row?.value === undefined || typeof row.value !== 'string') return undefined
      try {
        const parsed: unknown = JSON.parse(row.value)
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
      } catch {
        return undefined
      }
    }
    for (const kind of ['social', 'odic'] as const) {
      const token = read(`kirocli:${kind}:token`)
      const accessToken = token?.access_token
      if (typeof accessToken !== 'string' || accessToken === '') continue
      const expires = typeof token?.expires_at === 'string' ? Date.parse(token.expires_at) : Number(token?.expires_at)
      const registration = kind === 'odic' ? read('kirocli:odic:device-registration') : undefined
      return {
        accessToken,
        refreshToken: typeof token?.refresh_token === 'string' ? token.refresh_token : '',
        expiresAt: Number.isFinite(expires) ? expires : 0,
        ...typeof token?.region === 'string' && token.region !== '' ? { region: token.region } : {},
        ...typeof token?.profile_arn === 'string' && token.profile_arn !== '' ? { profileArn: token.profile_arn } : {},
        method: kind === 'social' ? 'social' : 'idc',
        loginProvider: kind === 'social' ? 'Kiro CLI' : 'BuilderId',
        ...typeof registration?.client_id === 'string' ? { clientId: registration.client_id } : {},
        ...typeof registration?.client_secret === 'string' ? { clientSecret: registration.client_secret } : {},
        source: path,
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    try { database.close() } catch { /* already closed */ }
  }
}

/**
 * Read the Kiro IDE's sign-in.
 *
 * The IDE keeps `~/.aws/sso/cache/kiro-auth-token.json`; nothing is copied, the
 * file is read where it lives. kiro-cli's store is a SQLite database, and this
 * reader deliberately does NOT open it: the hub has no SQLite dependency, and a
 * half-decoded credential is worse than a clear "sign in with the IDE instead".
 *
 * @returns the sign-in, or undefined when there is none.
 */
export async function readKiroIdeSignIn(home: string = homedir()): Promise<LocalKiroSignIn | undefined> {
  const candidates = [
    join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json'),
    join(process.env.APPDATA ?? '', 'aws', 'sso', 'cache', 'kiro-auth-token.json'),
  ].filter(path => path !== '')
  for (const path of candidates) {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        accessToken?: unknown
        refreshToken?: unknown
        expiresAt?: unknown
        region?: unknown
        profileArn?: unknown
      }
      if (typeof raw.accessToken !== 'string' || raw.accessToken === '') continue
      const expires = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : Number(raw.expiresAt)
      return {
        accessToken: raw.accessToken,
        refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : '',
        expiresAt: Number.isFinite(expires) ? expires : 0,
        ...typeof raw.region === 'string' && raw.region !== '' ? { region: raw.region } : {},
        ...typeof raw.profileArn === 'string' && raw.profileArn !== '' ? { profileArn: raw.profileArn } : {},
        source: path,
      }
    } catch {
      // Absent or unreadable: try the next location.
    }
  }
  return undefined
}

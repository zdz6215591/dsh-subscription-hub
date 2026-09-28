/**
 * JoyCode login: the browser/QR authorization flow the product itself uses.
 *
 * JoyCode signs in on its own web page, and that page can hand the resulting
 * `ptKey` straight back to whatever process started the login — `authPort` names
 * the local port, `authKey` correlates the callback with THIS attempt:
 *
 *     https://joycode.jd.com/login/?ideAppName=JoyCode&fromIde=ide&redirect=0&authPort=<port>&authKey=<key>
 *                        ↓  user scans/authorizes on that page
 *     http://127.0.0.1:<port>/api/oauth-callback?pt_key=…&login_type=…&tenant=…&authKey=…
 *
 * That is the same mechanism the JoyCode IDE uses, and it is the reference's
 * replacement for the raw JD QR flow (`qr.m.jd.com`): the reference's own
 * postmortem records that JD's `qrCodeTicketValidation` "不再通过 HTTP Set-Cookie
 * 返回 pt_key" — 14 cookies, no pt_key — so driving the product's own login page
 * (which itself shows a QR for the JD app) is the path that actually yields a
 * credential.
 *
 * A callback that cannot reach this machine — a browser on a laptop, DSH running
 * on a server — still leaves `pt_key=…` in the address bar, so the pasted text
 * is accepted by {@link parseJoyCodeCallback} as well.
 *
 * @module dsh-subscription-hub/providers/joycode/login
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The product's login page. */
export const JOYCODE_LOGIN_URL = 'https://joycode.jd.com/login/'

/** The path the login page calls back on. */
export const JOYCODE_CALLBACK_PATH = '/api/oauth-callback'

/** A login that was started and never finished is dropped after this long. */
export const JOYCODE_LOGIN_TIMEOUT_MS = 5 * 60_000

/** What the login page hands back. */
export interface JoyCodeCallback {
  ptKey: string
  /** `login_type` the page reported (`PIN`, …), when it sent one. */
  loginType?: string
  /** `tenant` the page reported, when it sent one. */
  tenant?: string
}

/**
 * The authorize URL for one attempt.
 * @param port - the local port the page should call back on.
 * @param authKey - the one-time key that identifies this attempt.
 * @returns the URL to open in a browser.
 */
export function joyCodeLoginUrl(port: number | string, authKey: string): string {
  const query = new URLSearchParams({
    ideAppName: 'JoyCode',
    fromIde: 'ide',
    redirect: '0',
    authPort: String(port),
    authKey,
  })
  return `${JOYCODE_LOGIN_URL}?${query.toString()}`
}

/**
 * Read the credential out of whatever the user or the browser handed over.
 *
 * Accepts a full callback URL, a bare query string, a JSON body, or the
 * `pt_key=…` text on its own — the last two because a browser that could not
 * reach this machine still exposes the query it was given.
 * @param text - the pasted callback text.
 * @returns the credential fields, or undefined when no pt_key was present.
 */
export function parseJoyCodeCallback(text: string): JoyCodeCallback | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const ptKey = str(parsed.pt_key) ?? str(parsed.ptKey)
      if (ptKey === undefined) return undefined
      return {
        ptKey,
        ...optional('loginType', str(parsed.login_type) ?? str(parsed.loginType)),
        ...optional('tenant', str(parsed.tenant)),
      }
    } catch {
      return undefined
    }
  }
  // A URL, a query string, or `pt_key=…` on its own all reduce to a query.
  const query = queryOf(trimmed)
  if (query === undefined) return undefined
  const ptKey = query.get('pt_key') ?? query.get('ptKey') ?? undefined
  if (ptKey === undefined || ptKey === '') return undefined
  return {
    ptKey,
    ...optional('loginType', query.get('login_type') ?? query.get('loginType') ?? undefined),
    ...optional('tenant', query.get('tenant') ?? undefined),
  }
}

/** Extract the query parameters from a URL, a bare query, or a single pair. */
function queryOf(text: string): URLSearchParams | undefined {
  const direct = /^[A-Za-z0-9_%-]+=[^\s&]*/.test(text)
  const candidates = [
    text.startsWith('http://') || text.startsWith('https://') ? text : undefined,
    // A browser that reached nothing still shows a host-less URL sometimes, and
    // a copy/paste often loses the scheme: parse those as a query on a stub host.
    `http://callback.invalid/${text.replace(/^\/+/, '')}`,
    direct ? `http://callback.invalid/?${text}` : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      if ([...url.searchParams.keys()].length > 0) return url.searchParams
    } catch { /* try the next shape */ }
  }
  const raw = new URLSearchParams(direct ? text : '')
  return [...raw.keys()].length > 0 ? raw : undefined
}

/** A running browser-login attempt. */
export interface JoyCodeBrowserLogin {
  /** The URL to open; its `authPort` is this attempt's listener. */
  authorizeUrl: string
  /** The one-time key identifying this attempt. */
  authKey: string
  /** The port the callback listener bound to. */
  port: number
  /** Resolves with the credential the login page handed back. */
  callback: Promise<JoyCodeCallback>
  /** Stop listening and reject the pending callback (user cancelled). */
  close(): void
}

/**
 * Start a browser login: bind the callback listener, then return the URL to open.
 *
 * The listener accepts only this attempt's `authKey`; a callback carrying a
 * different one is refused so a second attempt's answer cannot settle this one.
 * @param options - port (0 = ephemeral), timeout, cancellation, diagnostics.
 * @returns the attempt handle.
 * @throws {LlmError} `SERVER` when no port can be bound.
 */
export async function startJoyCodeBrowserLogin(options: {
  port?: number
  timeoutMs?: number
  signal?: AbortSignal
  onWarn?: (message: string) => void
} = {}): Promise<JoyCodeBrowserLogin> {
  const authKey = randomBytes(16).toString('hex')
  const timeoutMs = options.timeoutMs ?? JOYCODE_LOGIN_TIMEOUT_MS
  let settle: (value: JoyCodeCallback) => void = () => {}
  let fail: (reason: unknown) => void = () => {}
  const callback = new Promise<JoyCodeCallback>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // A rejected promise nobody awaits yet would crash the process.
  callback.catch(() => {})

  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const server = createServer()
  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    server.close()
  }
  const finish = (payload: JoyCodeCallback): void => {
    if (finished) return
    finished = true
    stop()
    settle(payload)
  }
  const abort = (reason: Error): void => {
    if (finished) return
    finished = true
    stop()
    fail(reason)
  }
  const onAbort = (): void => abort(new Error('login cancelled'))
  if (options.signal?.aborted === true) throw new Error('login cancelled')
  options.signal?.addEventListener('abort', onAbort, { once: true })

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(portOf(server))}`)
    const parsed = parseJoyCodeCallback(url.toString())
    if (parsed === undefined) {
      respond(response, 404, 'JoyCode', '这个地址不是登录回调地址，可以关掉这个页面。')
      return
    }
    const presented = url.searchParams.get('authKey')
    if (presented !== null && !sameKey(presented, authKey)) {
      // Another attempt's callback landed here: refuse it, and keep waiting for
      // this attempt's own answer instead of settling with someone else's key.
      options.onWarn?.('joycode: a callback arrived with a different authKey and was refused')
      respond(response, 403, 'JoyCode', '这个回调属于另一次登录，已忽略。请回到 DSH 重新发起登录。')
      return
    }
    respond(response, 200, 'JoyCode 登录成功', '凭据已收到，可以关闭这个页面并回到 DSH。')
    finish(parsed)
  })
  server.on('error', (error: Error) => abort(error))

  const preferred = options.port
  try {
    await listen(server, preferred ?? 0)
  } catch (error) {
    if (preferred !== undefined) throw error
    // An ephemeral port was refused: fall back to the port the reference's own
    // dashboard used, which the product's login page is known to accept.
    try {
      await listen(server, 34_891)
    } catch (fallbackError) {
      throw new LlmError(
        `JoyCode: could not open a local callback port for the browser login (${describe(error)}; ${describe(fallbackError)}). `
        + 'Use the ptKey paste instead.',
        'SERVER',
        { cause: fallbackError },
      )
    }
  }

  const port = portOf(server)
  timer = setTimeout(() => { abort(new Error(`JoyCode login timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
  timer.unref()
  return {
    authorizeUrl: joyCodeLoginUrl(port, authKey),
    authKey,
    port,
    callback,
    close: () => { abort(new Error('login cancelled')) },
  }
}

/** Bind a server, resolving once it is listening. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
}

/** The port a listening server bound to. */
function portOf(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

/** One short page telling the user what just happened. */
function respond(response: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font-family:system-ui;padding:40px"><h2>${title}</h2><p>${body}</p></body>`
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
}

/** Constant-time comparison of the attempt key. */
function sameKey(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

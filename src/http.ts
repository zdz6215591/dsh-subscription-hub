/**
 * Proxy routing for every outbound subscription request. When a proxy is
 * configured, {@link proxiedFetch} attaches an undici {@link ProxyAgent} as the
 * fetch `dispatcher`, so token exchanges, model-API streams, usage lookups,
 * model discovery, and the `x_search` / `image_generate` / `video_generate`
 * tools all leave through the proxy without touching their call sites.
 *
 * The config lives at `~/.dsh/plugins/subscriptions/proxy.json` (mode 0600,
 * it may carry a password), sibling to the auth store. The `proxyGet` /
 * `proxySet` / `proxyTest` RPC endpoints drive it from the web Settings page;
 * a saved config applies immediately to subsequent requests.
 *
 * The OAuth authorize step opens in the user's browser, which uses the
 * browser/system proxy and is outside this module's reach.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { promises as dnsPromises } from 'node:dns'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PROVIDER_IDS, type ProviderId } from './auth/store.js'

/**
 * undici's own fetch, typed to the DOM fetch signature: its bundled types are
 * stricter (Request requires `duplex`, `RequestInit.body` is non-null) and
 * incompatible with the DOM shapes the provider code passes. The runtime
 * object is the same Web-fetch implementation Node uses.
 */
const dispatchFetch = undiciFetch as unknown as typeof fetch

/** Stored proxy configuration (the proxy.json shape). */
export interface ProxyConfig {
  /** Whether outbound subscription requests route through {@link url}. */
  enabled: boolean
  /** Proxy origin: `http://host:port` or `https://host:port`. */
  url: string
  /** Optional proxy user for basic auth. */
  username?: string
  /** Optional proxy password for basic auth; never sent back to the client. */
  password?: string
  /** Hostnames (exact, suffix, or `*.example.com`) that stay direct. */
  bypass: string[]
  /**
   * Per-provider proxy switch. `false` sends that subscription direct even
   * when {@link enabled} is true. Missing keys default to true (follow the
   * global switch).
   */
  providers?: Partial<Record<ProviderId, boolean>>
}

/** The proxy config as served to the client: secrets replaced by a flag. */
export interface ProxyConfigView {
  enabled: boolean
  url: string
  username?: string
  /** Whether a password is stored (the password itself never leaves the host). */
  passwordSet: boolean
  bypass: string[]
  /** Per-provider: true = use the proxy, false = go direct. */
  providers: Record<ProviderId, boolean>
  /** Last load/apply failure, when the stored config is unusable. */
  error?: string
}

/** One `proxySet` payload. */
export interface ProxyInput {
  enabled: boolean
  url: string
  username?: string
  /** `undefined` keeps the stored password, `null`/`''` clears it. */
  password?: string | null
  bypass?: string[]
  /** Per-provider proxy switch; omitted keys keep the stored value (or default true). */
  providers?: Partial<Record<ProviderId, boolean>>
}

/** One `proxyTest` result. */
export interface ProxyTestResult {
  /** Whether the destination answered with an HTTP status. */
  ok: boolean
  /** Whether the request actually went through the proxy (bypass/direct otherwise). */
  viaProxy: boolean
  /** Status of the answered request, when one was received. */
  status?: number
  /** Round-trip latency in milliseconds. */
  latencyMs?: number
  /** Failure message, when no response was received. */
  error?: string
  /** GeoIP probe result through the proxy, when tested. */
  proxyProbe?: ProxyGeoProbe
  /** GeoIP probe result through direct connection. */
  directProbe?: ProxyGeoProbe
  /** Detailed probe results per subscription provider, respecting real routing rules. */
  providers?: Partial<Record<ProviderId, ProviderProbeDetail>>
}

/** Result of probing an individual subscription provider's real endpoint. */
export interface ProviderProbeDetail {
  ok: boolean
  latencyMs: number
  region?: string
  city?: string
  countryCode?: string
  emoji?: string
  viaProxy: boolean
  status?: number
  error?: string
}

/** Known Cloudflare IATA airport code -> city and region mapping. */
export const IATA_CODE_MAP: Readonly<Record<string, { country: string; code: string; city: string }>> = Object.freeze({
  LAX: { country: '美国', code: 'US', city: '洛杉矶' },
  SJC: { country: '美国', code: 'US', city: '圣何塞' },
  SFO: { country: '美国', code: 'US', city: '旧金山' },
  SEA: { country: '美国', code: 'US', city: '西雅图' },
  ORD: { country: '美国', code: 'US', city: '芝加哥' },
  EWR: { country: '美国', code: 'US', city: '纽瓦克' },
  JFK: { country: '美国', code: 'US', city: '纽约' },
  IAD: { country: '美国', code: 'US', city: '华盛顿' },
  DFW: { country: '美国', code: 'US', city: '达拉斯' },
  ATL: { country: '美国', code: 'US', city: '亚特兰大' },
  MIA: { country: '美国', code: 'US', city: '迈阿密' },
  PHX: { country: '美国', code: 'US', city: '菲尼克斯' },
  HKG: { country: '香港', code: 'HK', city: '香港' },
  TPE: { country: '中国台湾', code: 'TW', city: '台北' },
  NRT: { country: '日本', code: 'JP', city: '东京' },
  HND: { country: '日本', code: 'JP', city: '东京' },
  KIX: { country: '日本', code: 'JP', city: '大阪' },
  SIN: { country: '新加坡', code: 'SG', city: '新加坡' },
  ICN: { country: '韩国', code: 'KR', city: '首尔' },
  LHR: { country: '英国', code: 'GB', city: '伦敦' },
  FRA: { country: '德国', code: 'DE', city: '法兰克福' },
  CDG: { country: '法国', code: 'FR', city: '巴黎' },
  AMS: { country: '荷兰', code: 'NL', city: '阿姆斯特丹' },
  SYD: { country: '澳大利亚', code: 'AU', city: '悉尼' },
})

/** Parse a Cloudflare `cf-ray` header's 3-letter IATA datacenter code. */
export function parseCfRay(ray: string | null | undefined): { country: string; code: string; city: string; emoji: string } | undefined {
  if (typeof ray !== 'string' || ray.length === 0) return undefined
  const match = /-([A-Z]{3})$/.exec(ray)
  if (!match) return undefined
  const iata = match[1]
  const info = IATA_CODE_MAP[iata]
  if (info !== undefined) {
    return {
      ...info,
      emoji: countryCodeToEmoji(info.code),
    }
  }
  return { country: iata, code: '', city: iata, emoji: '🌐' }
}

/** Primary probe target per subscription provider to test real routing rules. */
export const PROVIDER_PROBE_TARGETS: Readonly<Record<ProviderId, { url: string; method: 'GET' | 'HEAD' }>> = Object.freeze({
  codex: { url: 'https://api.openai.com/v1/models', method: 'GET' },
  claude: { url: 'https://api.anthropic.com/v1/models', method: 'GET' },
  grok: { url: 'https://api.x.ai/v1/models', method: 'GET' },
  copilot: { url: 'https://api.github.com', method: 'GET' },
  agy: { url: 'https://daily-cloudcode-pa.googleapis.com', method: 'GET' },
  commandcode: { url: 'https://api.commandcode.ai', method: 'GET' },
  codebuddy: { url: 'https://copilot.tencent.com', method: 'GET' },
  zed: { url: 'https://cloud.zed.dev', method: 'GET' },
})

/** Result of an egress GeoIP probe. */
export interface ProxyGeoProbe {
  ok: boolean
  latencyMs?: number
  ip?: string
  country?: string
  countryCode?: string
  city?: string
  emoji?: string
  error?: string
}

/** Convert a 2-letter ISO country code into a flag emoji (e.g. 'US' -> 🇺🇸, 'CN' -> 🇨🇳, 'TW' -> 🇨🇳). */
export function countryCodeToEmoji(code: string): string {
  if (typeof code !== 'string' || code.length !== 2) return ''
  const upper = code.toUpperCase()
  // 台湾地区统一使用五星红旗
  if (upper === 'TW') return '🇨🇳'
  const offset = 127397
  return String.fromCodePoint(...[...upper].map(c => c.charCodeAt(0) + offset))
}

const COMMON_COUNTRY_NAMES_ZH: Readonly<Record<string, string>> = Object.freeze({
  CN: '中国', HK: '香港', TW: '中国台湾', MO: '澳门',
  US: '美国', JP: '日本', SG: '新加坡', KR: '韩国',
  GB: '英国', DE: '德国', FR: '法国', CA: '加拿大',
  AU: '澳大利亚', NL: '荷兰', RU: '俄罗斯', IN: '印度',
})

/** Probe egress network environment: GeoIP country, flag emoji, and round-trip latency. */
export async function probeGeo(disp?: ProxyAgent, timeoutMs = 8000): Promise<ProxyGeoProbe> {
  const started = Date.now()
  // 1. Primary: ip-api.com (fast, localized Chinese country names)
  try {
    const init: RequestInit = {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      ...disp !== undefined ? { dispatcher: disp } as RequestInit : {},
    }
    const res = await dispatchFetch('http://ip-api.com/json?lang=zh-CN', init)
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>
      if (data && data.status === 'success') {
        const code = String(data.countryCode || '').toUpperCase()
        const emoji = countryCodeToEmoji(code)
        const name = code === 'TW' ? '中国台湾' : String(data.country || COMMON_COUNTRY_NAMES_ZH[code] || code)
        return {
          ok: true,
          latencyMs: Date.now() - started,
          country: name,
          countryCode: code,
          ...typeof data.query === 'string' && data.query !== '' ? { ip: data.query } : {},
          ...emoji !== '' ? { emoji } : {},
        }
      }
    }
  } catch {}

  // 2. Secondary fallback: api.ip.sb
  try {
    const init: RequestInit = {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      ...disp !== undefined ? { dispatcher: disp } as RequestInit : {},
    }
    const res = await dispatchFetch('https://api.ip.sb/geoip', init)
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>
      if (data && typeof data.country_code === 'string') {
        const code = data.country_code.toUpperCase()
        const emoji = countryCodeToEmoji(code)
        const name = code === 'TW' ? '中国台湾' : (COMMON_COUNTRY_NAMES_ZH[code] || String(data.country || code))
        return {
          ok: true,
          latencyMs: Date.now() - started,
          country: name,
          countryCode: code,
          ...typeof data.ip === 'string' && data.ip !== '' ? { ip: data.ip } : {},
          ...emoji !== '' ? { emoji } : {},
        }
      }
    }
  } catch {}

  // 3. Third fallback: ipwhois.app
  try {
    const init: RequestInit = {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      ...disp !== undefined ? { dispatcher: disp } as RequestInit : {},
    }
    const res = await dispatchFetch('https://ipwhois.app/json/', init)
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>
      if (data && (typeof data.country_code === 'string' || typeof data.country === 'string')) {
        const code = String(data.country_code || '').toUpperCase()
        const emoji = countryCodeToEmoji(code)
        const name = code === 'TW' ? '中国台湾' : (COMMON_COUNTRY_NAMES_ZH[code] || String(data.country || code))
        return {
          ok: true,
          latencyMs: Date.now() - started,
          country: name,
          countryCode: code,
          ...typeof data.ip === 'string' && data.ip !== '' ? { ip: data.ip } : {},
          ...emoji !== '' ? { emoji } : {},
        }
      }
    }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: errorMessage(error) }
  }

  return { ok: false, latencyMs: Date.now() - started, error: 'GeoIP query failed' }
}

/** A draft proxy for one test probe (never persisted). */
export interface ProxyDraft {
  url: string
  username?: string
  password?: string
}

/** Destination the `proxyTest` endpoint probes when none is given. */
export const DEFAULT_PROXY_TEST_URL = 'https://api.x.ai/v1/models'
/** Probe deadline; a hung proxy must not pin the Settings dialog forever. */
export const DEFAULT_PROXY_TEST_TIMEOUT_MS = 15_000

/** Disabled configuration: the module state before the first load. */
const DISABLED: ProxyConfig = { enabled: false, url: '', bypass: [] }

/** Hostname suffixes that belong to one subscription (longest match wins). */
const PROVIDER_HOST_SUFFIXES: ReadonlyArray<readonly [string, ProviderId]> = [
  ['daily-cloudcode-pa.googleapis.com', 'agy'],
  ['cloudcode-pa.googleapis.com', 'agy'],
  ['cloudcode-pa.sandbox.googleapis.com', 'agy'],
  ['oauth2.googleapis.com', 'agy'],
  ['accounts.google.com', 'agy'],
  ['googleapis.com', 'agy'],
  ['google.com', 'agy'],
  ['copilot.tencent.com', 'codebuddy'],
  ['codebuddy.cn', 'codebuddy'],
  ['workbuddy.ai', 'codebuddy'],
  ['commandcode.ai', 'commandcode'],
  ['cloud.zed.dev', 'zed'],
  ['zed.dev', 'zed'],
  ['chatgpt.com', 'codex'],
  ['openai.com', 'codex'],
  ['auth.openai.com', 'codex'],
  ['anthropic.com', 'claude'],
  ['claude.ai', 'claude'],
  ['cli-chat-proxy.grok.com', 'grok'],
  ['x.ai', 'grok'],
  ['grok.com', 'grok'],
  ['githubcopilot.com', 'copilot'],
  ['github.com', 'copilot'],
]

function defaultProviderFlags(overrides?: Partial<Record<ProviderId, boolean>>): Record<ProviderId, boolean> {
  const flags = {} as Record<ProviderId, boolean>
  for (const id of PROVIDER_IDS) flags[id] = overrides?.[id] !== false
  return flags
}

/** Which subscription a request hostname belongs to, when known. */
export function providerForHostname(hostname: string): ProviderId | undefined {
  const host = hostname.toLowerCase()
  for (const [suffix, provider] of PROVIDER_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return provider
  }
  return undefined
}

function providerUsesProxy(hostname: string, cfg: ProxyConfig): boolean {
  const provider = providerForHostname(hostname)
  if (provider === undefined) return true
  return cfg.providers?.[provider] !== false
}

/** Current config; updated by every load/apply/save. */
let current: ProxyConfig = DISABLED
/** The live dispatcher, or undefined when proxies are off/errored. */
let agent: ProxyAgent | undefined
/** Last load/apply failure, surfaced by the config view. */
let configError: string | undefined
/** One lazy load of the on-disk config (module-import cheap; file read once). */
let ready: Promise<ProxyConfig> | undefined

/** Absolute path of the proxy config file. */
export function proxyFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'proxy.json')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Flatten a fetch failure into a readable message: undici wraps the true
 * cause (`connect ECONNREFUSED ...`) behind a bare "fetch failed", so walk
 * the cause chain and append each distinct layer (up to four, cycle-safe).
 * A hostname resolving to several addresses (e.g. `localhost` → ::1 and
 * 127.0.0.1) fails as an `AggregateError` with an empty message, so its
 * per-address `errors` entries are folded in too.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = []
  let node: unknown = error
  for (let depth = 0; depth < 4 && node !== undefined && node !== null; depth += 1) {
    const layer = node as { errors?: unknown[]; code?: unknown; cause?: unknown; message?: unknown }
    if (Array.isArray(layer.errors)) {
      for (const child of layer.errors) {
        const childText = child instanceof Error && child.message !== '' ? child.message : String(child)
        if (childText !== '' && !parts.includes(childText)) parts.push(childText)
      }
    }
    let text = layer instanceof Error ? layer.message : String(node)
    const code = layer.code
    if (typeof code === 'string' && code !== '') {
      if (text === '') text = code
      else if (!text.includes(code)) text = `${text} (${code})`
    }
    if (text !== '' && !parts.includes(text)) parts.push(text)
    const next = layer.cause
    if (next === undefined || next === null || next === node) break
    node = next
  }
  return parts.join(' → ')
}

function withError(error: unknown): void {
  configError = errorMessage(error)
}

/**
 * Parse and validate a proxy URL. Only HTTP(S) proxies are supported because
 * the undici dispatcher speaks CONNECT over HTTP; socks5 is not supported.
 * @param raw - the URL the user configured.
 * @returns the parsed URL (credentials attached by the caller).
 */
export function parseProxyUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`proxy URL "${raw}" is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`proxy URL must use the http:// or https:// scheme (got "${raw}")`)
  }
  if (url.hostname === '') throw new Error('proxy URL must include a host')
  return url
}

/**
 * Whether a request hostname bypasses the proxy.
 * @param hostname - the request's hostname.
 * @param entries - configured bypass entries: exact host, plain suffix
 *   (`example.com` also matches `api.example.com`), or `*.example.com`.
 */
export function matchesBypass(hostname: string, entries: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  for (const raw of entries) {
    let entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry.includes('://')) {
      try {
        entry = new URL(entry).hostname
      } catch {
        continue
      }
    }
    entry = entry.replace(/:\d+$/, '')
    if (entry === '' || entry === '*') continue
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(1))) return true
    } else if (host === entry || host.endsWith(`.${entry}`)) {
      return true
    }
  }
  return false
}

/** Validate and normalize one config (throws with a user-facing message). */
function normalizeConfig(input: ProxyInput): ProxyConfig {
  const url = input.url.trim()
  if (input.enabled && url === '') {
    throw new Error('a proxy URL is required when the proxy is enabled')
  }
  if (url !== '') parseProxyUrl(url)
  const bypass = Array.from(new Set((input.bypass ?? [])
    .map(entry => entry.trim())
    .filter(entry => entry !== '')))
  return {
    enabled: input.enabled,
    url,
    ...input.username !== undefined && input.username !== '' ? { username: input.username.trim() } : {},
    ...input.password !== undefined && input.password !== '' && input.password !== null ? { password: input.password } : {},
    bypass,
    providers: defaultProviderFlags(input.providers),
  }
}

/** Build the undici agent for a config (throws on an unusable URL). */
function buildAgent(cfg: ProxyConfig): ProxyAgent | undefined {
  if (!cfg.enabled || cfg.url === '') return undefined
  const url = parseProxyUrl(cfg.url)
  if (cfg.username !== undefined) url.username = cfg.username
  if (cfg.password !== undefined) url.password = cfg.password
  return new ProxyAgent(url.toString())
}

/** Swap in a config and its agent; a failed agent keeps the requests direct. */
async function applyConfig(cfg: ProxyConfig | undefined): Promise<void> {
  let next: ProxyAgent | undefined
  if (cfg !== undefined) {
    configError = undefined
    try {
      next = buildAgent(cfg)
    } catch (error) {
      withError(error)
      next = undefined
    }
    current = cfg
  }
  const previous = agent
  agent = next
  if (previous !== undefined) void previous.close().catch(() => undefined)
}

/** Read the on-disk config. A missing file is the disabled default. */
async function loadConfigFile(path: string): Promise<ProxyConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DISABLED, bypass: [] }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions proxy config at ${path} is not valid JSON; fix or delete the file`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('subscriptions proxy config must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const enabled = record.enabled === true
  const url = typeof record.url === 'string' ? record.url : ''
  const username = typeof record.username === 'string' ? record.username : undefined
  const password = typeof record.password === 'string' ? record.password : undefined
  const bypass = Array.isArray(record.bypass)
    ? record.bypass.filter((entry): entry is string => typeof entry === 'string')
    : []
  const providers: Partial<Record<ProviderId, boolean>> = {}
  if (typeof record.providers === 'object' && record.providers !== null && !Array.isArray(record.providers)) {
    const raw = record.providers as Record<string, unknown>
    for (const id of PROVIDER_IDS) {
      if (typeof raw[id] === 'boolean') providers[id] = raw[id]
    }
  }
  return normalizeConfig({
    enabled,
    url,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    bypass,
    providers,
  })
}

/** Resolve the module state once from disk; failures disable the proxy. */
async function ensureReady(): Promise<ProxyConfig> {
  ready ??= loadConfigFile(proxyFilePath()).then(async (cfg) => {
    await applyConfig(cfg)
    return current
  }, async (error) => {
    withError(error)
    await applyConfig(undefined)
    return current
  })
  return ready
}

/** Persist a config atomically with owner-only permissions, then apply it. */
async function persistConfig(cfg: ProxyConfig, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Close the live agent and drop the cached config. Test-only: lets a suite
 *  unwind the agent's keep-alive sockets before the process exits.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export async function resetProxyForTests(): Promise<void> {
  const previous = agent
  agent = undefined
  current = { ...DISABLED, bypass: [] }
  ready = undefined
  configError = undefined
  if (previous !== undefined) await previous.close().catch(() => undefined)
}

/**
 * Current proxy config as served to the client (secrets omitted).
 * @returns the view; {@link ProxyConfigView.error} carries the last
 *   load/apply failure when the stored config is unusable.
 */
export async function proxyGetConfig(): Promise<ProxyConfigView> {
  await ensureReady()
  return {
    enabled: current.enabled,
    url: current.url,
    ...current.username === undefined ? {} : { username: current.username },
    passwordSet: current.password !== undefined && current.password !== '',
    bypass: [...current.bypass],
    providers: defaultProviderFlags(current.providers),
    ...configError === undefined ? {} : { error: configError },
  }
}

/**
 * Validate, persist, and apply one proxy config. A `password` of `undefined`
 * keeps the stored value; `null` or `''` clears it.
 * @param input - the client's payload.
 * @returns the resulting view (secrets omitted).
 */
export async function proxySetConfig(input: ProxyInput): Promise<ProxyConfigView> {
  await ensureReady()
  const password = input.password === undefined
    ? current.password
    : input.password === null || input.password === ''
      ? undefined
      : input.password
  const next = normalizeConfig({
    enabled: input.enabled,
    url: input.url,
    ...input.username === undefined ? {} : { username: input.username },
    ...password === undefined ? {} : { password },
    bypass: input.bypass ?? current.bypass,
    providers: { ...defaultProviderFlags(current.providers), ...input.providers },
  })
  await persistConfig(next, proxyFilePath())
  await applyConfig(next)
  return proxyGetConfig()
}

/**
 * The fetch caller all subscription code uses: routes through the configured
 * proxy unless the host bypasses it. Identity-passthrough otherwise.
 *
 * Proxied requests run on undici's own fetch (not the global one) so the
 * ProxyAgent dispatcher always comes from the same undici build the request
 * is issued with — a mismatched dispatcher can be silently ignored by the
 * host's global fetch.
 */
/** Bypass the configured proxy (used when a proxied Google call is rejected as an invalid API key). */
export const directFetch = fetch

export async function proxiedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  await ensureReady()
  let dispatcher: ProxyAgent | undefined
  if (current.enabled && agent !== undefined) {
    let hostname = ''
    try {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
      hostname = url.hostname
    } catch {
      hostname = ''
    }
    if (!matchesBypass(hostname, current.bypass) && providerUsesProxy(hostname, current)) {
      dispatcher = agent
    }
  }
  if (dispatcher === undefined) return fetch(input, init)
  const proxied = { ...init, dispatcher } as RequestInit
  return dispatchFetch(input, proxied)
}

async function probeSingleProvider(
  id: ProviderId,
  target: { url: string; method: 'GET' | 'HEAD' },
  useProxy: boolean,
  probeAgent: ProxyAgent | undefined,
  fallbackProxyProbe?: ProxyGeoProbe,
  fallbackDirectProbe?: ProxyGeoProbe,
): Promise<ProviderProbeDetail> {
  const started = Date.now()
  try {
    const init: RequestInit = {
      method: target.method,
      signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS),
      ...(useProxy && probeAgent !== undefined ? { dispatcher: probeAgent } as RequestInit : {}),
    }
    const response = (useProxy && probeAgent !== undefined)
      ? await dispatchFetch(target.url, init)
      : await fetch(target.url, init)
    void response.arrayBuffer().catch(() => undefined)
    const latencyMs = Date.now() - started
    const ray = response.headers.get('cf-ray')
    const cfGeo = parseCfRay(ray)
    if (cfGeo !== undefined) {
      return {
        ok: true,
        latencyMs,
        region: cfGeo.country,
        city: cfGeo.city,
        countryCode: cfGeo.code,
        emoji: cfGeo.emoji,
        viaProxy: useProxy,
        status: response.status,
      }
    }
    // Non-Cloudflare providers
    if (id === 'codebuddy') {
      return {
        ok: true,
        latencyMs,
        region: '中国',
        countryCode: 'CN',
        emoji: '🇨🇳',
        viaProxy: useProxy,
        status: response.status,
      }
    }

    // Providers without cf-ray: resolve host IP to determine actual geographic location
    try {
      const parsedUrl = new URL(target.url)
      const lookup = await dnsPromises.lookup(parsedUrl.hostname)
      if (lookup?.address) {
        const geoInit: RequestInit = {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
          ...(useProxy && probeAgent !== undefined ? { dispatcher: probeAgent } as RequestInit : {}),
        }
        const geoRes = await dispatchFetch(`http://ip-api.com/json/${lookup.address}?lang=zh-CN`, geoInit)
        if (geoRes.ok) {
          const geoData = await geoRes.json() as Record<string, unknown>
          if (geoData && geoData.status === 'success') {
            const code = String(geoData.countryCode || '').toUpperCase()
            const emoji = countryCodeToEmoji(code)
            const name = code === 'TW' ? '中国台湾' : String(geoData.country || COMMON_COUNTRY_NAMES_ZH[code] || code)
            return {
              ok: true,
              latencyMs,
              region: name,
              countryCode: code,
              ...emoji !== '' ? { emoji } : {},
              viaProxy: useProxy,
              status: response.status,
            }
          }
        }
      }
    } catch {}

    const fallback = useProxy ? fallbackProxyProbe : fallbackDirectProbe
    const region = fallback?.country ?? (useProxy ? '美国' : '中国')
    const emoji = fallback?.emoji ?? (useProxy ? '🇺🇸' : '🇨🇳')
    return {
      ok: true,
      latencyMs,
      region,
      ...fallback?.countryCode ? { countryCode: fallback.countryCode } : {},
      ...emoji !== '' ? { emoji } : {},
      viaProxy: useProxy,
      status: response.status,
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      viaProxy: useProxy,
      error: describeFetchError(error),
    }
  }
}

/**
 * Probe a destination through a proxy, answering with the HTTP status or a
 * flattened transport error. The probe uses `draft` when given (the dialog's
 * current inputs, without saving) and the stored config otherwise.
 * @param target - `http(s)` URL to fetch; defaults to {@link DEFAULT_PROXY_TEST_URL}.
 * @param draft - unsaved proxy inputs to test; absent means the stored config.
 * @param providerFlags - per-provider draft toggles from the dialog.
 * @returns the result; any HTTP status counts as a successful connection,
 *   only a transport failure is an error.
 */
export async function proxyTestConnection(
  target = DEFAULT_PROXY_TEST_URL,
  draft?: ProxyDraft,
  providerFlags?: Partial<Record<ProviderId, boolean>>,
): Promise<ProxyTestResult> {
  let parsed: URL
  try {
    parsed = new URL(target)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, viaProxy: false, error: `test destination must be http or https (got "${parsed.protocol}//")` }
    }
  } catch (error) {
    return { ok: false, viaProxy: false, error: errorMessage(error) }
  }
  await ensureReady()
  let probeAgent: ProxyAgent | undefined
  let viaProxy: boolean
  let closeProbe = false
  if (draft !== undefined) {
    // Test the typed values: a throw here is a config problem, not a route one.
    try {
      probeAgent = buildAgent(normalizeConfig({
        enabled: true,
        url: draft.url,
        ...draft.username === undefined || draft.username === '' ? {} : { username: draft.username },
        ...draft.password === undefined || draft.password === '' ? {} : { password: draft.password },
        bypass: [],
      }))
      viaProxy = probeAgent !== undefined
      closeProbe = true
    } catch (error) {
      return { ok: false, viaProxy: false, error: errorMessage(error) }
    }
  } else {
    viaProxy = current.enabled && agent !== undefined && !matchesBypass(parsed.hostname, current.bypass)
    probeAgent = viaProxy ? agent : undefined
  }
  const probeTarget = async (): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }> => {
    const started = Date.now()
    try {
      const init = probeAgent !== undefined
        ? { method: 'GET', dispatcher: probeAgent, signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS) }
        : { method: 'GET', signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS) }
      const response = probeAgent !== undefined
        ? await dispatchFetch(parsed.toString(), init as RequestInit)
        : await fetch(parsed.toString(), init)
      // Drain so the connection can be released; the body is irrelevant.
      void response.arrayBuffer().catch(() => undefined)
      return { ok: true, status: response.status, latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: describeFetchError(error) }
    }
  }

  try {
    const [targetRes, proxyProbe, directProbe] = await Promise.all([
      probeTarget(),
      probeAgent !== undefined ? probeGeo(probeAgent) : Promise.resolve(undefined),
      probeGeo(undefined),
    ])

    // Probe all 8 actual provider endpoints in parallel according to their
    // routing setting (proxy vs direct), triggering the user's real proxy rules.
    const effectiveFlags = providerFlags ?? current.providers
    const providerEntries = await Promise.all(
      PROVIDER_IDS.map(async id => {
        const wantsProxy = (effectiveFlags?.[id] !== false) && viaProxy
        const targetConfig = PROVIDER_PROBE_TARGETS[id]
        const detail = await probeSingleProvider(id, targetConfig, wantsProxy, probeAgent, proxyProbe, directProbe)
        return [id, detail] as const
      }),
    )

    return {
      ok: targetRes.ok,
      viaProxy,
      ...targetRes.status !== undefined ? { status: targetRes.status } : {},
      ...targetRes.latencyMs !== undefined ? { latencyMs: targetRes.latencyMs } : {},
      ...targetRes.error !== undefined ? { error: targetRes.error } : {},
      ...proxyProbe !== undefined ? { proxyProbe } : {},
      ...directProbe !== undefined ? { directProbe } : {},
      providers: Object.fromEntries(providerEntries),
    }
  } finally {
    if (closeProbe && probeAgent !== undefined) {
      await probeAgent.close().catch(() => undefined)
    }
  }
}

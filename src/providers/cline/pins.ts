/**
 * Per-model upstream pinning for Cline.
 *
 * Cline's gateway fans a model out across several backing providers (OpenRouter
 * vendors, a Vercel-AI-Gateway planner). Which one serves a request is normally
 * the gateway's choice; this module lets the user pin that choice per model.
 *
 * The two gateway pipelines spell a pin DIFFERENTLY and a request must use the
 * spelling its pipeline understands:
 *
 *   - `direct`  (OpenRouter-backed): top-level `provider.only` / `provider.order`
 *     / `provider.sort`.
 *   - `planner` (Vercel AI Gateway): `providerOptions.gateway.only` / `.order`
 *     / `.sort`.
 *
 * An unknown pipeline gets BOTH spellings, because each pipeline ignores the
 * other's fields — so an un-detected pipeline still routes correctly.
 *
 * Two non-obvious rules carried over from the reference:
 *   - **Excludes compile into an `only` allow-list**, because the gateway
 *     ignores exclude/ignore fields outright.
 *   - **`sort` is translated per pipeline**: the user-facing metric names
 *     (`cost`/`ttft`/`tps`) are OpenRouter's `price`/`latency`/`throughput`.
 *
 * Adapted from yhshzh/dsh-cline-pass (MIT) `lib/protocol.js` + `lib/store.js`.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Which gateway pipeline served a request; decides the pin spelling. */
export type ClinePipeline = 'direct' | 'planner'

/** How a pin restricts the gateway's provider choice. */
export type ClinePinMode = 'strict' | 'preferred'

/** Sort metric, in the user-facing vocabulary. */
export type ClineSort = 'cost' | 'ttft' | 'tps' | ''

/** OpenRouter's names for the three sort metrics. */
export const OPENROUTER_SORT: Readonly<Record<string, string>> = Object.freeze({
  cost: 'price',
  ttft: 'latency',
  tps: 'throughput',
})

/** One model's upstream pin. */
export interface ClinePin {
  /** Preferred upstreams, in try order. Empty means "let the gateway choose". */
  upstreams: string[]
  /** Upstreams never to use. */
  exclude: string[]
  /** `strict` sends exactly one provider; `preferred` sends an ordered list. */
  pinMode: ClinePinMode
  /** Sort metric, or `''` for none. */
  sort: ClineSort
}

/** A pin with every field defaulted, as stored. */
export const EMPTY_PIN: ClinePin = Object.freeze({
  upstreams: [],
  exclude: [],
  pinMode: 'strict',
  sort: '',
})

/** One routing attempt: the upstream to try plus the ordering context. */
export interface ClineAttempt {
  /** The pinned upstream, or `null` for an unpinned (automatic) attempt. */
  upstream: string | null
  /** The remaining pinned upstreams, for `preferred` ordering. */
  orderRest: string[]
  /** Upstreams to exclude from this attempt. */
  excludeList: string[]
  strict: boolean
  /** Normalized wire sort value, or null when unset. */
  sort: string | null
}

/** Everything observed about one model, for the settings UI. */
export interface ClineModelMeta {
  /** Upstream slugs discovered for this model. */
  upstreams?: string[]
  /** The pipeline that served the last request, when observed. */
  pipeline?: ClinePipeline
  /** Per-upstream availability verdicts, newest last. */
  upstreamStatus?: Record<string, ClineUpstreamVerdict>
}

/** One upstream's observed availability. */
export interface ClineUpstreamVerdict {
  status: ClineUpstreamStatus
  note: string
  ms: number
  checkedAt: number
}

/** Availability verdict for one upstream. */
export type ClineUpstreamStatus = 'ok' | 'limited' | 'bad' | 'auth' | 'unknown'

/**
 * Normalize a configured sort into a wire value or `null`.
 *
 * Both an empty string and `'none'` mean "no sort" and must be dropped before
 * the request is built: the gateway rejects `sort: ""` with HTTP 400
 * (`Invalid option: expected one of "cost"|"ttft"|"tps"|...`).
 *
 * Any other non-empty value passes through untouched, so a typo is named by the
 * gateway's own diagnostic instead of being silently ignored.
 */
export function normalizeSort(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const sort = value.trim()
  return sort.length === 0 || sort === 'none' ? null : sort
}

/** Coerce a stored pin into the pinned shape (tolerating partial documents). */
export function normalizePin(raw: unknown): ClinePin {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY_PIN }
  const value = raw as Record<string, unknown>
  const list = (input: unknown, cap: number): string[] =>
    Array.isArray(input)
      ? [...new Set(input.filter((name): name is string => typeof name === 'string' && name.length > 0))].slice(0, cap)
      : []
  const mode = value.pinMode === 'preferred' ? 'preferred' : 'strict'
  const sort = value.sort
  return {
    upstreams: list(value.upstreams, 25),
    exclude: list(value.exclude, 25),
    pinMode: mode,
    sort: sort === 'cost' || sort === 'ttft' || sort === 'tps' ? sort : '',
  }
}

/**
 * Expand one model's pin into ordered failover candidates.
 *
 * A model with a non-empty (post-exclusion) pin list is tried upstream by
 * upstream; a model without one is a single automatic candidate whose excludes
 * become an allow-list.
 */
export function buildAttempts(pin: ClinePin | undefined): ClineAttempt[] {
  const config = pin ?? EMPTY_PIN
  const excluded = new Set(config.exclude)
  const wanted = config.upstreams.filter(name => !excluded.has(name))
  const strict = config.pinMode === 'strict'
  const sort = normalizeSort(config.sort)
  const base = { strict, sort, excludeList: config.exclude }
  if (wanted.length > 0) {
    return wanted.map((upstream, index) => ({
      ...base,
      upstream,
      // In `preferred` mode the other pinned upstreams ride along as the
      // gateway's own fallback order; in `strict` mode there is no fallback.
      orderRest: strict ? [] : wanted.filter((_, other) => other !== index),
    }))
  }
  return [{ ...base, upstream: null, orderRest: [] }]
}

/**
 * Write one attempt's upstream preference into a request body.
 *
 * Returns a NEW body; the caller's object is not mutated. An unknown pipeline
 * gets both spellings.
 */
export function injectPrefs(
  body: Record<string, unknown>,
  meta: ClineModelMeta | undefined,
  attempt: ClineAttempt,
): Record<string, unknown> {
  const next = { ...body }
  const { upstream, orderRest, excludeList, strict, sort } = attempt
  const excluded = excludeList.filter(name => name !== upstream)
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  // Excludes become an allow-list: the gateway ignores exclude/ignore fields.
  const allowList = excluded.length > 0 ? known.filter(name => !excluded.includes(name)) : null
  if (upstream === null && sort === null && (allowList === null || allowList.length === 0)) return next
  const pipeline = meta?.pipeline ?? null
  const useGateway = pipeline === 'planner' || pipeline === null
  const useOpenRouter = pipeline === 'direct' || pipeline === null

  if (useGateway) {
    const gateway: Record<string, unknown> = {}
    if (upstream !== null) {
      if (strict) gateway.only = [upstream]
      else {
        gateway.order = [upstream, ...orderRest]
        if (allowList !== null && allowList.length > 0) gateway.only = allowList
      }
    } else if (allowList !== null && allowList.length > 0) {
      gateway.only = allowList
    }
    if (sort !== null) gateway.sort = sort
    const existing = typeof next.providerOptions === 'object' && next.providerOptions !== null
      ? next.providerOptions as Record<string, unknown>
      : {}
    const existingGateway = typeof existing.gateway === 'object' && existing.gateway !== null
      ? existing.gateway as Record<string, unknown>
      : {}
    next.providerOptions = { ...existing, gateway: { ...existingGateway, ...gateway } }
  }

  if (useOpenRouter) {
    const provider = typeof next.provider === 'object' && next.provider !== null
      ? { ...(next.provider as Record<string, unknown>) }
      : {}
    if (upstream !== null) {
      if (strict) provider.only = [upstream]
      else {
        provider.order = [upstream, ...orderRest]
        if (allowList !== null && allowList.length > 0) provider.only = allowList
      }
    } else if (allowList !== null && allowList.length > 0) {
      provider.only = allowList
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    next.provider = provider
  }
  return next
}

/**
 * Read the routing facts out of one completed gateway response, so the pipeline
 * and the upstream that actually served the request are observable.
 */
export function parseRouting(json: unknown): {
  pipeline: ClinePipeline | null
  canonicalSlug: string | null
  finalProvider: string | null
  fallbacks: string[]
} {
  const envelope = typeof json === 'object' && json !== null ? json as Record<string, unknown> : {}
  // Some answers arrive wrapped in `{ data: { …choices } }`.
  const payload = (typeof envelope.data === 'object' && envelope.data !== null
    && Array.isArray((envelope.data as Record<string, unknown>).choices)
    ? envelope.data
    : envelope) as Record<string, unknown>
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = typeof choices[0] === 'object' && choices[0] !== null ? choices[0] as Record<string, unknown> : {}
  const message = typeof first.message === 'object' && first.message !== null
    ? first.message as Record<string, unknown>
    : {}
  const messageRouting = nested(message, ['provider_metadata', 'gateway', 'routing'])
  const payloadRouting = nested(payload, ['provider_metadata', 'gateway', 'routing'])
  const routing = messageRouting ?? payloadRouting ?? {}
  const direct = typeof payload.provider === 'string' ? payload.provider : null
  const finalProvider = typeof routing.finalProvider === 'string' ? routing.finalProvider : null
  const slug = typeof payload.model === 'string' && payload.model.includes('/') ? payload.model : null
  const fallbacks = Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : []
  return {
    pipeline: finalProvider !== null ? 'planner' : direct === null ? null : 'direct',
    canonicalSlug: typeof routing.canonicalSlug === 'string' ? routing.canonicalSlug : slug,
    finalProvider: finalProvider ?? (direct === null ? null : slugify(direct)),
    fallbacks,
  }
}

/** Read a nested object path, returning undefined when any hop is missing. */
function nested(source: Record<string, unknown>, path: readonly string[]): Record<string, unknown> | undefined {
  let node: unknown = source
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === 'object' && node !== null ? node as Record<string, unknown> : undefined
}

/** Lowercase a display name into an upstream slug. */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-')
}

/**
 * Recover the gateway's own upstream list from a routing-layer error.
 *
 * The probe channels an impossible `only` value, so the router fails BEFORE
 * spending a token and names every provider it could have used.
 */
export function extractAvailableProviders(message: string, pipeline: ClinePipeline | null): string[] | null {
  const text = String(message ?? '')
  if (pipeline === 'planner' || pipeline === null) {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match?.[1] !== undefined) {
      const tokens = match[1].split(/,\s*/).map(token => token.trim()).filter(token => /^[a-z0-9][a-z0-9-]*$/.test(token))
      if (tokens.length > 0) return tokens
    }
  }
  if (pipeline === 'direct' || pipeline === null) {
    const start = text.indexOf('{')
    if (start >= 0) {
      try {
        const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>
        const list = nested(parsed, ['error', 'metadata'])?.available_providers
        if (Array.isArray(list) && list.length > 0) return list.map(String)
      } catch { /* not JSON */ }
    }
  }
  return null
}

/** Read the tier-0 channel hint out of a planner's reasoning sentence. */
export function parseTier0(plan: string): string[] {
  const match = /([\w-]+) won tier 0 over ([^."]+)/.exec(String(plan ?? ''))
  if (match === null || match[1] === undefined || match[2] === undefined) return []
  return [...new Set([match[1], ...match[2].split(/,\s*|\s+and\s+/).map(part => part.trim()).filter(Boolean)])]
}

/** Merge upstream lists, keeping order, dropping duplicates, capped at 25. */
export function mergeUpstreams(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const seen: string[] = []
  for (const list of lists) {
    for (const name of list ?? []) {
      const value = String(name)
      if (value.length > 0 && !seen.includes(value)) seen.push(value)
    }
  }
  return seen.slice(0, 25)
}

/** Classify a pinned-request failure into one upstream availability verdict. */
export function classifyUpstreamError(message: string): ClineUpstreamStatus {
  const text = String(message ?? '')
  if (/empty response content/i.test(text)) return 'ok'
  if (/429|rate-?limited|temporarily rate/i.test(text)) return 'limited'
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(text)) return 'bad'
  if (/unauthorized|re-authenticate|401/i.test(text)) return 'auth'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Durable pin store
// ---------------------------------------------------------------------------

/** The persisted pin document: model id → pin. */
export interface ClinePinDocument {
  pins: Record<string, ClinePin>
}

export function clinePinPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'cline-pins.json')
}

async function readPins(): Promise<ClinePinDocument> {
  try {
    const raw = JSON.parse(await readFile(clinePinPath(), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { pins: {} }
    const value = (raw as Record<string, unknown>).pins
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { pins: {} }
    const pins: Record<string, ClinePin> = {}
    for (const [model, pin] of Object.entries(value as Record<string, unknown>)) {
      pins[model] = normalizePin(pin)
    }
    return { pins }
  } catch {
    return { pins: {} }
  }
}

async function writePins(document: ClinePinDocument): Promise<void> {
  const path = clinePinPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' })
  try { await chmod(tmp, 0o600) } catch { /* windows */ }
  await rename(tmp, path)
}

/**
 * Per-model pin storage plus the runtime routing observations.
 *
 * The settings split mirrors the reference: **pins persist** (they are user
 * configuration), while **discovered upstreams and verdicts are in-memory**
 * (derived data any probe can rebuild, so they are deliberately not persisted).
 */
export class ClinePinStore {
  private cached: ClinePinDocument | undefined
  private readonly meta = new Map<string, ClineModelMeta>()

  /** Load the pin document once, then serve it from cache. */
  private async document(): Promise<ClinePinDocument> {
    this.cached ??= await readPins()
    return this.cached
  }

  /** One model's pin (never undefined). */
  async pin(model: string): Promise<ClinePin> {
    return (await this.document()).pins[model] ?? { ...EMPTY_PIN }
  }

  /** Every configured pin. */
  async allPins(): Promise<Record<string, ClinePin>> {
    return { ...(await this.document()).pins }
  }

  /** Replace one model's pin; an all-empty pin removes the entry. */
  async setPin(model: string, pin: ClinePin): Promise<void> {
    const document = await this.document()
    const normalized = normalizePin(pin)
    const isEmpty = normalized.upstreams.length === 0
      && normalized.exclude.length === 0
      && normalized.sort === ''
    if (isEmpty) delete document.pins[model]
    else document.pins[model] = normalized
    await writePins(document)
  }

  /** Drop one model's pin entirely. */
  async clearPin(model: string): Promise<void> {
    const document = await this.document()
    delete document.pins[model]
    await writePins(document)
  }

  /** Discovered/observed metadata for one model (never undefined). */
  metaOf(model: string): ClineModelMeta {
    return this.meta.get(model) ?? {}
  }

  /** Every model with observed metadata, for the settings view. */
  allMeta(): (ClineModelMeta & { id: string })[] {
    return [...this.meta.entries()].map(([id, value]) => ({ id, ...value }))
  }

  /** Merge one discovery result into a model's metadata. */
  learn(model: string, patch: ClineModelMeta): void {
    const current = this.meta.get(model) ?? {}
    const next: ClineModelMeta = { ...current, ...patch }
    if (patch.upstreams !== undefined) {
      next.upstreams = mergeUpstreams(patch.upstreams)
    }
    if (patch.upstreamStatus !== undefined) {
      next.upstreamStatus = { ...(current.upstreamStatus ?? {}), ...patch.upstreamStatus }
    }
    this.meta.set(model, next)
  }

  /** Record one upstream's availability; an inconclusive verdict is dropped. */
  learnUpstream(model: string, upstream: string | null, status: ClineUpstreamStatus, note: string, ms: number): void {
    if (upstream === null || upstream === '' || status === 'unknown') return
    const current = this.meta.get(model) ?? {}
    this.meta.set(model, {
      ...current,
      upstreamStatus: {
        ...(current.upstreamStatus ?? {}),
        [upstream]: { status, note: String(note).slice(0, 200), ms, checkedAt: Date.now() },
      },
    })
  }

  /** Record the pipeline + upstream a request actually used. */
  learnRouting(model: string, routing: { pipeline: ClinePipeline | null; finalProvider: string | null; fallbacks: string[] }): void {
    if (routing.pipeline === null && routing.finalProvider === null) return
    const current = this.meta.get(model) ?? {}
    this.meta.set(model, {
      ...current,
      ...routing.pipeline === null ? {} : { pipeline: routing.pipeline },
      // The provider that served the request is proof it exists, so it seeds
      // the known list even before any probe runs.
      ...routing.finalProvider === null && routing.fallbacks.length === 0
        ? {}
        : { upstreams: mergeUpstreams(current.upstreams, [routing.finalProvider ?? ''], routing.fallbacks) },
    })
  }

  /** Forget everything observed for one model, or all models. */
  reset(model?: string): void {
    if (model === undefined) this.meta.clear()
    else this.meta.delete(model)
  }
}

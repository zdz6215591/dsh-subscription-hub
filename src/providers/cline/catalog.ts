import { normalizeInputModalities } from '../modality.js'
import type { InputModality } from '../modality.js'
/**
 * Cline (ClinePass) model catalog.
 *
 * The subscription roster comes from the official `recommended-models`
 * endpoint, and each model's metadata (context window, output cap, input
 * modalities, reasoning levels) is read from the two official catalogs rather
 * than from a hand-maintained table:
 *
 *   - **Cline's own model catalog** — `GET /ai/cline/models` (public). Every
 *     entry carries `context_length`, the per-provider `max_completion_tokens`
 *     cap and the `architecture.input_modalities`. Its ids are the underlying
 *     model slugs (`z-ai/glm-5.3`), so a `cline-pass/*` id is mapped onto them
 *     by prefix (`z-ai/`, `deepseek/`, `moonshotai/`, `minimax/`, `qwen/`,
 *     `alibaba/`, `xiaomi/`, `meta/`).
 *   - **models.dev** — the community registry the reference implementations also
 *     read. It is the only source that publishes the per-model reasoning levels
 *     (`reasoning_options[].values`).
 *
 * The roster is whatever the two official endpoints list, and each row carries
 * only what a source actually described. There is deliberately NO pinned table
 * underneath: the static `CLINE_MODEL_CATALOG` that used to sit here was unioned
 * into the live roster — so invented ids appeared available even when both reads
 * succeeded — and served as the entire answer on a total outage, which made a
 * broken route indistinguishable from a healthy one. A model no source describes
 * now yields NO row, and the caller reports the gap instead of filling it.
 *
 * Ported from yhshzh/dsh-cline-pass (MIT) `lib/catalog.js`,
 * GooDAnDReaDY/dsh-clinebot (MIT) `lib/models.js`, and
 * munmunjaklin458-afk/cline-pass-switcher (MIT) `fetchOfficialModels`.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../../http.js'
import type { FetchFn } from '../common.js'

/** Default Cline gateway base. */
export const CLINE_BASE_URL = 'https://api.cline.bot/api/v1'

/** Public (unauthenticated) endpoint listing the subscription roster. */
export const CLINE_RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'

/** Public (unauthenticated) endpoint carrying the full model metadata catalog. */
export const CLINE_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/models'

/** Community registry publishing per-model reasoning levels. */
export const CLINE_MODELS_DEV_URL = 'https://models.dev/api.json'

/** Model-id prefix every Cline subscription model carries. */
export const CLINE_MODEL_PREFIX = 'cline-pass/'

/** Selectable reasoning levels, used only when a source does not disclose them. */
export const CLINE_EFFORTS: readonly string[] = Object.freeze([
  'none', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** Where one catalog row's metadata came from. */
export type ClineCatalogSource = 'cline' | 'models.dev' | 'static'

/** One catalog entry. */
export interface ClineModel {
  /** Full wire id, `cline-pass/<slug>`. */
  id: string
  name: string
  /**
   * Advertised context window. ABSENT when no source described the model — the
   * field used to be a required number defaulted to 200000, which presented an
   * invented window as the model's own.
   */
  contextWindow?: number
  /** Advertised output cap; absent when no source described it. */
  maxTokens?: number
  input: InputModality[]
  /**
   * Whether the gateway accepts a `reasoning_effort` for it at all. Absent when
   * no source said — offering levels on a guess risks a rejected turn.
   */
  reasoning?: boolean
  /**
   * Selectable reasoning levels. Absent means "not disclosed" — the adapter
   * then offers the gateway-wide list rather than hiding levels that do work.
   */
  efforts?: readonly string[]
  /** Source the row's metadata came from. */
  source: ClineCatalogSource
}

/**
 * Models whose underlying catalog slug cannot be derived from the subscription
 * id by provider prefix alone.
 */
const CLINE_SLUG_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'muse-spark-1.3-contributor': 'meta/muse-spark-1.3-contributor',
})

/** Provider namespaces Cline's gateway resolves a bare model slug through. */
const CLINE_SLUG_NAMESPACES: readonly string[] = Object.freeze([
  'z-ai', 'zai', 'deepseek', 'moonshotai', 'minimax', 'qwen', 'alibaba', 'xiaomi', 'meta', 'openai', 'anthropic',
])

/** Normalize one model id to the `cline-pass/<slug>` spelling. */
function normalizeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  if (!id.startsWith(CLINE_MODEL_PREFIX)) return undefined
  if (!/^cline-pass\/[a-z0-9._-]+$/.test(id)) return undefined
  return id
}

/** Read the ids out of Cline's recommended-models groups. */
export function parseRecommendedModels(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const root = payload as Record<string, unknown>
  const data = typeof root.data === 'object' && root.data !== null ? root.data as Record<string, unknown> : undefined
  const groups = [root.clinePass, data?.clinePass]
  const ids: string[] = []
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const entry of group) {
      const raw = typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>).id
          : undefined
      const id = normalizeId(raw)
      if (id !== undefined && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/** Parse the gateway's own `/models` list, keeping only prefixed ids. */
export function parseGatewayModels(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const root = payload as Record<string, unknown>
  const data = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : []
  const ids: string[] = []
  for (const entry of data) {
    const raw = typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>).id
        : undefined
    const id = normalizeId(raw)
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** Map an `architecture.input_modalities` list onto harness modalities. */
function inputModalities(value: unknown): InputModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  // Text is IMPLIED rather than declared here: every model in this catalog
  // answers in text, and the upstream list names only the extra modalities.
  const declared = normalizeInputModalities(value) ?? []
  return ['text', ...declared.filter(modality => modality !== 'text')]
}

/**
 * Read one `cline-pass/*` row out of Cline's own model catalog.
 *
 * The catalog lists the underlying model slugs, so a subscription id is mapped
 * onto its slug by provider namespace. Nothing is invented: a model the catalog
 * does not describe simply yields no row, and the next source is consulted.
 */
export function parseClineCatalogEntry(clinePassId: string, catalog: unknown): Partial<ClineModel> | undefined {
  if (!isRecord(catalog)) return undefined
  const entries = Array.isArray(catalog.data) ? catalog.data : []
  const slug = clinePassId.slice(CLINE_MODEL_PREFIX.length)
  const override = CLINE_SLUG_OVERRIDES[slug]
  const candidates = override === undefined
    ? [...CLINE_SLUG_NAMESPACES.map(namespace => `${namespace}/${slug}`), slug]
    : [override, ...CLINE_SLUG_NAMESPACES.map(namespace => `${namespace}/${slug}`)]
  const byId = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id !== '') byId.set(id, entry)
  }
  let entry: Record<string, unknown> | undefined
  for (const candidate of candidates) {
    entry = byId.get(candidate)
    if (entry !== undefined) break
  }
  if (entry === undefined) return undefined

  const contextWindow = positiveNumber(entry.context_length)
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined
  const maxTokens = positiveNumber(topProvider?.max_completion_tokens)
  const input = inputModalities(isRecord(entry.architecture) ? entry.architecture.input_modalities : undefined)
  const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
  const reasoning = supported.some(parameter => parameter === 'reasoning_effort' || parameter === 'reasoning')
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { input },
    reasoning,
    source: 'cline',
  }
}

/** Read the reasoning levels models.dev publishes for one `cline-pass/*` id. */
export function parseModelsDevEfforts(clinePassId: string, registry: unknown): Partial<ClineModel> | undefined {
  if (!isRecord(registry)) return undefined
  const providers = isRecord(registry.providers) ? registry.providers : registry
  const provider = isRecord(providers) ? providers['cline-pass'] : undefined
  if (!isRecord(provider)) return undefined
  const models = isRecord(provider.models) ? provider.models : undefined
  const entry = models === undefined ? undefined : models[clinePassId]
  if (!isRecord(entry)) return undefined

  const options = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : []
  const efforts: string[] = []
  for (const option of options) {
    const values = isRecord(option) && Array.isArray(option.values) ? option.values : []
    for (const value of values) {
      if (typeof value !== 'string' || value === '') continue
      const normalized = value.trim().toLowerCase()
      if (!efforts.includes(normalized)) efforts.push(normalized)
    }
  }
  const limit = isRecord(entry.limit) ? entry.limit : undefined
  const contextWindow = positiveNumber(limit?.context)
  const maxTokens = positiveNumber(limit?.output)
  const modalities = isRecord(entry.modalities) ? entry.modalities : undefined
  const inputRaw = Array.isArray(modalities?.input) ? modalities.input : undefined
  // models.dev names `video` and `pdf` for a real set of models, and this used to
  // collapse all three onto `image` — so a reader could not tell a model that
  // accepts a screenshot from one that accepts a screen recording. The shared
  // normalizer keeps `video` as video and folds `pdf` onto `file`.
  const input = inputRaw === undefined ? undefined : normalizeInputModalities(inputRaw)
  const reasoning = entry.reasoning === true || efforts.length > 0
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { input },
    ...efforts.length === 0 ? {} : { efforts: ['none', ...efforts.filter(effort => effort !== 'none')] },
    reasoning,
    source: 'models.dev',
  }
}

/**
 * Merge the discovered metadata for one id.
 *
 * There is no static base row any more: every field comes from a source that
 * actually described this id, and a field no source described stays ABSENT. The
 * id and its display name are the only facts guaranteed here — the id came from
 * Cline's own roster, and the name is derived from that id rather than invented.
 */
export function mergeClineModel(id: string, live: { cline?: Partial<ClineModel>; modelsDev?: Partial<ClineModel> }): ClineModel {
  // models.dev publishes the reasoning levels and wins where both speak;
  // Cline's own catalog fills whatever it leaves out.
  const dev = live.modelsDev ?? {}
  const own = live.cline ?? {}
  const efforts = dev.efforts ?? own.efforts
  const contextWindow = dev.contextWindow ?? own.contextWindow
  const maxTokens = dev.maxTokens ?? own.maxTokens
  const reasoning = dev.reasoning ?? own.reasoning
  return {
    id,
    name: own.name ?? dev.name ?? displayNameOf(id),
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    // Text is the only modality that can be assumed for a request the harness
    // may send; an extra modality is a claim and is only ever read.
    input: own.input ?? dev.input ?? ['text'],
    ...reasoning === undefined ? {} : { reasoning },
    ...efforts === undefined ? {} : { efforts },
    source: dev.contextWindow !== undefined || dev.efforts !== undefined
      ? 'models.dev'
      : own.contextWindow !== undefined ? 'cline' : 'static',
  }
}

/** The display name derived from a `cline-pass/<slug>` wire id. */
function displayNameOf(id: string): string {
  return id.startsWith(CLINE_MODEL_PREFIX)
    ? id.slice(CLINE_MODEL_PREFIX.length).replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
    : id
}

/** Project one catalog model into the harness model-info shape. */
export function toClineModelInfo(model: ClineModel, provider: string): LlmModelInfo {
  // NO price is shown, and that is a DELIBERATE finding rather than an omission.
  //
  // models.dev publishes a `cost` block for cline-pass and the numbers look like
  // prices, but they are not Cline's. Two independent checks say so:
  //
  //   1. models.dev's cline-pass costs are IDENTICAL to the figures it lists for
  //      other resellers of the same models (nano-gpt, empiriolabs,
  //      llmgateway-providers, perplexity-agent) — so they are the upstream
  //      vendor's list price copied into the registry, not what this channel
  //      charges.
  //   2. Cline publishes no per-token price anywhere: neither its ClinePass docs
  //      nor its pricing page contains a single currency figure. ClinePass is sold
  //      as a subscription, so a per-token rate is not a fact it states at all.
  //
  // Presenting a third party's list price as this channel's rate would be a
  // fabricated figure, which is worse than none, so this route shows none.
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: [...model.input],
  }
}

/**
 * A model id this plugin recognizes, carrying ONLY what was read about it.
 *
 * Dropping an id the pinned table never knew would hide a model the user is
 * paying for, so the id and its derived display name are kept. Nothing else is:
 * this used to attach a 200000 window, a 32000 cap and `reasoning: true` to
 * every unrecognized id, which presented three invented capabilities as the
 * model's own and also offered it a reasoning selector it may reject. An id no
 * source described now resolves to an entry with no capability claims at all,
 * and the settings list shows those fields as not fetched.
 * @param id - the `cline-pass/<slug>` wire id.
 * @returns the row, with every unread capability ABSENT.
 */
export function clineModel(id: string): ClineModel {
  return {
    id,
    name: displayNameOf(id),
    input: ['text'],
    source: 'static',
  }
}

/** Read one JSON document, returning undefined on any failure. */
async function readJson(url: string, fetchFn: FetchFn, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    const response = await fetchFn(url, { headers, signal: signal ?? AbortSignal.timeout(20_000) })
    if (!response.ok) return undefined
    return await response.json() as unknown
  } catch {
    return undefined
  }
}

/**
 * Read the live catalog from the official sources.
 *
 * The roster id set is the union of the recommended list and the gateway's own
 * `/models`, so a model the recommendation endpoint lags behind is still
 * offered. The pinned table is NO LONGER added underneath: it used to be unioned
 * in, which meant ids nobody currently serves were listed as available even when
 * both reads succeeded, and it also became the entire answer on a total outage.
 * An empty roster is returned as empty, so the caller can say the read failed.
 */
export async function discoverClineModels(
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
  fetchFn: FetchFn = proxiedFetch,
): Promise<ClineModel[]> {
  const [recommended, gateway, catalog, registry] = await Promise.all([
    readJson(CLINE_RECOMMENDED_URL, fetchFn, { accept: 'application/json' }, signal),
    readJson(`${baseUrl.replace(/\/+$/, '')}/models`, fetchFn, { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal),
    readJson(CLINE_MODELS_URL, fetchFn, { accept: 'application/json' }, signal),
    readJson(CLINE_MODELS_DEV_URL, fetchFn, { accept: 'application/json' }, signal),
  ])

  const ids: string[] = []
  for (const id of [...parseRecommendedModels(recommended), ...parseGatewayModels(gateway)]) {
    if (!ids.includes(id)) ids.push(id)
  }
  // Nothing was listed: report an empty roster rather than a substituted one.
  if (ids.length === 0) return []

  const models: ClineModel[] = []
  for (const id of ids) {
    const own = parseClineCatalogEntry(id, catalog)
    const dev = parseModelsDevEfforts(id, registry)
    models.push(mergeClineModel(id, {
      ...own === undefined ? {} : { cline: own },
      ...dev === undefined ? {} : { modelsDev: dev },
    }))
  }
  return models
}

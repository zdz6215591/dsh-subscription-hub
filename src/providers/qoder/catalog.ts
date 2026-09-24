/**
 * Qoder model catalog: wire normalization, discovery merge, and the fallback list.
 *
 * The live catalog is the authority on what an account can actually call, but
 * three of its fields need interpretation before they can drive a request:
 * `context_config` is a map of tiers rather than one budget, `thinking_config`
 * carries BOTH an enabled and a disabled default, and `price_factor` is a free
 * number. Each is normalized here, deterministically, with conflicts reported
 * rather than guessed at.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect` `src/qoder/catalog.ts` (MIT),
 * keeping its separation between the EFFECTIVE input budget (`contextWindow`,
 * which a subscriber's tier may reduce) and the LARGEST known capacity
 * (`maxContextWindow`), because request tiering depends on the former and the
 * settings UI on the latter.
 *
 * `fetchQoderModels` — the catalog read itself — is the reference's
 * `src/qoder/transport/catalog-reader.ts` folded in here, matching the hub's
 * own `catalog.ts` shape (see `providers/trae/catalog.ts`).
 *
 * @module dsh-subscription-hub/providers/qoder/catalog
 */

import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../../http.js'
import { buildAuthHeaders } from './cosy.js'
import type { CosyCredentials } from './cosy.js'
import {
  qoderError,
  qoderHttpError,
  qoderRequestId,
  QODER_ABORTED_CODE,
  QODER_PROTOCOL_ERROR_CODE,
  QODER_TRANSPORT_CODE,
} from './errors.js'
import { redactLogPayload, redactLogValue } from './logging.js'
import type { QoderLogger } from './logging.js'
import { getQoderModelListUrl } from './region.js'
import type { QoderRegion } from './region.js'
import {
  defaultMaxErrorBytes,
  defaultMaxJsonBytes,
  defaultMetadataTimeoutMs,
  readLimitedText,
  withDeadline,
} from './request.js'

/** One normalized Qoder model. */
export interface QoderCatalogModel {
  id: string
  name: string
  description?: string
  /** Effective input budget, which may be smaller than the provider default tier. */
  contextWindow?: number
  /** Largest known capacity, independent of the effective input budget. */
  maxContextWindow?: number
  maxTokens?: number
  source?: string
  isReasoning?: boolean
  supportsEffort?: boolean
  reasoningEfforts?: Array<{
    id: string
    name: string
    description?: string
  }>
  defaultReasoningEffort?: string
  priceFactor?: number
  contextOptions?: Record<string, { tokenCount?: number; isDefault?: boolean }>
  supportsImages?: boolean
}

interface QoderModelEntry {
  key?: unknown
  enable?: unknown
  display_name?: unknown
  max_input_tokens?: unknown
  max_output_tokens?: unknown
  context_config?: unknown
  is_reasoning?: unknown
  thinking_config?: unknown
  source?: unknown
  price_factor?: unknown
  is_vl?: unknown
}

const discoveredMetadataKeys = [
  'description',
  'source',
  'isReasoning',
  'supportsEffort',
  'reasoningEfforts',
  'defaultReasoningEffort',
  'priceFactor',
  'contextOptions',
  'maxContextWindow',
  'supportsImages',
] as const satisfies readonly (keyof QoderCatalogModel)[]

const reasoningEffortOrder = new Map([
  ['low', 0],
  ['medium', 1],
  ['high', 2],
  ['xhigh', 3],
  ['max', 4],
])

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function contextOptionsOf(value: unknown): QoderCatalogModel['contextOptions'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const options: NonNullable<QoderCatalogModel['contextOptions']> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as { token_count?: unknown; is_default?: unknown }
    const tokenCount = positiveNumber(entry.token_count)
    const isDefault = typeof entry.is_default === 'boolean' ? entry.is_default : undefined
    if (tokenCount === undefined) continue
    options[key] = {
      ...tokenCount === undefined ? {} : { tokenCount },
      ...isDefault === undefined ? {} : { isDefault },
    }
  }
  if (Object.keys(options).length === 0) return undefined
  return options
}

function reasoningEffortsOf(value: unknown): {
  efforts?: NonNullable<QoderCatalogModel['reasoningEfforts']>
  defaultEffort?: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const enabled = (value as { enabled?: unknown }).enabled
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) return {}
  const rawEfforts = (enabled as { efforts?: unknown }).efforts
  if (typeof rawEfforts !== 'object' || rawEfforts === null || Array.isArray(rawEfforts)) return {}
  const efforts: NonNullable<QoderCatalogModel['reasoningEfforts']> = []
  let defaultEffort: string | undefined
  for (const [id, raw] of Object.entries(rawEfforts)) {
    if (!id.trim() || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as { description?: unknown; is_default?: unknown }
    efforts.push({
      id,
      name: id,
      ...typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.trim() }
        : {},
    })
    if (entry.is_default === true) defaultEffort = id
  }
  return {
    ...efforts.length === 0
      ? {}
      : {
          efforts: efforts.sort((left, right) =>
            (reasoningEffortOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
            - (reasoningEffortOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)),
        },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/** Why a catalog conflict was reported to the caller. */
export type CatalogConflict = 'context-defaults' | 'thinking-defaults'

function thinkingDefault(value: unknown, fallback: boolean, onConflict?: (conflict: CatalogConflict) => void): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback
  const config = value as Record<string, unknown>
  const isDefault = (entry: unknown): boolean => typeof entry === 'object' && entry !== null
    && !Array.isArray(entry) && (entry as { is_default?: unknown }).is_default === true
  const enabled = isDefault(config.enabled)
  const disabled = isDefault(config.disabled)
  if (enabled && disabled) onConflict?.('thinking-defaults')
  return enabled === disabled ? fallback : enabled
}

/**
 * Normalize the `model/list` payload into the models the account can call.
 *
 * Accepts only the `assistant` array — `chat` advertises a different product's
 * models and is deliberately ignored — and only entries with `enable: true`.
 * @param payload - the parsed `model/list` body.
 * @param onConflict - called with the kind of contradiction found, when the
 *   payload declares more than one default context tier or both a default
 *   enabled and a default disabled thinking state.
 * @returns the enabled, de-duplicated models in payload order.
 */
export function normalizeQoderModels(
  payload: unknown,
  onConflict?: (conflict: CatalogConflict) => void,
): QoderCatalogModel[] {
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { assistant?: unknown }).assistant)) return []
  const models: QoderCatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of (payload as { assistant: QoderModelEntry[] }).assistant) {
    if (typeof raw !== 'object' || raw === null || raw.enable !== true) continue
    const id = typeof raw.key === 'string' ? raw.key.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const contextOptions = contextOptionsOf(raw.context_config)
    const defaultOptions = Object.values(contextOptions ?? {}).filter(option => option.isDefault && option.tokenCount !== undefined)
    if (defaultOptions.length > 1) onConflict?.('context-defaults')
    const contextWindow = (defaultOptions.length === 1 ? defaultOptions[0]?.tokenCount : undefined)
      ?? positiveNumber(raw.max_input_tokens) ?? 180_000
    const maxContextWindow = Math.max(
      positiveNumber(raw.max_input_tokens) ?? 0,
      contextWindow,
      ...Object.values(contextOptions ?? {}).map(option => option.tokenCount ?? 0),
    )
    const isReasoning = thinkingDefault(raw.thinking_config, raw.is_reasoning === true, onConflict)
    const priceFactor = typeof raw.price_factor === 'number' && Number.isFinite(raw.price_factor) && raw.price_factor >= 0
      ? raw.price_factor : undefined
    const reasoning = reasoningEffortsOf(raw.thinking_config)
    models.push({
      id,
      name: typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name.trim() : id,
      contextWindow,
      maxContextWindow,
      maxTokens: positiveNumber(raw.max_output_tokens) ?? 32_768,
      source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'system',
      isReasoning,
      supportsEffort: reasoning.efforts !== undefined,
      supportsImages: raw.is_vl === true,
      ...reasoning.efforts === undefined ? {} : { reasoningEfforts: reasoning.efforts },
      ...reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: reasoning.defaultEffort },
      ...priceFactor === undefined ? {} : { priceFactor },
      ...contextOptions === undefined ? {} : { contextOptions },
    })
  }
  disambiguateNames(models)
  return models
}

/**
 * Append the wire key to a display name that does not identify its model.
 *
 * Upstream publishes `DeepSeek-Flash` with NO version, while its own sibling
 * `DeepSeek-V4-Pro` carries one — and DeepSeek genuinely ships a V4-Flash AND a
 * V4.1-Flash, so the name alone leaves a reader unable to tell which model the row
 * is. The version cannot be recovered from the payload (the row carries no such
 * field, and its `icon`, `original_price_factor` and `minimal_version` say nothing
 * about it), so nothing here is inferred: the row is labelled with the exact
 * `key` the upstream uses, which is the one identifier that IS authoritative.
 *
 * The rule fires narrowly. Models are grouped by the token before their first
 * separator — `DeepSeek-Flash` and `DeepSeek-V4-Pro` share the family
 * `DeepSeek` — and a name is decorated only when it carries NO digit while a
 * sibling in the same family does. Names that version themselves
 * (`GLM-5.3`, `GLM-5.3-Flash`, `Qwen3.8-Max`) and families with a single member
 * (`Auto`, `MiniMax-M2.7`) are left exactly as upstream wrote them.
 * @param models - the normalized catalog, mutated in place.
 */
export function disambiguateNames(models: QoderCatalogModel[]): void {
  const familyOf = (name: string): string => name.split(/[-_ /]/)[0]?.toLowerCase() ?? ''
  const hasDigit = (name: string): boolean => /[0-9]/.test(name)
  const families = new Map<string, QoderCatalogModel[]>()
  for (const model of models) {
    const family = familyOf(model.name)
    if (family === '') continue
    const bucket = families.get(family)
    if (bucket === undefined) families.set(family, [model])
    else bucket.push(model)
  }
  for (const bucket of families.values()) {
    if (bucket.length < 2) continue
    if (!bucket.some(model => hasDigit(model.name))) continue
    for (const model of bucket) {
      if (hasDigit(model.name) || model.name.includes(`(${model.id})`)) continue
      model.name = `${model.name} (${model.id})`
    }
  }
}

/**
 * Overlay freshly discovered capability metadata onto the configured catalog.
 *
 * The configured entry keeps its identity and any tighter input budget; every
 * DISCOVERED metadata key is replaced wholesale (never merged field by field),
 * so a capability the provider stopped advertising disappears instead of
 * lingering from an earlier sweep.
 * @param configured - the user's configured models.
 * @param discovered - the live catalog.
 * @returns a new list, one entry per configured model.
 */
export function mergeQoderDiscoveryMetadata(
  configured: readonly QoderCatalogModel[],
  discovered: readonly QoderCatalogModel[],
): QoderCatalogModel[] {
  const catalog = new Map(discovered.map(model => [model.id, model]))
  return configured.map((model) => {
    const advertised = catalog.get(model.id)
    if (advertised === undefined) return { ...model }

    const merged = { ...model }
    if (advertised.contextWindow !== undefined) {
      merged.contextWindow = Math.min(model.contextWindow ?? advertised.contextWindow, advertised.contextWindow)
    }
    for (const key of discoveredMetadataKeys) delete merged[key]
    for (const key of discoveredMetadataKeys) {
      if (advertised[key] !== undefined) Object.assign(merged, { [key]: advertised[key] })
    }
    return merged
  })
}

/**
 * Whether two catalogs agree on every discovered metadata key.
 * @param left - the current catalog, or undefined when nothing is known yet.
 * @param right - the freshly merged catalog.
 * @returns true when no metadata changed, so persistence can be skipped.
 */
export function hasSameQoderDiscoveryMetadata(
  left: readonly QoderCatalogModel[] | undefined,
  right: readonly QoderCatalogModel[],
): boolean {
  return left?.length === right.length && left.every((model, index) => {
    const candidate = right[index]
    return candidate?.id === model.id && candidate.contextWindow === model.contextWindow && discoveredMetadataKeys.every(key => (
      JSON.stringify(model[key]) === JSON.stringify(candidate[key])
    ))
  })
}

/** Per-request output cap assumed when a model's catalog entry omits one. */
export const defaultMaxTokens = 32_768

/** The catalog used before the first successful discovery (and when discovery is off). */
export const defaultModels: QoderCatalogModel[] = [
  {
    id: 'cmodel',
    name: 'Cantus (Qoder)',
    description: 'Default Global Qoder subscription model for quick validation',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
    supportsImages: true,
  },
  {
    id: 'auto',
    name: 'Qoder Auto',
    description: 'Server-routed Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
    supportsImages: true,
  },
  {
    id: 'ultimate',
    name: 'Qoder Ultimate',
    description: 'Highest-capability Global Qoder model pool',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
    supportsImages: true,
  },
  {
    id: 'performance',
    name: 'Qoder Performance',
    description: 'Performance-oriented Global Qoder model pool',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
    supportsImages: true,
  },
  {
    id: 'efficient',
    name: 'Qoder Efficient',
    description: 'Efficiency-oriented Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
    supportsImages: true,
  },
  {
    id: 'lite',
    name: 'Qoder Lite',
    description: 'Basic Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
]

/** Tuning for one catalog read. */
export interface FetchQoderModelsOptions {
  /** Fetcher to use; defaults to the hub's proxy-aware fetch. */
  fetchFn?: typeof fetch | undefined
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
  /** Which deployment to read. */
  region?: QoderRegion | undefined
  /** Diagnostic sink. */
  logger?: QoderLogger | undefined
  /** Deadline for the whole read; defaults to {@link defaultMetadataTimeoutMs}. */
  timeoutMs?: number | undefined
}

/**
 * Read and normalize the model catalog exposed to one subscriber.
 *
 * The read is COSY-signed but carries no body, so `Encode=1` is irrelevant
 * here: the response is plain JSON.
 * @param credentials - the account identity and job token to sign with.
 * @param options - fetcher, region, deadline and diagnostics.
 * @returns the enabled models, in catalog order.
 * @throws LlmError `TRANSPORT` for a network failure or unparseable body,
 *   `TIMEOUT` when the deadline fired, `ABORTED` when the caller cancelled,
 *   `EMPTY_RESPONSE` when the catalog advertised nothing enabled, and the
 *   status-mapped code for a non-2xx answer.
 */
export async function fetchQoderModels(
  credentials: CosyCredentials,
  options: FetchQoderModelsOptions = {},
): Promise<QoderCatalogModel[]> {
  const url = getQoderModelListUrl(options.region)
  const fetchImpl = options.fetchFn ?? proxiedFetch
  const startedAt = performance.now()
  const deadline = withDeadline(options.signal, options.timeoutMs ?? defaultMetadataTimeoutMs)
  options.logger?.debug?.('[Qoder Models] Requesting model catalog', { url })
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...buildAuthHeaders(null, url, credentials) },
      signal: deadline.signal,
    })
    options.logger?.debug?.('[Qoder Models] Catalog request completed', {
      url,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
    })
    const text = await readLimitedText(
      response,
      response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
      'Qoder model discovery response',
    )
    if (!response.ok) {
      options.logger?.error?.('[Qoder Models] Catalog request failed', redactLogPayload(text))
      throw qoderHttpError(
        `Qoder model discovery failed with HTTP status ${response.status}.`,
        { status: response.status, headers: response.headers, ...text.length === 0 ? {} : { body: text } },
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw qoderError('Qoder model discovery returned invalid JSON.', QODER_PROTOCOL_ERROR_CODE)
    }
    const models = normalizeQoderModels(payload, (conflict) => {
      options.logger?.warn?.('[Qoder Models] Conflicting catalog defaults; using fallback', { conflict })
    })
    if (models.length === 0) throw qoderError('Qoder model discovery returned no enabled models.', EMPTY_RESPONSE_CODE)
    return models
  } catch (error) {
    if (error instanceof LlmError) throw error
    if (options.signal?.aborted) throw qoderError('Qoder model discovery was aborted.', QODER_ABORTED_CODE)
    if (deadline.timeoutSignal.aborted) throw qoderError('Qoder model discovery timed out.', 'TIMEOUT')
    options.logger?.error?.('[Qoder Models] Catalog network request failed', redactLogValue(error))
    throw qoderError('Qoder model discovery network request failed.', QODER_TRANSPORT_CODE, { cause: error })
  }
}

/**
 * Cline (ClinePass) model catalog.
 *
 * `GET /v1/models` on the Cline gateway does NOT return the subscription
 * roster — it answers OpenRouter-style ids without the `cline-pass/` prefix.
 * The subscription list comes from the public recommended-models endpoint,
 * with a pinned table as the offline fallback.
 *
 * Ported from yhshzh/dsh-cline-pass (MIT) `lib/catalog.js` and
 * GooDAnDReaDY/dsh-clinebot (MIT) `lib/models.js`.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../../http.js'
import type { FetchFn } from '../common.js'

/** Default Cline gateway base. */
export const CLINE_BASE_URL = 'https://api.cline.bot/api/v1'

/** Public (unauthenticated) endpoint listing the subscription roster. */
export const CLINE_RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'

/** Model-id prefix every Cline subscription model carries. */
export const CLINE_MODEL_PREFIX = 'cline-pass/'

/** Reasoning levels every Cline model advertises (gateway-wide). */
export const CLINE_EFFORTS: readonly string[] = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** One catalog entry. */
export interface ClineModel {
  /** Full wire id, `cline-pass/<slug>`. */
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: ('text' | 'image')[]
  /** Whether the gateway exposes selectable reasoning levels for it. */
  reasoning: boolean
}

/**
 * Pinned roster used when the live endpoint is unreachable. Every row carries a
 * positive context window: the harness rejects a catalog whose models lack one.
 */
export const CLINE_MODEL_CATALOG: readonly ClineModel[] = Object.freeze([
  { id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], reasoning: true },
  { id: 'cline-pass/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], reasoning: true },
  { id: 'cline-pass/glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 131_072, input: ['text'], reasoning: true },
  { id: 'cline-pass/glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 131_072, input: ['text'], reasoning: true },
  { id: 'cline-pass/kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/minimax-m3', name: 'MiniMax-M3', contextWindow: 1_048_576, maxTokens: 512_000, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/qwen3.7-max', name: 'Qwen3.7 Max', contextWindow: 1_000_000, maxTokens: 65_536, input: ['text'], reasoning: true },
  { id: 'cline-pass/qwen3.7-plus', name: 'Qwen3.7 Plus', contextWindow: 1_000_000, maxTokens: 64_000, input: ['text', 'image'], reasoning: true },
  { id: 'cline-pass/mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text'], reasoning: true },
  { id: 'cline-pass/mimo-v2.5', name: 'MiMo-V2.5', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], reasoning: true },
])

const BY_ID = new Map(CLINE_MODEL_CATALOG.map(model => [model.id, model]))

/**
 * A model id this plugin recognizes: the pinned table when known, otherwise a
 * synthesized entry that keeps the id but carries conservative defaults.
 *
 * Synthesis is required because the gateway ships models (e.g.
 * `muse-spark-1.3-contributor`) that the pinned table predates; dropping them
 * would hide a model the user is paying for.
 */
export function clineModel(id: string): ClineModel {
  const known = BY_ID.get(id)
  if (known !== undefined) return known
  const slug = id.startsWith(CLINE_MODEL_PREFIX) ? id.slice(CLINE_MODEL_PREFIX.length) : id
  return {
    id,
    name: slug.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
    contextWindow: 128_000,
    maxTokens: 32_000,
    input: ['text'],
    reasoning: true,
  }
}

/** Project one catalog model into the harness model-info shape. */
export function toClineModelInfo(model: ClineModel, provider: string): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: [...model.input],
  }
}

/** Parse the `recommended-models` payload into ids. */
export function parseRecommendedModels(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const root = payload as Record<string, unknown>
  const data = typeof root.data === 'object' && root.data !== null ? root.data as Record<string, unknown> : undefined
  const raw = root.clinePass ?? data?.clinePass
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  for (const entry of raw) {
    const id = typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>).id
        : undefined
    if (typeof id !== 'string') continue
    const normalized = id.trim().toLowerCase()
    if (!normalized.startsWith(CLINE_MODEL_PREFIX)) continue
    if (!/^cline-pass\/[a-z0-9._-]+$/.test(normalized)) continue
    if (!ids.includes(normalized)) ids.push(normalized)
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
    const id = typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>).id
        : undefined
    if (typeof id !== 'string') continue
    const normalized = id.trim().toLowerCase()
    if (!normalized.startsWith(CLINE_MODEL_PREFIX)) continue
    if (!ids.includes(normalized)) ids.push(normalized)
  }
  return ids
}

/**
 * Discover the subscription roster.
 *
 * The recommended-models endpoint is public and authoritative for what the
 * subscription includes, so it leads; the pinned table is always merged in
 * underneath so a network failure never empties the picker. The gateway's own
 * `/models` is consulted last and only for extra `cline-pass/`-prefixed ids.
 */
export async function discoverClineModels(
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
  fetchFn: FetchFn = proxiedFetch,
): Promise<ClineModel[]> {
  const ids: string[] = []
  const add = (list: readonly string[]): void => {
    for (const id of list) if (!ids.includes(id)) ids.push(id)
  }
  try {
    const response = await fetchFn(CLINE_RECOMMENDED_URL, {
      headers: { accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (response.ok) add(parseRecommendedModels(await response.json()))
  } catch { /* the pinned table still covers us */ }
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (response.ok) add(parseGatewayModels(await response.json()))
  } catch { /* optional */ }
  add(CLINE_MODEL_CATALOG.map(model => model.id))
  return ids.map(id => clineModel(id))
}

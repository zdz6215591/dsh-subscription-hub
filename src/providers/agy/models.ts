/**
 * Model discovery: dynamic `v1internal:fetchAvailableModels` as the primary
 * source (fresh ids + per-model quotaInfo), the pinned catalog merged in for
 * capability metadata, and catalog fallback when the endpoint is unreachable.
 */

import { ReasoningEffortId, type LlmModelInfo, type LlmModelReasoningInfo, type LlmResolvedModelInfo, type ModelModality } from '@deepseek-ai/dsh-llm'
import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapClientMetadata, getAgyBootstrapUserAgent } from './constants.js'
import { proxiedFetch } from '../../http.js'
import { AGY_PUBLIC_MODELS, catalogModel, isChatCallableModelId, isLevelThinkingModel } from './catalog.js'
import type { ProviderUsage, UsageWindow } from '../common.js'

export const AGY_PROVIDER = 'agy'

/** Level-thinking: single id + selectable low/medium/high via thinkingLevel. Default is UI hint, not wire default. */
const LEVEL_REASONING: LlmModelReasoningInfo = Object.freeze({
  efforts: Object.freeze([
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ] as const),
  defaultEffort: ReasoningEffortId('medium'),
} as const)

/**
 * Input modalities per model. Image support follows the catalog's own
 * `supportsVision` metadata for known models (gpt-oss-120b-medium is text-only
 * there); unknown dynamic ids default to vision-capable — the upstream schema
 * accepts inlineData across the board, and a wrong guess surfaces as a clear
 * upstream 400 instead of a silent drop.
 */
const AGY_INPUT_MODALITIES = ['text', 'image'] as const
const AGY_TEXT_ONLY_MODALITIES = ['text'] as const

function inputModalitiesFor(meta: { supportsVision?: boolean } | undefined): ModelModality[] {
  return [...(meta ? meta.supportsVision === true : true) ? AGY_INPUT_MODALITIES : AGY_TEXT_ONLY_MODALITIES]
}

export interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

export interface DiscoveredModels {
  models?: Record<string, DiscoveredModelEntry>
}

/** Fetch the account's available models from the first reachable endpoint. */
export async function fetchAvailableModels(
  accessToken: string,
  projectId?: string,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<DiscoveredModels> {
  let lastError: unknown = null
  const body = projectId ? { project: projectId } : {}
  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(`${baseEndpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': getAgyBootstrapUserAgent(),
          'Client-Metadata': getAgyBootstrapClientMetadata(),
        },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        return (await response.json()) as DiscoveredModels
      }
      lastError = new Error(`fetchAvailableModels ${response.status} at ${baseEndpoint}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('fetchAvailableModels: all endpoints failed')
}

/** Merge dynamic ids with catalog metadata; non-chat models and unknowns keep minimal info. */
export function mergeModelCatalog(dynamic: DiscoveredModels): LlmModelInfo[] {
  const entries: LlmModelInfo[] = []
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!isChatCallableModelId(id)) continue
    const meta = catalogModel(id)
    entries.push({
      provider: AGY_PROVIDER,
      id,
      name: entry.displayName ?? meta?.name ?? entry.modelName ?? id,
      inputModalities: inputModalitiesFor(meta),
      ...(meta ? { context: { contextWindow: meta.contextLength } } : {}),
    })
  }
  return entries
}

function familyScope(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.startsWith('claude-')) return 'Claude'
  if (id.startsWith('gemini-') || id.startsWith('gemma-')) return 'Gemini'
  if (id.startsWith('gpt-') || id.startsWith('openai/')) return 'GPT'
  return 'Other'
}

/** Aggregate per-model quotaInfo into family usage windows. */
export function parseAgyQuotaUsage(dynamic: DiscoveredModels): ProviderUsage {
  const families = new Map<string, { remaining: number; resetsAt?: number }>()
  for (const [modelId, entry] of Object.entries(dynamic.models ?? {})) {
    const remaining = entry.quotaInfo?.remainingFraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const scope = familyScope(modelId)
    const current = families.get(scope)
    const reset = typeof entry.quotaInfo?.resetTime === 'string' ? Date.parse(entry.quotaInfo.resetTime) : undefined
    const resetsAt = reset !== undefined && Number.isFinite(reset) ? reset : current?.resetsAt
    families.set(scope, {
      remaining: current === undefined ? remaining : Math.min(current.remaining, remaining),
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  const windows: UsageWindow[] = [...families.entries()].map(([scope, row]) => ({
    kind: 'session' as const,
    scope,
    usedPercent: Math.max(0, Math.min(100, Math.round((1 - row.remaining) * 100))),
    remaining: Math.round(row.remaining * 1000) / 10,
    limit: 100,
    ...row.resetsAt === undefined ? {} : { resetsAt: row.resetsAt },
  }))
  if (windows.length === 0) return { supported: false }
  const worst = Math.min(...windows.map(window => window.remaining ?? 100))
  return { supported: true, windows, remaining: worst, limit: 100 }
}

/** Catalog-only model list used when the endpoint is unreachable. */
export function catalogModelList(): LlmModelInfo[] {
  return AGY_PUBLIC_MODELS.map((model) => ({
    provider: AGY_PROVIDER,
    id: model.id,
    name: model.name,
    inputModalities: inputModalitiesFor(model),
    context: { contextWindow: model.contextLength },
  }))
}

/** Adapter-facing listing: dynamic first, catalog fallback. */
export async function listAgyModels(
  accessToken: string | undefined,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<readonly LlmModelInfo[]> {
  if (!accessToken) return catalogModelList()
  try {
    const dynamic = await fetchAvailableModels(accessToken, projectId, fetchImpl)
    const merged = mergeModelCatalog(dynamic)
    return merged.length > 0 ? merged : catalogModelList()
  } catch {
    return catalogModelList()
  }
}

/** Resolve one exact model's metadata (catalog-backed; dynamic ids pass through). */
export function resolveAgyModel(provider: string, model: string): LlmResolvedModelInfo {
  const meta = catalogModel(model)
  if (isLevelThinkingModel(model)) {
    return {
      provider,
      id: model,
      name: meta?.name ?? model,
      inputModalities: inputModalitiesFor(meta),
      context: { contextWindow: meta?.contextLength ?? 1048576 },
      defaultMaxTokens: meta?.maxOutputTokens ?? 65536,
      // Return a shallow copy so callers cannot mutate the frozen singleton.
      reasoning: { ...LEVEL_REASONING, efforts: [...LEVEL_REASONING.efforts] },
    }
  }
  return {
    provider,
    id: model,
    name: meta?.name ?? model,
    inputModalities: inputModalitiesFor(meta),
    ...(meta ? { context: { contextWindow: meta.contextLength }, defaultMaxTokens: meta.maxOutputTokens } : {}),
  }
}

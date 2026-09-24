/**
 * Model discovery: dynamic `v1internal:fetchAvailableModels` as the primary
 * source (fresh ids + per-model quotaInfo), the pinned catalog merged in for
 * capability metadata, and catalog fallback when the endpoint is unreachable.
 */

import { ReasoningEffortId, type LlmModelInfo, type LlmModelReasoningInfo, type LlmResolvedModelInfo, type ModelModality } from '@deepseek-ai/dsh-llm'
import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapClientMetadata, getAgyBootstrapUserAgent } from './constants.js'
import { proxiedFetch } from '../../http.js'
import { AGY_PUBLIC_MODELS, antigravityEfforts, catalogModel, cleanAgyDisplayName, isChatCallableModelId, isLevelThinkingModel } from './catalog.js'
import type { ProviderUsage, UsageWindow } from '../common.js'

export const AGY_PROVIDER = 'agy'

/**
 * The level picker for one model, from its FAMILY rather than one set for everything.
 *
 * `antigravityEfforts` owns the table and the reasoning behind it; this only shapes it
 * into the harness contract. The default is a UI hint (which level the picker opens
 * on), not a wire default — the request carries whatever the user chose.
 */
function levelReasoningFor(model: string): LlmModelReasoningInfo | undefined {
  const ids = antigravityEfforts(model)
  if (ids.length === 0) return undefined
  return {
    efforts: ids.map(id => ({
      id: ReasoningEffortId(id),
      name: id === 'off' ? 'Off' : id === 'xhigh' ? 'Extra High' : id.charAt(0).toUpperCase() + id.slice(1),
    })),
    // `medium` where the family has it, otherwise the middle of what it does offer.
    defaultEffort: ReasoningEffortId(ids.includes('medium') ? 'medium' : (ids[Math.floor(ids.length / 2)] ?? ids[0]!)),
  }
}

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

/** Merge dynamic ids with catalog metadata; redundant variants and suffix tags are folded. */
export function mergeModelCatalog(dynamic: DiscoveredModels): LlmModelInfo[] {
  const entries: LlmModelInfo[] = []
  const seenNames = new Set<string>()
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!isChatCallableModelId(id)) continue
    const meta = catalogModel(id)
    const rawName = meta?.name ?? entry.displayName ?? entry.modelName ?? id
    const cleanName = cleanAgyDisplayName(rawName)
    if (seenNames.has(cleanName)) continue
    seenNames.add(cleanName)
    entries.push({
      provider: AGY_PROVIDER,
      id,
      name: cleanName,
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

/**
 * The pinned catalog's ids, as harness rows.
 *
 * NOT a fallback, and deliberately unreachable from {@link listAgyModels}. It exists
 * so a caller can state which ids the pinned table describes — the visibility test uses
 * it to prove the pinned CAPABILITY data is still intact for ids the live endpoint
 * returns. Serving it as a roster is precisely the fabrication this module removed, so
 * nothing on the model-listing path may call it.
 */
export function catalogModelList(): LlmModelInfo[] {
  return AGY_PUBLIC_MODELS.map((model) => ({
    provider: AGY_PROVIDER,
    id: model.id,
    name: cleanAgyDisplayName(model.name),
    inputModalities: inputModalitiesFor(model),
    context: { contextWindow: model.contextLength },
  }))
}

/**
 * Adapter-facing listing: the live endpoint, and NOTHING ELSE.
 *
 * Every branch here used to return {@link catalogModelList} — twelve models carrying
 * context windows — so a route with no token, an endpoint answering with an empty
 * roster, and a transport failure all rendered as a complete, healthy model list. The
 * caller could not tell them apart, which is exactly the failure the user reported:
 * they had no way to know whether what they were looking at was real.
 *
 * A failure now PROPAGATES so the adapter can report WHICH read failed and show no
 * roster, instead of being swallowed here. `catalogModel` is still used by
 * `mergeModelCatalog`/`discoveredFromList` to enrich ids the endpoint DID return —
 * a real disclosure rather than a substitute for one — which is why the pinned table
 * itself is kept.
 *
 * @param accessToken - the credential's access token, when one exists.
 * @param projectId - the project the roster is scoped to.
 * @param fetchImpl - injectable fetcher for tests.
 * @returns the endpoint's own rows, possibly none.
 * @throws when no access token exists, or when the endpoint fails.
 */
export async function listAgyModels(
  accessToken: string | undefined,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<readonly LlmModelInfo[]> {
  // Without a token there is nothing to read. Saying so lets the adapter report an
  // un-fetched roster rather than presenting the pinned catalog as the account's own.
  if (!accessToken) throw new Error('agy model list needs an access token; none is available')
  const dynamic = await fetchAvailableModels(accessToken, projectId, fetchImpl)
  // An endpoint that answered with nothing is reported as nothing. It is not evidence
  // that the account has the pinned twelve models.
  return mergeModelCatalog(dynamic)
}

/** Resolve one exact model's metadata (catalog-backed; dynamic ids pass through). */
export function resolveAgyModel(provider: string, model: string): LlmResolvedModelInfo {
  const meta = catalogModel(model)
  const isClaude = model.toLowerCase().startsWith('claude-')
  const cleanName = cleanAgyDisplayName(meta?.name ?? model)
  if (isLevelThinkingModel(model)) {
    // Only the values the pinned table ACTUALLY describes are reported. This branch
    // used to fill the gaps with invented figures — `?? 1048576` for a window and
    // `isClaude ? 64000 : (meta?.maxOutputTokens ?? 65536)` for the cap — so an id
    // nobody had described was presented as a 1M-context / 64K-output model. Those
    // are gone; an unread capacity is omitted rather than guessed.
    const contextWindow = meta?.contextLength
    const maxOutputTokens = meta?.maxOutputTokens
    const levelReasoning = levelReasoningFor(model)
    return {
      provider,
      id: model,
      name: cleanName,
      inputModalities: inputModalitiesFor(meta),
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...maxOutputTokens === undefined ? {} : { defaultMaxTokens: maxOutputTokens },
      // The levels THIS family accepts, not one set for every level-thinking model.
      ...levelReasoning === undefined ? {} : { reasoning: levelReasoning },
    }
  }
  return {
    provider,
    id: model,
    name: cleanName,
    inputModalities: inputModalitiesFor(meta),
    // The pinned table's own figures, reported VERBATIM. This used to read
    // `defaultMaxTokens: isClaude ? 64000 : meta.maxOutputTokens`, which overrode a
    // genuinely read output cap with a hardcoded constant for every Claude model —
    // so a table row declaring 65536 was reported as 64000. Overwriting a real
    // measurement with a constant is the same fault as inventing one.
    ...(meta === undefined ? {} : { context: { contextWindow: meta.contextLength }, defaultMaxTokens: meta.maxOutputTokens }),
  }
}

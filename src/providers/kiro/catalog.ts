/**
 * Kiro's model roster (`List-Available-Models`), and its mapping to harness
 * models.
 *
 * An API key's roster comes from `KiroControlPlaneBearerService.ListAvailableModels`
 * (paginated by `nextToken`, at most 20 pages read here) while a browser
 * sign-in's comes from `List-Available-Models` on the management plane. Both
 * answer the same row shape:
 *
 *   { models: [{ modelId, modelName, tokenLimits: { maxInputTokens, maxOutputTokens },
 *                supportedInputTypes: ['TEXT', 'IMAGE'] }], defaultModel: { modelId } }
 *
 * A model's window and output cap are stated by Kiro, so they are read straight
 * from `tokenLimits` — nothing is guessed. A row that states no limit is
 * published WITHOUT one rather than with a plausible default.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { kiroControlCall, kiroAuthHeaders, kiroManagement, kiroManagementCall, KIRO_ORIGIN } from './protocol.js'

/** One model as Kiro lists it. */
export interface KiroModel {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages: boolean
}

/** Page cap, as the reference implementation uses. */
const MAX_PAGES = 20

/**
 * Read one `List-Available-Models` answer.
 *
 * @param payload - the parsed response.
 * @returns the rows it listed, default first, with duplicates dropped.
 */
export function parseKiroModels(payload: unknown): { models: KiroModel[]; nextToken?: string } {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    models?: unknown
    defaultModel?: { modelId?: unknown }
    nextToken?: unknown
  }
  const seen = new Set<string>()
  const models: KiroModel[] = []
  for (const raw of Array.isArray(source.models) ? source.models : []) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      modelId?: unknown
      modelName?: unknown
      tokenLimits?: { maxInputTokens?: unknown; maxOutputTokens?: unknown }
      supportedInputTypes?: unknown
    }
    if (typeof row.modelId !== 'string' || row.modelId === '' || seen.has(row.modelId)) continue
    seen.add(row.modelId)
    const input = row.tokenLimits?.maxInputTokens
    const output = row.tokenLimits?.maxOutputTokens
    models.push({
      id: row.modelId,
      name: typeof row.modelName === 'string' && row.modelName !== '' ? row.modelName : row.modelId,
      ...typeof input === 'number' && Number.isFinite(input) && input > 0 ? { contextWindow: Math.trunc(input) } : {},
      ...typeof output === 'number' && Number.isFinite(output) && output > 0 ? { maxOutputTokens: Math.trunc(output) } : {},
      supportsImages: (Array.isArray(row.supportedInputTypes) ? row.supportedInputTypes : [])
        .some(type => String(type).toUpperCase() === 'IMAGE'),
    })
  }
  const next = source.nextToken
  return { models, ...typeof next === 'string' && next !== '' ? { nextToken: next } : {} }
}

/**
 * Fetch an API key's roster, following `nextToken`.
 *
 * @param fetchFn - fetch to use.
 * @param region - the key's region.
 * @param key - API key.
 * @param signal - caller cancellation.
 * @returns the roster (may be empty when Kiro listed nothing).
 */
export async function fetchKiroModels(
  fetchFn: typeof fetch,
  session: { region: string; token: string; method?: 'apikey' | 'social' | 'idc'; profileArn?: string },
  signal?: AbortSignal,
): Promise<KiroModel[]> {
  if (session.method !== undefined && session.method !== 'apikey') {
    return await fetchKiroModelsSignedIn(fetchFn, session, signal)
  }
  const region = session.region
  const key = session.token
  const models: KiroModel[] = []
  let nextToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const call = kiroControlCall(
      region,
      key,
      'KiroControlPlaneBearerService.ListAvailableModels',
      { origin: KIRO_ORIGIN, ...nextToken === undefined ? {} : { nextToken } },
      { origin: KIRO_ORIGIN },
    )
    const response = await fetchFn(call.url, {
      method: 'POST',
      headers: call.headers,
      body: call.body,
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      throw new Error(`kiro: ListAvailableModels answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const parsed = parseKiroModels(await response.json())
    models.push(...parsed.models)
    nextToken = parsed.nextToken
    if (nextToken === undefined) break
  }
  return models
}

/**
 * Wrap a Kiro row as harness model info.
 *
 * @param model - roster row.
 * @param provider - registered route id.
 * @returns the selector-facing entry.
 */
export function toKiroModelInfo(model: KiroModel, provider: string): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
  }
}

/**
 * Resolve one model's window and output cap from a roster, for request building.
 *
 * @param models - the roster.
 * @param id - model id.
 * @returns the row, when the roster knows it.
 */
export function findKiroModel(models: readonly KiroModel[], id: string): KiroModel | undefined {
  return models.find(model => model.id === id)
}

/** Re-export so callers do not need the management host directly. */
export { kiroAuthHeaders, kiroManagement }

/**
 * Read the roster of a SIGNED-IN account.
 *
 * A different API from the API key's (`GET /List-Available-Models` with the
 * profile named in the query). Sending the key's AWS-JSON shape here is exactly
 * what answers `AccessDeniedException: Invalid token`.
 *
 * @param fetchFn - fetch to use.
 * @param session - region, token and the profile the token may use.
 * @param signal - caller cancellation.
 * @returns the roster.
 */
async function fetchKiroModelsSignedIn(
  fetchFn: typeof fetch,
  session: { region: string; token: string; profileArn?: string },
  signal?: AbortSignal,
): Promise<KiroModel[]> {
  if (session.profileArn === undefined || session.profileArn === '') {
    throw new Error('kiro: this sign-in named no profile, so Kiro cannot list its models; sign in again (the profile is read at sign-in time)')
  }
  const models: KiroModel[] = []
  let nextToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const call = kiroManagementCall(session.region, session.token, 'List-Available-Models', {
      origin: KIRO_ORIGIN,
      profileArn: session.profileArn,
      ...nextToken === undefined ? {} : { nextToken },
    })
    const response = await fetchFn(call.url, {
      method: call.method,
      headers: call.headers,
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      throw new Error(`kiro: List-Available-Models answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const parsed = parseKiroModels(await response.json())
    models.push(...parsed.models)
    nextToken = parsed.nextToken
    if (nextToken === undefined) break
  }
  return models
}
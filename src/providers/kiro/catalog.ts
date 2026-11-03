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
): Promise<{ models: KiroModel[]; sources: KiroRosterSourceResult[] }> {
  const sources: KiroRosterSourceResult[] = []
  const merged = new Map<string, KiroModel>()
  const absorb = (models: readonly KiroModel[]): void => {
    for (const model of models) if (!merged.has(model.id)) merged.set(model.id, model)
  }

  // The source the credential's own client uses comes first, so its names and
  // limits win a tie.
  if (session.method !== undefined && session.method !== 'apikey') {
    try {
      const read = await fetchKiroModelsSignedIn(fetchFn, session, signal)
      sources.push({ api: 'management', ok: true, count: read.models.length, pages: read.pages })
      absorb(read.models)
    } catch (error) {
      sources.push({ api: 'management', ok: false, count: 0, pages: 0, error: text(error) })
    }
  } else {
    try {
      const read = await fetchKiroModelsBearer(fetchFn, session, signal)
      sources.push({ api: 'bearer', ok: true, count: read.models.length, pages: read.pages })
      absorb(read.models)
    } catch (error) {
      sources.push({ api: 'bearer', ok: false, count: 0, pages: 0, error: text(error) })
    }
  }

  // A third shape, so the answer is complete rather than inferred: the REST
  // operation the SIGN-IN path uses, asked with the API key. When Claude models
  // are missing from both AWS-JSON sources, this settles whether the family is
  // behind the other operation or absent from the credential altogether.
  if (session.method === undefined || session.method === 'apikey') {
    try {
      const read = await fetchKiroModelsRestWithKey(fetchFn, session, signal)
      sources.push({ api: 'management', ok: true, count: read.models.length, pages: read.pages })
      absorb(read.models)
    } catch (error) {
      sources.push({ api: 'management', ok: false, count: 0, pages: 0, error: text(error) })
    }
  }
  // A catalogue can be served by more than one operation, and which one carries
  // which family of models is NOT published: an API key here has been seen to
  // list the partner models only, while the same account's app also offers the
  // Claude ones. So the second operation is asked too and the answers merged —
  // a superset that costs one call and cannot lose a model the first one had.
  try {
    const read = await fetchKiroModelsCodeWhisperer(fetchFn, session, signal)
    sources.push({ api: 'codewhisperer', ok: true, count: read.models.length, pages: read.pages })
    absorb(read.models)
  } catch (error) {
    sources.push({ api: 'codewhisperer', ok: false, count: 0, pages: 0, error: text(error) })
  }

  // Nothing listed AND at least one source explained why: say it, rather than
  // reporting an empty roster that reads as "this account has no models".
  if (merged.size === 0) {
    const firstFailure = sources.find(source => !source.ok && source.error !== undefined)
    if (firstFailure?.error !== undefined) throw new Error(firstFailure.error)
  }
  return { models: [...merged.values()], sources }
}

/** One error's text, for a source's row. */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The control-plane roster an API key lists (`KiroControlPlaneBearerService`).
 *
 * `profileArn` must NOT be sent: kiro-cli sends none, and Kiro answers 400 when
 * one is present.
 */
async function fetchKiroModelsBearer(
  fetchFn: typeof fetch,
  session: { region: string; token: string },
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; pages: number }> {
  const models: KiroModel[] = []
  let nextToken: string | undefined
  let pages = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    pages++
    const call = kiroControlCall(
      session.region,
      session.token,
      'KiroControlPlaneBearerService.ListAvailableModels',
      { origin: KIRO_ORIGIN, ...nextToken === undefined ? {} : { nextToken } },
      { origin: KIRO_ORIGIN },
    )
    const response = await fetchFn(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      throw new Error(`ListAvailableModels answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const parsed = parseKiroModels(await response.json())
    models.push(...parsed.models)
    nextToken = parsed.nextToken
    if (nextToken === undefined) break
  }
  return { models, pages }
}

/**
 * The AWS-Q operation that lists models (`AmazonCodeWhispererService.ListAvailableModels`).
 *
 * This is the only source that can carry the Claude family for a credential the
 * control plane lists partner models for. A credential Kiro refuses here simply
 * contributes nothing.
 */
async function fetchKiroModelsCodeWhisperer(
  fetchFn: typeof fetch,
  session: { region: string; token: string },
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; pages: number }> {
  const call = kiroControlCall(
    session.region,
    session.token,
    'AmazonCodeWhispererService.ListAvailableModels',
    { origin: KIRO_ORIGIN },
    { origin: KIRO_ORIGIN },
  )
  const response = await fetchFn(call.url, {
    method: call.method,
    headers: call.headers,
    body: call.body,
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) {
    throw new Error(`CodeWhisperer ListAvailableModels answered ${response.status}: ${(await response.text()).slice(0, 160)}`)
  }
  return { models: parseKiroModels(await response.json()).models, pages: 1 }
}
async function fetchKiroModelsSignedIn(
  fetchFn: typeof fetch,
  session: { region: string; token: string; profileArn?: string },
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; api: 'bearer' | 'management'; pages: number }> {
  if (session.profileArn === undefined || session.profileArn === '') {
    throw new Error('kiro: this sign-in named no profile, so Kiro cannot list its models; sign in again (the profile is read at sign-in time)')
  }
  const models: KiroModel[] = []
  let nextToken: string | undefined
  let pages = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    pages++
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
  return { models, api: 'management', pages }
}
/**
 * Upper bound on the ids this diagnostic records, so a pathological roster
 * cannot write a huge file.
 */
const DIAGNOSTIC_ID_LIMIT = 500

/** One catalogue source's outcome. */
export interface KiroRosterSourceResult {
  /** Which API was asked, in the words the file uses. */
  api: 'bearer' | 'management' | 'codewhisperer'
  ok: boolean
  /** Models this source contributed (before de-duplication). */
  count: number
  /** Pages read. */
  pages: number
  /** The failure, when it failed. */
  error?: string
}

/** What one roster read saw, written for the user to compare with Kiro's app. */
export interface KiroRosterDiagnostic {
  at: number
  region: string
  /** Last six characters of the token, to tell two accounts apart. */
  tokenTail: string
  count: number
  /** Every source that was asked, and what it said. */
  sources: KiroRosterSourceResult[]
  models: { id: string; name: string; contextWindow?: number; maxOutputTokens?: number; images: boolean }[]
}

/**
 * Record the last roster read beside the plugin's other state.
 *
 * This exists because "Kiro's own app shows a model this plugin does not" is
 * otherwise undiagnosable from outside: the two APIs differ (`bearer` for an
 * API key, `management` for a sign-in), pagination can hide a page, and this
 * route's own visibility rules hide newly discovered models by default. The
 * file says exactly which ids Kiro sent, so the answer is a diff, not a guess.
 *
 * Best-effort: a diagnostic that fails must never fail the read it describes.
 *
 * @param diagnostic - what was seen.
 */
export async function writeKiroRosterDiagnostic(diagnostic: KiroRosterDiagnostic): Promise<void> {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
    const path = dshHomePath('plugins', 'subscriptions', 'kiro-roster.json')
    await mkdir(dirname(path), { recursive: true })
    const trimmed: KiroRosterDiagnostic = {
      ...diagnostic,
      models: diagnostic.models.slice(0, DIAGNOSTIC_ID_LIMIT),
    }
    await writeFile(path, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8')
  } catch {
    // Never let the record break the read.
  }
}

/** Where the diagnostic is written, for a message that tells the user where to look. */
export const KIRO_ROSTER_DIAGNOSTIC_FILE = 'plugins/subscriptions/kiro-roster.json'/**
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
 * Resolve one model's row from a roster.
 *
 * @param models - the roster.
 * @param id - model id.
 * @returns the row, when the roster knows it.
 */
export function findKiroModel(models: readonly KiroModel[], id: string): KiroModel | undefined {
  return models.find(model => model.id === id)
}

/**
 * Ask the sign-in path's REST catalogue with an API KEY.
 *
 * Recorded as its own source because it answers a different question from the
 * AWS-JSON ones: when the Claude family is missing from those, this says whether
 * it lives behind the REST operation or is simply not in the credential's
 * catalogue at all.
 *
 * @param fetchFn - fetch to use.
 * @param session - region and key.
 * @param signal - caller cancellation.
 * @returns whatever that operation lists.
 */
async function fetchKiroModelsRestWithKey(
  fetchFn: typeof fetch,
  session: { region: string; token: string },
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; pages: number }> {
  const response = await fetchFn(
    `${kiroManagement(session.region)}/List-Available-Models?${new URLSearchParams({ origin: KIRO_ORIGIN }).toString()}`,
    {
      method: 'GET',
      headers: { ...kiroAuthHeaders(session.token), Accept: 'application/json' },
      ...signal === undefined ? {} : { signal },
    },
  )
  if (!response.ok) {
    throw new Error(`REST List-Available-Models answered ${response.status}: ${(await response.text()).slice(0, 160)}`)
  }
  return { models: parseKiroModels(await response.json()).models, pages: 1 }
}
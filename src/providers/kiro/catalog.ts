/**
 * Kiro's model roster.
 *
 * Kiro splits its catalogue by CLIENT ORIGIN, and only one of the surfaces this
 * credential can reach is usable:
 *
 *   management.<region>.kiro.dev  /List-Available-Models  → what Kiro lets this
 *       credential CHAT with (the partner models: gpt-5.6-*, kimi-k3,
 *       deepseek-3.2, minimax-*, glm-5, qwen3-coder-next)
 *   q.<region>.amazonaws.com      /ListAvailableModels    → a SUPERSET that also
 *       lists the Claude family — measured on a live account — but every Claude id
 *       is refused by the chat endpoint with INVALID_MODEL_ID, because that family
 *       is served by Kiro's web portal (service.user-subscriptions.<region>.amazonaws.com,
 *       cookie + CSRF), not by the CLI surface.
 *
 * So this route lists EXACTLY what it can chat with. An earlier version merged
 * several "sources"; every one of them answered from the management host with the
 * same models, so the merge never added a single row. It is gone rather than kept
 * as decoration.
 *
 * A model's window and output cap come from Kiro's own `tokenLimits`; a row that
 * states none is published WITHOUT one instead of with a plausible default.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { kiroControlCall, kiroManagementCall, KIRO_ORIGIN } from './protocol.js'

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
 * @returns the rows it listed, plus Kiro's own page cursor when it sent one.
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

/** What one roster read saw, written for the user to compare with Kiro's app. */
export interface KiroRosterDiagnostic {
  at: number
  region: string
  /** Last six characters of the token, to tell two accounts apart. */
  tokenTail: string
  count: number
  /** The API that answered. */
  api: 'management' | 'bearer'
  /** Pages read. */
  pages: number
  models: { id: string; name: string; contextWindow?: number; maxOutputTokens?: number; images: boolean }[]
}

/**
 * Fetch the roster this credential can actually chat with, following `nextToken`.
 *
 * An API key uses the control-plane bearer operation; a signed-in token uses the
 * management REST path with its profile — Kiro refuses each shape for the other
 * credential kind.
 *
 * @param fetchFn - fetch to use.
 * @param session - region, token and (for a sign-in) the profile.
 * @param signal - caller cancellation.
 * @returns the models, and which API produced them.
 */
export async function fetchKiroModels(
  fetchFn: typeof fetch,
  session: { region: string; token: string; method?: 'apikey' | 'social' | 'idc'; profileArn?: string },
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; api: 'management' | 'bearer'; pages: number }> {
  const signedIn = session.method !== undefined && session.method !== 'apikey'
  if (signedIn && (session.profileArn === undefined || session.profileArn === '')) {
    throw new Error('kiro: this sign-in named no profile, so Kiro cannot list its models; sign in again (the profile is read at sign-in time)')
  }
  const models: KiroModel[] = []
  let nextToken: string | undefined
  let pages = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    pages++
    const call = signedIn
      ? kiroManagementCall(session.region, session.token, 'List-Available-Models', {
          origin: KIRO_ORIGIN,
          profileArn: session.profileArn ?? '',
          ...nextToken === undefined ? {} : { nextToken },
        })
      : kiroControlCall(
          session.region,
          session.token,
          'KiroControlPlaneBearerService.ListAvailableModels',
          { origin: KIRO_ORIGIN, ...nextToken === undefined ? {} : { nextToken } },
          { origin: KIRO_ORIGIN },
        )
    const response = await fetchFn(call.url, {
      method: call.method,
      headers: call.headers,
      ...'body' in call && call.body !== undefined ? { body: call.body } : {},
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      const name = signedIn ? 'List-Available-Models' : 'ListAvailableModels'
      throw new Error(`kiro: ${name} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    }
    const parsed = parseKiroModels(await response.json())
    models.push(...parsed.models)
    nextToken = parsed.nextToken
    if (nextToken === undefined) break
  }
  return { models, api: signedIn ? 'management' : 'bearer', pages }
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
 * Record the last roster read beside the plugin's other state.
 *
 * "Kiro's app shows a model this plugin does not" was undiagnosable from outside
 * for three rounds; this file is what ended that. It says which API answered, how
 * many pages, and every id Kiro sent — a diff, not a guess.
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
    await writeFile(path, `${JSON.stringify({ ...diagnostic, models: diagnostic.models.slice(0, 500) }, null, 2)}\n`, 'utf8')
  } catch {
    // Never let the record break the read.
  }
}

/** Where the diagnostic is written, for a message that tells the user where to look. */
export const KIRO_ROSTER_DIAGNOSTIC_FILE = 'plugins/subscriptions/kiro-roster.json'

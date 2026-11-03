/**
 * Kiro's model roster.
 *
 * Measured with two real credentials, and the two disagree:
 *
 *   API key  → `KiroControlPlaneBearerService.ListAvailableModels` answers 22
 *              models (Claude family included) AND every one of them chats —
 *              verified end to end, tool calls included.
 *   sign-in  → `management /List-Available-Models` answers 9 (partner models),
 *              while `q.<region>.amazonaws.com` lists the same 22 — and on that
 *              token a Claude id answers INVALID_MODEL_ID from the chat endpoint.
 *
 * So what a credential can LIST is not what it may USE, and the catalogue does not
 * say which side a model is on. This module therefore lists what the credential's
 * own API reports and leaves the "listed but refused" case to `unsupported.ts`,
 * which drops a model the first time Kiro refuses it.
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

/**
 * JoyCode's live model roster.
 *
 * `joycode_modelList` publishes ids and token budgets and nothing else — no
 * capability flags beyond a loose `features` array, and no reasoning levels at
 * all. So capabilities come from the pinned table ({@link joycode/catalog}) and
 * the live read decides WHICH models the account actually has.
 *
 * The id is the row's `chatApiModel` — the field the reference documents as "the
 * upstream's internal model ids" — with the `label` as its fallback (the first
 * reference exposes exactly that pair, `modelId ?? label`, and calls both). A row
 * carrying neither is dropped: it cannot be called at all. The `label` is also
 * the display name, falling back to the id for a nameless row.
 *
 * @module dsh-subscription-hub/providers/joycode/models
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { FetchFn, ModelListNotFetched } from '../common.js'
import { httpLlmError, mapFetchFailure, idleWatchdog } from '../common.js'
import type { JoyCodeCredential } from './client.js'
import { JOYCODE_ENDPOINTS, joyCodeEnvelope, joyCodeHeaders, joyCodeUrl, parseJoyCodeEnvelope } from './client.js'
import type { JoyCodeModel } from './catalog.js'
import { isJoyCodeChatModel, joyCodeModel } from './catalog.js'

/** One row of the upstream's model list, as this route reads it. */
interface WireModel {
  label?: unknown
  chatApiModel?: unknown
  modelId?: unknown
  maxTotalTokens?: unknown
  respMaxTokens?: unknown
  features?: unknown
}

/** One roster row after parsing: what the endpoint disclosed, plus pinned facts. */
export interface JoyCodeRosterEntry {
  /** The id this route calls the model by, and what the picker shows. */
  id: string
  /** Display name (the upstream's label). */
  name: string
  /** Pinned row, when the table describes this model. */
  pinned?: JoyCodeModel
  /** Whether the LIVE row advertised vision (overrides the pinned flag when present). */
  vision?: boolean
  contextWindow?: number
  maxOutputTokens?: number
}

/** What one roster read produced. */
export interface JoyCodeRosterRead {
  models: JoyCodeRosterEntry[]
  /** Set when the read failed, so the caller can report it instead of serving nothing. */
  reason?: ModelListNotFetched
}

/**
 * Read the account's model list.
 *
 * @param credential - the account credential (the call is authenticated).
 * @param fetchFn - fetcher to use.
 * @param signal - optional cancellation.
 * @returns the parsed roster.
 * @throws {LlmError} on transport failure or a non-2xx answer.
 */
export async function fetchJoyCodeModels(
  credential: JoyCodeCredential,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<JoyCodeRosterEntry[]> {
  const watchdog = idleWatchdog(signal, 20_000)
  let response: Response
  try {
    response = await fetchFn(joyCodeUrl(credential, 'models'), {
      method: 'POST',
      headers: joyCodeHeaders(credential),
      body: JSON.stringify(joyCodeEnvelope(credential)),
      signal: watchdog.signal,
    })
  } catch (error) {
    throw mapFetchFailure('JoyCode modelList', error, watchdog, signal)
  } finally {
    watchdog.stop()
  }
  if (!response.ok) throw await httpLlmError(response, 'JoyCode modelList')
  const payload: unknown = await response.json().catch(() => undefined)
  const envelope = parseJoyCodeEnvelope(payload)
  if (envelope?.code !== undefined && envelope.code !== 0) {
    throw new LlmError(
      `JoyCode modelList refused the read (code ${String(envelope.code)}${envelope.msg === undefined ? '' : `: ${envelope.msg}`})`,
      'SERVER',
    )
  }
  const rows = Array.isArray(envelope?.data) ? envelope.data as WireModel[] : undefined
  if (rows === undefined) {
    throw new LlmError(
      `JoyCode modelList answered no data array (${JOYCODE_ENDPOINTS.models.path})`,
      'MALFORMED_RESPONSE',
    )
  }
  const entries: JoyCodeRosterEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const chatApiModel = str(row.chatApiModel)
    const label = str(row.label) ?? chatApiModel
    // An id-less row cannot be called: chatApiModel is the wire name, the label
    // is its fallback, and with neither there is nothing to send.
    const id = chatApiModel ?? label
    if (id === undefined || label === undefined) continue
    if (!isJoyCodeChatModel(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const pinned = joyCodeModel(id) ?? joyCodeModel(label)
    const features = Array.isArray(row.features)
      ? row.features.filter((f): f is string => typeof f === 'string').map(f => f.toLowerCase())
      : []
    const vision = features.length === 0 ? undefined : features.includes('vision')
    const contextWindow = positive(row.maxTotalTokens) ?? pinned?.contextWindow
    const maxOutputTokens = positive(row.respMaxTokens) ?? pinned?.maxOutputTokens
    entries.push({
      id,
      name: label,
      ...pinned === undefined ? {} : { pinned },
      ...vision === undefined ? {} : { vision },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
    })
  }
  return entries
}

/**
 * Project one roster row onto the harness model shape.
 * @param provider - the provider id to stamp on the row.
 * @param entry - one parsed roster row.
 * @returns the harness row (no reasoning: `resolveOwnModel` owns that).
 */
export function joyCodeModelInfo(provider: string, entry: JoyCodeRosterEntry): LlmModelInfo {
  const vision = entry.vision ?? entry.pinned?.vision ?? false
  return {
    provider,
    id: entry.id,
    name: entry.name,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    ...entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } },
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

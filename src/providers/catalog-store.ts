import { normalizeInputModalities } from './modality.js'
import type { InputModality } from './modality.js'
/**
 * On-disk discovered-model-catalog cache at
 * `~/.dsh/plugins/subscriptions/models.json` — the durable half of each
 * provider's {@link ModelCatalogCache}. One entry per provider: the last
 * successfully discovered catalog with its fetch time, so capability metadata
 * (reasoning efforts) survives restarts and network failures.
 *
 * Unlike the auth store, this file is a cache: a missing, corrupt, or
 * malformed file silently reads as absent, because the next successful
 * discovery rewrites it. Loads are strictly validated — a malformed entry
 * passed through `resolveModel` would make the harness's metadata validation
 * throw on every call, which is worse than having no fallback at all.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { CatalogPersistence, CatalogSnapshot, DiscoveredModel } from './common.js'

/**
 * Absolute path of the catalog store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'models.json')`.
 */
export function modelsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'models.json')
}

/** The raw file shape: one unvalidated snapshot per provider. */
type CatalogFile = Partial<Record<ProviderId, unknown>>

/** Validate one persisted reasoning block, or undefined when malformed. */
function sanitizeReasoning(value: unknown): NonNullable<DiscoveredModel['reasoning']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { efforts?: unknown; defaultEffort?: unknown }
  if (!Array.isArray(raw.efforts) || raw.efforts.length === 0) return undefined
  const seen = new Set<string>()
  const efforts: NonNullable<DiscoveredModel['reasoning']>['efforts'] = []
  for (const entry of raw.efforts) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const effort = entry as Record<string, unknown>
    if (typeof effort.id !== 'string' || effort.id.length === 0
      || typeof effort.name !== 'string' || effort.name.length === 0
      || (effort.description !== undefined && typeof effort.description !== 'string')
      || seen.has(effort.id)) return undefined
    seen.add(effort.id)
    efforts.push({
      id: ReasoningEffortId(effort.id),
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })
  }
  if (raw.defaultEffort !== undefined
    && (typeof raw.defaultEffort !== 'string' || !seen.has(raw.defaultEffort))) return undefined
  return {
    efforts,
    ...raw.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(raw.defaultEffort as string) },
  }
}

/** Validate one persisted model, or undefined when malformed. */
function sanitizeModel(value: unknown): DiscoveredModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0
    || typeof raw.name !== 'string' || raw.name.length === 0
    || (raw.description !== undefined && typeof raw.description !== 'string')
    || (raw.contextWindow !== undefined
      && (typeof raw.contextWindow !== 'number' || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0))
    || (raw.priority !== undefined
      && (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)))) return undefined
  const reasoning = raw.reasoning === undefined ? undefined : sanitizeReasoning(raw.reasoning)
  if (raw.reasoning !== undefined && reasoning === undefined) return undefined
  const thinkingType = raw.thinkingType
  if (thinkingType !== undefined && thinkingType !== 'enabled' && thinkingType !== 'adaptive') return undefined
  const fastTier = raw.fastTier
  if (fastTier !== undefined && typeof fastTier !== 'boolean') return undefined
  const copilotWire = raw.copilotWire
  if (copilotWire !== undefined && copilotWire !== 'chat-completions' && copilotWire !== 'responses') {
    return undefined
  }
  const copilotResponses = raw.copilotResponses
  if (copilotResponses !== undefined && typeof copilotResponses !== 'boolean') return undefined
  const inputModalities = raw.inputModalities
  // Normalized rather than rejected: a snapshot written by an older build may
  // spell a modality differently, and discarding the whole provider's cache over
  // that would lose every model's window and reasoning metadata with it.
  const modalities = inputModalities === undefined
    ? undefined
    : Array.isArray(inputModalities) ? normalizeInputModalities(inputModalities) : undefined
  if (inputModalities !== undefined && modalities === undefined) return undefined
  return {
    id: raw.id,
    name: raw.name,
    ...raw.description === undefined ? {} : { description: raw.description as string },
    ...raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow as number },
    ...raw.priority === undefined ? {} : { priority: raw.priority as number },
    ...reasoning === undefined ? {} : { reasoning },
    ...thinkingType === undefined ? {} : { thinkingType: thinkingType as 'enabled' | 'adaptive' },
    ...fastTier === undefined ? {} : { fastTier },
    ...copilotWire === undefined ? {} : { copilotWire: copilotWire as 'chat-completions' | 'responses' },
    ...copilotResponses === undefined ? {} : { copilotResponses },
    ...modalities === undefined ? {} : { inputModalities: modalities },
  }
}

/**
 * Validate one persisted snapshot. Strict: any malformed field drops the
 * whole snapshot rather than repairing it — the next successful discovery
 * rewrites the entry anyway.
 * @param value - the raw per-provider file entry.
 * @returns the validated snapshot, or undefined when unusable.
 */
export function sanitizeSnapshot(value: unknown): CatalogSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { at?: unknown; models?: unknown }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  if (!Array.isArray(raw.models) || raw.models.length === 0) return undefined
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of raw.models) {
    const model = sanitizeModel(entry)
    if (model === undefined || seen.has(model.id)) return undefined
    seen.add(model.id)
    models.push(model)
  }
  return { at: raw.at, models }
}

/** Read the whole file; missing or unparsable reads as an empty cache. */
async function readCatalogFile(path: string): Promise<CatalogFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as CatalogFile
  } catch {
    return {}
  }
}

/** Persist the whole file atomically (tmp file + rename). */
async function writeCatalogFile(store: CatalogFile, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2))
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * One write chain per store path.
 *
 * Every mutation here is a read-modify-write of the whole shared models.json,
 * and the plugin runs them concurrently by design: `families()` lists every
 * provider's models in parallel, and "Refresh models" re-discovers all routes at
 * once. Overlapping them unserialized was NOT benign on Windows — reproduced
 * with five concurrent saves, which threw `EPERM rename` twice and left the file
 * holding a single provider, silently discarding the other four. The throw is
 * swallowed upstream (`void save(...).catch(() => undefined)`), so the loss was
 * invisible until a restart found the reasoning/vision/context metadata gone.
 *
 * A chain is dropped once nothing is queued behind it, so the map holds an entry
 * only while writes are in flight.
 */
const catalogWriteChains = new Map<string, Promise<unknown>>()

/**
 * Run one read-modify-write of the catalog path after every write already
 * queued for it. Callers join the chain synchronously, so call order is write
 * order.
 * @param path - the store file being mutated.
 * @param action - the read-modify-write to run.
 * @returns whatever `action` returns.
 */
async function serializeCatalog<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = catalogWriteChains.get(path) ?? Promise.resolve()
  // Both handlers: a failed write must not strand everything queued behind it.
  const next = previous.then(action, action)
  const tail = next.then(() => undefined, () => undefined)
  catalogWriteChains.set(path, tail)
  try {
    return await next
  } finally {
    if (catalogWriteChains.get(path) === tail) catalogWriteChains.delete(path)
  }
}

/**
 * Build the durable half of one provider's catalog cache over the shared
 * models.json file. Every mutation is serialized per path, so concurrent
 * writers merge instead of clobbering each other.
 * @param provider - the provider route keying the file entry.
 * @param path - store file path; defaults to {@link modelsFilePath}.
 * @returns the persistence hooks for {@link ModelCatalogCache}.
 */
export function catalogStore(provider: ProviderId, path = modelsFilePath()): CatalogPersistence {
  return {
    async load() {
      return sanitizeSnapshot((await readCatalogFile(path))[provider])
    },
    async save(snapshot) {
      await serializeCatalog(path, async () => {
        const store = await readCatalogFile(path)
        store[provider] = snapshot
        await writeCatalogFile(store, path)
      })
    },
    async clear() {
      await serializeCatalog(path, async () => {
        const store = await readCatalogFile(path)
        if (store[provider] === undefined) return
        delete store[provider]
        await writeCatalogFile(store, path)
      })
    },
  }
}

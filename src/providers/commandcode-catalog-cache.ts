/**
 * Durable fallback cache for the Command Code model catalog.
 *
 * Command Code serves its roster from `GET /provider/v1/models`, and the hub
 * used to keep it in memory only, with a two-model static list as the sole
 * fallback. Any `/models` hiccup — or simply a fresh process — therefore
 * collapsed the picker to those two models and mis-sized every other one, while
 * the conversation kept working. The roster is also expensive to re-derive:
 * it is what supplies each model's real context window and output cap.
 *
 * So the last successful read is persisted, and a failed read falls back to it
 * before the static list. This mirrors the reference implementation
 * (`Mars-Sea/dsh-commandcode-provider`'s `readModelsCache`/`writeModelsCache`,
 * MIT) with this hub's own conventions: a version guard, per-field validation,
 * and an atomic write through a per-path serialization chain so two providers
 * writing at once cannot clobber the file.
 *
 * Deliberately a fallback, not the primary cache: the adapter keeps its own
 * per-account freshness map, because the roster is plan-scoped and the picker
 * unions several accounts. This file is provider-scoped and only answers when
 * nothing fresher exists.
 *
 * @module dsh-subscription-hub/providers/commandcode-catalog-cache
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Bumped when the persisted shape changes; a mismatch discards the file. */
const COMMANDCODE_CACHE_VERSION = 1

/** One persisted catalog row. */
export interface CommandCodeCatalogEntry {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /**
   * The gateway declared this model Messages-only. Persisted because it decides
   * which transport the request uses: dropping it would make a post-restart
   * request lead with a transport the gateway rejects.
   */
  messagesOnly?: boolean
}

/** Default location, beside the plugin's other durable state. */
export function commandcodeCatalogPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'commandcode-models.json')
}

/**
 * One write chain per path, so overlapping writers merge instead of clobbering.
 * The hub runs several providers' discovery concurrently, and a bare
 * read-modify-write of a shared file is not safe on Windows.
 */
const writeChains = new Map<string, Promise<unknown>>()

async function serialize<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  // Both handlers: a failed write must not strand everything queued behind it.
  const next = previous.then(action, action)
  const tail = next.then(() => undefined, () => undefined)
  writeChains.set(path, tail)
  try {
    return await next
  } finally {
    if (writeChains.get(path) === tail) writeChains.delete(path)
  }
}

/** Validate one persisted row, or undefined when malformed. */
function sanitizeEntry(value: unknown): CommandCodeCatalogEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (typeof raw.name !== 'string' || raw.name.length === 0) return undefined
  const positive = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isSafeInteger(input) && input > 0 ? input : undefined
  const contextWindow = positive(raw.contextWindow)
  const maxTokens = positive(raw.maxTokens)
  if (contextWindow === undefined || maxTokens === undefined) return undefined
  const messagesOnly = raw.messagesOnly
  if (messagesOnly !== undefined && typeof messagesOnly !== 'boolean') return undefined
  return {
    id: raw.id,
    name: raw.name,
    contextWindow,
    maxTokens,
    ...messagesOnly === undefined ? {} : { messagesOnly },
  }
}

/**
 * Read the persisted catalog.
 *
 * Every failure — a missing file, a malformed document, a version mismatch, an
 * unreadable path — answers `undefined` rather than throwing: this is a cache,
 * and the caller's own fallback is what runs next.
 * @param path - store file path; defaults to {@link commandcodeCatalogPath}.
 * @returns the validated rows, or undefined when nothing usable is stored.
 */
export async function readCommandCodeCatalog(path = commandcodeCatalogPath()): Promise<CommandCodeCatalogEntry[] | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const document = parsed as { version?: unknown; models?: unknown }
    if (document.version !== COMMANDCODE_CACHE_VERSION) return undefined
    if (!Array.isArray(document.models)) return undefined
    const models: CommandCodeCatalogEntry[] = []
    for (const raw of document.models) {
      const entry = sanitizeEntry(raw)
      if (entry === undefined) return undefined
      models.push(entry)
    }
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the catalog, atomically and after any write already queued for the
 * path.
 *
 * A caller that cannot wait (the adapter writes through on a successful fetch)
 * may ignore the returned promise: durability is the only thing at stake, never
 * the request.
 * @param models - the rows just discovered.
 * @param path - store file path; defaults to {@link commandcodeCatalogPath}.
 */
export async function writeCommandCodeCatalog(
  models: readonly CommandCodeCatalogEntry[],
  path = commandcodeCatalogPath(),
): Promise<void> {
  await serialize(path, async () => {
    await fs.mkdir(dirname(path), { recursive: true })
    // A random nonce, like every other store in this plugin: a pid-only name is
    // shared by concurrent writers inside one process.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.writeFile(tmp, `${JSON.stringify({ version: COMMANDCODE_CACHE_VERSION, models }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await fs.rename(tmp, path)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  })
}
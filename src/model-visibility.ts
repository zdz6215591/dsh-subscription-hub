/**
 * Per-provider model visibility and new-model discovery tracking.
 * - Hidden ids stay out of the composer picker.
 * - New catalog models default to HIDDEN (not displayed) and are tagged unread with subtle red dots.
 * - Once viewed / read, unread marks are cleared.
 *
 * All operations are serialized through an async mutex queue and temp files use
 * cryptographically unique names to prevent concurrent write collisions on Windows.
 * `readDocument` never throws unhandled syntax errors on corrupt files and automatically
 * self-heals trailing garbage.
 */

import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ProviderId } from './auth/store.js'

export interface VisibilityDocument {
  hidden: Partial<Record<ProviderId, string[]>>
  known?: Partial<Record<ProviderId, string[]>>
  unread?: Partial<Record<ProviderId, string[]>>
}

export function visibilityFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'visible-models.json')
}

/** Mutex queue to serialize all reads and writes to visible-models.json. */
let fileQueue = Promise.resolve<unknown>(undefined)

function withFileLock<T>(task: () => Promise<T>): Promise<T> {
  const next = fileQueue.then(task, task)
  fileQueue = next.then(() => {}, () => {})
  return next
}

/** Robustly extract the first top-level JSON object from a potentially corrupt or appended string. */
function extractFirstJsonObject(str: string): string | null {
  const start = str.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < str.length; i++) {
    const char = str[i]
    if (escape) {
      escape = false
      continue
    }
    if (char === '\\') {
      escape = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (!inString) {
      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          return str.slice(start, i + 1)
        }
      }
    }
  }
  return null
}

async function readDocument(): Promise<VisibilityDocument> {
  try {
    const text = await readFile(visibilityFilePath(), 'utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      // In case of corruption (e.g. leftover bytes from an interrupted write),
      // salvage by extracting the first complete top-level JSON object.
      const clean = extractFirstJsonObject(text)
      if (clean) {
        try {
          value = JSON.parse(clean)
          // Asynchronously self-heal the file on disk
          void writeDocument(value as VisibilityDocument).catch(() => {})
        } catch {
          // fall through
        }
      }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { hidden: {}, known: {}, unread: {} }
    }
    const doc = value as VisibilityDocument
    return {
      hidden: doc.hidden ?? {},
      known: doc.known ?? {},
      unread: doc.unread ?? {},
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hidden: {}, known: {}, unread: {} }
    }
    // Never throw a SyntaxError or I/O error to the caller, which would crash adapter.listModels.
    return { hidden: {}, known: {}, unread: {} }
  }
}

async function writeDocument(document: VisibilityDocument): Promise<void> {
  const path = visibilityFilePath()
  await mkdir(dirname(path), { recursive: true })
  // Unique temp file name prevents any concurrent write collisions
  const nonce = randomBytes(8).toString('hex')
  const tmp = `${path}.${process.pid}.${Date.now()}.${nonce}.tmp`
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  try { await chmod(tmp, 0o600) } catch { /* windows */ }
  try {
    await rename(tmp, path)
  } catch {
    // Windows fallback: if atomic rename fails, copy and delete
    await copyFile(tmp, path)
    await unlink(tmp).catch(() => {})
  }
}

export async function hiddenIds(provider: ProviderId): Promise<ReadonlySet<string>> {
  return withFileLock(async () => {
    const document = await readDocument()
    return new Set(document.hidden[provider] ?? [])
  })
}

export async function isModelVisible(provider: ProviderId, model: string): Promise<boolean> {
  return !(await hiddenIds(provider)).has(model)
}

/**
 * Synchronize newly discovered models for a provider:
 * - If this provider has no "known" list yet, initialize it with current models.
 * - Any newly appeared model is automatically:
 *     1. Hidden by default (added to `hidden`).
 *     2. Marked as unread (added to `unread`).
 *     3. Recorded in `known`.
 */
export async function syncDiscoveredModels(
  provider: ProviderId,
  currentModelIds: readonly string[],
): Promise<{ hidden: ReadonlySet<string>; unread: ReadonlySet<string> }> {
  return withFileLock(async () => {
    const document = await readDocument()
    if (!document.hidden[provider]) document.hidden[provider] = []
    if (!document.known) document.known = {}
    if (!document.unread) document.unread = {}

    const knownList = document.known[provider]
    const hiddenSet = new Set(document.hidden[provider])
    const unreadSet = new Set(document.unread[provider] ?? [])

    if (knownList === undefined) {
      // First time initializing: seed known with all current models so existing models aren't flagged as unread.
      document.known[provider] = [...currentModelIds].sort()
      await writeDocument(document)
      return { hidden: hiddenSet, unread: unreadSet }
    }

    const knownSet = new Set(knownList)
    let changed = false

    for (const id of currentModelIds) {
      if (!knownSet.has(id)) {
        // New model discovered: default to hidden, tag as unread, and record as known.
        hiddenSet.add(id)
        unreadSet.add(id)
        knownSet.add(id)
        changed = true
      }
    }

    if (changed) {
      document.hidden[provider] = [...hiddenSet].sort()
      document.known[provider] = [...knownSet].sort()
      document.unread[provider] = [...unreadSet].sort()
      await writeDocument(document)
    }

    return { hidden: hiddenSet, unread: unreadSet }
  })
}

/** Mark all unread models for a provider as read. */
export async function markProviderModelsRead(provider: ProviderId): Promise<void> {
  return withFileLock(async () => {
    const document = await readDocument()
    if (document.unread?.[provider] && document.unread[provider]!.length > 0) {
      document.unread[provider] = []
      await writeDocument(document)
    }
  })
}

export async function setModelVisible(provider: ProviderId, model: string, visible: boolean): Promise<void> {
  return withFileLock(async () => {
    const document = await readDocument()
    const current = new Set(document.hidden[provider] ?? [])
    if (visible) current.delete(model)
    else current.add(model)
    document.hidden[provider] = [...current].sort()

    if (!document.known) document.known = {}
    const knownSet = new Set(document.known[provider] ?? [])
    if (!knownSet.has(model)) {
      knownSet.add(model)
      document.known[provider] = [...knownSet].sort()
    }

    if (document.unread?.[provider]) {
      const unreadSet = new Set(document.unread[provider] ?? [])
      if (unreadSet.has(model)) {
        unreadSet.delete(model)
        document.unread[provider] = [...unreadSet].sort()
      }
    }

    await writeDocument(document)
  })
}

export async function filterVisible<T extends { id: string }>(
  provider: ProviderId,
  models: readonly T[],
): Promise<T[]> {
  const { hidden } = await syncDiscoveredModels(provider, models.map(m => m.id))
  if (hidden.size === 0) return [...models]
  return models.filter(model => !hidden.has(model.id))
}

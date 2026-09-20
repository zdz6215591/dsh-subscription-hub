/**
 * Per-provider model visibility and new-model discovery tracking.
 * - Hidden ids stay out of the composer picker.
 * - New catalog models default to HIDDEN (not displayed) and are tagged unread with subtle red dots.
 * - Once viewed / read, unread marks are cleared.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

async function readDocument(): Promise<VisibilityDocument> {
  try {
    const text = await readFile(visibilityFilePath(), 'utf8')
    const value = JSON.parse(text) as VisibilityDocument
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { hidden: {}, known: {}, unread: {} }
    }
    return {
      hidden: value.hidden ?? {},
      known: value.known ?? {},
      unread: value.unread ?? {},
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hidden: {}, known: {}, unread: {} }
    }
    throw error
  }
}

async function writeDocument(document: VisibilityDocument): Promise<void> {
  const path = visibilityFilePath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' })
  try { await chmod(tmp, 0o600) } catch { /* windows */ }
  await rename(tmp, path)
}

export async function hiddenIds(provider: ProviderId): Promise<ReadonlySet<string>> {
  const document = await readDocument()
  return new Set(document.hidden[provider] ?? [])
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
}

/** Mark all unread models for a provider as read. */
export async function markProviderModelsRead(provider: ProviderId): Promise<void> {
  const document = await readDocument()
  if (document.unread?.[provider] && document.unread[provider]!.length > 0) {
    document.unread[provider] = []
    await writeDocument(document)
  }
}

export async function setModelVisible(provider: ProviderId, model: string, visible: boolean): Promise<void> {
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
}

export async function filterVisible<T extends { id: string }>(
  provider: ProviderId,
  models: readonly T[],
): Promise<T[]> {
  const { hidden } = await syncDiscoveredModels(provider, models.map(m => m.id))
  if (hidden.size === 0) return [...models]
  return models.filter(model => !hidden.has(model.id))
}

/**
 * Per-provider model visibility. Hidden ids stay out of the composer picker.
 * New catalog models are visible until the user hides them (deny-list).
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ProviderId } from './auth/store.js'

export interface VisibilityDocument {
  hidden: Partial<Record<ProviderId, string[]>>
}

export function visibilityFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'visible-models.json')
}

async function readDocument(): Promise<VisibilityDocument> {
  try {
    const text = await readFile(visibilityFilePath(), 'utf8')
    const value = JSON.parse(text) as VisibilityDocument
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { hidden: {} }
    return { hidden: value.hidden ?? {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hidden: {} }
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

export async function setModelVisible(provider: ProviderId, model: string, visible: boolean): Promise<void> {
  const document = await readDocument()
  const current = new Set(document.hidden[provider] ?? [])
  if (visible) current.delete(model)
  else current.add(model)
  document.hidden[provider] = [...current].sort()
  await writeDocument(document)
}

export async function filterVisible<T extends { id: string }>(
  provider: ProviderId,
  models: readonly T[],
): Promise<T[]> {
  const hidden = await hiddenIds(provider)
  if (hidden.size === 0) return [...models]
  return models.filter(model => !hidden.has(model.id))
}

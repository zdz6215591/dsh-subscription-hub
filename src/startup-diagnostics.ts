/**
 * Diagnostics for the plugin's own startup.
 *
 * A route has TWO independent halves: its credential (in the auth store, which
 * the Settings card reads) and its adapter (in the plugin's `adapters` map, which
 * every model listing goes through). A route whose credential exists while its
 * adapter does not is the worst failure shape this plugin can produce, because
 * every surface stays quiet about it: the card says "connected", `visibility`
 * answers an empty list, the model picker shows nothing, and no error is raised
 * anywhere. The user sees "no models" and nothing else.
 *
 * Nothing else on disk records which adapters exist, so this writes it down. It is
 * a DIAGNOSTIC, not state: nothing reads it at runtime, and it is deliberately
 * cheap and failure-tolerant.
 *
 * @module dsh-subscription-hub/startup-diagnostics
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Where the registration record is written. */
export function registeredProvidersPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'registered-providers.json')
}

/**
 * Write the routes that registered, and the routes that were asked for.
 *
 * The difference between the two lists is the answer to "why does this route
 * show no models?" — a route missing from `registered` never got an adapter.
 * @param registered - the provider ids whose adapter was registered.
 * @param requested - the provider ids the plugin was configured to serve.
 * @param now - the instant, for the timestamp.
 */
export async function writeRegisteredProviders(
  registered: readonly string[],
  requested: readonly string[],
  now = new Date(),
): Promise<void> {
  const path = registeredProvidersPath()
  await mkdir(dirname(path), { recursive: true })
  const missing = requested.filter(id => !registered.includes(id))
  const payload = {
    at: now.toISOString(),
    pid: process.pid,
    registered,
    requested,
    // Spelled out rather than left to arithmetic, because this is the field a
    // reader is looking for.
    missing,
  }
  // A random-named temp file then a rename, like every other store here: a
  // pid-only name is shared by two writers in one process.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
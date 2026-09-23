/**
 * The machine fingerprint every COSY request carries.
 *
 * Qoder binds a session to the machine that minted it, so both `Cosy-Machineid`
 * and `Cosy-Machinetoken` must stay stable across restarts: a fresh value each
 * launch reads upstream as a new device and re-triggers whatever device
 * admission the account is under. The Qoder client's own file is the first
 * choice (it is the value upstream already knows); only when no Qoder install
 * left one is a DSH-owned value created, once, and reused thereafter.
 *
 * Ported from `masknull/dsh-qoder-connect` `src/qoder/transport/machine-id.ts`
 * (MIT). The DSH-owned fallback path is the hub's own state directory here
 * rather than the reference's `~/.dsh/qoder`, so every file this hub owns stays
 * under `dshHomePath('plugins', 'subscriptions')`.
 *
 * @module dsh-subscription-hub/providers/qoder/machine-id
 */

import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * Where the DSH-owned machine id lives.
 * @returns the absolute path of the fallback machine-id file.
 */
export function qoderMachineIdPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'qoder-machine-id')
}

/**
 * The locations probed for a machine id, in precedence order.
 * @returns the Qoder client's own file first, the DSH-owned fallback last.
 */
function defaultMachineIdPaths(): string[] {
  return [
    join(homedir(), '.qoder', '.auth', 'machine_id'),
    qoderMachineIdPath(),
  ]
}

/**
 * Read Qoder's machine id or create the DSH-owned fallback.
 * @param paths - probe order; the last entry is the one written to.
 * @returns a non-empty machine id, stable for this machine once created.
 */
export function getMachineId(paths: readonly string[] = defaultMachineIdPaths()): string {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // Try the next trusted location.
    }
  }

  const machineId = crypto.randomUUID()
  const savePath = paths.at(-1)
  if (savePath !== undefined) {
    try {
      mkdirSync(dirname(savePath), { recursive: true })
      writeFileSync(savePath, machineId, { encoding: 'utf8', flag: 'wx' })
    } catch {
      // Another process may have won creation; prefer its stable value.
      try {
        const existing = readFileSync(savePath, 'utf8').trim()
        if (existing) return existing
      } catch {
        // An ephemeral id is still sufficient for this process.
      }
    }
  }
  return machineId
}

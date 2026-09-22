/**
 * Trae device identity, read from the installed app rather than invented.
 *
 * Every authenticated Trae endpoint validates `x-machine-id` / `x-device-id`,
 * and the values are supposed to identify the machine the app runs on. The
 * plugin used to fabricate them: one `randomUUID()` per process, with the device
 * id taken as that same value's first 32 characters. Three things were wrong
 * with that:
 *
 * 1. **It changed on every restart.** A brand-new "device" every time the host
 *    started is exactly the pattern anti-abuse telemetry flags.
 * 2. **Both headers carried the same value.** `x-machine-id` and `x-device-id`
 *    were the same string, which no real client ever sends.
 * 3. **The lengths were wrong.** The official client sends the 64-character
 *    `telemetry.machineId` and the `icube-dc:` device id's numeric suffix.
 *
 * Verified against a real CN install on this machine:
 * `telemetry.machineId = 11b2ff2c…dea83423` (64 hex chars),
 * `iCubeAuthInfo://icube-dc:2556824262025977`, `iCubeLastVersion = 2.3.86566`,
 * and `product.json`'s `appVersion`. Note the app version the plugin hardcoded
 * was stale by 36 releases.
 *
 * Ported from dingminhua/dsh-connect-trae (MIT) `src/identity.ts`.
 *
 * @module dsh-subscription-hub/providers/trae/identity
 */

import { createHash } from 'node:crypto'
import { cpus, homedir, release } from 'node:os'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The editions whose install layout this module knows. */
export type TraeEdition = 'cn' | 'solo'

/** Install directory name per edition, used for identity discovery. */
const APP_NAME_BY_EDITION: Readonly<Record<TraeEdition, string>> = {
  cn: 'Trae CN',
  solo: 'TRAE SOLO CN',
}

/** Resolved device identity as the client would report it. */
export interface TraeIdentity {
  /** 64-character `telemetry.machineId`, or the install's `machineid` file. */
  machineId: string
  /** Numeric suffix of the `icube-dc:` device id, or a derived 32-char value. */
  deviceId: string
  /** The app version the real client sends as `x-app-version`. */
  appVersion?: string
  /** The build version the real client sends as `x-app-version-code`-adjacent state. */
  buildVersion?: string
  /** e.g. `Windows 10.0.26100` — the platform name plus its release, never a hostname. */
  osVersion: string
  /** `mac` / `windows` / other, as `x-device-type` carries it. */
  deviceType: string
  /** First CPU model word, which the client also reports. */
  deviceCpu?: string
  /** Whether these values came from a real install or were derived. */
  source: 'install' | 'derived'
}

/** One non-empty string read from a Trae-owned file, or undefined. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The machine id embedded in `iCubeAuthInfo://icube-dc:<id>`.
 *
 * The key name carries the value, so it is found by prefix rather than by a
 * fixed name: the id differs per install.
 */
export function deviceCenterIdFrom(storage: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(storage)) {
    if (!key.startsWith('iCubeAuthInfo://icube-dc:')) continue
    const id = nonEmpty(key.slice('iCubeAuthInfo://icube-dc:'.length))
    if (id !== undefined) return id
  }
  return undefined
}

/** `Windows 10.0.26100`, `macOS 15.0` — the shape the client reports. */
export function osVersionFor(platform: NodeJS.Platform, osRelease: string): string {
  const name = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform
  return `${name} ${osRelease}`
}

/** `x-device-type`, as the client spells it. */
export function deviceTypeFor(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
}

/** Whether a value looks like the 64-char machine id the client sends. */
export function looksLikeMachineId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

/**
 * Derive a STABLE identity when no install can be read.
 *
 * A machine running only the CLI, or a manually pasted token, has no
 * `storage.json` to read. The identity still must not change between restarts,
 * so it is derived from the account's own user id rather than generated: the
 * same account then reports the same device forever, and two different accounts
 * do not collide.
 * @param seed - a stable per-account value (the Trae user id).
 * @param platform - the platform to describe.
 * @returns a derived identity, marked as such.
 */
export function deriveTraeIdentity(
  seed: string,
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): TraeIdentity {
  const machineId = createHash('sha256').update(`dsh-subscription-hub:trae:${seed}`).digest('hex')
  return {
    machineId,
    deviceId: createHash('sha256').update(machineId).digest('hex').slice(0, 32),
    osVersion: osVersionFor(platform, osRelease),
    deviceType: deviceTypeFor(platform),
    source: 'derived',
  }
}

/** Where this module looks for one edition's identity, exposed for tests. */export interface TraeIdentityPaths {
  /** `…/User/globalStorage/storage.json`, whose telemetry keys carry the id. */
  storage: string
  /** `<appRoot>/machineid`, the fallback when telemetry has none. */
  machineIdFile: string
  /** Candidate `product.json` paths carrying the app version. */
  productFiles: readonly string[]
}

/**
 * Build the identity paths for one edition.
 * @param edition - which install to describe.
 * @param platform - defaults to the running platform.
 * @param home - defaults to the user's home directory.
 * @param env - defaults to the process environment.
 * @returns the candidate paths, in the order they should be tried.
 */
export function traeIdentityPaths(
  edition: TraeEdition,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeIdentityPaths {
  const appName = APP_NAME_BY_EDITION[edition]
  const roams: string[] = platform === 'darwin'
    ? [join(home, 'Library', 'Application Support')]
    : platform === 'win32'
      ? [env.APPDATA, join(home, 'AppData', 'Roaming')]
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .filter((value, index, all) => all.indexOf(value) === index)
      : [env.XDG_CONFIG_HOME ?? join(home, '.config')]
  const storage = join(roams[0] ?? home, appName, 'User', 'globalStorage', 'storage.json')
  // The machineid file sits at the install root: three levels above
  // `<app>/User/globalStorage/storage.json`.
  const machineIdFile = join(dirname(dirname(dirname(storage))), 'machineid')
  const productFiles: string[] = []
  if (platform === 'darwin') {
    productFiles.push(join('/Applications', `${appName}.app`, 'Contents', 'Resources', 'app', 'product.json'))
  } else if (platform === 'win32') {
    const locals = [env.LOCALAPPDATA, join(home, 'AppData', 'Local')]
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .filter((value, index, all) => all.indexOf(value) === index)
    for (const root of locals) productFiles.push(join(root, 'Programs', appName, 'resources', 'app', 'product.json'))
  }
  return { storage, machineIdFile, productFiles }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one edition's device identity from its install.
 *
 * Every field is best-effort against the app's own files and nothing is ever
 * generated into an impersonated id: when no stable machine id exists at all the
 * answer is `undefined`, and the caller derives one per account instead.
 * @param edition - which install to describe.
 * @param options - path/platform overrides for tests.
 * @returns the identity, or undefined when this machine has no readable id.
 */
export async function readTraeIdentity(
  edition: TraeEdition,
  options: {
    platform?: NodeJS.Platform
    home?: string
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<TraeIdentity | undefined> {
  const platform = options.platform ?? process.platform
  const paths = traeIdentityPaths(edition, platform, options.home ?? homedir(), options.env ?? process.env)
  const storage = await readJson(paths.storage)
  if (storage === undefined) return undefined

  // Historical official chat logs use the 64-char telemetry.machineId; the
  // install's `machineid` file is the fallback, not the primary.
  const machineId = nonEmpty(storage['telemetry.machineId'])
    ?? nonEmpty(await readFile(paths.machineIdFile, 'utf8').catch(() => ''))
  if (machineId === undefined) return undefined

  // The numeric suffix of iCubeAuthInfo://icube-dc:<id> is what the official CN
  // chat logs send as x-device-id; telemetry remains the fallback.
  const deviceId = deviceCenterIdFrom(storage)
    ?? nonEmpty(storage['telemetry.devDeviceId'])
    ?? createHash('sha256').update(machineId).digest('hex').slice(0, 32)

  // The app version the real client sends lives in product.json, whose location
  // differs per platform; a miss must not break identity resolution.
  let appVersion: string | undefined
  for (const path of paths.productFiles) {
    const product = await readJson(path)
    appVersion = nonEmpty(product?.['appVersion'])
    if (appVersion !== undefined) break
  }

  const buildVersion = nonEmpty(storage['iCubeLastVersion'])
  const cpu = cpus()[0]?.model.split(' ')[0]
  return {
    machineId,
    deviceId,
    ...appVersion === undefined ? {} : { appVersion },
    ...buildVersion === undefined ? {} : { buildVersion },
    osVersion: osVersionFor(platform, release()),
    deviceType: deviceTypeFor(platform),
    ...cpu === undefined ? {} : { deviceCpu: cpu },
    source: 'install',
  }
}

/**
 * One install read per edition per process.
 *
 * The identity is a constant of the machine, and every request needs it, so it
 * is read once and shared. A failure is remembered as `undefined` rather than
 * retried per request: a machine with no Trae install will never have one
 * mid-session.
 */
const installReads = new Map<TraeEdition, Promise<TraeIdentity | undefined>>()

/**
 * The identity for one edition, read from the install when it exists.
 * @param edition - which install to describe.
 * @returns the identity, or undefined when this machine has no readable id.
 */
export function traeInstallIdentity(edition: TraeEdition): Promise<TraeIdentity | undefined> {
  let pending = installReads.get(edition)
  if (pending === undefined) {
    pending = readTraeIdentity(edition).catch(() => undefined)
    installReads.set(edition, pending)
  }
  return pending
}

/** Drop the memoized install reads. Tests only. */
export function resetTraeIdentityCache(): void {
  installReads.clear()
}

/**
 * The identity to put on a request.
 *
 * Prefers the installed app's own values. A machine with only the CLI, or a
 * manually pasted token, has none — and inventing a fresh device each time is
 * what the previous implementation did wrong. Instead one is DERIVED from the
 * account's user id, so it is stable across restarts and distinct per account.
 * @param edition - which install to describe.
 * @param seed - a stable per-account value, used only when no install answers.
 * @returns the identity for this account's requests.
 */
export async function traeIdentityFor(edition: TraeEdition, seed: string): Promise<TraeIdentity> {
  const installed = await traeInstallIdentity(edition)
  if (installed !== undefined) return installed
  return deriveTraeIdentity(seed)
}
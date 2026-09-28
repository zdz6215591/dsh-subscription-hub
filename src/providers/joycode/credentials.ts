/**
 * JoyCode credential discovery and parsing.
 *
 * JoyCode signs in through its own IDE (QR scan or browser OAuth), so a headless
 * deployment has exactly two ways in: paste a `ptKey` (+ user id), or read the
 * credential the IDE already stored. This module is the second one.
 *
 * ## Where the credential lives
 *
 * The IDE keeps it in its Electron state database — SQLite, table `ItemTable`,
 * key `JoyCoder.IDE`, JSON value `{ joyCoderUser: { ptKey, userId, … } }` — under
 * `…/JoyCode/User/globalStorage/state.vscdb`:
 *
 *   - macOS   `~/Library/Application Support/`
 *   - Linux   `~/.config/`
 *   - Windows `%APPDATA%/`
 *
 * Both reference implementations probe those three, and the container path
 * `/root/.joycode-ide/state.vscdb` (a mount target) is probed before any home
 * lookup. `JOYCODE_STATE_DB` overrides everything.
 *
 * The database is opened READ-ONLY: the IDE is very likely running and holding
 * it, and the reference states the reason plainly — a read-only open takes a
 * shared lock and never blocks the IDE.
 *
 * @module dsh-subscription-hub/providers/joycode/credentials
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { JoyCodeCredential } from './client.js'

/** SQLite key holding the IDE's JoyCode login document. */
export const JOYCODE_STATE_KEY = 'JoyCoder.IDE'

/**
 * Directory the state database lives under, per separator convention.
 *
 * Spelled per platform rather than joined with the running host's separator: a
 * candidate list is a statement about ANOTHER machine's layout (the tests build
 * Linux paths on Windows and vice versa), and a backslashed Linux path is not a
 * path that machine has.
 */
const STATE_DB_POSIX = 'JoyCode/User/globalStorage/state.vscdb'
const STATE_DB_WINDOWS = 'JoyCode\\User\\globalStorage\\state.vscdb'

/** A mount target used by the container images, probed before $HOME. */
const CONTAINER_STATE_DB = '/root/.joycode-ide/state.vscdb'

/**
 * Every state-database path to try, in order.
 * @param platform - target platform; defaults to the running one.
 * @param home - home directory; defaults to the real one.
 * @param env - environment; defaults to `process.env`.
 * @returns candidate paths, most specific first.
 */
export function joyCodeStateDbCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = []
  const override = env.JOYCODE_STATE_DB
  if (typeof override === 'string' && override !== '') candidates.push(override)
  if (platform !== 'win32' && platform !== 'darwin') candidates.push(CONTAINER_STATE_DB)
  if (platform === 'darwin') {
    candidates.push(posix.join(home, 'Library', 'Application Support', STATE_DB_POSIX))
  } else if (platform === 'win32') {
    const appData = env.APPDATA !== undefined && env.APPDATA !== ''
      ? env.APPDATA
      : win32.join(home, 'AppData', 'Roaming')
    candidates.push(win32.join(appData, STATE_DB_WINDOWS))
  } else {
    const configHome = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
      ? env.XDG_CONFIG_HOME
      : posix.join(home, '.config')
    candidates.push(posix.join(configHome, STATE_DB_POSIX))
  }
  return [...new Set(candidates)]
}

/**
 * Read the stored credential document from one state database.
 *
 * @param path - the `state.vscdb` path.
 * @returns the credential fields, or undefined when the file or key is absent.
 * @throws {LlmError} `SERVER` when the database exists but cannot be read (a
 *   missing SQLite driver, a corrupt file), because "the IDE is logged out" and
 *   "this Node cannot read SQLite" need different fixes.
 */
export async function readJoyCodeStateDb(path: string): Promise<JoyCodeStoredCredential | undefined> {
  if (!existsSync(path)) return undefined
  let sqlite: typeof import('node:sqlite')
  try {
    // `node:sqlite` ships with Node 22.5+; a deployment older than that gets the
    // paste path instead, and this message says so rather than failing obscurely.
    sqlite = await import('node:sqlite')
  } catch (error) {
    throw new LlmError(
      `JoyCode credential import needs Node's built-in SQLite (node:sqlite): ${String(error)}. Paste the ptKey instead.`,
      'SERVER',
      { cause: error },
    )
  }
  let db: import('node:sqlite').DatabaseSync | undefined
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(JOYCODE_STATE_KEY) as
      | { value?: unknown }
      | undefined
    const value = row?.value
    if (value === undefined) return undefined
    const text = typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString('utf8')
    return parseJoyCodeStateValue(text)
  } catch (error) {
    throw new LlmError(
      `could not read JoyCode's state database at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'SERVER',
      { cause: error },
    )
  } finally {
    db?.close()
  }
}

/** The `joyCoderUser` document the IDE stores, as much of it as this route uses. */
interface StoredJoyCoderUser {
  ptKey?: unknown
  userId?: unknown
  userName?: unknown
  colorBaseUrl?: unknown
  masterBaseUrl?: unknown
  tenant?: unknown
  loginType?: unknown
  orgFullName?: unknown
}

/** A discovered credential plus the IDE's display name for the account. */
export interface JoyCodeStoredCredential extends JoyCodeCredential {
  /** The IDE's own `userName`, used as the account's display label. */
  account?: string
}

/**
 * Parse the stored document into credential fields.
 *
 * The value is the IDE's own JSON, so the fields are read tolerantly: an absent
 * `ptKey` or `userId` means the document is not a usable login (the IDE has
 * never signed in, or signed out) and the caller must say so.
 * @param raw - the `ItemTable.value` text.
 * @returns the credential, or undefined when the document is not a login.
 */
export function parseJoyCodeStateValue(raw: string): JoyCodeStoredCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  const nested = typeof root.joyCoderUser === 'object' && root.joyCoderUser !== null
    ? root.joyCoderUser as StoredJoyCoderUser
    : root as StoredJoyCoderUser
  const ptKey = str(nested.ptKey)
  const userId = str(nested.userId)
  if (ptKey === undefined || userId === undefined) return undefined
  const colorBaseUrl = str(nested.colorBaseUrl)
  const masterBaseUrl = str(nested.masterBaseUrl)
  const tenant = str(nested.tenant)
  const loginType = str(nested.loginType)
  const orgFullName = str(nested.orgFullName)
  const account = str(nested.userName)
  return {
    ptKey,
    userId,
    ...colorBaseUrl === undefined ? {} : { colorBaseUrl },
    ...masterBaseUrl === undefined ? {} : { masterBaseUrl },
    ...tenant === undefined ? {} : { tenant },
    ...loginType === undefined ? {} : { loginType },
    ...orgFullName === undefined ? {} : { orgFullName },
    ...account === undefined ? {} : { account },
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Extension package locations the IDE version can be read from, per platform. */
function extensionPackageCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const relative = 'extensions/joycoder-editor/package.json'
  const relativeWindows = 'extensions\\joycoder-editor\\package.json'
  const candidates: string[] = []
  const override = env.JOYCODE_EXT_PKG
  if (typeof override === 'string' && override !== '') candidates.push(override)
  if (platform === 'darwin') {
    candidates.push(posix.join('/Applications', 'JoyCode.app', 'Contents', 'Resources', 'app', relative))
    candidates.push(posix.join(home, 'Applications', 'JoyCode.app', 'Contents', 'Resources', 'app', relative))
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== ''
      ? env.LOCALAPPDATA
      : win32.join(home, 'AppData', 'Local')
    candidates.push(win32.join(local, 'Programs', 'JoyCode', 'resources', 'app', relativeWindows))
  } else {
    candidates.push(posix.join('/opt', 'JoyCode', 'resources', 'app', relative))
    candidates.push(posix.join(home, '.local', 'share', 'JoyCode', 'resources', 'app', relative))
  }
  return candidates
}

/**
 * The JoyCode IDE's own version, when it can be read.
 *
 * The gateway's gray-release gate is documented to trust the EXTENSION's version
 * rather than the app shell's, which is why the reference port that added this
 * read considered it a fix (`ref-switch-dev/CHANGELOG.md`). Read opportunistically:
 * a deployment without the IDE falls back to the protocol constant.
 * @param platform - target platform.
 * @param home - home directory.
 * @param env - environment.
 * @returns the extension version, or undefined when no copy is readable.
 */
export async function joyCodeExtensionVersion(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const path of extensionPackageCandidates(platform, home, env)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const version = str((parsed as Record<string, unknown> | null)?.version)
      if (version !== undefined) return version
    } catch { /* try the next location */ }
  }
  return undefined
}

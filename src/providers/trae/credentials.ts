/**
 * Trae (ByteDance) credential discovery and decryption.
 *
 * Trae signs in through its own desktop app rather than an OAuth flow this
 * plugin drives, so an account is imported from the local install:
 *
 *   - the Electron app keeps a `User/globalStorage/storage.json` whose
 *     `iCubeAuthInfo://icube.cloudide` value is either plaintext JSON or an
 *     AES-CBC blob (`[6B magic][32B random][ciphertext]`);
 *   - the Trae CLI writes a bare, unencrypted JWT to `~/.trae-cn/trae-jwt-token`.
 *
 * Only the CN channels are supported here (see {@link TRAE_CHANNELS}): the
 * international installs route through different gateways with an unverified
 * refresh contract, so they are deliberately not discovered.
 *
 * Adapted from dingminhua/dsh-connect-trae (MIT) — `decrypt.ts` / `paths.ts` /
 * `auth.ts` — and Wang-JQ77/dsh-trae-api (MIT) `trae-decrypt.js`, whose layout
 * documents are byte-identical.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Storage key holding the encrypted/plaintext auth document. */
export const TRAE_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide'

/**
 * The two CN channels this plugin serves. Both are ByteDance Trae products on
 * the same CN gateway, but they expose different model rosters and are separate
 * sign-ins, so each is imported and listed independently.
 */
export type TraeChannel = 'solo' | 'ide'

export interface TraeChannelDefinition {
  id: TraeChannel
  /** Display name for the account picker. */
  label: string
  /** Electron app-data directory name (Windows `%APPDATA%`, macOS `Application Support`). */
  appName: string
  /** Linux config directory spellings probed in order. */
  linuxAppNames: readonly string[]
}

export const TRAE_CHANNELS: readonly TraeChannelDefinition[] = [
  { id: 'solo', label: 'TRAE SOLO CN', appName: 'TRAE SOLO CN', linuxAppNames: ['trae-solo-cn', 'TRAE SOLO CN'] },
  { id: 'ide', label: 'Trae CN IDE', appName: 'Trae CN', linuxAppNames: ['trae-cn', 'Trae CN', 'trae', 'Trae'] },
]

/** CLI home directory names, mapped to the channel whose roster they serve. */
const TRAE_CLI_HOMES: readonly { name: string; channel: TraeChannel }[] = [
  { name: '.trae-cn', channel: 'ide' },
]

/** Basename of the CLI's persisted bare JWT. */
export const TRAE_CLI_TOKEN_FILENAME = 'trae-jwt-token'

/** Where a credential came from, for the Settings-page diagnostics. */
export type TraeCredentialSource = 'desktop' | 'cli'

/** One candidate credential location, tried in order. */
export interface TraeCandidate {
  channel: TraeChannel
  edition: 'cn' | 'solo'
  path: string
  source: TraeCredentialSource
}

function channelOf(definition: TraeChannelDefinition): { channel: TraeChannel; edition: 'cn' | 'solo' } {
  return definition.id === 'solo'
    ? { channel: 'solo', edition: 'solo' }
    : { channel: 'ide', edition: 'cn' }
}

/**
 * Every local credential path to try, in priority order. Desktop storage files
 * come first (they carry a refresh token); CLI token files are the fallback for
 * a machine with only the CLI installed.
 */
export function traeCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeCandidate[] {
  const result: TraeCandidate[] = []
  for (const definition of TRAE_CHANNELS) {
    const identity = channelOf(definition)
    let roots: string[]
    let appNames: readonly string[]
    if (platform === 'darwin') {
      roots = [join(home, 'Library', 'Application Support')]
      appNames = [definition.appName]
    } else if (platform === 'win32') {
      roots = [env.APPDATA, join(home, 'AppData', 'Roaming')].filter(
        (value, index, all): value is string =>
          typeof value === 'string' && value !== '' && all.indexOf(value) === index,
      )
      appNames = [definition.appName]
    } else if (platform === 'linux') {
      roots = [env.XDG_CONFIG_HOME ?? join(home, '.config')]
      appNames = definition.linuxAppNames
    } else {
      roots = []
      appNames = [definition.appName]
    }
    for (const root of roots) {
      for (const appName of appNames) {
        result.push({
          ...identity,
          path: join(root, appName, 'User', 'globalStorage', 'storage.json'),
          source: 'desktop',
        })
      }
    }
  }
  // The CLI home is a dotfile directory directly under $HOME on every observed
  // platform; on Windows both USERPROFILE and the resolved home are probed.
  const cliRoots: string[] = []
  if (platform === 'win32') {
    for (const value of [env.USERPROFILE, home]) {
      if (typeof value === 'string' && value !== '' && !cliRoots.includes(value)) cliRoots.push(value)
    }
  } else {
    cliRoots.push(home)
  }
  for (const root of cliRoots) {
    for (const entry of TRAE_CLI_HOMES) {
      result.push({
        channel: entry.channel,
        edition: entry.channel === 'solo' ? 'solo' : 'cn',
        path: join(root, entry.name, TRAE_CLI_TOKEN_FILENAME),
        source: 'cli',
      })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Decryption (the "tc" container). Four hardcoded 64-byte salt tables from the
// Trae CN frontend bundle; the active one is selected by the 6-byte magic.
// ---------------------------------------------------------------------------

const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])
const SALT_C = Uint8Array.from([
  191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176,
  135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156,
  51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6,
  18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
])
const SALT_D = Uint8Array.from([
  246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145,
  50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106,
  175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154,
  86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
])

type TraeEncryption = 'aes' | 'aes-private'

function xorSalts(a: Uint8Array, b: Uint8Array): Buffer {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)))
}

function encryptionType(header: Buffer): TraeEncryption {
  if (header.equals(Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]))) return 'aes'
  if (header.equals(Buffer.from([18, 57, 32, 32, 2, 3]))) return 'aes-private'
  throw new Error('unsupported Trae auth encryption header')
}

/**
 * Decrypt one `iCubeAuthInfo://icube.cloudide` value.
 * @param encoded - the base64 ciphertext as stored.
 * @returns the plaintext JSON document.
 */
export function decryptTraeStorageValue(encoded: string): string {
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length <= 102) throw new Error('Trae auth ciphertext is too short')
  const type = encryptionType(buffer.subarray(0, 6))
  const random = buffer.subarray(6, 38)
  const encrypted = buffer.subarray(38)
  // Key/IV derivation: sha512( sha512(random) || salt ), key = [0,16), iv = [16,32).
  const salt = type === 'aes-private' ? xorSalts(SALT_C, SALT_D) : xorSalts(SALT_A, SALT_B)
  const first = createHash('sha512').update(random).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length < 64) throw new Error('Trae auth plaintext is too short')
  // The first 64 bytes are a SHA-512 digest of the JSON that follows.
  const expected = decrypted.subarray(0, 64)
  const plaintext = decrypted.subarray(64)
  const actual = createHash('sha512').update(plaintext).digest()
  if (!expected.equals(actual)) throw new Error('Trae auth integrity check failed')
  return plaintext.toString('utf8')
}

/** Parse the auth value: plaintext JSON when it starts with `{`, else decrypt. */
export function parseTraeAuthValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('Trae auth value is empty')
  const plaintext = trimmed.startsWith('{') ? trimmed : decryptTraeStorageValue(trimmed)
  return JSON.parse(plaintext) as unknown
}

/** Parse a desktop `storage.json` document into the inner auth document. */
export function parseTraeStorageDocument(text: string): unknown {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Trae storage document must be an object')
  }
  const value = (parsed as Record<string, unknown>)[TRAE_AUTH_STORAGE_KEY]
  if (typeof value !== 'string') {
    throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`)
  }
  return parseTraeAuthValue(value)
}

/** Claims read from a Trae CLI `trae-jwt-token` file. */
export interface TraeCliTokenClaims {
  accessToken: string
  userId: string
  expiresAtMs?: number
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | undefined {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse the CLI token file: a bare three-part JWT (or a JSON envelope carrying
 * one). The signature is not verified — the token is consumed locally and
 * re-validated upstream on every request.
 */
export function parseTraeCliToken(text: string): TraeCliTokenClaims {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('Trae CLI token file is empty')
  let token = trimmed
  if (trimmed.startsWith('{')) {
    const envelope = JSON.parse(trimmed) as Record<string, unknown>
    const candidate = envelope.token ?? envelope.accessToken ?? envelope.jwt
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new Error('Trae CLI token document has no token field')
    }
    token = candidate.trim()
  }
  const segments = token.split('.')
  if (segments.length !== 3 || segments.some(segment => segment === '')) {
    throw new Error('Trae CLI token is not a three-part JWT')
  }
  const payload = decodeBase64UrlJson(segments[1]!)
  if (payload === undefined) throw new Error('Trae CLI token payload is not decodable JSON')
  const data = typeof payload.data === 'object' && payload.data !== null && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : undefined
  const userId = typeof data?.user_id === 'string' ? data.user_id : undefined
  if (userId === undefined || userId === '') throw new Error('Trae CLI token has no data.user_id claim')
  const exp = payload.exp
  const expiresAtMs = typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  return { accessToken: token, userId, ...expiresAtMs === undefined ? {} : { expiresAtMs } }
}

/** A normalized credential read from one candidate path. */
export interface TraeCredential {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshExpiresAt?: number
  userId: string
  account?: string
  host: string
  channel: TraeChannel
  edition: 'cn' | 'solo'
  source: TraeCredentialSource
}

/** Host used for CLI tokens, which carry no host claim of their own. */
export const TRAE_CN_DEFAULT_HOST = 'https://api.trae.cn'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Normalize the decrypted auth document into a credential. */
export function normalizeTraeCredential(
  raw: unknown,
  channel: TraeChannel,
  edition: 'cn' | 'solo',
  source: TraeCredentialSource,
): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value.token) ?? optionalString(value.accessToken)
  if (accessToken === undefined) return undefined
  const account = typeof value.account === 'object' && value.account !== null && !Array.isArray(value.account)
    ? value.account as Record<string, unknown>
    : undefined
  const accountName = optionalString(account?.username)
  const refreshExpiresAt = timeToMs(value.refreshExpiredAt ?? value.refreshExpiresAt)
  return {
    accessToken,
    refreshToken: optionalString(value.refreshToken) ?? '',
    expiresAt: timeToMs(value.expiredAt ?? value.expiresAt) ?? 0,
    ...refreshExpiresAt === undefined ? {} : { refreshExpiresAt },
    userId: optionalString(value.userId) ?? '',
    ...accountName === undefined ? {} : { account: accountName },
    host: optionalString(value.host) ?? TRAE_CN_DEFAULT_HOST,
    channel,
    edition,
    source,
  }
}

/** One candidate path that did not yield an account (token-free diagnostics). */
export interface TraeCandidateFailure {
  path: string
  channel: TraeChannel
  source: TraeCredentialSource
  reason: 'missing' | 'unreadable' | 'invalid'
  message?: string
}

/** Read one candidate file into a credential, or throw. */
async function credentialFrom(candidate: TraeCandidate): Promise<TraeCredential> {
  let text: string
  try {
    text = await readFile(candidate.path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const wrapped = new Error(code === 'ENOENT' ? 'missing' : `unreadable: ${String(error)}`)
    ;(wrapped as { reason?: string }).reason = code === 'ENOENT' ? 'missing' : 'unreadable'
    throw wrapped
  }
  if (candidate.source === 'cli') {
    const claims = parseTraeCliToken(text)
    const credential = normalizeTraeCredential({
      token: claims.accessToken,
      refreshToken: '',
      userId: claims.userId,
      host: TRAE_CN_DEFAULT_HOST,
      ...claims.expiresAtMs === undefined ? {} : { expiredAt: claims.expiresAtMs },
    }, candidate.channel, candidate.edition, 'cli')
    if (credential === undefined) throw new Error('CLI candidate could not be normalized into a credential')
    return credential
  }
  const credential = normalizeTraeCredential(
    parseTraeStorageDocument(text),
    candidate.channel,
    candidate.edition,
    'desktop',
  )
  if (credential === undefined) throw new Error('desktop candidate could not be normalized into a credential')
  return credential
}

/** Result of one discovery sweep. */
export interface TraeDiscoveryResult {
  credentials: TraeCredential[]
  failures: TraeCandidateFailure[]
}

/**
 * Discover every locally signed-in CN Trae account. Reading is read-only and
 * never touches the desktop storage files; the plugin keeps its own refreshed
 * copy in the shared auth store.
 */
export async function discoverTraeCredentials(
  candidates: readonly TraeCandidate[] = traeCandidates(),
): Promise<TraeDiscoveryResult> {
  const credentials: TraeCredential[] = []
  const failures: TraeCandidateFailure[] = []
  for (const candidate of candidates) {
    try {
      const credential = await credentialFrom(candidate)
      // One account per (channel, user): a channel with both a desktop and a
      // CLI credential would otherwise list the same sign-in twice.
      if (credentials.some(existing =>
        existing.channel === credential.channel
        && (existing.userId !== '' ? existing.userId : existing.accessToken) === (credential.userId !== '' ? credential.userId : credential.accessToken))) {
        continue
      }
      credentials.push(credential)
    } catch (error) {
      const reason = (error as { reason?: string }).reason
      failures.push({
        path: candidate.path,
        channel: candidate.channel,
        source: candidate.source,
        reason: reason === 'missing' || reason === 'unreadable' ? reason : 'invalid',
        ...reason === 'missing' ? {} : { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return { credentials, failures }
}

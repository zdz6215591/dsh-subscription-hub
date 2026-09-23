/**
 * COSY authentication headers and signature algorithm for Qoder services.
 *
 * Every Qoder gateway request is signed. The scheme is COSY: a per-request
 * AES-128 key encrypts the caller's identity, that key is wrapped with a fixed
 * RSA public key, and an MD5 signature binds the wrapped key, the timestamp,
 * the request body and the signed path together. Nothing is derived from a
 * server-issued nonce, so a captured signature is replayable for as long as its
 * timestamp is accepted — which is exactly why the timestamp and request id are
 * generated fresh per request here.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect`
 * `src/qoder/transport/wire/cosy.ts` (MIT). The client-version constants are
 * hard-coded by the reference for the reasons cited on each one, and must not be
 * "modernized": the gateway gates behavior on them.
 *
 * @module dsh-subscription-hub/providers/qoder/cosy
 */

import crypto from 'node:crypto'
import { getMachineId } from './machine-id.js'

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** The IDE version the gateway gates behavior on; the reference hard-codes it. */
export const qoderIdeVersion = '1.1.47'
/** The generic client identifier every non-campaign route sends. */
export const qoderClientType = '5'
/**
 * The desktop client identifier the campaign endpoints require.
 *
 * Measured against the live upstream: `/sash/api/v1/me/campaigns` answers
 * HTTP 200 with an EMPTY `campaigns` array when the caller presents the
 * generic {@link qoderClientType} (`5`), and returns the real list only when
 * it presents the desktop identifier `10`. A check-in built on the wrong
 * identifier looks healthy at the transport layer — status 200, no error —
 * while silently reporting "no campaign today" forever, so the campaign
 * paths must send this one explicitly.
 */
export const qoderDesktopClientType = '10'
/** The user agent every COSY-signed request carries. */
export const defaultUserAgent = `qoder/${qoderIdeVersion}`
const qoderDataPolicy = 'disagree'
const qoderLoginVersion = 'v2'
const qoderMachineOs = process.platform === 'win32'
  ? process.arch === 'arm64'
    ? 'aarch64_windows'
    : 'x86_64_windows'
  : process.arch === 'arm64'
    ? 'aarch64_linux'
    : 'x86_64_linux'
const qoderMachineTypeMagic = '5'

/** What {@link buildAuthHeaders} needs to sign one request. */
export interface CosyCredentials {
  /** Qoder account id (`Cosy-User`). */
  userID: string
  /** The job token exchanged from the account's PAT. */
  authToken: string
  /** Display name; may be empty. */
  name: string
  /** Account email; may be empty. */
  email: string
  /** Machine fingerprint; resolved from the stored/created machine id when omitted. */
  machineID?: string
}

interface UserInfo {
  uid: string
  security_oauth_token: string
  name: string
  aid: string
  email: string
}

interface CosyPayload {
  version: string
  requestId: string
  info: string
  cosyVersion: string
  ideVersion: string
}

/**
 * The path a COSY signature covers: the URL path with the `/algo` prefix
 * removed.
 *
 * qodercli's WASM `prepareRequest` adds `/algo` to the HTTP URL and signs the
 * path WITHOUT it, so the two must be derived from the same source here.
 * @param urlStr - the fully qualified request URL.
 * @returns the signed path.
 */
export function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr)
  let sigPath = parsed.pathname
  if (sigPath.startsWith('/algo')) {
    sigPath = sigPath.substring('/algo'.length)
  }
  return sigPath
}

function rsaEncryptBase64(data: Buffer | string): string {
  const key = {
    key: qoderRSAPublicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }
  const encrypted = crypto.publicEncrypt(key, typeof data === 'string' ? Buffer.from(data) : data)
  return encrypted.toString('base64')
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr), Buffer.from(keyStr))
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  return encrypted
}

/**
 * Build the complete COSY header set for one request.
 *
 * @param body - the exact bytes that will be sent as the body, or null for a
 *   request without one. The signature and `Cosy-Bodyhash` / `Cosy-Bodylength`
 *   are computed over these bytes, so they cannot be assembled after the fact.
 * @param requestURL - the fully qualified request URL; `/algo` is stripped from
 *   the signed path.
 * @param creds - the account identity and job token to sign with.
 * @returns the headers to merge into the request.
 * @throws Error when `creds.userID` or `creds.authToken` is empty — a signed
 *   request with no identity is never accepted, and failing here names the
 *   cause instead of producing a silent 401 upstream.
 */
export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
): Record<string, string> {
  if (!creds.userID) {
    throw new Error('cosy: user id is empty')
  }
  if (!creds.authToken) {
    throw new Error('cosy: auth token is empty')
  }

  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const userInfo: UserInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || '',
    aid: '',
    email: creds.email || '',
  }

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey)
  const cosyKey = rsaEncryptBase64(aesKey)

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const requestId = crypto.randomUUID()

  const cosyPayload: CosyPayload = {
    version: 'v1',
    requestId,
    info: infoB64,
    cosyVersion: qoderIdeVersion,
    ideVersion: '',
  }

  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString('base64')
  const sigPath = computeSigPath(requestURL)

  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString('utf8') : body) : ''
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`
  const sig = crypto.createHash('md5').update(sigInput).digest('hex')

  const bodyHash = crypto
    .createHash('md5')
    .update(body || '')
    .digest('hex')
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : '0'

  const machineID = creds.machineID || getMachineId()

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': qoderIdeVersion,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': qoderMachineTypeMagic,
    'Cosy-Machineos': qoderMachineOs,
    'Cosy-Clienttype': qoderClientType,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': bodyLen,
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': qoderDataPolicy,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': qoderLoginVersion,
    'X-Request-Id': crypto.randomUUID(),
  }
}

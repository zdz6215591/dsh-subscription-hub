/** Minimal PKCE (RFC 7636) with S256, hand-rolled on node:crypto (no extra dependency). */

import { createHash, randomBytes } from 'node:crypto'

function base64url(input: Buffer): string {
  return input.toString('base64url')
}

/** Generate a PKCE verifier (43-char URL-safe random) and its S256 challenge. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Encode an object into a URL-safe base64 string (used for the OAuth state). */
export function encodeState(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode a URL-safe base64 OAuth state back into its structured representation. */
export function decodeState<T>(state: string): T {
  const normalized = state.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + (((4 - (normalized.length % 4)) % 4)),
    '=',
  )
  const json = Buffer.from(padded, 'base64').toString('utf8')
  return JSON.parse(json) as T
}

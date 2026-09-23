/**
 * Qoder WAF body encoding (`Encode=1`) and its exact inverse.
 *
 * Every request that carries `Encode=1` — chat streaming and the model catalog —
 * sends a body that is standard Base64 with the three chunks rotated
 * (`Math.floor(n / 3)` trailing characters moved to the front) and then
 * translated character-for-character through a custom alphabet. It is not
 * encryption and it is not a real codec: it exists to get past the gateway's
 * WAF, which rejects the literal Base64 of a JSON model request.
 *
 * Ported from `masknull/dsh-qoder-connect`
 * `src/qoder/transport/wire/encoding.ts` (MIT). The reference ships the ENCODE
 * direction only — its SSE reader parses the envelope body as plain JSON and
 * never reverses this transform — so {@link qoderDecodeBody} is the exact
 * mathematical inverse derived from the algorithm below, and is verified here
 * against a round trip rather than against reference code that does not exist.
 *
 * Both directions run through a 256-byte translation table applied to a Buffer
 * rather than a per-character string loop. The loop form (`out += char` plus
 * `alphabet.indexOf(char)`) costs ~800 ms on a 1 MB body and runs on the main
 * thread once per model request, which saturated the harness event loop as soon
 * as a few large-context sessions were in flight. The table form is
 * byte-for-byte identical (the input is always Base64, i.e. ASCII) and about
 * 24x faster.
 *
 * @module dsh-subscription-hub/providers/qoder/encoding
 */

const qoderCustomAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const qoderStdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Byte translation table: every byte maps to itself unless it is a Base64
 * alphabet character (→ the custom alphabet) or the `=` pad (→ `$`).
 */
const encodeTable: Uint8Array = (() => {
  const table = new Uint8Array(256)
  for (let index = 0; index < 256; index++) table[index] = index
  for (let index = 0; index < qoderStdAlphabet.length; index++) {
    table[qoderStdAlphabet.charCodeAt(index)] = qoderCustomAlphabet.charCodeAt(index)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/** The exact inverse of {@link encodeTable}: custom alphabet (and `$`) back to standard Base64. */
const decodeTable: Uint8Array = (() => {
  const table = new Uint8Array(256)
  for (let index = 0; index < 256; index++) table[index] = index
  for (let index = 0; index < qoderStdAlphabet.length; index++) {
    table[qoderCustomAlphabet.charCodeAt(index)] = qoderStdAlphabet.charCodeAt(index)
  }
  table['$'.charCodeAt(0)] = '='.charCodeAt(0)
  return table
})()

/**
 * Rotate the three Base64 chunks so the trailing third leads.
 *
 * The transform is its own inverse when applied to a string of the same length:
 * `std = A + B + C` with `|A| = |C| = floor(n / 3)` maps to `C + B + A`, and
 * applying the same slice arithmetic to that result gives `A + B + C` back.
 * @param text - a Base64 string.
 * @returns the rotated string.
 */
function rotateBase64Chunks(text: string): string {
  const n = text.length
  const a = Math.floor(n / 3)
  return text.slice(n - a) + text.slice(a, n - a) + text.slice(0, a)
}

/** Apply one 256-byte table to a latin1 view of an ASCII string. */
function translateBytes(text: string, table: Uint8Array): string {
  // Base64 output is ASCII by construction, so a latin1 view is exact and the
  // table applies byte-wise.
  const source = Buffer.from(text, 'latin1')
  const target = Buffer.allocUnsafe(source.length)
  for (let index = 0; index < source.length; index++) {
    // Both indexes are in range by construction; the fallbacks only satisfy
    // noUncheckedIndexedAccess.
    target[index] = table[source[index] ?? 0] ?? 0
  }
  return target.toString('latin1')
}

/**
 * Encode one JSON request body for the Qoder WAF.
 * @param plaintext - the JSON text, or its bytes.
 * @returns the encoded body to send under `Encode=1`.
 */
export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64')
  return translateBytes(rotateBase64Chunks(std), encodeTable)
}

/**
 * Decode one `Encode=1` body back to its bytes.
 *
 * The exact inverse of {@link qoderEncodeBody}: undo the alphabet translation,
 * undo the chunk rotation, then Base64-decode. A body that was never encoded
 * does not round-trip — decoding it yields whatever Base64 its own characters
 * happen to spell — so callers must know from the request that `Encode=1` was
 * in force.
 * @param encoded - the encoded body text.
 * @returns the decoded bytes.
 */
export function qoderDecodeBodyBuffer(encoded: string): Buffer {
  const untranslated = translateBytes(encoded, decodeTable)
  return Buffer.from(rotateBase64Chunks(untranslated), 'base64')
}

/**
 * Decode one `Encode=1` body back to its UTF-8 text.
 * @param encoded - the encoded body text.
 * @returns the decoded text.
 */
export function qoderDecodeBody(encoded: string): string {
  return qoderDecodeBodyBuffer(encoded).toString('utf8')
}

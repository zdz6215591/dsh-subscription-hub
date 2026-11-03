/**
 * AWS event-stream decoding, the framing Kiro answers `generateAssistantResponse` with.
 *
 * Kiro is not an SSE service. A reply is `application/vnd.amazon.eventstream`: a
 * sequence of BINARY frames, each
 *
 *   [0..4)   total byte length (big-endian uint32, includes the 16-byte envelope)
 *   [4..8)   headers byte length (uint32)
 *   [8..12)  prelude CRC32
 *   [12..12+headers)  typed headers
 *   …        payload (JSON)
 *   [total-4..total)  message CRC32
 *
 * Only the headers and the payload are read here: the type of a frame lives in
 * `:message-type` (`event` | `exception` | `error`) and `:event-type`, and the
 * body is JSON. The CRCs are deliberately NOT verified — the reference
 * implementation (`packages/kiro/index.mjs`, `frames()`) does not either, and a
 * mismatch there would be a transport fault the HTTP layer already surfaces;
 * verifying them here would only add a second place to get the byte offsets
 * wrong. What IS enforced is every length: a frame whose declared size cannot
 * fit its own envelope is rejected rather than trusted, because a truncated
 * stream otherwise decodes as garbage JSON and reads as "the model said nothing".
 */

/** One decoded frame: its string headers and its payload bytes. */
export interface EventStreamFrame {
  /** `:message-type`, `:event-type`, `:exception-type` and friends. */
  headers: Record<string, string>
  /** JSON payload bytes (not yet decoded). */
  payload: Uint8Array
}

/** Largest frame this decoder will accept; Kiro's replies are far below it. */
const MAX_FRAME_BYTES = 16 << 20

/** Byte width of each fixed-width header value type. */
const HEADER_VALUE_SIZE: Readonly<Record<number, number>> = Object.freeze({
  0: 0, // true
  1: 0, // false
  2: 1, // byte
  3: 2, // short
  4: 4, // int
  5: 8, // long
  8: 8, // timestamp
  9: 16, // uuid
})

const HEADER_TYPE_STRING = 7
const HEADER_TYPE_BYTE_ARRAY = 6

/**
 * Parse a frame's header block.
 *
 * Header values this decoder does not read as strings (booleans, numbers,
 * byte arrays) are SKIPPED by their declared width rather than stored: nothing
 * in Kiro's protocol keys on them, and storing them as strings would invite a
 * caller to compare an int to `'1'`.
 *
 * @param bytes - the header block (`frame[12 .. 12+headersLength)`).
 * @returns the string-valued headers.
 */
export function parseFrameHeaders(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const decoder = new TextDecoder()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset < bytes.length) {
    const nameLength = bytes[offset]
    // name length + at least one byte of value type must still fit
    if (nameLength === undefined || bytes.length < offset + 1 + nameLength + 1) break
    const name = decoder.decode(bytes.subarray(offset + 1, offset + 1 + nameLength))
    const type = bytes[offset + 1 + nameLength]
    offset += 1 + nameLength + 1
    if (type === undefined) break
    if (type === HEADER_TYPE_STRING || type === HEADER_TYPE_BYTE_ARRAY) {
      if (bytes.length < offset + 2) break
      const length = view.getUint16(offset)
      if (bytes.length < offset + 2 + length) break
      if (type === HEADER_TYPE_STRING) out[name] = decoder.decode(bytes.subarray(offset + 2, offset + 2 + length))
      offset += 2 + length
      continue
    }
    const size = HEADER_VALUE_SIZE[type]
    if (size === undefined || bytes.length < offset + size) break
    offset += size
  }
  return out
}

/**
 * Decode a Kiro reply body into frames as they arrive.
 *
 * Reads the stream incrementally: a frame split across two chunks is held until
 * it is whole, and several frames in one chunk are all yielded.
 *
 * @param body - the response body.
 * @yields each complete frame, in arrival order.
 * @throws {Error} when the stream ends mid-frame or a length cannot be its own.
 */
export async function* decodeEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamFrame> {
  let buffer = new Uint8Array(0)
  const reader = body.getReader()
  try {
    for (;;) {
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        const total = view.getUint32(0)
        const headerLength = view.getUint32(4)
        // A frame cannot be smaller than its own envelope, and its headers have
        // to fit inside it; either violation means the stream is not this format.
        if (total < 16 || total > MAX_FRAME_BYTES || headerLength > total - 16) {
          throw new Error('kiro: malformed event stream frame')
        }
        if (buffer.length < total) break
        const inside = buffer.subarray(12, total)
        yield {
          headers: parseFrameHeaders(inside.subarray(0, headerLength)),
          payload: inside.subarray(headerLength, inside.length - 4),
        }
        buffer = buffer.slice(total)
      }
      const { value, done } = await reader.read()
      if (done) {
        if (buffer.length > 0) throw new Error('kiro: event stream ended mid-frame')
        return
      }
      const merged = new Uint8Array(buffer.length + value.length)
      merged.set(buffer)
      merged.set(value, buffer.length)
      buffer = merged
    }
  } finally {
    reader.releaseLock?.()
  }
}

/**
 * Turn an exception frame's payload into a message a reader can act on.
 *
 * Kiro's failures arrive as frames with `:message-type: exception` and a body of
 * `{ message, reason }`; its throttling wording is normalised to `rate limited`
 * so the hub's rate-limit classifier recognises it.
 *
 * @param kind - `:exception-type` (or `:error-code`), when present.
 * @param payload - the frame payload.
 * @returns the message.
 */
export function exceptionText(kind: string | undefined, payload: Uint8Array): string {
  let body: { message?: string; Message?: string; reason?: string } = {}
  const raw = new TextDecoder().decode(payload).trim()
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    // Not JSON: the raw text is the best message there is.
  }
  let message = body.message ?? body.Message ?? raw
  if (body.reason !== undefined && body.reason !== '') message += ` (${body.reason})`
  if (String(kind ?? '').toLowerCase().includes('throttl')) return `rate limited: ${message}`
  return kind === undefined || kind === '' ? message : `${kind}: ${message}`
}

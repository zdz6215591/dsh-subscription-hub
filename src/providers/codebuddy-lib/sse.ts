/**
 * Decode an SSE byte stream into event `data` payloads.
 *
 * Framing reuses the hub's spec-strict parser (chunk reassembly, CRLF, multi-
 * `data:` joining, comments). The literal `[DONE]` sentinel is yielded so the
 * caller owns final flushing, and EOF before it is truncation rather than a
 * completable response.
 *
 * @module dsh-llm-codebuddy/sse
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { parseSse as parseSseEvents } from '../../translate/sse.js'

/** The terminal payload an OpenAI-compatible stream sends after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads.
 * @param stream - raw SSE byte chunks; reads may split anywhere.
 * @param onActivity - transport-activity callback (chunks and comments).
 * @returns each payload in arrival order, `[DONE]` last.
 * @throws LlmError `STREAM_CLOSED` when the stream ends without `[DONE]`.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  for await (const event of parseSseEvents(stream, onActivity)) {
    yield event.data
    if (event.data === DONE) return
  }
  throw new LlmError('CodeBuddy SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

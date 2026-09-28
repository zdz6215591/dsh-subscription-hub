/**
 * JoyCode's double-wrapped SSE, unwrapped.
 *
 * The Responses path (`gpt*` models) does not emit plain SSE. It emits an
 * envelope around each event, so one logical event arrives as two lines:
 *
 *     data: event: response.output_text.done
 *     data: data: {"type":"response.output_text.done","text":"…"}
 *
 * The reference implementation documents exactly this (`doubleWrapped` snapshot
 * in `ref-joycode2api/pkg/anthropic/completion_snapshots_test.go`), and its own
 * reader strips any leading `data:` before it looks at the payload. Handing the
 * raw body to the hub's Responses translator would fail on the first line, whose
 * "payload" is the literal text `event: …` rather than JSON — so the wrapper is
 * removed HERE, leaving the translator to see the protocol it already speaks.
 *
 * Everything the inner layer is not — a keepalive, a comment, an `event:` name
 * line — is dropped, because the JSON payload carries the event type itself.
 *
 * @module dsh-subscription-hub/providers/joycode/translate
 */

/** Payload prefix this unwrapper emits. */
const PREFIX = 'data: '

/**
 * Reduce one raw line to the line worth forwarding.
 *
 * Leading `data:` / `event:` markers are stripped repeatedly (the envelope nests
 * them), and only a JSON object, a JSON array or the `[DONE]` terminator
 * survives — anything else is framing rather than content.
 * @param raw - one line of the upstream body, without its newline.
 * @returns the line to emit, or undefined when the line carries no payload.
 */
export function joyCodeSseLine(raw: string): string | undefined {
  let line = raw.trim()
  if (line === '') return undefined
  for (;;) {
    const match = /^(?:data|event)\s*:\s*/i.exec(line)
    if (match === null) break
    line = line.slice(match[0].length).trim()
    if (line === '') return undefined
  }
  if (line === '[DONE]') return `${PREFIX}[DONE]`
  if (!line.startsWith('{') && !line.startsWith('[')) return undefined
  return `${PREFIX}${line}`
}

/**
 * Rewrite a double-wrapped SSE body into plain SSE.
 *
 * A byte-level transform, not a parser: lines are reassembled across chunk
 * boundaries (a chunk boundary can fall inside a line, and a rewritten line has
 * to be forwarded whole), then each line is filtered by {@link joyCodeSseLine}.
 * @param stream - the upstream body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns a stream the hub's Responses translator can consume.
 */
export function unwrapDoubleWrappedSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''
  const emit = (line: string): string | undefined => {
    const payload = joyCodeSseLine(line)
    if (payload === undefined) return undefined
    onActivity?.()
    return `${payload}\n\n`
  }
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const payload = emit(line)
        if (payload !== undefined) controller.enqueue(encoder.encode(payload))
        newline = buffered.indexOf('\n')
      }
    },
    flush(controller) {
      buffered += decoder.decode()
      const payload = emit(buffered)
      if (payload !== undefined) controller.enqueue(encoder.encode(payload))
    },
  }))
}

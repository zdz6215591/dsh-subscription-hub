/**
 * JoyCode stream framing: the two shapes this API answers in, normalized.
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
 * The chat path is looser still: the same reader tolerates BARE JSON lines (it
 * only requires a line to start with `{`), and the same project's stream writer
 * records that the upstream "omits" the `[DONE]` terminator on some responses and
 * appends one itself. A body with no `data:` framing produced no events at all
 * downstream, which surfaced as "chat completions SSE stream ended before a
 * finish chunk" — {@link normalizeChatSse} is what makes both shapes read.
 *
 * Everything the inner layer is not — a keepalive, a comment, an `event:` name
 * line — is dropped, because the JSON payload carries the event type itself.
 *
 * @module dsh-subscription-hub/providers/joycode/translate
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

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

/** The synthesized terminator a chat stream that never sent one gets. */
const CHAT_FINISH_TAIL = 'data: [DONE]\n\n'

/** One chat line's decision: the frame to forward, and what it told us. */
export interface JoyCodeChatFrame {
  /** The SSE frame to hand the hub's chat translator. */
  frame: string
  /** Whether this frame TERMINATES the stream (a finish reason or `[DONE]`). */
  terminal: boolean
  /** Whether this frame carried a tool-call delta. */
  toolCall: boolean
}

/**
 * Reduce one raw chat line to the SSE frame the hub's translator expects.
 *
 * JoyCode's chat path is the same envelope as its Responses path — leading
 * `data:` / `event:` markers nest — but it is NOT guaranteed to be SSE framing at
 * all. The reference's own reader strips `data:` prefixes in a loop and then only
 * accepts lines that START WITH `{`, which is what it takes to read a stream that
 * arrives either way; and its stream writer says outright that "some upstream
 * responses omit" the `[DONE]` terminator and that it appends one itself. Handing
 * that body straight to an SSE parser is what produced "stream ended before a
 * finish chunk": a body of bare JSON lines yields no events at all.
 *
 * So a bare JSON line becomes a `data:` frame here, and a frame's own JSON is
 * inspected for the two facts the synthesizer needs (a finish reason, a tool-call
 * delta). Non-payload lines — an `event:` name, a keepalive comment, blank lines
 * — are dropped: the payload carries its own type.
 * @param raw - one line of the upstream body, without its newline.
 * @returns the frame decision, or undefined when the line carries no payload.
 */
export function joyCodeChatFrame(raw: string): JoyCodeChatFrame | undefined {
  let line = raw.trim()
  if (line === '') return undefined
  for (;;) {
    const match = /^(?:data|event)\s*:\s*/i.exec(line)
    if (match === null) break
    line = line.slice(match[0].length).trim()
    if (line === '') return undefined
  }
  if (line === '[DONE]') return { frame: CHAT_FINISH_TAIL, terminal: true, toolCall: false }
  if (!line.startsWith('{') && !line.startsWith('[')) return undefined
  let terminal = false
  let toolCall = false
  try {
    const parsed: unknown = JSON.parse(line)
    const choices = (parsed as { choices?: unknown }).choices
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (typeof choice !== 'object' || choice === null) continue
        const record = choice as { finish_reason?: unknown, delta?: unknown }
        if (typeof record.finish_reason === 'string' && record.finish_reason !== '') terminal = true
        const delta = record.delta
        if (typeof delta === 'object' && delta !== null && Array.isArray((delta as { tool_calls?: unknown }).tool_calls)) {
          toolCall = true
        }
      }
    }
  } catch {
    // Not JSON: forward it so the translator reports the malformed payload by name
    // instead of this layer silently eating it.
  }
  return { frame: `${PREFIX}${line}\n\n`, terminal, toolCall }
}

/**
 * Normalize a chat body into the framing the hub's chat translator reads.
 *
 * Three tolerances, each one observed in the reference's own reader/writer:
 * nested `data:`/`event:` prefixes are stripped, bare JSON lines are reframed as
 * `data:` frames, and a stream that ends WITHOUT a terminal signal gets one
 * synthesized — `tool_calls` when tool-call deltas arrived, `stop` otherwise,
 * which is the same rule the translator would apply.
 *
 * Synthesizing is safe precisely because a TRUNCATED transfer does not end here:
 * a body cut mid-answer makes the reader's `read()` REJECT (undici raises on an
 * aborted chunked body), so it surfaces as a transport failure before this flush
 * ever runs. Reaching flush with `done: true` means the upstream considered the
 * response complete — and this API's terminators are optional by its own
 * reference's account.
 *
 * A body that carried no payload at all fails loudly here rather than downstream
 * as a bare STREAM_CLOSED, and the message quotes what actually arrived: "this
 * endpoint is not speaking the protocol we think it is" is only diagnosable with
 * the bytes in hand.
 * @param stream - the upstream chat body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns a stream the hub's chat translator can consume.
 */
export function normalizeChatSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''
  let frames = 0
  let terminal = false
  let toolCall = false
  let sample = ''
  const emit = (line: string): string | undefined => {
    const decision = joyCodeChatFrame(line)
    if (decision === undefined) {
      if (sample === '' && line.trim() !== '') sample = line.trim().slice(0, 200)
      return undefined
    }
    frames += 1
    terminal ||= decision.terminal
    toolCall ||= decision.toolCall
    onActivity?.()
    return decision.frame
  }
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const frame = emit(line)
        if (frame !== undefined) controller.enqueue(encoder.encode(frame))
        newline = buffered.indexOf('\n')
      }
    },
    flush(controller) {
      buffered += decoder.decode()
      const tail = emit(buffered)
      if (tail !== undefined) controller.enqueue(encoder.encode(tail))
      if (frames === 0) {
        controller.error(new LlmError(
          'JoyCode chat path sent no stream payloads: the endpoint answered in a wire shape this route does not read '
          + `(no SSE \`data:\` frames and no JSON lines). First line was: ${sample === '' ? '<empty>' : sample}`,
          'MALFORMED_RESPONSE',
        ))
        return
      }
      if (terminal) return
      controller.enqueue(encoder.encode(`${PREFIX}${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
      })}\n\n${CHAT_FINISH_TAIL}`))
    },
  }))
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

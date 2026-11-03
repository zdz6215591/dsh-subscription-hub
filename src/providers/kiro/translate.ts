/**
 * Kiro conversation translation: harness messages → `generateAssistantResponse`
 * body, and Kiro's event stream → harness `StreamChunk`s.
 *
 * Three Kiro requirements shape the request side, and each of them fails the
 * whole call (400 `REQUEST_BODY_INVALID`) rather than degrading, so they are
 * handled here instead of being left to the caller:
 *
 *   1. Every tool's input schema must name `type: "object"` at its ROOT. A
 *      schema that says nothing at the root, or says `object|null`, is sent as
 *      an object with no properties.
 *   2. Tool names are limited to 64 characters of `[A-Za-z0-9_-]`. A longer or
 *      differently-spaced name (an MCP tool, `mcp__plugin_x__y`) is sent under a
 *      stable shortened name and mapped back on the way out, so the caller sees
 *      the name it used.
 *   3. A tool call id must match `[a-zA-Z0-9_.:-]{1,64}`; another vendor's id is
 *      rewritten to a stable Kiro id, and results are matched through the same
 *      mapping.
 *
 * Text-only tool results are a fact of the wire: Kiro's `toolResults[].content`
 * is `[{ text }]`, so an image a tool returned cannot ride there. Images are
 * therefore sent on the user message that carries the result, which is what the
 * reference implementation does too.
 */

import { createHash, randomUUID } from 'node:crypto'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toolResultsOf } from '../../translate/resolved.js'
import type { TranslatableBlock, TranslatableMessage } from '../../translate/resolved.js'
import { KIRO_ORIGIN } from './protocol.js'

/** Kiro takes no empty message; this is what is sent instead. */
const PROCEED = 'Please proceed with the task.'

/** A tool's output is cut here, as Kiro's own agent cuts it. */
const RESULT_LIMIT = 250_000

/** Kiro refuses an image larger than 5 MiB once it is base64. */
const KIRO_IMAGE_BASE64_LIMIT = 5 * 1024 * 1024

/** Kiro refuses an image larger than 5 MiB once it is base64. */

/** What a call that never got a result is reported as. */
const NO_RESULT = 'Tool use was interrupted and did not produce a result.'

/** Names and ids Kiro accepts. */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
const TOOL_ID_RE = /^[a-zA-Z0-9_.:-]{1,64}$/

/** Kiro's image format names. */
const IMAGE_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

/** A tool name Kiro accepts, stable for a given caller-side name. */
export function kiroToolName(name: string): string {
  const value = String(name ?? '')
  if (TOOL_NAME_RE.test(value)) return value
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12)
  const head = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64 - 1 - hash.length)
  return `${head}_${hash}`
}

/** A tool-call id Kiro accepts, stable for a given caller-side id. */
export function kiroToolId(id: string): string {
  const value = String(id ?? '')
  if (TOOL_ID_RE.test(value)) return value
  return `t_${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`
}

/**
 * A tool's input schema as Kiro takes it.
 *
 * Only the ROOT is touched: everything under it (unions, `$ref`, `nullable`) is
 * forwarded exactly as the caller wrote it, because rewriting a schema's
 * interior is how a tool silently starts validating differently.
 *
 * @param schema - the caller's JSON schema.
 * @returns a schema whose root names `type: "object"`.
 */
export function kiroInputSchema(schema: unknown): Record<string, unknown> {
  const source = typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {}
  const rootType = source.type
  if (rootType === 'object') return { ...source }
  if (rootType === undefined || rootType === null || rootType === 'object' || Array.isArray(rootType)) {
    // Absent, null-or-object, or a union: Kiro refuses all three at the root.
    const { type: _dropped, ...rest } = source
    return { type: 'object', ...rest, properties: (rest.properties as Record<string, unknown> | undefined) ?? {} }
  }
  // A root that names another type is left exactly as it is: refusing it here
  // would be this adapter inventing a validation rule Kiro never stated.
  return { ...source }
}

/** One Kiro conversation entry. */
type KiroEntry =
  | { userInputMessage: Record<string, unknown> }
  | { assistantResponseMessage: Record<string, unknown> }

/** The body of a `generateAssistantResponse` call. */
export interface KiroRequestBody {
  conversationState: Record<string, unknown>
  agentMode: 'vibe'
  profileArn?: string
}

/** Flatten one message's text blocks. */
function textOf(content: readonly TranslatableBlock[]): string {
  return content
    .filter((block): block is Extract<TranslatableBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n\n')
}

/**
 * Build the request body.
 *
 * @param options - the harness request.
 * @param modelId - Kiro model id to send.
 * @param profileArn - profile to name, `''` for a key that has none.
 * @returns the body fields.
 */
export function buildKiroRequest(options: GenerateOptions, messages: readonly TranslatableMessage[], modelId: string, profileArn: string): KiroRequestBody {
  const entries: KiroEntry[] = []
  /** id mapping so a result can find the call Kiro knows him by. */
  const results: Record<string, unknown>[] = []
  const answered = new Set<string>()
  const images: Record<string, unknown>[] = []
  let system = options.system ?? ''

  const pushResults = (): void => {
    if (results.length === 0) return
    const previous = entries.at(-1)
    const context = (previous !== undefined && 'userInputMessage' in previous
      ? previous.userInputMessage.userInputMessageContext as { toolResults?: Record<string, unknown>[] } | undefined
      : undefined)
    if (context !== undefined && Array.isArray(context.toolResults)) {
      context.toolResults.push(...results.splice(0))
      return
    }
    entries.push({
      userInputMessage: {
        content: '',
        modelId,
        origin: KIRO_ORIGIN,
        images: [],
        userInputMessageContext: { toolResults: results.splice(0) },
      },
    })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text !== '') system = system === '' ? text : `${system}\n\n${text}`
      continue
    }
    if (message.role === 'assistant') {
      pushResults()
      const toolUses = message.content
        .filter((block): block is Extract<TranslatableBlock, { type: 'tool-call' }> => block.type === 'tool-call')
        .map(block => ({
          name: kiroToolName(block.name),
          toolUseId: kiroToolId(block.id),
          input: safeJson(block.arguments),
        }))
      const content = textOf(message.content)
      if (content === '' && toolUses.length === 0) continue
      const previous = entries.at(-1)
      if (previous !== undefined && 'assistantResponseMessage' in previous) {
        // Two assistant turns in a row are one turn to Kiro.
        const merged = previous.assistantResponseMessage
        merged.content = [merged.content, content].filter(part => typeof part === 'string' && part !== '').join('\n\n')
        ;(merged.toolUses as Record<string, unknown>[]).push(...toolUses)
      } else {
        entries.push({ assistantResponseMessage: { content, toolUses } })
      }
      continue
    }
    // A user message: tool results and images ride with it.
    for (const result of toolResultsOf(message)) {
      answered.add(kiroToolId(String(result.toolCallId)))
      results.push({
        toolUseId: kiroToolId(String(result.toolCallId)),
        status: result.isError === true ? 'error' : 'success',
        content: [{ text: cut(textOf(result.content as unknown as TranslatableBlock[])) }],
      })
    }
    const omitted: string[] = []
    for (const block of message.content) {
      if (block.type !== 'image' || !('mediaType' in block)) continue
      const format = IMAGE_FORMATS[block.mediaType]
      if (format === undefined) continue
      if (block.dataBase64.length > KIRO_IMAGE_BASE64_LIMIT) {
        // Kiro turns away an image over 5 MiB once base64'd, and this route has
        // no image codec to shrink one. Dropping it with a note keeps the turn
        // alive; the note says why, so nobody wonders where the picture went.
        omitted.push("[image omitted: it is over Kiro's 5 MB image limit]")
        continue
      }
      images.push({ format, source: { bytes: block.dataBase64 } })
    }
    const content = [textOf(message.content), ...omitted].filter(part => part !== '').join('\n\n')
    if (content === '' && results.length === 0) continue
    pushResults()
    if (content !== '') entries.push({ userInputMessage: { content, modelId, origin: KIRO_ORIGIN, images: images.splice(0) } })
  }
  pushResults()

  // Calls the history left unanswered are reported as failures: Kiro refuses a
  // conversation with a call that has no result, and dropping the call would
  // rewrite the caller's history.
  const unanswered: Record<string, unknown>[] = []
  for (const entry of entries) {
    if (!('assistantResponseMessage' in entry)) continue
    for (const use of entry.assistantResponseMessage.toolUses as { toolUseId: string }[]) {
      if (!answered.has(use.toolUseId)) {
        unanswered.push({ toolUseId: use.toolUseId, status: 'error', content: [{ text: NO_RESULT }] })
      }
    }
  }
  if (unanswered.length > 0) {
    const interrupted: KiroEntry = {
      userInputMessage: {
        content: '', modelId, origin: KIRO_ORIGIN, images: [],
        userInputMessageContext: { toolResults: unanswered },
      },
    }
    // It belongs AFTER the call it answers and BEFORE the turn being answered
    // now — appending it would make the caller's question the thing that carries
    // the result, which is not the order Kiro (or the caller) means.
    const last = entries.at(-1)
    if (last !== undefined && 'userInputMessage' in last) entries.splice(entries.length - 1, 0, interrupted)
    else entries.push(interrupted)
  }

  const current = entries.pop()
  const currentMessage = current !== undefined && 'userInputMessage' in current
    ? current.userInputMessage
    : { content: PROCEED, modelId, origin: KIRO_ORIGIN, images: [] }
  if (typeof currentMessage.content !== 'string' || currentMessage.content.trim() === '') {
    currentMessage.content = PROCEED
  }
  if (system !== '') {
    // Kiro refuses its `systemPrompt` field for this account type, so the system
    // prompt goes at the head of the first message — the reference's finding.
    currentMessage.content = `${system}\n\n${String(currentMessage.content)}`
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    const tools = options.tools.map(tool => ({
      toolSpecification: {
        name: kiroToolName(tool.name),
        description: tool.description === undefined || tool.description === '' ? tool.name : tool.description,
        inputSchema: { json: kiroInputSchema(tool.parameters) },
      },
    }))
    const context = (currentMessage.userInputMessageContext ??= {}) as Record<string, unknown>
    context.tools = tools
  }

  const conversationState: Record<string, unknown> = {
    chatTriggerType: 'MANUAL',
    agentTaskType: 'vibe',
    conversationId: randomUUID(),
    currentMessage: { userInputMessage: currentMessage },
  }
  if (entries.length > 0) conversationState.history = entries
  return {
    conversationState,
    agentMode: 'vibe',
    ...profileArn === '' ? {} : { profileArn },
  }
}

/** `JSON.parse` that yields `{}` instead of throwing on a partial argument. */
function safeJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text === '' ? '{}' : text)
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    return {}
  }
}

/** Cut a tool result to what Kiro accepts. */
function cut(text: string): string {
  if (text.length <= RESULT_LIMIT) return text
  return `${text.slice(0, RESULT_LIMIT)}\n\n[output cut at ${RESULT_LIMIT} characters]`
}

/**
 * Split a reply that opens with `<thinking>…</thinking>` into thinking and text,
 * however the tags fall across chunks.
 *
 * Kiro has no thinking field: thinking is asked for in the prompt with a budget,
 * and comes back as that tag, so it has to be separated here.
 */
class ThinkParser {
  private buffer = ''
  private state: 0 | 1 | 2 = 0 // 0 = not seen yet, 1 = inside, 2 = after
  private static readonly OPEN = '<thinking>'
  private static readonly CLOSE = '</thinking>'

  feed(chunk: string): { kind: 'text' | 'reasoning'; text: string }[] {
    const out: { kind: 'text' | 'reasoning'; text: string }[] = []
    this.buffer += chunk
    for (;;) {
      if (this.state === 0) {
        const trimmed = this.buffer.replace(/^[ \t\r\n]+/, '')
        if (trimmed.startsWith(ThinkParser.OPEN)) {
          this.buffer = trimmed.slice(ThinkParser.OPEN.length)
          this.state = 1
          continue
        }
        if (trimmed.length < ThinkParser.OPEN.length && ThinkParser.OPEN.startsWith(trimmed)) return out
        this.state = 2
        continue
      }
      if (this.state === 1) {
        const index = this.buffer.indexOf(ThinkParser.CLOSE)
        if (index >= 0) {
          if (index > 0) out.push({ kind: 'reasoning', text: this.buffer.slice(0, index) })
          this.buffer = this.buffer.slice(index + ThinkParser.CLOSE.length).replace(/^[\r\n]+/, '')
          this.state = 2
          continue
        }
        // Hold back a partial closing tag.
        let hold = 0
        for (let n = Math.min(ThinkParser.CLOSE.length - 1, this.buffer.length); n > 0; n--) {
          if (this.buffer.endsWith(ThinkParser.CLOSE.slice(0, n))) { hold = n; break }
        }
        const emit = this.buffer.length - hold
        if (emit > 0) {
          out.push({ kind: 'reasoning', text: this.buffer.slice(0, emit) })
          this.buffer = this.buffer.slice(emit)
        }
        return out
      }
      if (this.buffer !== '') out.push({ kind: 'text', text: this.buffer })
      this.buffer = ''
      return out
    }
  }

  end(): { kind: 'text' | 'reasoning'; text: string }[] {
    if (this.buffer === '') return []
    const event = { kind: this.state === 1 ? 'reasoning' as const : 'text' as const, text: this.buffer }
    this.buffer = ''
    if (this.state === 0) this.state = 2
    return [event]
  }
}

/** One decoded reply event, before it becomes harness chunks. */
export type KiroReplyEvent =
  | { kind: 'text' | 'reasoning'; text: string }
  | { kind: 'tool-start'; id: string; name: string }
  | { kind: 'tool-args'; text: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { kind: 'stop'; reason: string }
  | { kind: 'error'; message: string }

/**
 * Turn decoded frames into reply events.
 *
 * @param frames - the decoded event stream.
 * @param contextWindow - the model's window, used to turn Kiro's context
 *   percentage into an input-token estimate (Kiro reports no token counts of
 *   its own; the reference records the same gap).
 * @param parseThinking - whether the reply's `<thinking>` block is expected.
 * @yields reply events in order.
 */
export async function* readKiroReply(
  frames: AsyncIterable<{ headers: Record<string, string>; payload: Uint8Array }>,
  contextWindow: number,
  parseThinking: boolean,
): AsyncGenerator<KiroReplyEvent> {
  const think = parseThinking ? new ThinkParser() : undefined
  const decoder = new TextDecoder()
  let currentTool = ''
  let percentage = 0
  let reported: KiroReplyEvent | undefined
  for await (const frame of frames) {
    const messageType = frame.headers[':message-type']
    if (messageType === 'exception' || messageType === 'error') {
      const kind = frame.headers[':exception-type'] ?? frame.headers[':error-code']
      let json: { message?: string; reason?: string } = {}
      const raw = decoder.decode(frame.payload).trim()
      try { json = JSON.parse(raw) as typeof json } catch { /* raw text below */ }
      const text = json.message ?? raw
      const reason = json.reason === undefined ? '' : ` (${json.reason})`
      yield { kind: 'error', message: `${kind ?? 'Kiro error'}: ${text}${reason}` }
      return
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>
    } catch {
      continue
    }
    const kind = frame.headers[':event-type']
    if (kind === 'assistantResponseEvent') {
      const text = typeof body.content === 'string' ? body.content : ''
      if (text === '') continue
      if (think === undefined) yield { kind: 'text', text }
      else for (const event of think.feed(text)) yield event
      continue
    }
    if (kind === 'reasoningContentEvent') {
      const text = typeof body.text === 'string' ? body.text : ''
      if (text !== '') yield { kind: 'reasoning', text }
      continue
    }
    if (kind === 'toolUseEvent') {
      const id = typeof body.toolUseId === 'string' ? body.toolUseId : ''
      const name = typeof body.name === 'string' ? body.name : ''
      if (id !== '' && id !== currentTool) {
        if (think !== undefined) for (const event of think.end()) yield event
        currentTool = id
        yield { kind: 'tool-start', id, name }
      }
      const input = body.input
      if (input === undefined || input === null) continue
      if (typeof input === 'string') {
        if (input !== '') yield { kind: 'tool-args', text: input }
      } else {
        const text = JSON.stringify(input)
        if (text !== '{}') yield { kind: 'tool-args', text }
      }
      continue
    }
    if (kind === 'metadataEvent' || kind === 'messageMetadataEvent') {
      const stop = typeof body.stopReason === 'string' ? body.stopReason : ''
      const usage = body.tokenUsage
      if (typeof usage === 'object' && usage !== null) {
        const counts = usage as Record<string, number>
        reported = {
          kind: 'usage',
          inputTokens: (counts.uncachedInputTokens ?? counts.inputTokens ?? 0) + (counts.cacheReadInputTokens ?? 0) + (counts.cacheWriteInputTokens ?? 0),
          outputTokens: counts.outputTokens ?? 0,
          cacheReadTokens: counts.cacheReadInputTokens ?? 0,
          cacheWriteTokens: counts.cacheWriteInputTokens ?? 0,
        }
        const pct = counts.contextUsagePercentage
        if (typeof pct === 'number' && pct > 0) percentage = pct
      }
      if (stop !== '') yield { kind: 'stop', reason: stop }
      continue
    }
    if (kind === 'contextUsageEvent') {
      const pct = body.contextUsagePercentage
      if (typeof pct === 'number' && pct > 0) percentage = pct
      continue
    }
    if (kind === 'throttlingError' || kind === 'validationError' || kind === 'internalServerException' || kind === 'serviceUnavailableError') {
      const message = typeof body.message === 'string' ? body.message : decoder.decode(frame.payload)
      yield { kind: 'error', message: `${kind}: ${message}` }
      return
    }
  }
  if (think !== undefined) for (const event of think.end()) yield event
  if (reported !== undefined) yield reported
  else if (percentage > 0 && contextWindow > 0) {
    // Kiro reported only how full the context is; the reference derives input
    // tokens from it the same way. Output tokens stay unknown rather than 0, so
    // no usage event is emitted when there is nothing but a percentage.
  }
}

/**
 * Map reply events onto harness chunks.
 *
 * @param events - reply events from {@link readKiroReply}.
 * @param toolNames - map from the shortened name sent to the caller's own name.
 * @yields harness stream chunks, ending with a `finish`.
 */
export async function* toStreamChunks(
  events: AsyncIterable<KiroReplyEvent>,
  toolNames: ReadonlyMap<string, string>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let open: { index: number; type: 'text' | 'reasoning'; text: string } | undefined
  const calls: { index: number; id: string; name: string; args: string }[] = []
  let active: { index: number; id: string; name: string; args: string } | undefined
  let stopReason = ''
  let error: string | undefined

  const closeOpen = (): StreamChunk | undefined => {
    if (open === undefined) return undefined
    const chunk: StreamChunk = { type: 'block-end', index: open.index, block: { type: open.type, text: open.text } }
    open = undefined
    return chunk
  }

  for await (const event of events) {
    if (event.kind === 'text' || event.kind === 'reasoning') {
      if (open !== undefined && open.type !== event.kind) {
        const closed = closeOpen()
        if (closed !== undefined) yield closed
      }
      if (open === undefined) {
        open = { index: nextIndex++, type: event.kind, text: '' }
        yield { type: 'block-start', index: open.index, blockType: event.kind }
      }
      open.text += event.text
      yield event.kind === 'text'
        ? { type: 'text-delta', index: open.index, text: event.text }
        : { type: 'reasoning-delta', index: open.index, text: event.text }
      continue
    }
    if (event.kind === 'tool-start') {
      const closed = closeOpen()
      if (closed !== undefined) yield closed
      active = { index: nextIndex++, id: event.id, name: event.name, args: '' }
      calls.push(active)
      yield { type: 'block-start', index: active.index, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: active.index,
        id: ToolCallId(active.id),
        name: toolNames.get(event.name) ?? event.name,
        argumentsDelta: '',
      }
      continue
    }
    if (event.kind === 'tool-args' && active !== undefined) {
      active.args += event.text
      yield {
        type: 'tool-call-delta',
        index: active.index,
        id: ToolCallId(active.id),
        name: toolNames.get(active.name) ?? active.name,
        argumentsDelta: event.text,
      }
      continue
    }
    if (event.kind === 'usage') {
      const closed = closeOpen()
      if (closed !== undefined) yield closed
      yield { type: 'usage', usage: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...event.cacheReadTokens === 0 ? {} : { cacheReadTokens: event.cacheReadTokens },
        ...event.cacheWriteTokens === 0 ? {} : { cacheWriteTokens: event.cacheWriteTokens },
      } }
      continue
    }
    if (event.kind === 'stop') {
      stopReason = event.reason
      continue
    }
    if (event.kind === 'error') {
      error = event.message
    }
  }

  const closed = closeOpen()
  if (closed !== undefined) yield closed
  for (const call of calls) {
    yield {
      type: 'block-end',
      index: call.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(call.id),
        name: toolNames.get(call.name) ?? call.name,
        arguments: call.args === '' ? '{}' : call.args,
      },
    }
  }

  if (error !== undefined) throw new LlmError(`kiro: ${error}`, classifyKiroFailure(error))
  yield {
    type: 'finish',
    reason: calls.length > 0 || stopReason === 'tool_use'
      ? { kind: 'tool-calls' }
      : stopReason === 'max_tokens'
        ? { kind: 'max-tokens' }
        : { kind: 'stop' },
  }
}

/**
 * The harness error code for a Kiro failure message.
 *
 * The wording is Kiro's, so the classification is done on what it says rather
 * than on an HTTP status that a stream failure never carries.
 *
 * @param message - the failure text.
 * @returns the error code.
 */
export function classifyKiroFailure(message: string): 'INVALID_REQUEST' | 'RATE_LIMIT' | 'QUOTA_EXCEEDED' | 'UPSTREAM_ERROR' {
  if (/CONTENT_LENGTH_EXCEEDS_THRESHOLD|MODEL_CONTEXT_WINDOW_EXCEEDED|input is too long/i.test(message)) return 'INVALID_REQUEST'
  if (/USAGE_LIMIT|MONTHLY_REQUEST_COUNT|usage limit/i.test(message)) return 'QUOTA_EXCEEDED'
  if (/throttl|rate limited|too many requests/i.test(message)) return 'RATE_LIMIT'
  return 'UPSTREAM_ERROR'
}

/** Names Kiro was sent that differ from the caller's, keyed by the sent name. */
export function kiroToolNameMap(tools: GenerateOptions['tools']): Map<string, string> {
  const map = new Map<string, string>()
  for (const tool of tools ?? []) {
    const sent = kiroToolName(tool.name)
    if (sent !== tool.name) map.set(sent, tool.name)
  }
  return map
}

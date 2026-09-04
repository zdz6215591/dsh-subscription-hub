/**
 * Parse Antigravity SSE responses (Gemini-style `candidates[]` events) into the
 * DSH StreamChunk protocol: block-start / text-delta / reasoning-delta /
 * tool-call-delta / block-end / usage / finish.
 *
 * Wire shape: each `data:` payload is a JSON array of candidate objects with
 * `content.parts[]` (text / {thought:true} / functionCall), `usageMetadata`,
 * and `finishReason`. Streams terminate with `data: [DONE]`.
 */

import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../../compat.js'

export interface SsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name?: string; args?: unknown }
}

export interface SseCandidate {
  index?: number
  content?: {
    role?: string
    parts?: SsePart[]
  }
  finishReason?: string
}

export interface SsePayload {
  candidates?: SseCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
  error?: { code?: number; status?: string; message?: string }
}

/**
 * Parse one SSE `data:` line; returns null for `[DONE]` or empty lines.
 * Accepts the `{"response": {...}}` envelope (daily endpoint wire shape) and
 * the bare array/object shapes older clients emitted.
 */
export function parseSseDataLine(line: string): SsePayload | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return null
  const parsed = JSON.parse(data) as unknown
  const root = (parsed as { response?: unknown })?.response ?? parsed
  const payload = (Array.isArray(root) ? root[0] : root) as SsePayload | undefined
  return payload ?? null
}

function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' }
    case 'STOP':
      return { kind: 'stop' }
    case 'TOOL_CALLS':
    case 'FUNCTION_CALL':
      return { kind: 'tool-calls' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * Consume an SSE text stream and yield StreamChunks. One accumulating block is
 * kept open at a time; tool-call argument deltas accumulate until a different
 * part kind, usage metadata, or stream end closes it.
 */
export interface ParseAgySseOptions {
  signal?: AbortSignal
  /**
   * Invoked when a functionCall part carries a sibling thoughtSignature, and
   * when a thought part carries one, keyed by the functionCall id (or the
   * thought signature is ignored unless paired). The adapter persists these
   * for replay on the next turn (see signature-cache.ts).
   */
  onToolSignature?(toolCallId: string, signature: string): void
}

export async function* parseAgySse(
  body: ReadableStream<Uint8Array>,
  options: ParseAgySseOptions = {},
): AsyncGenerator<StreamChunk> {
  const { signal } = options
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let blockIndex = 0
  let finishReason: FinishReason = { kind: 'stop' }
  let sawUsage = false
  let lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null = null

  interface OpenBlock {
    kind: 'text' | 'reasoning' | 'tool-call'
    id?: string
    name?: string
    arguments: string
    text: string
  }
  let open: OpenBlock | null = null

  const closeBlock = (): StreamChunk | null => {
    if (!open) return null
    const block: StreamChunk = open.kind === 'tool-call'
      ? {
          type: 'block-end',
          index: blockIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(open.id ?? `call-${blockIndex}`),
            name: open.name ?? '',
            arguments: open.arguments,
          },
        }
      : {
          type: 'block-end',
          index: blockIndex,
          block: { type: open.kind, text: open.text },
        }
    open = null
    blockIndex += 1
    return block
  }

  /**
   * Ensure a block of the given kind is open, switching when needed.
   * Returns chunks to yield (a closed block's end, then the new block's start).
   * Callers MUST yield everything returned — dropping the end silently corrupts
   * the block stream for DSH (verified: multi-tool turns and text→tool
   * transitions lost their block-end).
   */
  const ensureBlock = (kind: OpenBlock['kind'], meta: { id?: string; name?: string } = {}): StreamChunk[] => {
    const out: StreamChunk[] = []
    if (open && open.kind !== kind) {
      const end = closeBlock()
      if (end) out.push(end)
    }
    if (!open) {
      open = {
        kind,
        arguments: '',
        text: '',
        ...meta.id === undefined ? {} : { id: meta.id },
        ...meta.name === undefined ? {} : { name: meta.name },
      }
      const blockType = kind === 'tool-call' ? 'tool-call' : kind
      out.push({ type: 'block-start', index: blockIndex, blockType })
    }
    return out
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('aborted', 'AbortError')
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue
        const payload = parseSseDataLine(line)
        if (!payload) continue
        if (payload.error) {
          const message = payload.error.message ?? payload.error.status ?? 'upstream error'
          throw new Error(`agy stream error (${payload.error.code ?? 'unknown'}): ${message}`)
        }
        for (const candidate of payload.candidates ?? []) {
          if (candidate.finishReason) {
            finishReason = mapFinishReason(candidate.finishReason)
          }
          for (const part of candidate.content?.parts ?? []) {
            if (part.text !== undefined && part.thought !== true) {
              for (const chunk of ensureBlock('text')) yield chunk
              open!.text += part.text
              yield { type: 'text-delta', index: blockIndex, text: part.text }
            } else if (part.text !== undefined && part.thought === true) {
              for (const chunk of ensureBlock('reasoning')) yield chunk
              open!.text += part.text
              yield { type: 'reasoning-delta', index: blockIndex, text: part.text }
            } else if (part.functionCall) {
              // Use the upstream functionCall id when present so the signature
              // captured on this part can be replayed for the same id next turn.
              const upstreamId = part.functionCall.id || String(blockIndex)
              // Each functionCall part is an ATOMIC block: a stream can carry
              // several functionCall parts in one turn (multi-tool responses),
              // and they share kind "tool-call" — ensureBlock alone would not
              // switch between them, concatenating their args JSON into one
              // invalid string. Close any open block (yielding its end) first.
              if (open) {
                const end = closeBlock()
                if (end) yield end
              }
              const start = ensureBlock('tool-call', {
                id: upstreamId,
                ...part.functionCall.name === undefined ? {} : { name: part.functionCall.name },
              })
              if (start.length > 0) yield start[0]!
              if (part.thoughtSignature) {
                options.onToolSignature?.(upstreamId, part.thoughtSignature)
              }
              const argsJson = typeof part.functionCall.args === 'string'
                ? part.functionCall.args
                : JSON.stringify(part.functionCall.args ?? {})
              open!.arguments += argsJson
              yield {
                type: 'tool-call-delta',
                index: blockIndex,
                id: ToolCallId(open!.id ?? ''),
                ...open!.name === undefined ? {} : { name: open!.name },
                argumentsDelta: argsJson,
              }
            }
          }
        }
        if (payload.usageMetadata) {
          // The upstream sends usageMetadata on EVERY SSE event (cumulative).
          // Do NOT close the block here: closing per event would split one
          // continuous text stream into a block per chunk (frontend renders
          // block boundaries as line breaks). Stash the last (full) totals
          // and emit one usage chunk at stream end.
          sawUsage = true
          // DSH TokenUsage buckets are DISJOINT: inputTokens must be the
          // uncached portion only; cache reads are reported separately.
          // Reporting the full promptTokenCount here double-counts cached
          // tokens in the stats line's cache-hit percentage (it divides by
          // uncached + cacheRead + cacheWrite).
          const promptTokens = payload.usageMetadata.promptTokenCount ?? 0
          const cachedTokens = payload.usageMetadata.cachedContentTokenCount ?? 0
          lastUsage = {
            inputTokens: Math.max(0, promptTokens - cachedTokens),
            outputTokens: payload.usageMetadata.candidatesTokenCount ?? 0,
            cacheReadTokens: cachedTokens,
          }
        }
      }
    }
    const closed = closeBlock()
    if (closed) yield closed
    if (lastUsage) {
      yield { type: 'usage', usage: lastUsage }
    } else if (sawUsage) {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    }
    yield { type: 'finish', reason: finishReason }
  } finally {
    reader.releaseLock()
  }
}

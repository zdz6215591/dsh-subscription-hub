/**
 * Command Code Go: Studio loopback login + /alpha/generate JSONL stream.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../compat.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CommandCodeSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import { httpLlmError, idleWatchdog, mapFetchFailure } from './common.js'
import type { FetchFn, ModelEntry, ProviderUsage } from './common.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait, RetryDefaults } from './rate-limit.js'
import { resolveImages, withToolResultImages } from '../translate/resolved.js'
import type { TranslatableBlock, TranslatableMessage } from '../translate/resolved.js'

export const COMMANDCODE_PREEMPT_MS = 365 * 24 * 60 * 60 * 1000
export const COMMANDCODE_API_BASE = 'https://api.commandcode.ai'
/** CLI version header — keep in lockstep with Mars-Sea/dsh-commandcode-provider. */
export const COMMAND_CODE_CLI_VERSION = '1.47.0'
const STUDIO_BASE = 'https://commandcode.ai'
const LOGIN_ORIGINS = new Set(['https://commandcode.ai', 'https://staging.commandcode.ai', 'http://localhost:3000'])

/** Output-token floor for code models when the catalog omits a max (matched to dsh-commandcode-provider). */
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
/** Hard ceiling for `max_tokens` sent to `/alpha/generate`, matching the reference adapter. */
const DEFAULT_GENERATE_MAX_TOKENS = 64_000

/**
 * Command Code's persistent retry shape (mirrors `Mars-Sea/dsh-commandcode-provider`):
 * transient stream/server/rate-limit failures retry far longer than the generic
 * pool default so a server-side blip or a limited window recovers in place instead
 * of surfacing to the user as an interrupt that forces a manual "继续".
 */
const COMMANDCODE_RETRY: RetryDefaults = Object.freeze({
  maxRetries: 500,
  initialDelayMs: 500,
  maxDelayMs: 900_000,
  jitterRatio: 0.1,
})

export async function refreshCommandCode(session: CommandCodeSession): Promise<CommandCodeSession> {
  return session
}

export function isCommandCodePermanentRefreshError(_error: unknown): boolean {
  return false
}

function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === 'api') return stringValue(value.key)
  if (type === 'oauth') return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

/** Read the official CLI file at `~/.commandcode/auth.json` (same as Mars-Sea). */
export function commandCodeCliAuthPath(): string {
  return join(homedir(), '.commandcode', 'auth.json')
}

export function parseCommandCodeAuthFile(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const direct = stringValue(raw.apiKey) ?? stringValue(raw.commandcode)
  if (direct !== undefined) return direct
  return apiKeyFromCredentialRecord(raw.commandcode) ?? apiKeyFromCredentialRecord(raw['command-code'])
}

async function sessionFromApiKey(apiKey: string, fetchFn: FetchFn = proxiedFetch): Promise<CommandCodeSession> {
  const key = apiKey.trim()
  if (key.length === 0) throw new Error('Command Code API key is empty')
  let account: string | undefined
  let userId: string | undefined
  try {
    const response = await fetchFn(`${COMMANDCODE_API_BASE}/alpha/whoami`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...attributionHeaders() },
    })
    if (response.ok) {
      const body = await response.json() as { user?: { id?: string; name?: string; userName?: string } }
      const user = body.user
      account = typeof user?.name === 'string' && user.name.length > 0
        ? user.name
        : typeof user?.userName === 'string' && user.userName.length > 0 ? user.userName : undefined
      userId = typeof user?.id === 'string' && user.id.length > 0 ? user.id : undefined
    }
  } catch { /* identity is optional; the key can still be stored */ }
  return {
    accessToken: key,
    refreshToken: key,
    expiresAt: Date.now() + COMMANDCODE_PREEMPT_MS,
    ...account === undefined ? {} : { account },
    ...userId === undefined ? {} : { userId },
  }
}

/** Import the key the official `cmd login` / `command-code login` already wrote. */
export async function importCommandCodeCli(fetchFn: FetchFn = proxiedFetch): Promise<CommandCodeSession> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(commandCodeCliAuthPath(), 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No Command Code CLI login found (~/.commandcode/auth.json). Paste an API key, or run `cmd login`.')
    }
    throw error
  }
  const key = parseCommandCodeAuthFile(raw)
  if (key === undefined) {
    throw new Error('~/.commandcode/auth.json has no API key. Paste one, or run `cmd login` again.')
  }
  return sessionFromApiKey(key, fetchFn)
}

/** Paste a Command Code API key (`user_…`) or a JSON blob that contains one. */
export async function sessionFromCommandCodePaste(input: string, fetchFn: FetchFn = proxiedFetch): Promise<CommandCodeSession> {
  const trimmed = input.trim()
  if (trimmed.startsWith('{')) {
    const key = parseCommandCodeAuthFile(JSON.parse(trimmed) as unknown)
    if (key === undefined) throw new Error('JSON paste needs apiKey / commandcode.key')
    return sessionFromApiKey(key, fetchFn)
  }
  return sessionFromApiKey(trimmed, fetchFn)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Terminal stream-error markers from the official Command Code CLI (mirrors
 * `Mars-Sea/dsh-commandcode-provider`): these always mean "retrying cannot
 * succeed", so the adapter must not classify them as transient server errors
 * that the retry policy would retry pointlessly.
 */
const TERMINAL_STREAM_ERROR_MARKERS = [
  'premium_credits_exhausted',
  'model_not_in_plan',
  'insufficient credits',
]

function hasTerminalStreamMarker(message: string): boolean {
  const lower = message.toLowerCase()
  return TERMINAL_STREAM_ERROR_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * True when a Provider API rejection is Command Code's Go-plan gate
 * (`upgrade_required`) — the one rejection that should retry the same request
 * through the CLI /alpha/generate transport. Other 4xx/5xx must surface as
 * ordinary errors so real account/model problems are not masked.
 * @param response - the failed response (its body is consumed).
 * @returns whether to fall back to the CLI transport.
 */
async function isProviderUpgradeRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  let text = ''
  try {
    text = (await response.clone().text()).toLowerCase()
  } catch {
    return false
  }
  if (text.includes('upgrade_required')) return true
  if (text.includes('go plan') && text.includes('api access')) return true
  if (text.includes('only plan without api access')) return true
  if (text.includes('upgrade to goat or higher')) return true
  return false
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

/**
 * Collect tool calls that have a paired tool result, plus each call's name.
 * Matches Mars-Sea/dsh-commandcode-provider: only paired tool calls are
 * replayed; unpaired ones would leave the wire conversation dangling.
 */
function pairedToolCalls(messages: readonly Message[]): {
  ids: Set<string>
  names: Map<string, string>
} {
  const callIds = new Set<string>()
  const names = new Map<string, string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call' && block.name && block.name.trim() !== '' && block.id && block.id.trim() !== '') {
        callIds.add(block.id)
        names.set(block.id, block.name)
      }
      if (block.type === 'tool-result' && block.toolCallId && block.toolCallId.trim() !== '') resultIds.add(block.toolCallId)
    }
  }
  return { ids: new Set([...callIds].filter((id) => resultIds.has(id))), names }
}

function isToolResultMessage(message: Message | TranslatableMessage): boolean {
  if (message.role !== 'user') return false
  const source = 'source' in message ? message.source : undefined
  const kind: string | undefined = source?.kind
  if (kind !== undefined) return kind === 'tool'
  return message.content?.[0]?.type === 'tool-result'
}

function toolParametersSchema(parameters: unknown): Record<string, unknown> {
  if (!isRecord(parameters)) return { type: 'object', properties: {}, additionalProperties: true }
  if (parameters.type === 'object') return parameters
  if (Array.isArray(parameters.type) && parameters.type.includes('object')) {
    return { ...parameters, type: 'object' }
  }
  if (parameters.type === undefined || parameters.type === null) {
    if (isRecord(parameters.properties)) return { ...parameters, type: 'object' }
  }
  return { type: 'object', properties: {}, additionalProperties: true }
}

function blockText(block: ContentBlock | TranslatableBlock): string {
  return block.type === 'text' || block.type === 'reasoning' ? block.text : ''
}

function toolResultText(block: { content: readonly (ContentBlock | TranslatableBlock)[]; isError?: boolean }): string {
  return block.content.map(blockText).filter(Boolean).join('\n')
}

/**
 * Convert harness messages to the Command Code `/alpha/generate` wire shape.
 *
 * Critical difference from the previous naive text-only fold: tool calls and
 * tool results MUST round-trip as structured parts. Folding everything to
 * plain `role/content` text drops the tool loop, so the model re-reads the
 * system prompt every turn, never sees prior tool output, and keeps
 * "injecting context" with almost no real progress — matching the user report.
 *
 * Reasoning blocks are intentionally NOT replayed on the CLI transport
 * (they are replayed via messagesToOpenAI on the Provider API transport).
 */
/** Models whose Capabilities include Vision in Command Code. */
export const KNOWN_COMMANDCODE_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.8-Flash',
  'Qwen/Qwen3.8-Max',
  'Qwen/Qwen3.8-Max-0902',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  'google/gemini-3.8-flash',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3',
  'meta/muse-spark-1.3-contributor',
  'moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K3',
  'sakana/fugu-ultra',
  'stepfun/Step-3.7-Flash',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'xai/grok-4.5',
  'xai/grok-4.6',
  'xiaomi/mimo-v2.5',
  'z-ai/glm-5.3-flash',
])

export function isCommandCodeVisionModel(modelId: string): boolean {
  if (KNOWN_COMMANDCODE_IMAGE_MODELS.has(modelId)) return true
  const lower = modelId.toLowerCase()
  return lower.includes('v4.1-flash') || lower.includes('vision')
    || lower.startsWith('claude-') || lower.startsWith('google/') || lower.startsWith('gemini')
    || lower.startsWith('gpt-4') || lower.startsWith('gpt-5') || lower.startsWith('gpt-6')
}

export function messagesToCommandCode(messages: readonly (Message | TranslatableMessage)[]): unknown[] {
  const out: unknown[] = []
  const { ids: paired, names: toolNames } = pairedToolCalls(messages as readonly Message[])

  for (const message of withToolResultImages(messages as readonly TranslatableMessage[])) {
    if (message.role === 'system') continue

    if (message.role === 'user' && !isToolResultMessage(message)) {
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image' && 'dataBase64' in block) {
          parts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.mediaType,
              data: block.dataBase64,
            },
          })
        }
      }
      if (parts.length > 0) out.push({ role: 'user', content: parts })
      continue
    }

    if (message.role === 'assistant') {
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool-call' && paired.has(block.id)) {
          parts.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: recordOrEmpty(block.arguments),
          })
        }
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }

    if (isToolResultMessage(message)) {
      const block = message.content[0]
      if (!block || block.type !== 'tool-result' || !paired.has(block.toolCallId)) continue
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: block.toolCallId,
            toolName: toolNames.get(block.toolCallId) || 'unknown',
            output: block.isError
              ? { type: 'error-text', value: toolResultText(block) }
              : { type: 'text', value: toolResultText(block) },
          },
        ],
      })
    }
  }
  return out
}

/** Working-dir → project slug header (mirrors the reference adapter). */
function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|(?<!-)-+$/g, '')
  return slug || 'project'
}

/**
 * Convert harness messages to the Provider API (`/provider/v1/chat/completions`)
 * OpenAI Chat Completions shape.
 */
export function messagesToOpenAI(messages: readonly (Message | TranslatableMessage)[]): unknown[] {
  const out: unknown[] = []
  const { ids: paired } = pairedToolCalls(messages as readonly Message[])

  for (const message of withToolResultImages(messages as readonly TranslatableMessage[])) {
    if (message.role === 'system') continue

    if (message.role === 'user' && !isToolResultMessage(message)) {
      const hasImage = message.content.some(b => b.type === 'image' && 'dataBase64' in b)
      if (hasImage) {
        const parts: unknown[] = []
        for (const block of message.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image' && 'dataBase64' in block) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` },
            })
          }
        }
        if (parts.length > 0) out.push({ role: 'user', content: parts })
      } else {
        const text = message.content.map(blockText).filter(Boolean).join('\n')
        if (text.length > 0) out.push({ role: 'user', content: text })
      }
      continue
    }

    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      const reasoning = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
        .map(block => block.text)
        .join('')
      const toolCalls = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
          block.type === 'tool-call' && paired.has(block.id))
        .map(block => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: block.arguments },
        }))

      if (text === '' && reasoning === '' && toolCalls.length === 0) continue
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content: text === '' ? null : text,
      }
      if (reasoning !== '') assistant.reasoning_content = reasoning
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      out.push(assistant)
      continue
    }

    if (isToolResultMessage(message)) {
      const block = message.content[0]
      if (!block || block.type !== 'tool-result' || !paired.has(block.toolCallId)) continue
      out.push({
        role: 'tool',
        tool_call_id: block.toolCallId,
        content: toolResultText(block),
      })
    }
  }
  return out
}

/** Map an OpenAI `finish_reason` onto the harness's finish kinds. */
export function mapOpenAIFinishReason(reason: unknown): FinishReason {
  if (reason === 'tool_calls' || reason === 'tool-calls') return { kind: 'tool-calls' }
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens'
    || reason === 'max_output_tokens') {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

/** Map an OpenAI usage payload onto the harness's disjoint token counts. */
function mapOpenAIUsage(usage: unknown): TokenUsage {
  const source = isRecord(usage) ? usage : {}
  const promptTokens = numberValue(source.prompt_tokens) ?? 0
  const outputTokens = numberValue(source.completion_tokens) ?? 0
  const details = isRecord(source.prompt_tokens_details) ? source.prompt_tokens_details : undefined
  const completionDetails = isRecord(source.completion_tokens_details)
    ? source.completion_tokens_details
    : undefined
  const cached = numberValue(details?.cached_tokens) ?? 0
  const out: TokenUsage = {
    inputTokens: Math.max(0, promptTokens - cached),
    outputTokens,
  }
  if (cached > 0) out.cacheReadTokens = cached
  const reasoningTokens = numberValue(completionDetails?.reasoning_tokens)
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens
  return out
}

/**
 * Parse a Provider API SSE stream (`data: {...}` chunks) into harness chunks.
 *
 * Mirrors the reference adapter: reasoning arrives as `delta.reasoning` or
 * `delta.reasoning_content`, text as `delta.content`, and tool calls as
 * fragmented `delta.tool_calls` entries keyed by `index`.
 */
export async function* parseCommandCodeOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textIndex = -1
  let textContent = ''
  let reasoningIndex = -1
  let reasoningContent = ''
  let finished = false

  const closeText = function* (): Generator<StreamChunk> {
    if (textIndex < 0) return
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } }
    textIndex = -1
    textContent = ''
  }
  const closeReasoning = function* (): Generator<StreamChunk> {
    if (reasoningIndex < 0) return
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningContent } }
    reasoningIndex = -1
    reasoningContent = ''
  }

  // Fragmented tool calls accumulate here until the finish chunk.
  const pendingCalls: Array<{ index: number; id?: string; name: string; args: string }> = []
  const emitToolCalls = function* (): Generator<StreamChunk> {
    for (const call of pendingCalls) {
      const id = call.id ?? randomUUID()
      const args = call.args === '' ? '{}' : call.args
      const index = nextIndex++
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: ToolCallId(id), name: call.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: ToolCallId(id), name: call.name, arguments: args },
      }
    }
    pendingCalls.length = 0
  }

  const handle = function* (event: Record<string, unknown>): Generator<StreamChunk> {
    const choices = event.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      // Some servers send a standalone usage chunk before [DONE].
      if (event.usage !== undefined) yield { type: 'usage', usage: mapOpenAIUsage(event.usage) }
      return
    }
    const choice = isRecord(choices[0]) ? choices[0] : {}
    const delta = isRecord(choice.delta) ? choice.delta : {}

    const reasoningDelta = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content) ?? ''
    if (reasoningDelta !== '') {
      yield* closeText()
      if (reasoningIndex < 0) {
        reasoningIndex = nextIndex++
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
      }
      reasoningContent += reasoningDelta
      yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoningDelta }
    }

    const contentDelta = stringValue(delta.content) ?? ''
    if (contentDelta !== '') {
      yield* closeReasoning()
      if (textIndex < 0) {
        textIndex = nextIndex++
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
      }
      textContent += contentDelta
      yield { type: 'text-delta', index: textIndex, text: contentDelta }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!isRecord(rawCall)) continue
        const callIndex = numberValue(rawCall.index) ?? 0
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const id = stringValue(rawCall.id)
        const name = fn === undefined ? undefined : stringValue(fn.name)
        const argDelta = fn === undefined
          ? undefined
          : (stringValue(fn.arguments) ?? (fn.arguments === undefined ? '' : JSON.stringify(fn.arguments)))
        let existing = pendingCalls.find(call => call.index === callIndex)
        if (existing === undefined) {
          existing = { index: callIndex, name: name ?? '', args: argDelta ?? '' }
          if (id !== undefined) existing.id = id
          pendingCalls.push(existing)
        } else {
          if (id !== undefined && existing.id === undefined) existing.id = id
          if (name !== undefined && existing.name === '') existing.name = name
          if (argDelta !== undefined) existing.args += argDelta
        }
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      yield* closeText()
      yield* closeReasoning()
      yield* emitToolCalls()
      if (event.usage !== undefined) yield { type: 'usage', usage: mapOpenAIUsage(event.usage) }
      yield { type: 'finish', reason: mapOpenAIFinishReason(choice.finish_reason) }
      finished = true
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        let event: unknown
        try { event = JSON.parse(payload) } catch { continue }
        if (!isRecord(event)) continue
        yield* handle(event)
        if (finished) return
      }
    }
    if (!finished) {
      yield* closeText()
      yield* closeReasoning()
      yield* emitToolCalls()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } finally {
    reader.releaseLock()
  }
}

export const COMMANDCODE_PLANS: Readonly<Record<string, { name: string; monthlyCredits: number }>> = {
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15 },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
}

const COMMANDCODE_PLAN_PREFIXES = Object.keys(COMMANDCODE_PLANS).sort((a, b) => b.length - a.length)

export function commandCodePlanInfo(planId: string): { name: string; monthlyCredits: number } | undefined {
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  const prefix = COMMANDCODE_PLAN_PREFIXES.find(candidate => normalized.startsWith(candidate))
  return prefix === undefined ? undefined : COMMANDCODE_PLANS[prefix]
}

function creditWindow(
  kind: 'session' | 'weekly' | 'other',
  used: number | undefined,
  cap: number | undefined,
  resetAt?: number,
  scope?: string,
): NonNullable<ProviderUsage['windows']>[number] | undefined {
  if (typeof used !== 'number' || typeof cap !== 'number' || !(cap > 0)) return undefined
  return {
    kind,
    usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
    remaining: Math.max(cap - used, 0),
    limit: cap,
    ...typeof resetAt === 'number' && resetAt > 0 ? { resetsAt: resetAt } : {},
    ...scope === undefined ? {} : { scope },
  }
}

function periodEndMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function parseCommandCodeCredits(
  body: unknown,
  planCap?: number,
  planName?: string,
  periodEnd?: number,
): ProviderUsage {
  if (!isRecord(body)) return { supported: false }
  const credits = isRecord(body.credits) ? body.credits : undefined
  const windowLimits = isRecord(body.windowLimits) ? body.windowLimits : undefined
  const monthlyRemaining = numberValue(credits?.monthlyCredits)
  const purchased = numberValue(credits?.purchasedCredits) ?? 0
  const free = numberValue(credits?.freeCredits) ?? 0
  const planId = stringValue(credits?.planId)
  const info = planId === undefined ? undefined : commandCodePlanInfo(planId)
  const monthlyLimit = planCap ?? info?.monthlyCredits
  const windows: NonNullable<ProviderUsage['windows']> = []
  if (monthlyRemaining !== undefined) {
    const cap = monthlyLimit !== undefined && monthlyLimit > 0 ? monthlyLimit : undefined
    const used = cap === undefined ? undefined : Math.max(cap - monthlyRemaining, 0)
    windows.push({
      kind: 'other',
      scope: 'monthly',
      usedPercent: cap !== undefined && used !== undefined
        ? Math.min(100, Math.max(0, (used / cap) * 100))
        : 0,
      remaining: monthlyRemaining,
      ...cap === undefined ? {} : { limit: cap },
      ...periodEnd === undefined ? {} : { resetsAt: periodEnd },
    })
  }
  const five = isRecord(windowLimits?.fiveHour) ? windowLimits.fiveHour : undefined
  const weekly = isRecord(windowLimits?.weekly) ? windowLimits.weekly : undefined
  const fiveWindow = creditWindow('session', numberValue(five?.used), numberValue(five?.cap), numberValue(five?.resetAt))
  const weeklyWindow = creditWindow('weekly', numberValue(weekly?.used), numberValue(weekly?.cap), numberValue(weekly?.resetAt))
  if (fiveWindow !== undefined) windows.push(fiveWindow)
  if (weeklyWindow !== undefined) windows.push(weeklyWindow)
  const onDemand = purchased + free
  if (onDemand > 0) {
    windows.push({ kind: 'other', scope: 'on-demand', usedPercent: 0, remaining: onDemand })
  }
  if (windows.length === 0) return { supported: false }
  const plan = planName ?? info?.name
  return {
    supported: true,
    windows,
    ...monthlyRemaining === undefined ? {} : { remaining: monthlyRemaining },
    ...monthlyLimit === undefined ? {} : { limit: monthlyLimit },
    ...plan === undefined ? {} : { plan },
  }
}

export async function fetchCommandCodeUsage(
  session: CommandCodeSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const headers = { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', ...attributionHeaders() }

  const getJson = async (path: string, timeoutMs: number): Promise<unknown> => {
    try {
      const perSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      const res = await fetchFn(`${COMMANDCODE_API_BASE}${path}`, { headers, signal: perSignal })
      if (res.ok) return await res.json()
    } catch {
      // Degrades gracefully per endpoint
    }
    return undefined
  }

  // Fetch billing credits (essential) in parallel with optional identity
  const [whoami, credits] = await Promise.all([
    getJson('/alpha/whoami', 2500) as Promise<{ user?: { name?: string }; org?: { id?: string } } | undefined>,
    getJson('/alpha/billing/credits', 8000),
  ])

  if (!credits) return { supported: false }

  let planName: string | undefined
  let planCap: number | undefined
  let periodEnd: number | undefined

  if (typeof whoami?.user?.name === 'string') planName = whoami.user.name
  const orgId = typeof whoami?.org?.id === 'string' && whoami.org.id.length > 0 ? whoami.org.id : undefined

  // Optionally fetch subscription if orgId exists or directly
  const subPath = orgId === undefined
    ? '/alpha/billing/subscriptions'
    : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`
  const subscription = await getJson(subPath, 2500) as { data?: { planId?: string; currentPeriodEnd?: unknown } } | undefined
  if (subscription?.data) {
    const planId = typeof subscription.data.planId === 'string' ? subscription.data.planId : undefined
    const info = planId === undefined ? undefined : commandCodePlanInfo(planId)
    if (info !== undefined) {
      planName = info.name
      planCap = info.monthlyCredits
    }
    periodEnd = periodEndMs(subscription.data.currentPeriodEnd)
  }

  return parseCommandCodeCredits(credits, planCap, planName, periodEnd)
}

export async function startCommandCodeLogin(): Promise<{ authorizeUrl: string; wait: () => Promise<CommandCodeSession> }> {
  const state = randomBytes(16).toString('hex')
  const server = createHttpServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('commandcode login: no port'))
      else resolve(address.port)
    })
  })
  const authorizeUrl = `${STUDIO_BASE}/studio/auth/cli?callback=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}&state=${state}`
  const wait = (): Promise<CommandCodeSession> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Command Code login timed out'))
    }, 180_000)
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const origin = req.headers.origin
      const cors = typeof origin === 'string' && LOGIN_ORIGINS.has(origin) ? origin : undefined
      res.setHeader('Connection', 'close')
      if (cors !== undefined) res.setHeader('Access-Control-Allow-Origin', cors)
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end()
        return
      }
      if (req.method !== 'POST' || req.url?.split('?')[0] !== '/callback') {
        res.writeHead(404).end()
        return
      }
      if (typeof origin === 'string' && !LOGIN_ORIGINS.has(origin)) {
        res.writeHead(403).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > 10_000) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            apiKey?: string; state?: string; userId?: string; userName?: string
          }
          if (body.state !== state || typeof body.apiKey !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true }))
          clearTimeout(timer)
          server.close()
          resolve({
            accessToken: body.apiKey,
            refreshToken: body.apiKey,
            expiresAt: Date.now() + COMMANDCODE_PREEMPT_MS,
            ...typeof body.userName === 'string' ? { account: body.userName } : {},
            ...typeof body.userId === 'string' ? { userId: body.userId } : {},
          })
        } catch (error) {
          clearTimeout(timer)
          server.close()
          reject(error)
        }
      })
    })
  })
  return { authorizeUrl, wait }
}

function mapCommandCodeFinish(reason: unknown): FinishReason {
  if (reason === 'tool-calls' || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'max-tokens' || reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Parse Command Code JSONL / SSE events into harness StreamChunks. */
export async function* parseCommandCodeStream(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textIndex = -1
  let textContent = ''
  let reasoningIndex = -1
  let reasoningContent = ''
  let finished = false

  const closeText = function* (): Generator<StreamChunk> {
    if (textIndex < 0) return
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } }
    textIndex = -1
    textContent = ''
  }
  const closeReasoning = function* (): Generator<StreamChunk> {
    if (reasoningIndex < 0) return
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningContent } }
    reasoningIndex = -1
    reasoningContent = ''
  }

  const handle = function* (event: Record<string, unknown>): Generator<StreamChunk> {
    switch (event.type) {
      case 'text-delta': {
        yield* closeReasoning()
        const delta = stringValue(event.text) ?? stringValue(event.delta) ?? ''
        if (delta.length === 0) return
        if (textIndex < 0) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textContent += delta
        yield { type: 'text-delta', index: textIndex, text: delta }
        return
      }
      case 'reasoning-delta': {
        yield* closeText()
        const delta = stringValue(event.text) ?? stringValue(event.delta) ?? ''
        if (delta.length === 0) return
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoningContent += delta
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta }
        return
      }
      case 'reasoning-start':
        yield* closeText()
        return
      case 'reasoning-end':
        yield* closeReasoning()
        return
      case 'tool-call': {
        yield* closeText()
        yield* closeReasoning()
        const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? randomUUID()
        const name = stringValue(event.toolName) ?? stringValue(event.name) ?? ''
        const args = JSON.stringify(isRecord(event.input) ? event.input : isRecord(event.args) ? event.args : event.arguments ?? {})
        const index = nextIndex++
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } }
        return
      }
      case 'finish': {
        yield* closeText()
        yield* closeReasoning()
        const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
        if (usage !== undefined) {
          const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
          const totalInput = numberValue(usage.inputTokens) ?? 0
          const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
          const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
          const tokenUsage: TokenUsage = {
            inputTokens: numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
            outputTokens: numberValue(usage.outputTokens) ?? 0,
            ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
            ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
          }
          yield { type: 'usage', usage: tokenUsage }
        }
        yield { type: 'finish', reason: mapCommandCodeFinish(event.finishReason) }
        finished = true
        return
      }
      case 'error': {
        // Mirror the official Command Code CLI's stream-error classification
        // (readStreamErrorEvent + isStreamErrorRetryable in command-code's
        // cli.mjs), matching `Mars-Sea/dsh-commandcode-provider`: a stream
        // error that is explicitly non-retryable, carries a terminal marker
        // (quota/plan/credits), or reports a non-retryable HTTP status is a
        // hard failure; anything else is a transient mid-stream drop that the
        // harness's default retry policy should retry (SERVER is in the
        // default retryable set, PROVIDER_STREAM_ERROR is not). Without this,
        // a server-side blip that the official CLI silently recovers from
        // fails the whole turn and forces the user to re-prompt manually.
        const err = isRecord(event.error) ? event.error : undefined
        const detail = err !== undefined
          ? (stringValue(err.message) ?? stringValue(event.message) ?? JSON.stringify(err))
          : (stringValue(event.message) ?? stringValue(event.delta) ?? 'Stream error')
        const statusCode = err !== undefined ? numberValue(err.statusCode) : undefined
        const isRetryable = err !== undefined ? booleanValue(err.isRetryable) : undefined
        const retryableStatus = statusCode !== undefined && (statusCode === 429 || statusCode >= 500)
        const terminal = hasTerminalStreamMarker(detail)
        const retryable = isRetryable === true
          || (statusCode !== undefined ? retryableStatus : (isRetryable !== false && !terminal))
        const options = statusCode !== undefined ? { status: statusCode } : undefined
        if (retryable) {
          throw new LlmError(`Command Code stream error: ${detail}`, 'SERVER', options)
        }
        throw new LlmError(`Command Code stream error: ${detail}`, 'PROVIDER_STREAM_ERROR', options)
      }
      default: {
        const delta = stringValue(event.delta) ?? stringValue(event.text)
        if (delta !== undefined && delta.length > 0 && event.type === undefined) {
          yield* closeReasoning()
          if (textIndex < 0) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textContent += delta
          yield { type: 'text-delta', index: textIndex, text: delta }
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        let event: unknown
        try { event = JSON.parse(payload) }
        catch { continue }
        if (!isRecord(event)) continue
        yield* handle(event)
        if (finished) return
      }
    }
    if (!finished) {
      yield* closeText()
      yield* closeReasoning()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parse one row of `/provider/v1/models` into a sized catalog model. The
 * endpoint reports `context_length` (and possibly `max_tokens`); the output
 * cap defaults to the context-relative ceiling like the reference adapter
 * (`min(context_length, DEFAULT_MAX_OUTPUT_TOKENS)`).
 */
function parseCatalogModel(row: Record<string, unknown>): CommandCodeCatalogModel | undefined {
  const id = typeof row.id === 'string' ? row.id : undefined
  if (id === undefined || id.length === 0) return undefined
  const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : id
  const contextLength = coercePositiveNumber(row.context_length ?? row.contextWindow ?? row.context)
  if (contextLength === undefined) return undefined
  const rawMax = coercePositiveNumber(row.max_tokens) ?? coercePositiveNumber(row.max_output_tokens)
  return {
    id,
    name,
    contextWindow: contextLength,
    maxTokens: rawMax !== undefined ? rawMax : Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
  }
}

/** Extract a positive finite number from a number or numeric string field. */
function coercePositiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

/**
 * Selectable reasoning-effort levels per Command Code catalog id, mirroring the
 * official CLI's bundled model table (`dist/cli.mjs`) exactly — the Provider API
 * exposes no reasoning metadata, so this snapshot is the source of truth.
 *
 * Models absent here either reason automatically at a fixed depth (the CLI omits
 * `reasoning_effort` for them, so the picker must not offer a selector) or take
 * no reasoning at all.
 *
 * Adapted from Mars-Sea/dsh-commandcode-provider (MIT) `KNOWN_EFFORTS`.
 * Keep in sync with the official registry when new models ship.
 */
export const COMMANDCODE_KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max-0902': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash': ['low', 'high', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['high', 'max'],
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'google/gemini-3.8-flash': ['low', 'medium', 'high'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'moonshotai/Kimi-K3': ['low', 'high', 'max'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'tencent/hy4-preview': ['low', 'medium', 'high'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
  'z-ai/glm-5.3-flashx': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
})

/** Display names for Command Code effort ids. */
const COMMANDCODE_EFFORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
})

/** The `reasoning` block for a model, or undefined when it has no selectable levels. */
function commandCodeReasoning(model: string): LlmResolvedModelInfo['reasoning'] | undefined {
  const efforts = COMMANDCODE_KNOWN_EFFORTS[model]
  if (efforts === undefined || efforts.length === 0) return undefined
  return {
    efforts: efforts.map(effort => ({
      id: ReasoningEffortId(effort),
      name: COMMANDCODE_EFFORT_NAMES[effort] ?? effort,
    })),
  }
}

/**
 * Models the official CLI marks `reasoning: true` but defines NO selectable
 * `reasoning_effort` levels for: they think automatically at a depth Command
 * Code drives, so the CLI sends no `reasoning_effort` and the picker must not
 * offer a selector. Mirrors Mars-Sea/dsh-commandcode-provider (MIT)
 * `KNOWN_THINKING_MODELS`.
 *
 * Not surfaced in the picker — it exists so {@link looksLikeMissingEffortEntry}
 * does not report these as snapshot gaps.
 */
export const COMMANDCODE_AUTO_REASONING_MODELS: ReadonlySet<string> = new Set([
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.8-Omni-Flash',
  'moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'stepfun/Step-3.5-Flash',
  'stepfun/Step-3.7-Flash',
  'tencent/hy3',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'poolside/laguna-s-2.1-free',
  'meituan/LongCat-2.0',
  'meituan/LongCat-2.0:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'zai-org/GLM-5',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5.2-Fast',
  'MiniMaxAI/MiniMax-M2.5',
  'MiniMaxAI/MiniMax-M2.7',
  'xiaomi/mimo-v2.5',
  'xiaomi/mimo-v2.5-pro',
])

/**
 * Heuristic: does this catalog id look like a model the effort table should
 * cover but does not? Families that ship selectable levels are recognizable
 * from the id, so a newly released member is a likely snapshot gap rather than
 * a genuinely fixed-depth model.
 *
 * Advisory only — it drives a one-line warning so the gap is visible in the
 * logs, never a guessed selector: a `reasoning_effort` the CLI would not send
 * is rejected by the gateway, so offering a level on a guess risks a failed
 * turn. Verified to report zero false positives against the live 71-model
 * catalog.
 */
export function looksLikeMissingEffortEntry(model: string): boolean {
  if (COMMANDCODE_KNOWN_EFFORTS[model] !== undefined) return false
  if (COMMANDCODE_AUTO_REASONING_MODELS.has(model)) return false
  const id = model.toLowerCase()
  // `-fast` / `omni` / `haiku` variants reason automatically or take none.
  if (id.endsWith('-fast') || id.includes('omni') || id.includes('haiku')) return false
  // Families whose shipped members all carry selectable levels.
  return /^(claude-(sonnet|opus|fable)-|gpt-5\.[3-9]|gpt-6|qwen\/qwen3\.[89]-(max|flash|\d+b)|deepseek\/deepseek-v4|google\/gemini-3\.[5-9]|xai\/grok-4\.[5-9]|moonshotai\/kimi-k3|zai-org\/glm-5\.[2-9]|z-ai\/glm-5\.[3-9]|meta\/muse-spark|minimaxai\/minimax-m[3-9]|tencent\/hy[4-9])/.test(id)
}

/** Project a sized catalog model into the harness model-info shape. */
function toModelInfo(catalog: CommandCodeCatalogModel, provider: string): LlmModelInfo {
  return {
    provider,
    id: catalog.id,
    name: catalog.name,
    inputModalities: isCommandCodeVisionModel(catalog.id) ? ['text', 'image'] : ['text'],
  }
}

export interface CommandCodeAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<CommandCodeSession>
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  rateLimit?: RateLimitWait
}

const COMMANDCODE_CATALOG_TTL_MS = 5 * 60_000

/** A catalog model sized from the live `/provider/v1/models` response. */
interface CommandCodeCatalogModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export class CommandCodeAdapter extends LlmAdapter {
  /** Per-account live catalog, retaining each model's context window and output cap. */
  private readonly catalogs = new Map<string, { at: number; models: CommandCodeCatalogModel[] }>()

  /** Catalog ids already warned about a missing effort-table entry (one warning each). */
  private readonly warnedEffortGaps = new Set<string>()

  /** The live catalog entry for a model from any account, preferring the most recent snapshot. */
  private catalogModel(model: string): CommandCodeCatalogModel | undefined {
    let best: { at: number; entry: CommandCodeCatalogModel } | undefined
    for (const { at, models } of this.catalogs.values()) {
      const entry = models.find(candidate => candidate.id === model)
      if (entry !== undefined && (best === undefined || at > best.at)) best = { at, entry }
    }
    return best?.entry
  }

  constructor(private readonly options: CommandCodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(COMMANDCODE_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `commandcode: "${provider}"`)
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.catalogs.clear()
    else this.catalogs.delete(account)
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    // Selectable reasoning levels come from the pinned CLI-table snapshot: the
    // Provider API exposes no reasoning metadata, so a model outside the map
    // either reasons at a fixed depth or takes no reasoning at all, and the
    // picker must not offer a selector for it.
    const reasoning = commandCodeReasoning(model)
    let live = this.catalogModel(model)
    if (live === undefined) {
      // Prime the live catalog on the resolve path so a caller that resolves a
      // model before discovery runs still gets the real context/output caps
      // instead of the static fallbacks. Failures are non-fatal here.
      try {
        const accounts = (await this.options.tokens.list()).map(entry => entry.key)
        if (accounts.length > 0) await this.listOwnModels(provider, accounts[0])
        live = this.catalogModel(model)
      } catch { /* best-effort warm */ }
    }
    if (live !== undefined) {
      return {
        provider,
        id: model,
        name: live.name ?? configured?.name ?? model,
        inputModalities: configured?.inputModalities ?? (isCommandCodeVisionModel(model) ? ['text', 'image'] : ['text']),
        context: { contextWindow: live.contextWindow },
        defaultMaxTokens: Math.min(live.maxTokens, DEFAULT_GENERATE_MAX_TOKENS),
        ...reasoning === undefined ? {} : { reasoning },
      }
    }
    return {
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? (isCommandCodeVisionModel(model) ? ['text', 'image'] : ['text']),
      context: { contextWindow: configured?.contextWindow ?? 128_000 },
      defaultMaxTokens: Math.min(configured?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_GENERATE_MAX_TOKENS),
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.resolveOwnModel(provider, model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const own = await this.listOwnModels(provider)
    const extra = await this.options.pool?.()?.modelsForProvider(provider as ProviderId) ?? []
    const seen = new Set(own.map(model => model.id))
    return [...own, ...extra.filter(model => !seen.has(model.id))]
  }

  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account === undefined) {
      const accounts = (await this.options.tokens.list()).map(entry => entry.key)
      if (accounts.length === 0) return []
      return unionAccountCatalogs(
        accounts,
        (key, accountSignal) => this.listOwnModels(provider, key, accountSignal),
        { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } },
      )
    }
    if (!await this.options.tokens.hasSession(account)) return []
    const cached = this.catalogs.get(account)
    if (cached !== undefined && Date.now() - cached.at < COMMANDCODE_CATALOG_TTL_MS) {
      return cached.models.map(model => toModelInfo(model, provider))
    }
    try {
      const session = await this.options.tokens.session(account)
      const response = await proxiedFetch(`${COMMANDCODE_API_BASE}/provider/v1/models`, {
        headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', ...attributionHeaders() },
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw await httpLlmError(response, 'commandcode models')
      const payload = await response.json() as unknown
      const rows = Array.isArray(payload) ? payload
        : isRecord(payload) && Array.isArray(payload.data) ? payload.data
        : isRecord(payload) && Array.isArray(payload.models) ? payload.models
        : []
      const rawModels = rows
        .filter(isRecord)
        .map(row => parseCatalogModel(row as Record<string, unknown>))
        .filter((entry): entry is CommandCodeCatalogModel => entry !== undefined)
      if (rawModels.length > 0) {
        this.catalogs.set(account, { at: Date.now(), models: rawModels })
        // Snapshot-gap advisory: a newly shipped model from a family that
        // normally carries selectable efforts has no entry in
        // COMMANDCODE_KNOWN_EFFORTS, so its picker shows no thinking-level
        // selector until the table is updated. Warned once per model so the
        // gap is discoverable in the logs rather than silently shipped.
        for (const model of rawModels) {
          if (!looksLikeMissingEffortEntry(model.id)) continue
          const key = `efforts:${model.id}`
          if (this.warnedEffortGaps.has(key)) continue
          this.warnedEffortGaps.add(key)
          this.options.onWarn?.(
            `commandcode model "${model.id}" looks like it should carry selectable reasoning`
            + ' levels but is absent from COMMANDCODE_KNOWN_EFFORTS; its picker will show no'
            + ' thinking-level selector until the table is synced with the official CLI bundle.',
          )
        }
        return rawModels.map(model => toModelInfo(model, provider))
      }
    } catch (error) {
      if (cached !== undefined) return cached.models.map(model => toModelInfo(model, provider))
      this.options.onWarn?.(`commandcode catalog failed (${error instanceof Error ? error.message : String(error)})`)
    }
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: isCommandCodeVisionModel(model.id) ? ['text', 'image'] : ['text'],
    }))
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCore(options)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const session = await this.options.tokens.session(account)
      const workingDir = process.cwd()
      const systemText = [options.system ?? '', ...options.messages.filter(m => m.role === 'system')
        .map(m => m.content.map(blockText).filter(Boolean).join('\n'))]
        .filter(Boolean).join('\n\n')
      const live = this.catalogModel(options.model)
      const configured = this.options.models.find(entry => entry.id === options.model)
      const modelMax = live?.maxTokens ?? configured?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
      const maxTokens = Math.min(
        options.maxTokens ?? modelMax,
        modelMax,
        DEFAULT_GENERATE_MAX_TOKENS,
      )
      const effort = options.reasoningEffort !== undefined && options.reasoningEffort !== 'off'
        ? options.reasoningEffort
        : undefined

      const resolvedMessages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)

      // CLI transport (`/alpha/generate`) — the Go plan's only surface.
      const cliBody = {
        config: {
          workingDir,
          date: new Date().toISOString().slice(0, 10),
          environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
          structure: [],
          isGitRepo: false,
          currentBranch: '',
          mainBranch: '',
          gitStatus: '',
          recentCommits: [],
        },
        memory: null,
        taste: null,
        skills: null,
        params: {
          model: options.model,
          messages: messagesToCommandCode(resolvedMessages),
          tools: (options.tools ?? []).map(tool => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            input_schema: toolParametersSchema(tool.parameters),
          })),
          system: systemText,
          max_tokens: maxTokens,
          temperature: options.temperature ?? 0.3,
          stream: true,
          ...effort === undefined ? {} : { reasoning_effort: effort },
        },
        threadId: randomUUID(),
      }
      // Provider API transport — the one that can replay `reasoning_content`.
      const openAiTools = (options.tools ?? []).map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toolParametersSchema(tool.parameters),
        },
      }))
      const openAiBody = {
        model: options.model,
        messages: [
          ...systemText.length > 0 ? [{ role: 'system', content: systemText }] : [],
          ...messagesToOpenAI(resolvedMessages),
        ],
        ...openAiTools.length > 0 ? { tools: openAiTools } : {},
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.3,
        stream: true,
        ...effort === undefined ? {} : { reasoning_effort: effort },
      }

      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessToken}`,
        'x-command-code-version': COMMAND_CODE_CLI_VERSION,
        'x-cli-environment': 'production',
        'x-project-slug': projectSlugFromPath(workingDir),
        'x-taste-learning': 'true',
        'x-co-flag': 'false',
        ...attributionHeaders(),
      }

      let response: Response
      let usedProviderApi = true
      try {
        // DeepSeek thinking models REQUIRE reasoning replay, which only the
        // Provider API performs, so it leads. A Go-plan account without API
        // access answers 403 `upgrade_required`, and only then do we fall back
        // to the CLI transport (whose message shape is what that plan serves).
        response = await proxiedFetch(`${COMMANDCODE_API_BASE}/provider/v1/chat/completions`, {
          method: 'POST',
          headers: { ...headers, accept: 'text/event-stream' },
          body: JSON.stringify(openAiBody),
          signal: watchdog.signal,
        })
        if (!response.ok && await isProviderUpgradeRequired(response)) {
          usedProviderApi = false
          response = await proxiedFetch(`${COMMANDCODE_API_BASE}/alpha/generate`, {
            method: 'POST',
            headers,
            body: JSON.stringify(cliBody),
            signal: watchdog.signal,
          })
        }
      } catch (error) {
        throw mapFetchFailure('commandcode', error, watchdog, options.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'commandcode')
      if (response.body === null) throw new LlmError('commandcode returned an empty stream', 'EMPTY_RESPONSE')
      if (usedProviderApi) {
        yield* parseCommandCodeOpenAIStream(response.body, () => watchdog.pulse())
      } else {
        yield* parseCommandCodeStream(response.body, () => watchdog.pulse())
      }
    } finally {
      watchdog.stop()
    }
  }
}

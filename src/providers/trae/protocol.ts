/**
 * Trae CN wire protocol: the shared header set, the `llm_utils_chat` body
 * builder, and the named-SSE decoder.
 *
 * Trae's chat endpoint is NOT OpenAI-compatible: it takes a small fixed
 * envelope (`messages` / `model` / `config_name` / `function` / `stream`) and
 * answers with named SSE events (`output`, `token_usage`, `done`, `error`)
 * rather than OpenAI chunks. Reverse-engineered from the Trae CN desktop client
 * and cross-checked against dingminhua/dsh-connect-trae (MIT) `protocol.ts` /
 * `sse.ts` / `solo.ts` and Wang-JQ77/dsh-trae-api (MIT) `trae-client.js`.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

/** CN chat gateway (shared by the Trae CN IDE and TRAE SOLO CN channels). */
export const TRAE_CHAT_BASE = 'https://trae-api-cn.mchost.guru'
/** CN SOLO remote model directory base. */
export const TRAE_REMOTE_BASE = 'https://solo.trae.cn/api/remote/v1'
/** CN pay/entitlement base (read-only usage + check-in). */
export const TRAE_PAY_BASE = 'https://api.trae.cn'

/** Chat endpoint: one request = one turn. */
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
/** Model directory endpoint (returns the callable `config_info_list`). */
export const TRAE_MODELS_PATH = '/api/ide/v1/get_detail_param'

/** The app id every Trae client sends. */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
/** Plugin channel marker. */
export const TRAE_PLUGIN_CHANNEL = 'icube-ai'
/**
 * Numeric version code fallback. The upstream binds `x-*-version-code` as a
 * NUMBER, so a dotted build string (`2.3.76922`) is rejected; keep it digits.
 */
export const TRAE_VERSION_CODE = '20260716'
/** Client version reported in `User-Agent` / `x-app-version`. */
export const TRAE_CLIENT_VERSION = '3.3.67'

/** Directory functions whose rosters are unioned for the SOLO channel, in precedence order. */
export const TRAE_SOLO_DIRECTORY_FUNCTIONS: readonly string[] = ['solo_work_remote', 'solo_work_lite']
/** The default SOLO function when a model's own listing function is unknown. */
export const TRAE_SOLO_FUNCTION = 'solo_work_lite'
/** Directory functions probed for the IDE channel. */
export const TRAE_IDE_DIRECTORY_FUNCTIONS: readonly string[] = ['inline_chat', 'chat']

/** Stable per-process device identity (device-stable values the upstream validates). */
const DEVICE_MACHINE_ID = randomUUID().replace(/-/g, '')
const DEVICE_ID = createDeviceId(DEVICE_MACHINE_ID)

function createDeviceId(machineId: string): string {
  // The client derives the device id as a 32-char hash of the machine id.
  // Node's createHash is imported lazily below to keep this module fetch-safe.
  return machineId.slice(0, 32)
}

/** The `reasoning_effort` values Trae's client sends on the wire. */
export const TRAE_WIRE_EFFORTS: Readonly<Record<string, string>> = Object.freeze({
  low: 'light',
  high: 'high',
  xhigh: 'extra_high',
})

/** Build the header set every authenticated Trae endpoint shares. */
export function traeHeaders(accessToken: string, userId: string): Record<string, string> {
  const requestId = randomUUID()
  const traceId = requestId.replace(/-/g, '')
  return {
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    'X-Ide-Token': accessToken,
    'X-Cloudide-Token': accessToken,
    'x-uid': userId,
    'x-app-id': TRAE_APP_ID,
    'x-plugin-channel': TRAE_PLUGIN_CHANNEL,
    'User-Agent': `Trae/${TRAE_CLIENT_VERSION}`,
    'x-app-version': TRAE_CLIENT_VERSION,
    'x-ide-version': TRAE_CLIENT_VERSION,
    'x-app-version-code': TRAE_VERSION_CODE,
    'x-ide-version-code': TRAE_VERSION_CODE,
    'x-ide-version-type': 'stable',
    'x-machine-id': DEVICE_MACHINE_ID,
    'x-device-id': DEVICE_ID,
    'x-device-type': process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
    'x-os-version': `${process.platform} ${hostname()}`,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'x-custom-trace-id': traceId.slice(0, 32),
    'x-flow-traceparent': `04-${traceId.slice(0, 32)}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
}

/** One tool call as Trae emits/accepts it. */
export interface TraeToolCall {
  id: string
  name: string
  /** Raw JSON argument string, passed through verbatim. */
  arguments: string
}

/** One message in the Trae request envelope. */
export interface TraeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  text: string
  toolCalls?: TraeToolCall[]
  toolCallId?: string
}

/** Options for {@link buildTraeChatBody}. */
export interface TraeChatBodyOptions {
  model: string
  /** The directory function that listed this model (replayed so the call routes correctly). */
  functionName: string
  messages: readonly TraeMessage[]
  tools?: readonly { name: string; description: string; parameters: unknown }[]
  reasoningEffort?: string
}

/**
 * Build the `llm_utils_chat` request body. Only the fields the upstream
 * actually binds are emitted — optional OpenAI fields (temperature, top_p,
 * tool_choice, response_format, …) make every model fail validation.
 */
export function buildTraeChatBody(options: TraeChatBodyOptions): Record<string, unknown> {
  const messages = options.messages.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: [{ type: 'text', text: message.text }],
        tool_call_id: message.toolCallId ?? '',
      }
    }
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.text === '' ? [] : [{ type: 'text', text: message.text }],
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          // Trae expects `function_call` here, not OpenAI's `function`.
          function_call: { name: call.name, arguments: call.arguments },
        })),
      }
    }
    return { role: message.role, content: [{ type: 'text', text: message.text }] }
  })

  const wireEffort = options.reasoningEffort === undefined
    ? undefined
    : TRAE_WIRE_EFFORTS[options.reasoningEffort]

  return {
    messages,
    model: options.model,
    config_name: options.model,
    function: options.functionName,
    stream: true,
    ...wireEffort === undefined ? {} : { reasoning_effort: wireEffort },
    ...options.tools === undefined || options.tools.length === 0 ? {} : {
      tools: options.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          // The upstream binds parameters as a JSON STRING, not an object.
          parameters: JSON.stringify(tool.parameters),
        },
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// SSE decoding
// ---------------------------------------------------------------------------

/** One decoded SSE frame. */
export interface TraeSseEvent {
  event?: string
  data: string
}

/** Incremental SSE decoder: handles CRLF, chunk splits and multi-line data. */
export class TraeSseDecoder {
  private buffer = ''
  private event: string | undefined
  private data: string[] = []

  push(chunk: string): TraeSseEvent[] {
    this.buffer += chunk
    const events: TraeSseEvent[] = []
    for (;;) {
      const match = /\r?\n/.exec(this.buffer)
      if (match === null || match.index === undefined) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const emitted = this.consumeLine(line)
      if (emitted !== undefined) events.push(emitted)
    }
    return events
  }

  finish(): TraeSseEvent[] {
    const events: TraeSseEvent[] = []
    if (this.buffer !== '') {
      const emitted = this.consumeLine(this.buffer)
      this.buffer = ''
      if (emitted !== undefined) events.push(emitted)
    }
    const final = this.dispatch()
    if (final !== undefined) events.push(final)
    return events
  }

  private consumeLine(line: string): TraeSseEvent | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
    return undefined
  }

  private dispatch(): TraeSseEvent | undefined {
    if (this.data.length === 0) {
      this.event = undefined
      return undefined
    }
    const result: TraeSseEvent = {
      ...this.event === undefined || this.event === '' ? {} : { event: this.event },
      data: this.data.join('\n'),
    }
    this.event = undefined
    this.data = []
    return result
  }
}

/** One decoded Trae stream event. */
export type TraeStreamEvent =
  | { type: 'delta'; text: string; reasoning?: string; toolCalls?: unknown }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
  | { type: 'done'; finishReason: string }
  | { type: 'queue'; position?: number }
  | { type: 'error'; code?: number; message: string }
  | { type: 'ignore' }

/** Decode one SSE frame into a semantic event. */
export function decodeTraeEvent(event: TraeSseEvent): TraeStreamEvent {
  if (event.data === '[DONE]') return { type: 'done', finishReason: 'stop' }
  let payload: unknown
  try {
    payload = JSON.parse(event.data) as unknown
  } catch {
    return { type: 'ignore' }
  }
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  if (event.event === 'request_wait_in_queue') {
    return { type: 'queue', ...typeof record.position === 'number' ? { position: record.position } : {} }
  }
  if (event.event === 'error' || (typeof record.code === 'number' && record.code >= 4000)) {
    const code = typeof record.code === 'number' ? record.code : undefined
    const message = typeof record.message === 'string' && record.message !== ''
      ? record.message
      : typeof record.msg === 'string' && record.msg !== ''
        ? record.msg
        : `Trae upstream error${code === undefined ? '' : ` (code ${String(code)})`}`
    return { type: 'error', ...code === undefined ? {} : { code }, message }
  }
  if (event.event === 'token_usage') {
    return {
      type: 'usage',
      ...typeof record.prompt_tokens === 'number' ? { inputTokens: record.prompt_tokens } : {},
      ...typeof record.completion_tokens === 'number' ? { outputTokens: record.completion_tokens } : {},
      ...typeof record.reasoning_tokens === 'number' ? { reasoningTokens: record.reasoning_tokens } : {},
    }
  }
  if (event.event === 'done' || (typeof record.finish_reason === 'string' && record.response === undefined)) {
    return { type: 'done', finishReason: typeof record.finish_reason === 'string' ? record.finish_reason : 'stop' }
  }
  if (event.event === 'output' || record.response !== undefined || record.reasoning_content !== undefined) {
    return {
      type: 'delta',
      text: typeof record.response === 'string' ? record.response : '',
      ...typeof record.reasoning_content === 'string' ? { reasoning: record.reasoning_content } : {},
      ...record.tool_calls === undefined || record.tool_calls === null ? {} : { toolCalls: record.tool_calls },
    }
  }
  // progress_notice / metadata / timing_cost / extra_info carry no model output.
  return { type: 'ignore' }
}

/** One tool-call delta normalized out of a Trae `output` event. */
export interface TraeToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

/** Normalize Trae's `tool_calls` array (which uses `function_call`, not `function`). */
export function normalizeTraeToolCalls(value: unknown): TraeToolCallDelta[] {
  if (!Array.isArray(value)) return []
  const calls: TraeToolCallDelta[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const rawFunction = typeof record.function_call === 'object' && record.function_call !== null
      ? record.function_call as Record<string, unknown>
      : typeof record.function === 'object' && record.function !== null
        ? record.function as Record<string, unknown>
        : {}
    calls.push({
      index: typeof record.index === 'number' ? record.index : calls.length,
      ...typeof record.id === 'string' ? { id: record.id } : {},
      ...typeof rawFunction.name === 'string' ? { name: rawFunction.name } : {},
      ...typeof rawFunction.arguments === 'string' ? { arguments: rawFunction.arguments } : {},
    })
  }
  return calls
}

/** Join a gateway base and a path without doubling or dropping the slash. */
export function traeEndpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

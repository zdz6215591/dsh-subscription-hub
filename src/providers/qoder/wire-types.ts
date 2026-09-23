/**
 * Qoder protocol wire types — the request envelope and its answer.
 *
 * `QoderWireRequest` is the whole contract: the gateway accepts nothing less
 * than a populated envelope, and several of its fields (the `chat_context`
 * mirror of the model config, the `business` block, the fixed `session_type`
 * `qodercli`) are not optional in practice even though the upstream schema does
 * not say so. The reference discovered each of them against live traffic; none
 * of these names may be renamed or omitted.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect`
 * `src/qoder/transport/wire/wire-types.ts` (MIT).
 *
 * @module dsh-subscription-hub/providers/qoder/wire-types
 */

/** One tool invocation as the wire carries it. */
export interface QoderWireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** One tool declaration as the wire carries it. */
export interface QoderWireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One text part of a multimodal user message. */
export interface QoderWireTextPart {
  type: 'text'
  text: string
}

/** One image part of a multimodal user message (a center object URL or a data URL). */
export interface QoderWireImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** A wire message body: a plain string, or ordered parts when images are present. */
export type QoderWireContent = string | Array<QoderWireTextPart | QoderWireImagePart>

/** One conversation message in the Qoder envelope. */
export interface QoderWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: QoderWireContent | null
  tool_calls?: QoderWireToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

/** The model tier block of the envelope. */
export interface QoderModelConfig {
  key: string
  is_reasoning: boolean
  max_output_tokens: number
  source: string
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>
}

/** The `chat_context` block; it duplicates the model config and the last user text. */
export interface QoderChatContext {
  chatPrompt: string
  imageUrls: null | string[]
  extra: {
    context: unknown[]
    modelConfig: {
      key: string
      is_reasoning: boolean
    }
    originalContent: string
  }
  features: unknown[]
  text: string
}

/** The `business` block; the gateway requires it on every chat. */
export interface QoderBusiness {
  product: string
  version: string
  type: string
  stage: string
  id: string
  name: string
  begin_at: number
}

/**
 * The complete chat request envelope.
 *
 * `stream` is typed as the literal `true` because the SSE route has no
 * non-streaming mode.
 */
export interface QoderWireRequest {
  request_id: string
  request_set_id: string
  chat_record_id: string
  session_id: string
  stream: true
  chat_task: string
  is_reply: boolean
  is_retry: boolean
  source: number
  version: string
  session_type: string
  agent_id: string
  task_id: string
  code_language: string
  chat_prompt: string
  image_urls: null
  aliyun_user_type: string
  system: string
  messages: QoderWireMessage[]
  tools: QoderWireTool[]
  parameters: {
    max_tokens: number
    reasoning_effort?: string
  }
  chat_context: QoderChatContext
  model_config: QoderModelConfig
  business: QoderBusiness
}

/** Qoder's outer SSE frame: a status plus a body that is itself a JSON chunk or `[DONE]`. */
export interface QoderSseEnvelope {
  statusCodeValue?: number
  body?: string
}

/** The OpenAI-shaped chunk nested inside one envelope. */
export interface QoderInnerChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string
      role?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

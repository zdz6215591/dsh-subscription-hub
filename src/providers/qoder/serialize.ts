/**
 * Build the minimum qodercli request envelope for a validated harness request.
 *
 * The envelope is deliberately minimal but not sparse: `chat_context` mirrors
 * the model key, the reasoning flag and the last user text; `business` carries
 * a fresh id and the truncated prompt as a display name; `session_type` is the
 * fixed `qodercli`; and `parameters.max_tokens` is clamped DOWN to the model's
 * advertised output cap, because the gateway rejects a larger value outright.
 *
 * Two identities are derived rather than randomized so a retry of the same
 * request is recognizable upstream: `chat_record_id` hashes the model, the
 * translated messages, the tools and the token budget, while `session_id`
 * hashes the subscriber and model and appends the harness session id when the
 * caller supplied one.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect`
 * `src/qoder/transport/wire/serialize.ts` (MIT). The reference's
 * `UNSUPPORTED_REASONING_EFFORT` and `UNSUPPORTED_CONTENT` collapse onto the
 * hub's single `UNSUPPORTED` code.
 *
 * @module dsh-subscription-hub/providers/qoder/serialize
 */

import crypto from 'node:crypto'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { qoderError, QODER_UNSUPPORTED_CODE } from './errors.js'
import { translateTools, validateAndTranslateMessages, validateMessageShapes } from './translate.js'
import type { QoderImageAttachments, QoderImageResolver } from './translate.js'
import type { QoderWireMessage, QoderWireRequest, QoderWireTool } from './wire-types.js'
import type { QoderCatalogModel } from './catalog.js'
import type { CosyCredentials } from './cosy.js'

/**
 * What the wire's required `max_tokens` field falls back to when NEITHER the
 * catalog nor the caller supplied one.
 *
 * The Qoder envelope has no optional spelling of this field, so a request cannot
 * be built without a number — unlike `resolveOwnModel`, which is free to omit
 * it. This is therefore the harness's own request requirement, kept deliberately
 * here at the request boundary rather than dressed up as the model's capacity.
 */
const REQUEST_DEFAULT_MAX_TOKENS = 32_768

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash('sha256')
  hash.update(prefix)
  for (const input of inputs) {
    hash.update('\0')
    hash.update(input)
  }
  return hash.digest('hex').slice(0, 16)
}

function stableChatRecordId(
  model: string,
  messages: readonly QoderWireMessage[],
  tools: readonly QoderWireTool[],
  maxTokens: number,
): string {
  const hash = crypto.createHash('sha256')
  hash.update('qoder-record')
  hash.update('\0')
  hash.update(model)
  hash.update('\0')
  hash.update(JSON.stringify(messages))
  hash.update('\0')
  hash.update(JSON.stringify(tools))
  hash.update('\0')
  hash.update(`mt=${maxTokens}`)
  return hash.digest('hex').slice(0, 16)
}

/**
 * Reject an unusable request before any credential resolution or provider I/O.
 *
 * Image publication needs credentials, so message translation runs after
 * authentication. This static pass preserves the guarantee that a request the
 * provider cannot serve never reaches the network.
 * @param options - the request.
 * @param model - the resolved catalog entry, when the model is known.
 * @throws LlmError `UNSUPPORTED` for an unadvertised reasoning effort, an image
 *   on a non-vision model, or a message shape the transport cannot carry.
 */
export function validateQoderRequestShape(
  options: GenerateOptions,
  model?: QoderCatalogModel,
): void {
  if (options.reasoningEffort !== undefined) {
    const effort = String(options.reasoningEffort)
    if (!model?.reasoningEfforts?.some(candidate => candidate.id === effort)) {
      throw qoderError(
        `Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`,
        QODER_UNSUPPORTED_CODE,
      )
    }
  }
  if (options.messages.some(message => contentHasImage(message.content)) && model?.supportsImages !== true) {
    throw qoderError(
      `Qoder model "${options.model}" does not advertise image input.`,
      QODER_UNSUPPORTED_CODE,
    )
  }
  validateMessageShapes(options.messages)
}

/**
 * Translate a request whose shape has already been validated.
 * @param options - the request.
 * @param attachments - the attachment store images are read through.
 * @param pipeline - the image publisher, credentials, and thinking-replay flag.
 * @returns the wire messages.
 */
export function translateQoderMessages(
  options: GenerateOptions,
  attachments?: QoderImageAttachments,
  pipeline?: {
    uploader?: QoderImageResolver | undefined
    credentials?: CosyCredentials | undefined
    preserveThinking?: boolean | undefined
  },
): Promise<QoderWireMessage[]> {
  return validateAndTranslateMessages(
    options.messages,
    options.system,
    attachments,
    options.signal,
    pipeline,
  )
}

/**
 * Validate the request shape and translate its messages in one step.
 * @param options - the request.
 * @param model - the resolved catalog entry, when known.
 * @param attachments - the attachment store images are read through.
 * @returns the wire messages.
 */
export async function validateQoderRequest(
  options: GenerateOptions,
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
): Promise<QoderWireMessage[]> {
  validateQoderRequestShape(options, model)
  return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal)
}

/**
 * Assemble the complete request envelope.
 *
 * @param options - the request.
 * @param userId - the authenticated account id; the session id is derived from it.
 * @param translatedMessages - already-translated wire messages, when the caller
 *   translated them earlier (image publication needs the credentials first).
 * @param model - the resolved catalog entry, when known.
 * @param attachments - the attachment store used when translation happens here.
 * @returns the envelope to encode and send.
 * @throws LlmError `AUTH` when `userId` is empty.
 */
export async function buildQoderRequestBody(
  options: GenerateOptions,
  userId: string,
  translatedMessages?: QoderWireMessage[],
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
): Promise<QoderWireRequest> {
  if (!userId) {
    throw qoderError('Qoder request identity is missing.', 'AUTH')
  }
  const modelKey = options.model || 'cmodel'
  const messages = translatedMessages ?? await validateQoderRequest(options, model, attachments)
  // The wire REQUIRES a number here (`parameters.max_tokens` and
// `model_config.max_output_tokens` are both non-optional), so when the catalog
// published no cap the caller's own request value is used and, failing that,
// the harness's per-request ceiling. This is a REQUEST requirement, not a claim
// about the model: `resolveOwnModel` reports no `defaultMaxTokens` in that case,
// so nothing presents the number as the model's own capacity.
  const modelMaxTokens = model?.maxTokens ?? options.maxTokens ?? REQUEST_DEFAULT_MAX_TOKENS
  const maxTokens = Math.min(options.maxTokens ?? modelMaxTokens, modelMaxTokens)
  const isReasoning = options.reasoningEffort !== undefined || (model?.isReasoning ?? false)
  const tools = translateTools(options.tools)
  // The request DECLARES the largest tier, not upstream's default one.
  //
  // This has to agree with the window `resolveOwnModel` reports, or the two
  // contradict each other: advertising a 1M window while asking the gateway for
  // the 200K tier would pack a request the gateway then rejects. Upstream's
  // `context_config` offers 200K / 400K / 1M with 200K marked default, and the
  // reference's own preference for the maximum is `z.boolean().default(true)` —
  // so the largest tier is selected, and the SMALLEST is chosen as the tie-break
  // only when entries somehow share the top token count.
  const contextConfig = model?.contextOptions === undefined
    ? undefined
    : (() => {
        const tiers = Object.entries(model.contextOptions)
          .filter(([, value]) => typeof value.tokenCount === 'number' && Number.isFinite(value.tokenCount) && value.tokenCount > 0)
        if (tiers.length === 0) return undefined
        const largest = Math.max(...tiers.map(([, value]) => value.tokenCount ?? 0))
        // The lowest-keyed tier wins a tie, so the choice is deterministic rather
        // than dependent on property order.
        const chosen = tiers.filter(([, value]) => value.tokenCount === largest).map(([key]) => key).sort()[0]
        return Object.fromEntries(Object.entries(model.contextOptions).map(([key, value]) => [key, {
          ...value.tokenCount === undefined ? {} : { token_count: value.tokenCount },
          // `is_default` is written for EVERY tier, including one upstream left
          // unmarked: exactly one tier has to carry it or the gateway sees an
          // ambiguous request, and upstream's own omission is not an instruction
          // to send none.
          is_default: key === chosen,
        }]))
      })()
  let lastUserText = ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    // index is bounded by messages.length; guard only satisfies noUncheckedIndexedAccess.
    if (message === undefined) continue
    if (message.role === 'user') {
      const content = message.content
      lastUserText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(part => part.type === 'text').map(part => part.text).join('')
          : ''
      break
    }
  }

  const stablePart = stableHash('qoder-session', userId, modelKey)
  const sessionId = options.sessionId === undefined
    ? `${stablePart}-${crypto.randomUUID()}`
    : `${stablePart}-${String(options.sessionId)}`
  const recordId = stableChatRecordId(modelKey, messages, tools, maxTokens)

  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages,
    tools,
    parameters: {
      max_tokens: maxTokens,
      ...options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: String(options.reasoningEffort) },
    },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: {
      key: modelKey,
      is_reasoning: isReasoning,
      max_output_tokens: maxTokens,
      source: model?.source || 'system',
      ...contextConfig === undefined ? {} : { context_config: contextConfig },
    },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: crypto.randomUUID(),
      name: lastUserText.substring(0, 30),
      begin_at: Date.now(),
    },
  }
}

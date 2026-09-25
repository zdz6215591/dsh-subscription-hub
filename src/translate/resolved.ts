/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { readRequestImage } from './image-request.js'

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type verified by the attachment service (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
}

/** Translator input block: a harness block, with images pre-resolved. */
export type TranslatableBlock = Exclude<ContentBlock, ToolResultBlock> | ResolvedImagePart | ResolvedToolResultBlock

/** Tool results may themselves carry attachment-backed images. */
export interface ResolvedToolResultBlock extends Omit<ToolResultBlock, 'content'> {
  content: readonly TranslatableBlock[]
}

/** The tool result one message answers (unified view across DSH versions). */
export interface ToolResultView {
  readonly toolCallId: string
  readonly isError?: boolean | undefined
  readonly content: readonly (ContentBlock | TranslatableBlock)[]
}

/**
 * Extract all tool results from a message.
 * Supports both DSH 0.1.7 native `role: 'tool'` messages (one result per message)
 * and legacy DSH <=0.1.5 `role: 'user'` messages containing one or more `tool-result` blocks.
 */
export function toolResultsOf(message: Message | TranslatableMessage): ToolResultView[] {
  const current = message as unknown as {
    role: string
    toolCallId?: string
    isError?: boolean
    content: readonly (ContentBlock | TranslatableBlock)[]
  }
  if (current.role === 'tool') {
    if (typeof current.toolCallId !== 'string' || current.toolCallId === '') return []
    return [{ toolCallId: current.toolCallId, isError: current.isError ?? false, content: current.content }]
  }
  if (message.role !== 'user') return []
  const results: ToolResultView[] = []
  for (const block of message.content) {
    if (block?.type === 'tool-result') {
      results.push({
        toolCallId: (block as ToolResultBlock).toolCallId,
        isError: (block as ToolResultBlock).isError ?? false,
        content: (block as ToolResultBlock).content as readonly (ContentBlock | TranslatableBlock)[],
      })
    }
  }
  return results
}

/**
 * Extract the primary tool result from a message, or undefined if none.
 */
export function toolResultOf(message: Message | TranslatableMessage): ToolResultView | undefined {
  return toolResultsOf(message)[0]
}

/**
 * Collect the tool calls that have a paired tool result, plus each call's name.
 */
export function pairedToolCalls(messages: readonly (Message | TranslatableMessage)[]): {
  ids: Set<string>
  names: Map<string, string>
} {
  const callIds = new Set<string>()
  const names = new Map<string, string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    const results = toolResultsOf(message)
    for (const result of results) {
      if (result.toolCallId && result.toolCallId.trim() !== '') {
        resultIds.add(result.toolCallId)
      }
    }
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call') {
        callIds.add(block.id)
        if (block.name) names.set(block.id, block.name)
      }
    }
  }
  return { ids: new Set([...callIds].filter((id) => resultIds.has(id))), names }
}

/**
 * Wires with text-only tool outputs receive images in a following user turn.
 * Defer that turn until all consecutive user messages have been processed:
 * parallel tool results can arrive in separate harness messages, and a user
 * image message must not interrupt their tool-call/output pairing.
 */
export function withToolResultImages(messages: readonly TranslatableMessage[]): TranslatableMessage[] {
  const out: TranslatableMessage[] = []
  let images: TranslatableBlock[] = []
  const flush = (): void => {
    if (images.length > 0) out.push({ role: 'user', content: images })
    images = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') flush()
    out.push(message)
    const results = toolResultsOf(message)
    for (const result of results) {
      const parts = result.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(result.toolCallId)}:` }, ...parts)
      }
    }
  }
  flush()
  return out
}

/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: readonly TranslatableBlock[]
  /** Preserved for adapters whose provider-private replay metadata is required. */
  source?: Message['source']
  toolCallId?: string
  isError?: boolean
}

/**
 * Resolve every ImageBlock's attachment reference to inline base64 bytes.
 * Messages without images pass through unchanged. A request carrying an image
 * with no attachment service available fails loudly rather than silently
 * dropping the image.
 * @param messages - the request's conversation messages.
 * @param attachments - the deployment's attachment service, when mounted.
 * @param signal - cancellation for the storage reads.
 * @returns the same messages with image blocks resolved for the translators.
 */
export async function resolveImages(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly TranslatableMessage[]> {
  const hasImage = (block: ContentBlock): boolean => block.type === 'image'
    || (block.type === 'tool-result' && block.content.some(hasImage))
  if (!messages.some(message => message.content.some(hasImage))) {
    return messages
  }
  if (attachments === undefined) {
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED',
    )
  }
  const resolveBlock = async (block: ContentBlock): Promise<TranslatableBlock[]> => {
    if (block.type === 'tool-result') {
      return [{ ...block, content: (await Promise.all(block.content.map(resolveBlock))).flat() }]
    }
    if (block.type !== 'image') return [block]
    // The model-request version, not the stored original: the provider would
    // downscale to its own tile budget anyway, and this history is replayed on
    // every turn of the session.
    const stored = await readRequestImage(attachments, block.attachment, signal)
    const { attachmentId, mediaType, bytes, width, height, name } = block.attachment
    return [{
      type: 'image',
      mediaType: stored.mediaType,
      dataBase64: Buffer.from(stored.data).toString('base64'),
    }, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}`,
    }]
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    role: message.role as TranslatableMessage['role'],
    source: message.source,
    content: (await Promise.all(message.content.map(resolveBlock))).flat(),
    ...('toolCallId' in message && typeof (message as { toolCallId?: string }).toolCallId === 'string'
      ? { toolCallId: (message as { toolCallId: string }).toolCallId }
      : {}),
    ...('isError' in message && typeof (message as { isError?: boolean }).isError === 'boolean'
      ? { isError: (message as { isError: boolean }).isError }
      : {}),
  })))
}

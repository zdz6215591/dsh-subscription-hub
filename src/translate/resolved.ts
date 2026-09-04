/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type verified by the attachment service (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
}

/** Translator input block: a harness block, with images pre-resolved. */
export type TranslatableBlock = ContentBlock | ResolvedImagePart

/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
  role: 'system' | 'user' | 'assistant'
  content: readonly TranslatableBlock[]
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
  if (!messages.some(message => message.content.some(block => block.type === 'image'))) {
    return messages
  }
  if (attachments === undefined) {
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED',
    )
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    role: message.role,
    content: await Promise.all(message.content.map(async (block): Promise<TranslatableBlock> => {
      if (block.type !== 'image') return block
      const stored = await attachments.readImage(block.attachment, signal)
      return {
        type: 'image',
        mediaType: stored.ref.mediaType,
        dataBase64: Buffer.from(stored.data).toString('base64'),
      }
    })),
  })))
}

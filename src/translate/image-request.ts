/**
 * Request-image projection: the downscaled "request version" of an attachment.
 *
 * An attachment is stored at its full normalized size, but a model request does
 * not need those pixels. Every vision provider downscales to its own tile
 * budget anyway, so sending the original only costs upload time, request bytes
 * and context for detail no model reads. A long session makes that worse: the
 * hub replays the whole history on every request, so one Retina screenshot
 * (2880x1800) used to be re-sent at full size on every single turn.
 *
 * The harness already owns the transform — `AttachmentStore.readImageRequest`
 * derives one deterministic request version per (attachment, policy) and caches
 * it, deduplicating concurrent requests for the same version. This module
 * supplies the policy and a graceful fallback for a mounted provider that cannot
 * project: the base `AttachmentStore` deliberately rejects with
 * `ATTACHMENT_PROJECTION_UNSUPPORTED`, and that must degrade to the original
 * bytes rather than fail the turn.
 *
 * Ported from Mars-Sea/dsh-commandcode-provider (MIT) `src/image-request.ts`.
 *
 * @module dsh-subscription-hub/translate/image-request
 */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Long-edge budget for an image sent to a model.
 *
 * 1568 px is Anthropic's documented ceiling and also sits inside the OpenAI and
 * Gemini high-detail tile bands, so no upstream this hub reaches reads more
 * detail than the target keeps. The case this exists for is a Retina
 * screenshot: 2880x1800 becomes 1568x980 — a 3.4x pixel cut — and the model
 * loses nothing it would not have downscaled itself.
 */
export const REQUEST_IMAGE_MAX_LONG_EDGE = 1568

/**
 * Encoded bytes one request image may keep, before base64 expansion.
 *
 * The same 1 MiB budget the harness's own multi-provider adapter defaults to.
 * The attachment service keeps its smallest quality-ladder output when no
 * quality fits, so this bounds bytes without ever refusing an image.
 */
export const REQUEST_IMAGE_MAX_ENCODED_BYTES = 1024 * 1024

/** Projected request geometry for one attachment. */
export interface RequestImagePolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number
  /** Encoded-byte target before base64 expansion. */
  maxBytes: number
}

/**
 * Aspect-preserving projection onto a long-edge budget.
 *
 * Never enlarges (a smaller image keeps its own dimensions) and never returns a
 * zero side: rounding an extreme aspect ratio can produce one, and a 0 would
 * make the encoder refuse the image outright.
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @param longEdge - the long-edge ceiling.
 * @returns the projected dimensions.
 */
export function longEdgeDimensions(width: number, height: number, longEdge: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    // Defensive: a malformed reference must not become a zero-sized target.
    return { width: Math.max(1, Math.round(width) || 1), height: Math.max(1, Math.round(height) || 1) }
  }
  if (longEdge >= Math.max(width, height)) return { width, height }
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round((longEdge * height) / width)) }
    : { width: Math.max(1, Math.round((longEdge * width) / height)), height: longEdge }
}

/**
 * The request policy for one normalized attachment.
 *
 * The pixel budget is derived from the PROJECTED dimensions rather than the
 * source's, so the provider's own pixel projection lands on exactly this
 * geometry instead of re-deriving a slightly different one from the original.
 * @param ref - the durable normalized attachment reference.
 * @returns the policy to hand to `readImageRequest`.
 */
export function requestImagePolicy(ref: Pick<ImageAttachmentRef, 'width' | 'height'>): RequestImagePolicy {
  const projected = longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_LONG_EDGE)
  return {
    maxPixels: projected.width * projected.height,
    maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES,
  }
}

/** One image's bytes as they should travel on a model request. */
export interface RequestImageBytes {
  mediaType: string
  data: Uint8Array
}

/** Whether an attachment failure means "this provider cannot project". */
function isProjectionUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === 'ATTACHMENT_PROJECTION_UNSUPPORTED'
}

/**
 * Read the model-request bytes for one attachment.
 *
 * Prefers the provider's deterministic request version (downscaled to
 * {@link REQUEST_IMAGE_MAX_LONG_EDGE} and bounded by
 * {@link REQUEST_IMAGE_MAX_ENCODED_BYTES}). A provider without projection, or a
 * rejection that says it cannot derive one, falls back to the stored original so
 * the turn still runs — the request is merely larger, which is the pre-existing
 * behaviour rather than a failure.
 * @param store - the mounted attachment service.
 * @param ref - the durable normalized attachment reference.
 * @param signal - optional cancellation.
 * @returns the bytes to send, with the media type the encoder produced.
 */
export async function readRequestImage(
  store: AttachmentStore,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<RequestImageBytes> {
  const project = (store as {
    readImageRequest?: (ref: ImageAttachmentRef, policy: RequestImagePolicy, signal?: AbortSignal) =>
      Promise<{ data: Uint8Array; mediaType: string }>
  }).readImageRequest
  if (typeof project === 'function') {
    try {
      const projected = await project.call(store, ref, requestImagePolicy(ref), signal)
      return { mediaType: projected.mediaType, data: projected.data }
    } catch (error) {
      // A caller cancellation is the caller's, not a reason to re-read.
      signal?.throwIfAborted()
      if (!isProjectionUnsupported(error)) throw error
      // Fall through: this provider has no projection support.
    }
  }
  const stored = await store.readImage(ref, signal)
  return { mediaType: stored.ref.mediaType, data: stored.data }
}
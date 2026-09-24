/**
 * Request-image projection: the geometry and the graceful fallback.
 *
 * The point of the module is that a model request carries the harness's
 * deterministic request version of an image rather than the stored original —
 * and that a provider which cannot derive one degrades to the original instead
 * of failing the turn.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUEST_IMAGE_MAX_ENCODED_BYTES,
  REQUEST_IMAGE_MAX_LONG_EDGE,
  longEdgeDimensions,
  readRequestImage,
  requestImagePolicy,
} from '../src/translate/image-request.js'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

function ref(width: number, height: number): ImageAttachmentRef {
  return { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 1234, width, height } as ImageAttachmentRef
}

/** A minimal store whose readImageRequest behaviour the test controls. */
function store(overrides: {
  request?: (ref: ImageAttachmentRef, policy: unknown, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType: string }>
  stored?: { data: Uint8Array; mediaType: string }
}): AttachmentStore {
  return {
    ...overrides.request === undefined ? {} : { readImageRequest: overrides.request },
    async readImage() {
      const stored = overrides.stored ?? { data: new Uint8Array([9, 9, 9]), mediaType: 'image/png' }
      return { ref: { ...ref(10, 10), mediaType: stored.mediaType }, data: stored.data }
    },
  } as unknown as AttachmentStore
}

test('longEdgeDimensions preserves aspect, never enlarges, never returns zero', () => {
  // The case the module exists for: a Retina screenshot, 3.4x pixel cut.
  assert.deepEqual(longEdgeDimensions(2880, 1800, REQUEST_IMAGE_MAX_LONG_EDGE), { width: 1568, height: 980 })
  // Portrait.
  assert.deepEqual(longEdgeDimensions(1800, 2880, REQUEST_IMAGE_MAX_LONG_EDGE), { width: 980, height: 1568 })
  // Smaller than the budget is returned untouched — never enlarged.
  assert.deepEqual(longEdgeDimensions(800, 600, REQUEST_IMAGE_MAX_LONG_EDGE), { width: 800, height: 600 })
  // Exactly at the budget is untouched.
  assert.deepEqual(longEdgeDimensions(1568, 10, REQUEST_IMAGE_MAX_LONG_EDGE), { width: 1568, height: 10 })
  // An extreme aspect ratio must not round a side to 0.
  const thin = longEdgeDimensions(20000, 3, REQUEST_IMAGE_MAX_LONG_EDGE)
  assert.equal(thin.width, 1568)
  assert.ok(thin.height >= 1)
  // A malformed reference cannot produce a zero-sized target.
  assert.deepEqual(longEdgeDimensions(0, 0, REQUEST_IMAGE_MAX_LONG_EDGE), { width: 1, height: 1 })
  assert.deepEqual(longEdgeDimensions(Number.NaN, 100, REQUEST_IMAGE_MAX_LONG_EDGE), { width: 1, height: 100 })
})

test('requestImagePolicy derives the pixel budget from the PROJECTED dimensions', () => {
  const policy = requestImagePolicy(ref(2880, 1800))
  // 1568 * 980, not 2880 * 1800: the provider's own projection then lands on
  // the same geometry instead of re-deriving a different one.
  assert.equal(policy.maxPixels, 1568 * 980)
  assert.equal(policy.maxBytes, REQUEST_IMAGE_MAX_ENCODED_BYTES)
  // A small image keeps its own area.
  assert.equal(requestImagePolicy(ref(64, 64)).maxPixels, 64 * 64)
})

test('readRequestImage prefers the provider request version', async () => {
  const projected = new Uint8Array([1, 2, 3])
  let seenPolicy: unknown
  const bytes = await readRequestImage(store({
    request: async (_ref, policy) => {
      seenPolicy = policy
      return { data: projected, mediaType: 'image/jpeg' }
    },
  }), ref(2880, 1800))

  assert.deepEqual(bytes.data, projected)
  // The encoder's media type travels, not the stored one (webp may become jpeg).
  assert.equal(bytes.mediaType, 'image/jpeg')
  assert.deepEqual(seenPolicy, { maxPixels: 1568 * 980, width: 1568, height: 980, maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES })
})

test('readRequestImage falls back to the original when the provider cannot project', async () => {
  // The base AttachmentStore rejects with this code.
  const unsupported = Object.assign(new Error('cannot derive model-request images'), {
    code: 'ATTACHMENT_PROJECTION_UNSUPPORTED',
  })
  const original = new Uint8Array([7, 7])
  const bytes = await readRequestImage(store({
    request: async () => { throw unsupported },
    stored: { data: original, mediaType: 'image/png' },
  }), ref(100, 100))

  assert.deepEqual(bytes.data, original)
  assert.equal(bytes.mediaType, 'image/png')
})

test('readRequestImage falls back when the provider has no projection method at all', async () => {
  const original = new Uint8Array([5])
  const bytes = await readRequestImage(
    store({ stored: { data: original, mediaType: 'image/webp' } }),
    ref(100, 100),
  )
  assert.deepEqual(bytes.data, original)
  assert.equal(bytes.mediaType, 'image/webp')
})

test('readRequestImage rethrows a real failure and a caller abort', async () => {
  // A genuine storage fault must not be silently turned into a second read.
  const corrupt = Object.assign(new Error('corrupt'), { code: 'ATTACHMENT_CORRUPT' })
  await assert.rejects(
    readRequestImage(store({ request: async () => { throw corrupt } }), ref(10, 10)),
    (error: unknown) => (error as { code?: string }).code === 'ATTACHMENT_CORRUPT',
  )

  // A caller cancellation is the caller's own, and is surfaced as such.
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    readRequestImage(
      store({ request: async () => { throw unsupportedAbort() } }),
      ref(10, 10),
      controller.signal,
    ),
  )
})

/** The projection rejection, used only to reach the abort branch. */
function unsupportedAbort(): Error {
  return Object.assign(new Error('aborted'), { code: 'ATTACHMENT_PROJECTION_UNSUPPORTED' })
}
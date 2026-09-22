/**
 * The input-modality vocabulary.
 *
 * The harness core declares only `text | image`, and the hub used to fold every
 * upstream value onto one of those two — so a model that accepts a screen
 * recording was indistinguishable from one that accepts a screenshot, and
 * models.dev's `pdf` became `image`. These tests pin the widened vocabulary and
 * the normalization that keeps it honest.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INPUT_MODALITIES,
  isInputModality,
  normalizeInputModality,
  normalizeInputModalities,
} from '../src/providers/modality.js'

test('the vocabulary covers what the upstream catalogs actually disclose', () => {
  // Observed live: Cline's own catalog names text/image/video/audio for
  // xiaomi/mimo-v2.6-flash, and models.dev names text/image/video/pdf for
  // cline-pass/glm-5.3-flash. Every one of those must be nameable here.
  assert.deepEqual([...INPUT_MODALITIES], ['text', 'image', 'video', 'audio', 'file'])
  for (const modality of INPUT_MODALITIES) {
    assert.equal(isInputModality(modality), true, modality)
  }
  // Anything else is not.
  for (const value of ['hologram', '', 'Text', null, 7, undefined]) {
    assert.equal(isInputModality(value), false, String(value))
  }
})

test('a modality is read case- and whitespace-insensitively', () => {
  assert.equal(normalizeInputModality(' image '), 'image')
  assert.equal(normalizeInputModality('VIDEO'), 'video')
  assert.equal(normalizeInputModality('Audio'), 'audio')
})

test('every document-ish spelling folds onto the file modality', () => {
  // These name the same capability. Dropping them would lose it, and mapping
  // them onto `image` (the old behaviour) claimed the model accepts pictures.
  for (const value of ['file', 'pdf', 'document', 'doc', 'PDF']) {
    assert.equal(normalizeInputModality(value), 'file', value)
  }
})

test('an unknown value is undefined rather than a guess', () => {
  for (const value of ['hologram', '', '   ', null, 7, {}, [], undefined]) {
    assert.equal(normalizeInputModality(value), undefined, JSON.stringify(value))
  }
})

test('a list is normalized, deduplicated, and order-preserving', () => {
  assert.deepEqual(normalizeInputModalities(['text', 'image']), ['text', 'image'])
  // Order follows the source, not the vocabulary.
  assert.deepEqual(normalizeInputModalities(['image', 'text']), ['image', 'text'])
  // Aliases fold in place, and the fold can collide with an explicit entry.
  assert.deepEqual(normalizeInputModalities(['pdf', 'file']), ['file'])
  assert.deepEqual(normalizeInputModalities(['text', 'image', 'video', 'audio']), ['text', 'image', 'video', 'audio'])
})

test('an unknown value is DROPPED from a list, not fatal to it', () => {
  // A catalog that starts disclosing a modality this build has never heard of
  // must not take the whole model down: the known modalities are still true, and
  // the request path never consults this list.
  assert.deepEqual(normalizeInputModalities(['text', 'hologram']), ['text'])
  assert.deepEqual(normalizeInputModalities(['hologram', 'image', 'smell']), ['image'])
  // A list of nothing but unknowns has no usable content, so it is undefined —
  // which the callers treat as "undeclared", never as "text only".
  assert.equal(normalizeInputModalities(['hologram']), undefined)
  assert.equal(normalizeInputModalities([]), undefined)
})

/**
 * The `Encode=1` WAF body codec.
 *
 * The encoding is part of the wire contract: a mismatch upstream is rejected
 * with no useful diagnostic, so equivalence is pinned against an independent
 * reference implementation of the algorithm (the character loop it was first
 * ported from, before the byte-table rewrite). The decode direction is the
 * exact inverse derived from that same algorithm, and is pinned by round trip
 * over every length class — the three-chunk rotation behaves differently at
 * each residue of `n % 3`, so a single sample would prove nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qoderDecodeBody, qoderDecodeBodyBuffer, qoderEncodeBody } from '../src/providers/qoder/encoding.js'

const stdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const customAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'

/** The algorithm as first ported from qodercli, kept as the independent oracle. */
function referenceEncode(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  let out = ''
  for (let index = 0; index < n; index++) {
    const character = rearranged[index]
    if (character === undefined) continue
    if (character === '=') out += '$'
    else {
      const position = stdAlphabet.indexOf(character)
      out += position >= 0 ? customAlphabet[position] : character
    }
  }
  return out
}

/** Every length class the rotation distinguishes, plus UTF-8 payloads. */
function cases(): string[] {
  const list: string[] = []
  for (let length = 0; length <= 40; length++) list.push('x'.repeat(length))
  list.push(
    '{"messages":[{"role":"user","content":"你好，世界 🌍"}]}',
    JSON.stringify({ filler: 'A'.repeat(10_000) }),
    JSON.stringify({ filler: '中'.repeat(5_000) }),
    'a',
    'ab',
    'abc',
    'abcd',
    '',
  )
  return list
}

test('the alphabets are both 64 characters, so the table is a total function', () => {
  // A short custom alphabet would leave the table's tail at NUL for the
  // highest Base64 indexes, and the character-loop oracle would then disagree
  // on exactly those characters — silently, since both sides still "work".
  assert.equal(customAlphabet.length, 64)
  assert.equal(stdAlphabet.length, 64)
  assert.equal(new Set(customAlphabet).size, 64)
})

test('qoderEncodeBody encodes ASCII strings deterministically', () => {
  const input = '{"test": "hello world"}'
  const encoded1 = qoderEncodeBody(input)
  const encoded2 = qoderEncodeBody(Buffer.from(input))

  assert.equal(typeof encoded1, 'string')
  assert.equal(encoded1, encoded2)
  assert.ok(encoded1.length > 0)
})

test('qoderEncodeBody handles padding characters correctly', () => {
  const input = 'a' // Base64 is "YQ==", so the pad becomes '$'
  const encoded = qoderEncodeBody(input)
  assert.ok(encoded.includes('$'))
})

test('qoderEncodeBody handles UTF-8 characters correctly', () => {
  const input = '{"message": "你好，世界"}'
  const encoded = qoderEncodeBody(input)
  assert.ok(encoded.length > 0)
  assert.equal(Buffer.from(encoded, 'latin1').length, Buffer.from(input, 'utf8').toString('base64').length)
})

test('qoderEncodeBody matches the character-loop reference on every length class', () => {
  for (const input of cases()) {
    assert.equal(
      qoderEncodeBody(input),
      referenceEncode(input),
      `mismatch for input of length ${input.length}`,
    )
    assert.equal(
      qoderEncodeBody(Buffer.from(input, 'utf8')),
      referenceEncode(Buffer.from(input, 'utf8')),
      `buffer mismatch for input of length ${input.length}`,
    )
  }
})

test('qoderDecodeBody is the exact inverse of qoderEncodeBody', () => {
  for (const input of cases()) {
    assert.equal(qoderDecodeBody(qoderEncodeBody(input)), input, `round trip for length ${input.length}`)
    assert.deepEqual(qoderDecodeBodyBuffer(qoderEncodeBody(Buffer.from(input, 'utf8'))), Buffer.from(input, 'utf8'))
  }
})

test('qoderDecodeBody reverses the chunk rotation rather than the Base64 alone', () => {
  // Plain Base64 of this payload differs from the encoded form, so a decode
  // that skipped the rotation would produce something, but not this.
  const input = '{"a":1,"b":"rotated"}'
  const plain = Buffer.from(input).toString('base64')
  const encoded = qoderEncodeBody(input)
  assert.notEqual(encoded, plain)
  assert.equal(qoderDecodeBody(encoded), input)
  assert.notEqual(qoderDecodeBody(plain), input)
})

test('qoderDecodeBody decodes the catalog envelope shape an encoded response would carry', () => {
  const envelope = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) })
  assert.equal(qoderDecodeBody(qoderEncodeBody(envelope)), envelope)
})

test('qoderEncodeBody stays cheap on a large body (main-thread budget)', () => {
  // A 1 MB body is an ordinary large-context request; the character loop took
  // ~800 ms of blocked event loop on it, the table form is a few milliseconds.
  const body = JSON.stringify({ filler: '中'.repeat(500_000) })
  const started = performance.now()
  const encoded = qoderEncodeBody(body)
  const elapsed = performance.now() - started
  assert.equal(encoded, referenceEncode(body))
  assert.ok(elapsed < 250, `encoding a ${body.length}-char body took ${Math.round(elapsed)}ms`)
})

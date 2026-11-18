/**
 * Antigravity tool-schema folding.
 *
 * This route used to run every schema through an ALLOWLIST, which silently
 * dropped `anyOf`/`oneOf`/`allOf`: a union-typed parameter arrived at the model
 * with no type at all, and `allOf` lost the constraints it merged. The reference
 * (`c621ce2`) replaced rejection with widening, and this route now folds the same
 * way — never narrower than any alternative, because a narrowed branch makes the
 * tool uncallable with the others' values.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { toAgyRequestBody } from '../src/providers/agy/translate.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** Build a request body from one tool schema and read back what was declared. */
function declared(schema: Record<string, unknown>): Record<string, unknown> {
  const messages = [{
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'user' },
  }] as unknown as readonly TranslatableMessage[]
  const body = toAgyRequestBody(
    {
      provider: 'agy',
      model: 'gemini-4-argon-low',
      messages,
      tools: [{ name: 'demo', description: 'demo', parameters: schema }],
    } as never,
    { projectId: 'project-123' },
  ) as unknown as {
    request: { tools: { functionDeclarations: { name: string; parameters: Record<string, unknown> }[] }[] }
  }
  const declarations = body.request.tools[0]?.functionDeclarations ?? []
  return declarations[0]?.parameters ?? {}
}

test('agy schema: two object alternatives keep both property sets and only the shared requirement', () => {
  const parameters = declared({
    type: 'object',
    properties: {
      payload: {
        anyOf: [
          { type: 'object', properties: { kind: { type: 'string', enum: ['a'] }, a: { type: 'string' } }, required: ['kind', 'a'] },
          { type: 'object', properties: { kind: { type: 'string', enum: ['b'] }, b: { type: 'number' } }, required: ['kind', 'b'] },
        ],
      },
    },
  })
  const payload = (parameters.properties as Record<string, Record<string, unknown>>).payload
  assert.equal(payload?.type, 'object', 'the union is folded to an object, not dropped')
  const properties = payload.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(properties).sort(), ['a', 'b', 'kind'])
  assert.deepEqual(payload.required, ['kind'], 'only what every alternative requires stays required')
  // A discriminator both branches constrain keeps its precise choices.
  assert.deepEqual(properties.kind?.enum, ['a', 'b'])
})

test('agy schema: a union of scalars widens to one type, integers and numbers to number', () => {
  assert.equal(declared({ type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'string' }] } } })
    .properties !== undefined, true)
  const single = declared({ type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] } } })
  assert.equal((single.properties as Record<string, Record<string, unknown>>).v?.type, 'string')

  const numeric = declared({ type: 'object', properties: { n: { anyOf: [{ type: 'integer' }, { type: 'number' }] } } })
  assert.equal((numeric.properties as Record<string, Record<string, unknown>>).n?.type, 'number')

  // Heterogeneous alternatives are left unconstrained rather than narrowed to one.
  const mixed = declared({ type: 'object', properties: { m: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } } })
  assert.equal((mixed.properties as Record<string, Record<string, unknown>>).m?.type, undefined)
})

test('agy schema: allOf merges every member', () => {
  const parameters = declared({
    type: 'object',
    properties: {
      both: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
          { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] },
        ],
      },
    },
  })
  const both = (parameters.properties as Record<string, Record<string, unknown>>).both
  assert.equal(both?.type, 'object')
  assert.deepEqual(Object.keys(both.properties as Record<string, unknown>).sort(), ['x', 'y'])
  assert.deepEqual((both.required as string[]).sort(), ['x', 'y'])
})

test('agy schema: a numeric type array widens to number, a mixed one is dropped', () => {
  const numeric = declared({ type: 'object', properties: { n: { type: ['integer', 'number'] } } })
  assert.equal((numeric.properties as Record<string, Record<string, unknown>>).n?.type, 'number')
  const mixed = declared({ type: 'object', properties: { m: { type: ['string', 'boolean'] } } })
  assert.equal((mixed.properties as Record<string, Record<string, unknown>>).m?.type, undefined)
  const nullable = declared({ type: 'object', properties: { s: { type: ['string', 'null'] } } })
  assert.equal((nullable.properties as Record<string, Record<string, unknown>>).s?.type, 'string')
})

/**
 * Kiro's tool-call/tool-result pairing.
 *
 * Reported from real use with three ids at once:
 *
 *   400 TOOL_USE_RESULT_MISMATCH: tool_use ids were found without tool_result
 *   blocks immediately after: glob_2_…, glob_3_…, read_1_…
 *
 * Kiro validates PLACEMENT, not mere presence: each `toolUse` must be answered by a
 * `toolResult` in the very next message. A text-only user message sitting between a
 * call and its results therefore broke the turn, and the old builder happily produced
 * exactly that (it merged results into whatever entry happened to be last).
 *
 * The audit below reproduces Kiro's own rule against the built body, so a regression
 * fails here instead of in a user's session.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKiroRequest } from '../src/providers/kiro/translate.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const TOOLS = [{ name: 'glob', description: 'list files', parameters: { type: 'object', properties: {} } }]
const IDS = ['glob_2_d9fe55d7', 'glob_3_6efffe72', 'read_1_e42c2c55'] as const

const call = (id: string) => ({ type: 'tool-call' as const, id, name: 'glob', arguments: '{"pattern":"*.ts"}' })
const result = (id: string) => ({ type: 'tool-result' as const, toolCallId: id, content: [{ type: 'text' as const, text: `R-${id}` }] })
const user = (content: unknown[], kind = 'user'): TranslatableMessage => ({
  id: `u${Math.random()}`, role: 'user', content, source: { kind },
} as never)
const assistant = (content: unknown[]): TranslatableMessage => ({
  id: `a${Math.random()}`, role: 'assistant', content, source: { kind: 'model' },
} as never)
const text = (value: string) => [{ type: 'text' as const, text: value }]

/** The body's entries in send order, current message included. */
function entriesOf(messages: readonly TranslatableMessage[]): Record<string, unknown>[] {
  const body = buildKiroRequest(
    { provider: 'kiro', model: 'claude-sonnet-5', messages: [], tools: TOOLS } as never,
    messages,
    'claude-sonnet-5',
    '',
  )
  const state = body.conversationState as { history?: Record<string, unknown>[]; currentMessage: { userInputMessage: Record<string, unknown> } }
  return [...(state.history ?? []), { userInputMessage: state.currentMessage.userInputMessage }]
}

/**
 * Kiro's rule: every `toolUse` of an assistant turn is answered in the NEXT entry.
 * @param messages - history to build and inspect.
 * @returns the ids that violate the rule.
 */
function unpaired(messages: readonly TranslatableMessage[]): string[] {
  const entries = entriesOf(messages)
  const offenders: string[] = []
  for (const [index, entry] of entries.entries()) {
    const assistantEntry = entry.assistantResponseMessage as { toolUses?: { toolUseId?: string }[] } | undefined
    if (assistantEntry === undefined) continue
    const uses = (assistantEntry.toolUses ?? []).map(use => use.toolUseId ?? '').filter(id => id !== '')
    if (uses.length === 0) continue
    const next = entries[index + 1]?.userInputMessage as {
      userInputMessageContext?: { toolResults?: { toolUseId?: string }[] }
    } | undefined
    const answered = new Set((next?.userInputMessageContext?.toolResults ?? []).map(row => row.toolUseId ?? ''))
    for (const id of uses) if (!answered.has(id)) offenders.push(id)
  }
  return offenders
}

test('kiro pairing: results in one message directly after the call', () => {
  assert.deepEqual(unpaired([user(text('go')), assistant(IDS.map(call)), user(IDS.map(result))]), [])
})

test('kiro pairing: a text-only message between call and results does not break it', () => {
  // This is the reported failure: the results existed but sat one message too late.
  assert.deepEqual(unpaired([
    user(text('go')),
    assistant(IDS.map(call)),
    user(text('a note in between')),
    user(IDS.map(result)),
  ]), [])
})

test('kiro pairing: results split across several messages are gathered', () => {
  assert.deepEqual(unpaired([
    user(text('go')),
    assistant(IDS.map(call)),
    ...IDS.map(id => user([result(id)])),
  ]), [])
})

test('kiro pairing: two rounds of calls stay paired to their own round', () => {
  assert.deepEqual(unpaired([
    user(text('go')),
    assistant([call(IDS[0])]),
    user([result(IDS[0])]),
    assistant([call(IDS[1]), call(IDS[2])]),
    user(text('another note')),
    user([result(IDS[1]), result(IDS[2])]),
  ]), [])
})

test('kiro pairing: an unanswered call is still answered, with an error result', () => {
  // Dropping the call would rewrite the caller's history; Kiro instead needs a result.
  const entries = entriesOf([user(text('go')), assistant([call(IDS[0])])])
  const carried = entries
    .flatMap(entry => (entry.userInputMessage as { userInputMessageContext?: { toolResults?: { toolUseId?: string; status?: string }[] } } | undefined)
      ?.userInputMessageContext?.toolResults ?? [])
  const forCall = carried.find(row => row.toolUseId === IDS[0])
  assert.equal(forCall?.status, 'error')
  assert.deepEqual(unpaired([user(text('go')), assistant([call(IDS[0])])]), [])
})

test('kiro pairing: hoisting result blocks never swallows conversation text', () => {
  const entries = entriesOf([
    user(text('first question')),
    assistant(IDS.map(call)),
    user(text('note')),
    user(IDS.map(result)),
    user(text('last question')),
  ])
  const spoken = entries
    .map(entry => {
      const assistantEntry = entry.assistantResponseMessage as { content?: unknown } | undefined
      if (assistantEntry !== undefined) return typeof assistantEntry.content === 'string' ? assistantEntry.content : ''
      const content = (entry.userInputMessage as { content?: unknown }).content
      return typeof content === 'string' ? content : ''
    })
    .join('\n')
  for (const sentence of ['first question', 'note', 'last question']) {
    assert.ok(spoken.includes(sentence), `${sentence} survived`)
  }
})

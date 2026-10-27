import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeCodeBuddyText,
  systemAsUser,
  systemKey,
  isCodeBuddyUnapprovedChannelError,
  CODEBUDDY_DEFAULT_SYSTEM_PROMPT,
} from '../src/providers/codebuddy-lib/serialize.js'
import type { WireRequest } from '../src/providers/codebuddy-lib/types.js'

test('sanitizeCodeBuddyText rewords known channel-check trigger strings', () => {
  const input = 'You are an AI agent powered by DeepSeek Harness.\n'
    + 'The DeepSeek Harness implementation checkout is at path.\n'
    + 'Web GUI whose URL the runtime context names. When the user refers to this page\n'
    + 'You are Claude Code, Anthropic\'s official CLI for Claude\n'
    + 'Codex CLI is an open source project led by OpenAI.\n'
    + 'Main branch (you will usually use this for PRs)\n'
    + 'x-anthropic-billing-header: test\n'
    + 'Normal text here.'

  const sanitized = sanitizeCodeBuddyText(input)
  assert.ok(!sanitized.includes('powered by DeepSeek Harness'))
  assert.ok(sanitized.includes('You are an AI agent that helps the user with programming tasks.'))
  assert.ok(sanitized.includes('The harness implementation checkout'))
  assert.ok(sanitized.includes('Web GUI whose URL the runtime context names. The interface, when the user refers'))
  assert.ok(sanitized.includes("You are Claude Code, Anthropic's CLI for Claude"))
  assert.ok(sanitized.includes('The Codex CLI is an open source project led by OpenAI.'))
  assert.ok(sanitized.includes('Main branch (usually the base for PRs)'))
  assert.ok(!sanitized.includes('x-anthropic-billing-header'))
  assert.ok(sanitized.includes('Normal text here.'))
})

test('isCodeBuddyUnapprovedChannelError identifies 11128 error responses', () => {
  assert.equal(isCodeBuddyUnapprovedChannelError('{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}'), true)
  assert.equal(isCodeBuddyUnapprovedChannelError('unapproved channel'), true)
  assert.equal(isCodeBuddyUnapprovedChannelError('illegal api invocation'), true)
  assert.equal(isCodeBuddyUnapprovedChannelError('{"code":10085,"msg":"Invalid request"}'), false)
})

test('systemAsUser relocates system prompt to user message under <instructions>', () => {
  const req: WireRequest = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'Custom system instructions here.' },
      { role: 'user', content: 'Please write a poem.' },
    ],
    stream: true,
  }

  const transformed = systemAsUser(req)
  assert.equal(transformed.messages.length, 2)
  assert.equal(transformed.messages[0]?.role, 'system')
  assert.equal(transformed.messages[0]?.content, CODEBUDDY_DEFAULT_SYSTEM_PROMPT)
  assert.equal(transformed.messages[1]?.role, 'user')
  assert.ok(transformed.messages[1]?.content.startsWith('<instructions>\nCustom system instructions here.\n</instructions>\n\nPlease write a poem.'))
})

test('systemAsUser creates user message if only system message exists', () => {
  const req: WireRequest = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'System only.' },
    ],
    stream: true,
  }

  const transformed = systemAsUser(req)
  assert.equal(transformed.messages.length, 2)
  assert.equal(transformed.messages[0]?.role, 'system')
  assert.equal(transformed.messages[0]?.content, CODEBUDDY_DEFAULT_SYSTEM_PROMPT)
  assert.equal(transformed.messages[1]?.role, 'user')
  assert.equal(transformed.messages[1]?.content, '<instructions>\nSystem only.\n</instructions>')
})

test('systemKey returns clean trimmed key or empty string for default', () => {
  assert.equal(systemKey([{ role: 'system', content: CODEBUDDY_DEFAULT_SYSTEM_PROMPT }]), '')
  assert.equal(systemKey([{ role: 'system', content: '  custom sys  ' }]), 'custom sys')
  assert.equal(systemKey([{ role: 'user', content: 'hello' }]), '')
})

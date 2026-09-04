/**
 * Runtime detection of the locally installed Claude Code CLI version and
 * beta flags.  Exercises both the happy path (claude binary on $PATH) and
 * the fallback path (binary absent or broken).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectClaudeVersion,
  CLAUDE_CLI_FALLBACK_VERSION,
  CLAUDE_BETA_FALLBACK,
} from '../src/providers/claude.js'

// ---------------------------------------------------------------------------
// detectClaudeVersion
// ---------------------------------------------------------------------------

test('detectClaudeVersion returns a semver-shaped string', () => {
  const version = detectClaudeVersion()
  assert.match(version, /^\d+\.\d+\.\d+$/, `expected semver, got "${version}"`)
})

test('detectClaudeVersion fallback is a valid semver', () => {
  assert.match(CLAUDE_CLI_FALLBACK_VERSION, /^\d+\.\d+\.\d+$/)
})

test('detectClaudeVersion returns the fallback when claude is not in PATH', () => {
  // Temporarily break PATH so `claude` cannot be found.
  const original = process.env.PATH
  try {
    process.env.PATH = ''
    const version = detectClaudeVersion()
    assert.equal(version, CLAUDE_CLI_FALLBACK_VERSION)
  } finally {
    process.env.PATH = original
  }
})

// ---------------------------------------------------------------------------
// CLAUDE_BETA_FALLBACK
// ---------------------------------------------------------------------------

const EXPECTED_FLAGS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'effort-2025-11-24',
  'compact-2026-01-12',
  'files-api-2025-04-14',
]

test('CLAUDE_BETA_FALLBACK is a well-formed comma-separated flag list', () => {
  assert.ok(CLAUDE_BETA_FALLBACK.length > 0, 'must not be empty')
  assert.ok(!CLAUDE_BETA_FALLBACK.startsWith(',') && !CLAUDE_BETA_FALLBACK.endsWith(','), 'no leading/trailing commas')
  for (const flag of CLAUDE_BETA_FALLBACK.split(',')) {
    // Dates appear both dashed (oauth-2025-04-20) and compact (claude-code-20250219).
    assert.match(flag, /^[a-z][\w-]+-\d{4}-?\d{2}-?\d{2}$/, `malformed flag: "${flag}"`)
  }
})

test('CLAUDE_BETA_FALLBACK contains exactly the live-verified flag set', () => {
  const flags = CLAUDE_BETA_FALLBACK.split(',')
  for (const expected of EXPECTED_FLAGS) {
    assert.ok(flags.includes(expected), `missing expected flag: ${expected}`)
  }
  assert.equal(flags.length, EXPECTED_FLAGS.length, `expected ${EXPECTED_FLAGS.length} flags, got ${flags.length}`)
})

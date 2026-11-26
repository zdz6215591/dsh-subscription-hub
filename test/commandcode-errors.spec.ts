/**
 * Command Code error classification.
 *
 * A 403 from this vendor is NOT one thing. Measured on one live Go-plan key:
 *
 *   403 MODEL_NOT_IN_PLAN     → the model is not in the plan (GOAT and above)
 *   403 upgrade_required      → the CLI version presented is too old (minVersion given)
 *   403 permission_error      → "Go plans use the Provider API with credits"
 *   401/403 otherwise         → the credential really is refused
 *
 * Reporting all of them as "API key invalid" sent a user chasing a credential
 * problem three times for three different, actionable causes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCommandCodeFailure } from '../src/providers/commandcode.js'

test('commandcode: an out-of-plan model names the plan, not the key', () => {
  const verdict = classifyCommandCodeFailure(
    403,
    '{"success":false,"error":{"code":"FORBIDDEN","status":403,"message":"MODEL_NOT_IN_PLAN: Claude Sonnet 5.5 available in GOAT and above plans or extra on demand usage"}}',
    'claude-sonnet-5-5',
    'cli',
  )
  assert.equal(verdict.code, 'INVALID_REQUEST')
  assert.match(verdict.message, /not in this account's plan/)
  assert.match(verdict.message, /claude-sonnet-5-5/)
})

test('commandcode: an old CLI is named with the version it demands', () => {
  const verdict = classifyCommandCodeFailure(
    403,
    '{"error":{"code":"upgrade_required","message":"Your Command Code CLI is out of date.","minVersion":"0.18.10"}}',
    'claude-sonnet-5-5',
    'cli',
  )
  assert.equal(verdict.code, 'INVALID_REQUEST')
  assert.match(verdict.message, /requires a newer CLI \(>= 0\.18\.10\)/)
  assert.match(verdict.message, /commandCodeCliVersion/)
})

test('commandcode: a Go plan\u2019s Provider-API refusal is not a credential problem', () => {
  const verdict = classifyCommandCodeFailure(
    403,
    '{"type":"error","error":{"type":"permission_error","message":"Go plans use the Provider API with credits. Add credits or upgrade to GOAT."}}',
    'claude-sonnet-5-5',
    'messages',
  )
  assert.equal(verdict.code, 'INVALID_REQUEST')
  assert.match(verdict.message, /Go plan cannot use the Provider API \(messages\)/)
})

test('commandcode: a bare 401/403 stays a credential problem', () => {
  const unauthorized = classifyCommandCodeFailure(401, '{"error":{"message":"unauthorized"}}', 'm', 'provider')
  assert.equal(unauthorized.code, undefined, 'no override: the caller uses the shared mapping')
  const forbidden = classifyCommandCodeFailure(403, '{"error":{"message":"forbidden"}}', 'm', 'provider')
  assert.equal(forbidden.code, undefined)
})

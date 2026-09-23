/**
 * Config-level invariants.
 *
 * The bug these exist for: `Config.providers` carried a LITERAL array of the
 * provider ids as its schemastery default. Schemastery injects a declared default
 * whenever the field is omitted, so that literal — not `PROVIDER_IDS` — was the
 * route list for every user who never set `providers` explicitly, and the
 * `config.providers ?? [...PROVIDER_IDS]` fallback at the use site could never
 * fire. Adding a route therefore required editing the id union, the schema, the
 * switch, the catalogs, the client tables AND that array; forgetting the last one
 * produced a route that was fully implemented and never registered, whose only
 * symptom was an empty model list with no error anywhere.
 *
 * The real fix is that the default is now DERIVED. These tests pin that, so a
 * future literal cannot reintroduce it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_IDS } from '../src/auth/store.js'
import { Config } from '../src/index.js'

/** Resolve the schema's defaults the way the host does for an empty config. */
function resolvedDefaults(): { providers: string[] } {
  return Config({}) as { providers: string[] }
}

test('the default provider list is DERIVED from PROVIDER_IDS, so no route is dropped', () => {
  const resolved = resolvedDefaults()
  // THE regression: `qoder` was registered everywhere except this literal, so the
  // route was fully implemented and never registered.
  assert.deepEqual([...resolved.providers].sort(), [...PROVIDER_IDS].sort())
  assert.ok(resolved.providers.includes('qoder'), resolved.providers.join(', '))
})

test('every provider id in PROVIDER_IDS is served by default', () => {
  const resolved = resolvedDefaults()
  const missing = PROVIDER_IDS.filter(id => !resolved.providers.includes(id))
  // A route absent here is advertised by the UI (its card renders from
  // PROVIDER_IDS) while its adapter never registers — "connected, no models".
  assert.deepEqual(missing, [], `routes present in PROVIDER_IDS but not served by default: ${missing.join(', ')}`)
})

test('the default list has no duplicates and no unknown ids', () => {
  const resolved = resolvedDefaults()
  assert.equal(new Set(resolved.providers).size, resolved.providers.length, 'duplicate provider id')
  const unknown = resolved.providers.filter(id => !(PROVIDER_IDS as readonly string[]).includes(id))
  assert.deepEqual(unknown, [])
})

test('an explicit providers list still wins over the default', () => {
  // The default must not override a real choice; a user who serves only two
  // routes must keep getting only those two.
  const explicit = Config({ providers: ['codex', 'qoder'] }) as { providers: string[] }
  assert.deepEqual(explicit.providers, ['codex', 'qoder'])
})
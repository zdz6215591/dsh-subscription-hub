/**
 * Antigravity host fallback.
 *
 * The daily canary and production answer DIFFERENTLY for the same request: on a
 * live account the canary returned `400 FAILED_PRECONDITION "User location is not
 * supported for the API use"` while production returned
 * `429 RESOURCE_EXHAUSTED` — it accepted the request. The walk used to skip 429
 * (as "wrong host") and return the canary's location refusal, so the user was told
 * their account was region-locked when it was really out of quota.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGY_ENDPOINT_DAILY,
  AGY_ENDPOINT_PROD,
  fetchAgyFirstOk,
  isAgyUnusableEndpoint,
} from '../src/providers/agy/constants.js'

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const LOCATION = { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } }
const QUOTA = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }

test('agy fallback: a location refusal is a host problem, a quota answer is the account\u2019s', async () => {
  assert.equal(await isAgyUnusableEndpoint(json(400, LOCATION)), true, 'the canary refusing a location must not end the walk')
  assert.equal(await isAgyUnusableEndpoint(json(429, QUOTA)), false, '429 is the account\u2019s real state, not a wrong host')
  assert.equal(await isAgyUnusableEndpoint(json(403, {})), true)
  assert.equal(await isAgyUnusableEndpoint(json(400, { error: { message: 'API key is invalid' } })), true)
})

test('agy fallback: production\u2019s quota answer wins over the canary\u2019s location refusal', async () => {
  const seen: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.startsWith(AGY_ENDPOINT_DAILY)) return json(400, LOCATION)
    if (url.startsWith(AGY_ENDPOINT_PROD)) return json(429, QUOTA)
    return json(400, {})
  }) as unknown as typeof fetch

  const response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', { method: 'POST' }, fetchImpl)
  assert.equal(response.status, 429, 'the caller must see quota exhaustion, not "location not supported"')
  assert.equal(seen[0]?.startsWith(AGY_ENDPOINT_DAILY), true)
  assert.equal(seen[1]?.startsWith(AGY_ENDPOINT_PROD), true)
})

test('agy fallback: the first success short-circuits the walk', async () => {
  const seen: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seen.push(String(input))
    return json(200, { ok: true })
  }) as unknown as typeof fetch
  const response = await fetchAgyFirstOk('/x', {}, fetchImpl)
  assert.equal(response.status, 200)
  assert.equal(seen.length, 1, 'no other host is asked once one answers')
})

test('agy fallback: when every host refuses by location, that refusal is still reported', async () => {
  const fetchImpl = (async () => json(400, LOCATION)) as unknown as typeof fetch
  const response = await fetchAgyFirstOk('/x', {}, fetchImpl)
  assert.equal(response.status, 400)
  assert.match(await response.clone().text(), /User location is not supported/)
})

/**
 * The COSY signature header set, and the machine fingerprint it carries.
 *
 * Every header here is load-bearing: the gateway validates the signature over
 * the wrapped AES key, the timestamp, the encoded body and the signed path, so
 * a change to any one of them fails the request with an indistinguishable 401.
 * The machine id is the only field that must remain STABLE across restarts —
 * a fresh value each launch reads upstream as a new device.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { buildAuthHeaders, computeSigPath, qoderClientType, qoderDesktopClientType, qoderIdeVersion } from '../src/providers/qoder/cosy.js'
import { getQoderChatUrl, getQoderModelListUrl } from '../src/providers/qoder/region.js'
import { getMachineId, qoderMachineIdPath } from '../src/providers/qoder/machine-id.js'

const credentials = {
  userID: 'user-123',
  authToken: 'jt-token',
  name: 'User',
  email: 'user@example.com',
  machineID: 'machine-123',
}

test('computeSigPath strips the /algo prefix', () => {
  assert.equal(computeSigPath('https://api3.qoder.sh/algo/api/v2/service'), '/api/v2/service')
})

test('the hard-coded client identity matches the reference', () => {
  // These are gated on upstream; "modernizing" them changes behavior, not just
  // metadata. `10` is the desktop identifier the campaign endpoints require —
  // the generic `5` makes them answer 200 with an empty list forever.
  assert.equal(qoderIdeVersion, '1.1.47')
  assert.equal(qoderClientType, '5')
  assert.equal(qoderDesktopClientType, '10')
})

test('getMachineId accepts an isolated storage location', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'qoder-machine-')), 'machine_id')
  const machineId = getMachineId([path])
  assert.ok(machineId.length > 0)
  assert.equal(getMachineId([path]), machineId)
  assert.equal(readFileSync(path, 'utf8'), machineId)
  // A second probe list that lost the first entry still finds the created id.
  assert.equal(getMachineId([join(tmpdir(), 'qoder-absent'), path]), machineId)
})

test('getMachineId prefers an existing Qoder-owned id over creating one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-machine-src-'))
  const owned = join(dir, 'owned')
  const fallback = join(dir, 'fallback')
  writeFileSync(owned, 'qoder-owned-id\n')
  assert.equal(getMachineId([owned, fallback]), 'qoder-owned-id')
})

test('the DSH-owned machine id lives under the hub state directory', () => {
  assert.ok(qoderMachineIdPath().includes('subscriptions'), qoderMachineIdPath())
  assert.ok(qoderMachineIdPath().endsWith('qoder-machine-id'), qoderMachineIdPath())
})

test('buildAuthHeaders creates the required bounded COSY headers', () => {
  const body = Buffer.from('encoded-body')
  const headers = buildAuthHeaders(body, getQoderChatUrl(), credentials)
  assert.ok(headers.Authorization!.startsWith('Bearer COSY.'))
  assert.equal(headers['Cosy-User'], 'user-123')
  assert.equal(headers['Cosy-Bodylength'], String(body.length))
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/service/pro/sse/agent_chat_generation')
  assert.equal(headers['Cosy-Machineid'], 'machine-123')
  assert.equal(headers['Cosy-Machinetoken'], 'machine-123')
  assert.equal(headers['Cosy-Clienttype'], '5')
  assert.equal(headers['Cosy-Version'], '1.1.47')
  assert.equal(headers['Login-Version'], 'v2')
  assert.equal(headers['Cosy-Clientip'], '127.0.0.1')
  assert.ok(headers['Cosy-Key']!.length > 0)
  assert.match(headers['Cosy-Date']!, /^\d+$/u)
  assert.match(headers['Cosy-Bodyhash']!, /^[a-f0-9]{32}$/u)
  assert.match(headers['X-Request-Id']!, /^[0-9a-f-]{36}$/u)
})

test('the signature input covers the wrapped key, the timestamp, the body and the path', () => {
  const body = Buffer.from('{"encoded":true}')
  const url = getQoderModelListUrl()
  const headers = buildAuthHeaders(body, url, credentials)
  const parts = headers.Authorization!.split('.')
  assert.equal(parts.length, 3)
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf8')) as Record<string, unknown>
  assert.equal(payload.version, 'v1')
  assert.equal(payload.cosyVersion, '1.1.47')
  // The AES material is base64 of the RSA-wrapped AES key, and `info` is the
  // identity encrypted under it — neither is the credential in clear text.
  assert.ok(typeof payload.info === 'string' && payload.info.length > 0)
  assert.ok(!String(payload.info).includes('jt-token'))
  assert.equal(headers['Cosy-Key'], headers['Cosy-Key'])
  assert.match(parts[2]!, /^[a-f0-9]{32}$/u)

  // The same body signed twice yields different signatures (fresh AES key,
  // timestamp and request id), which is what makes replay non-trivial.
  const again = buildAuthHeaders(body, url, credentials)
  assert.notEqual(again.Authorization, headers.Authorization)
  assert.notEqual(again['Cosy-Key'], headers['Cosy-Key'])
})

test('a body-less request signs an empty body and reports length 0', () => {
  const headers = buildAuthHeaders(null, getQoderModelListUrl(), credentials)
  assert.equal(headers['Cosy-Bodylength'], '0')
  assert.equal(headers['Cosy-Bodyhash'], 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/model/list')
})

test('buildAuthHeaders refuses a request with no identity to sign', () => {
  const noUser = { ...credentials, userID: '' }
  assert.throws(() => buildAuthHeaders(null, getQoderChatUrl(), noUser), /user id is empty/u)
  const noToken = { ...credentials, authToken: '' }
  assert.throws(() => buildAuthHeaders(null, getQoderChatUrl(), noToken), /auth token is empty/u)
})

test('buildAuthHeaders resolves the machine id when the credential carries none', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'qoder-machine-hdr-')), 'machine_id')
  const { machineID: _omitted, ...withoutMachine } = credentials
  const headers = buildAuthHeaders(null, getQoderChatUrl(), { ...withoutMachine, machineID: getMachineId([path]) })
  assert.equal(headers['Cosy-Machineid'], getMachineId([path]))
})

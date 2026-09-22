/**
 * Trae device identity (F6).
 *
 * The plugin used to fabricate both device headers from one `randomUUID()` per
 * process: a brand-new "device" on every restart, with `x-machine-id` and
 * `x-device-id` carrying the SAME string, at the wrong length. These tests pin
 * the real contract, including against this machine's actual Trae install when
 * one is present.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  deriveTraeIdentity,
  deviceCenterIdFrom,
  deviceTypeFor,
  looksLikeMachineId,
  osVersionFor,
  readTraeIdentity,
  traeIdentityFor,
  traeIdentityPaths,
  resetTraeIdentityCache,
} from '../src/providers/trae/identity.js'
import { traeHeaders } from '../src/providers/trae/protocol.js'

/** The values a real CN install was observed to hold. */
const REAL_MACHINE_ID = '11b2ff2c4fdd110f47f785122ab3940d7f256528bc9388cf7431d706dea83423'
const REAL_DEVICE_ID = '2556824262025977'

/** The env a fake install needs: both roam and local roots point at the scratch tree. */
function fakeEnv(root: string): NodeJS.ProcessEnv {
  return { APPDATA: root, LOCALAPPDATA: root }
}

/** Build a fake install tree with the app's own file layout. */
function fakeInstall(root: string, edition: 'cn' | 'solo', storage: Record<string, unknown>, appVersion?: string): void {
  const appName = edition === 'solo' ? 'TRAE SOLO CN' : 'Trae CN'
  const appRoot = join(root, appName)
  const storageDir = join(appRoot, 'User', 'globalStorage')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'storage.json'), JSON.stringify(storage), 'utf8')
  if (appVersion !== undefined) {
    // The Windows layout the reader expects: %LOCALAPPDATA%\Programs\<App>\resources\app\product.json
    const productDir = join(root, 'Programs', appName, 'resources', 'app')
    mkdirSync(productDir, { recursive: true })
    writeFileSync(join(productDir, 'product.json'), JSON.stringify({ appVersion }), 'utf8')
  }
}

test('the icube-dc device id is found by prefix because its key carries the value', () => {
  assert.equal(deviceCenterIdFrom({ 'iCubeAuthInfo://icube-dc:2556824262025977': 'x' }), REAL_DEVICE_ID)
  // The id differs per install, so a different key yields a different id.
  assert.equal(deviceCenterIdFrom({ 'iCubeAuthInfo://icube-dc:999': 'x' }), '999')
  // Absent, or present but empty, is undefined — never a fallback here.
  assert.equal(deviceCenterIdFrom({}), undefined)
  assert.equal(deviceCenterIdFrom({ 'iCubeAuthInfo://icube-dc:': 'x' }), undefined)
})

test('osVersion and deviceType match what the client reports', () => {
  // The shape bug was `win32 <hostname>`: platform NAME plus release, never a hostname.
  assert.equal(osVersionFor('win32', '10.0.26100'), 'Windows 10.0.26100')
  assert.equal(osVersionFor('darwin', '24.0.0'), 'macOS 24.0.0')
  assert.equal(osVersionFor('linux', '6.9.0'), 'linux 6.9.0')
  assert.equal(deviceTypeFor('darwin'), 'mac')
  assert.equal(deviceTypeFor('win32'), 'windows')
  assert.equal(deviceTypeFor('linux'), 'linux')
})

test('a real install is read for every field', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trae-id-'))
  try {
    fakeInstall(root, 'cn', {
      'telemetry.machineId': REAL_MACHINE_ID,
      'telemetry.devDeviceId': '307222b6-9927-47e8-864a-2bfce0314a01',
      'iCubeAuthInfo://icube-dc:2556824262025977': 'opaque',
      iCubeLastVersion: '2.3.86566',
    }, '3.3.103')
    const identity = await readTraeIdentity('cn', { platform: 'win32', home: root, env: fakeEnv(root) })
    assert.ok(identity !== undefined)
    assert.equal(identity.machineId, REAL_MACHINE_ID)
    // The icube-dc suffix wins over telemetry.devDeviceId.
    assert.equal(identity.deviceId, REAL_DEVICE_ID)
    assert.equal(identity.appVersion, '3.3.103')
    assert.equal(identity.buildVersion, '2.3.86566')
    assert.equal(identity.source, 'install')
    assert.match(identity.osVersion, /^Windows /)
    // The two headers must no longer be the same value.
    assert.notEqual(identity.machineId, identity.deviceId)
    assert.equal(looksLikeMachineId(identity.machineId), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the machineid file is the fallback when telemetry has no machine id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trae-id-'))
  try {
    fakeInstall(root, 'cn', { 'iCubeAuthInfo://icube-dc:777': 'x' })
    writeFileSync(join(root, 'Trae CN', 'machineid'), '4992f64d-342c-4d95-9d8c-3b37587ba05b\n', 'utf8')
    const identity = await readTraeIdentity('cn', { platform: 'win32', home: root, env: fakeEnv(root) })
    assert.equal(identity?.machineId, '4992f64d-342c-4d95-9d8c-3b37587ba05b')
    // The icube-dc suffix is the device id whenever it is present: it is the
    // value the official CN chat logs carry.
    assert.equal(identity?.deviceId, '777')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('with neither icube-dc nor devDeviceId the device id is derived, not left off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trae-id-'))
  try {
    fakeInstall(root, 'cn', { 'telemetry.machineId': REAL_MACHINE_ID })
    const identity = await readTraeIdentity('cn', { platform: 'win32', home: root, env: fakeEnv(root) })
    assert.equal(identity?.machineId, REAL_MACHINE_ID)
    // A real 32-char derived value, so no request ever goes out without one.
    assert.equal(identity?.deviceId.length, 32)
    assert.notEqual(identity?.deviceId, identity?.machineId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no install is undefined, never an invented device', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trae-id-'))
  try {
    assert.equal(await readTraeIdentity('cn', { platform: 'win32', home: root, env: fakeEnv(root) }), undefined)
    // A storage file with no usable id is also undefined.
    fakeInstall(root, 'cn', { 'iCubeAuthInfo://icube-dc:5': 'x' })
    assert.equal(await readTraeIdentity('cn', { platform: 'win32', home: root, env: fakeEnv(root) }), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the derived identity is STABLE per account and distinct across accounts', () => {
  // This is the whole point: the old value was a fresh random per process, so a
  // restart presented a brand-new device.
  const first = deriveTraeIdentity('user-1')
  const again = deriveTraeIdentity('user-1')
  const other = deriveTraeIdentity('user-2')
  assert.deepEqual(first, again)
  assert.notEqual(first.machineId, other.machineId)
  // Correct shape: a 64-char machine id, a 32-char device id, and not the same.
  assert.equal(looksLikeMachineId(first.machineId), true)
  assert.equal(first.deviceId.length, 32)
  assert.notEqual(first.machineId, first.deviceId)
  assert.equal(first.source, 'derived')
})

test('traeHeaders carries the resolved identity, not a per-process random', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trae-id-'))
  try {
    const identity = deriveTraeIdentity('acct', 'win32', '10.0.26100')
    const headers = traeHeaders('tok', 'uid-1', identity)
    assert.equal(headers['x-machine-id'], identity.machineId)
    assert.equal(headers['x-device-id'], identity.deviceId)
    assert.notEqual(headers['x-machine-id'], headers['x-device-id'])
    assert.equal(headers['x-os-version'], 'Windows 10.0.26100')
    assert.equal(headers['x-device-type'], 'windows')
    // Two calls differ only in their per-request ids, never in the device.
    const second = traeHeaders('tok', 'uid-1', identity)
    assert.equal(second['x-machine-id'], headers['x-machine-id'])
    assert.notEqual(second['x-request-id'], headers['x-request-id'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('traeIdentityFor prefers the install and falls back to the account', async () => {
  resetTraeIdentityCache()
  // Whatever this machine has, the result is always a usable identity pair.
  const identity = await traeIdentityFor('cn', 'some-account')
  assert.ok(looksLikeMachineId(identity.machineId))
  assert.ok(identity.deviceId.length > 0)
  assert.notEqual(identity.machineId, identity.deviceId)
  // And it is stable when asked twice.
  const again = await traeIdentityFor('cn', 'some-account')
  assert.deepEqual(again, identity)
})

test('this machine\'s real Trae install, when present, is read correctly', async (t) => {
  // A live check against the actual install: skipped rather than faked when the
  // machine has none, so the suite stays honest about what it verified.
  const paths = traeIdentityPaths('cn')
  if (!existsSync(paths.storage)) {
    t.skip(`no Trae CN install at ${paths.storage}`)
    return
  }
  const identity = await readTraeIdentity('cn')
  assert.ok(identity !== undefined, 'a real install must yield an identity')
  assert.equal(identity.source, 'install')
  // Telemetry machine ids are 64 hex chars; the observed install matches.
  assert.equal(looksLikeMachineId(identity.machineId), true, `machineId=${identity.machineId}`)
  assert.notEqual(identity.machineId, identity.deviceId)
  // The app version comes from product.json, not the pinned constant.
  assert.ok(identity.appVersion !== undefined, 'product.json must supply appVersion')
  console.log(`    verified live: machineId=${identity.machineId.slice(0, 12)}… deviceId=${identity.deviceId} appVersion=${identity.appVersion} build=${identity.buildVersion ?? '-'}`)
})
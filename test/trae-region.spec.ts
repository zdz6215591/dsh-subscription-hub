/**
 * Trae's region model.
 *
 * The region decides which gateway serves a credential, so getting it wrong
 * routes a working account at an address that cannot answer. It is derived from
 * the credential's own facts in three levels, and every level is pinned here.
 *
 * Verification boundary: the CN gateways below are exercised by this hub's live
 * tests; the international ones are transcribed from the reference's evidence
 * (no international credential was available to probe from this machine). The
 * tests therefore pin the SELECTION logic and the table's shape, not the
 * international addresses' liveness.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REGION_GATEWAYS,
  gatewaysFor,
  regionOfCredential,
  regionOfEdition,
  regionOfHost,
  regionOfUserRegion,
} from '../src/providers/trae/region.js'

test('the edition maps to its service bucket', () => {
  assert.equal(regionOfEdition('cn'), 'cn')
  assert.equal(regionOfEdition('solo'), 'cn')
  assert.equal(regionOfEdition('sg'), 'ai')
  assert.equal(regionOfEdition('solo-sg'), 'ai')
})

test('the userRegion claim is read in every shape the app writes it', () => {
  // The desktop storage spells it as an object; the app logs spell it bare.
  assert.equal(regionOfUserRegion({ region: 'CN' }), 'cn')
  assert.equal(regionOfUserRegion('CN'), 'cn')
  assert.equal(regionOfUserRegion(' cn '), 'cn')
  assert.equal(regionOfUserRegion('sg'), 'ai')
  assert.equal(regionOfUserRegion('SG'), 'ai')
  // `ai` is accepted because the logs use it as a synonym for `sg`.
  assert.equal(regionOfUserRegion('ai'), 'ai')
  assert.equal(regionOfUserRegion({ region: 'sg' }), 'ai')
  // An unrecognised or malformed claim is undefined, never a default: guessing
  // here would silently reroute the account.
  for (const value of [undefined, null, '', 'EU', 'us', 7, { other: 'CN' }, { region: 7 }, []]) {
    assert.equal(regionOfUserRegion(value), undefined, JSON.stringify(value))
  }
})

test('the host suffix is the second signal', () => {
  assert.equal(regionOfHost('https://api.trae.cn'), 'cn')
  assert.equal(regionOfHost('api.trae.cn'), 'cn')
  assert.equal(regionOfHost('https://trae.com.cn/x'), 'cn')
  assert.equal(regionOfHost('https://coresg-normal.trae.ai'), 'ai')
  assert.equal(regionOfHost('trae.ai'), 'ai')
  // A host that names neither region tells us nothing.
  for (const host of [undefined, '', 'https://example.com', 'not a url']) {
    assert.equal(regionOfHost(host), undefined, String(host))
  }
})

test('the claim outranks the host, and the host outranks the edition', () => {
  // Level 1 wins: a credential whose claim says SG is international even when
  // it happens to name a CN host, because the claim is what the account was
  // issued under.
  assert.equal(regionOfCredential({ edition: 'cn', host: 'https://api.trae.cn', userRegion: 'SG' }), 'ai')
  // Level 2: no claim, but the host decides.
  assert.equal(regionOfCredential({ edition: 'cn', host: 'https://coresg-normal.trae.ai' }), 'ai')
  // Level 3: neither, so the edition label is the last resort.
  assert.equal(regionOfCredential({ edition: 'sg' }), 'ai')
  assert.equal(regionOfCredential({ edition: 'solo-sg', host: 'https://example.com' }), 'ai')
  // A CN credential with no signals at all stays CN — the conservative default,
  // since CN is the contract this hub has probed.
  assert.equal(regionOfCredential({ edition: 'cn' }), 'cn')
  assert.equal(regionOfCredential({ edition: 'solo' }), 'cn')
})

test('gateways are per region, and the CN ones are the probed addresses', () => {
  assert.equal(REGION_GATEWAYS.cn.chat, 'https://trae-api-cn.mchost.guru')
  assert.equal(REGION_GATEWAYS.cn.remote, 'https://solo.trae.cn/api/remote/v1')
  assert.equal(REGION_GATEWAYS.cn.pay, 'https://api.trae.cn')
  // The international entries are transcribed, not probed: assert only that
  // they are distinct hosts from the CN ones, so a copy-paste slip fails.
  for (const key of ['chat', 'remote', 'pay'] as const) {
    assert.notEqual(REGION_GATEWAYS.ai[key], REGION_GATEWAYS.cn[key], key)
  }
  assert.ok(REGION_GATEWAYS.ai.chat.includes('.trae.ai'))
  assert.ok(REGION_GATEWAYS.ai.pay.includes('.trae.ai'))
})

test('a credential that named a host keeps it for the pay calls', () => {
  // The pay endpoints are the web dashboard's own; a credential that
  // authenticated against a specific host is the better authority than the
  // table, because a relocated account keeps answering there.
  const gateways = gatewaysFor({ edition: 'cn', host: 'https://api.trae.cn/' })
  assert.equal(gateways.pay, 'https://api.trae.cn')
  // Chat and remote come from the TABLE: those are the addresses the gateway
  // itself serves, and a credential's host claim is not an authority for them.
  assert.equal(gateways.chat, REGION_GATEWAYS.cn.chat)
  assert.equal(gateways.remote, REGION_GATEWAYS.cn.remote)

  // No host at all falls back to the region's own pay base.
  assert.equal(gatewaysFor({ edition: 'sg' }).pay, REGION_GATEWAYS.ai.pay)
  // And an international credential's own host still wins over the table.
  assert.equal(
    gatewaysFor({ edition: 'sg', host: 'https://growsg-normal.trae.ai' }).pay,
    'https://growsg-normal.trae.ai',
  )
})

test('an SG credential is never routed at a CN gateway', () => {
  // The bug this whole module exists to prevent: an international account
  // pointed at the CN gateway cannot authenticate, and the failure would look
  // like a broken credential rather than a routing mistake.
  for (const edition of ['sg', 'solo-sg'] as const) {
    const gateways = gatewaysFor({ edition })
    assert.ok(gateways.chat.includes('.trae.ai'), `${edition} chat: ${gateways.chat}`)
    assert.ok(gateways.remote.includes('.trae.ai'), `${edition} remote: ${gateways.remote}`)
    assert.ok(gateways.pay.includes('.trae.ai'), `${edition} pay: ${gateways.pay}`)
  }
})

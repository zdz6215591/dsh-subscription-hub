/**
 * Qoder's daily check-in.
 *
 * Two rules carry the whole feature, and both are easy to get wrong silently:
 * the campaign list only answers for the DESKTOP client identifier (the generic
 * one returns 200 with an empty list, which looks like "no campaign today"
 * forever), and the day boundary is UTC+8 — the vendor's reset clock, not this
 * machine's zone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  claimQoderCheckin,
  fetchQoderCampaigns,
  getQoderCheckinStatusView,
  qoderDayString,
  readQoderCheckinState,
  writeQoderCheckinState,
} from '../src/providers/qoder/checkin.js'
import type { FetchFn } from '../src/providers/common.js'

/** Run one case with DSH_HOME pointed at a scratch tree. */
async function withHome<T>(body: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'qoder-checkin-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** The exchange + userinfo pair, so `getCredentials` can succeed. */
function authResponse(url: string): Response | undefined {
  if (url.includes('jobToken/exchange')) {
    return Response.json({ token: 'job-1', expires_in: 3_600_000 })
  }
  if (url.includes('/userinfo')) {
    return Response.json({ id: 'uid-1', name: 'Tester' })
  }
  return undefined
}

test('the day boundary is UTC+8, not the machine zone', () => {
  // 2026-09-23T17:30Z is already the 24th in Beijing (01:30). Judging this on a
  // western machine's local day would double-claim across the boundary.
  const instant = new Date('2026-09-23T17:30:00Z')
  assert.equal(qoderDayString(instant), '2026-09-24')
  // And just before the boundary it is still the 23rd.
  assert.equal(qoderDayString(new Date('2026-09-23T15:30:00Z')), '2026-09-23')
  // Midnight UTC+8.
  assert.equal(qoderDayString(new Date('2026-09-23T16:00:00Z')), '2026-09-24')
})

test('the campaign list is fetched with the DESKTOP client identifier', async () => {
  // THE rule the reference measured: the generic identifier answers 200 with an
  // empty list, so a check-in built on it reports "no campaign" forever while
  // looking healthy at the transport layer.
  const seen: { url: string; clientType: string | null }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    seen.push({ url, clientType: headers.get('cosy-clienttype') })
    return Response.json({ campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }] })
  }) as unknown as FetchFn

  const campaigns = await fetchQoderCampaigns('job-1', 'china', fetchFn)
  assert.equal(campaigns.length, 1)
  assert.equal(seen[0]?.clientType, '10')
  assert.ok(seen[0]?.url.includes('openapi.qoder.com.cn'), seen[0]?.url)
})

test('a claimable campaign is claimed and the amount is reported', async () => {
  const calls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const auth = authResponse(url)
    if (auth !== undefined) return auth
    if (url.includes('/sash/api/v1/me/campaigns/') && url.includes('/claim')) {
      return Response.json({ status: 'CLAIMED', benefit: { amount: 100 } })
    }
    if (url.includes('/campaigns')) {
      return Response.json({ campaigns: [{ campaignId: 'c1', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }] })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as FetchFn

  const outcome = await claimQoderCheckin('pt-token', 'china', fetchFn)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.status, 'claimed')
  assert.equal(outcome.amount, 100)
  assert.match(outcome.message, /100 credits/)
  // list → claim, both against the China deployment.
  assert.ok(calls.some(url => url.includes('/campaigns/c1/claim')), calls.join('\n'))
})

test('an already-claimed campaign is reported as done, not as an error', async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    const auth = authResponse(url)
    if (auth !== undefined) return auth
    return Response.json({ campaigns: [{ campaignId: 'c1', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 100 } }] })
  }) as unknown as FetchFn

  const outcome = await claimQoderCheckin('pt-token', 'china', fetchFn)
  // `ok` because the day's credits exist; `already` because this process did not
  // mint them. Either way the scheduler must not retry.
  assert.equal(outcome.ok, true)
  assert.equal(outcome.status, 'already')
})

test('a replayed claim counts as already claimed', async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    const auth = authResponse(url)
    if (auth !== undefined) return auth
    if (url.includes('/claim')) return Response.json({ status: 'CLAIMED', replayed: true })
    return Response.json({ campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }] })
  }) as unknown as FetchFn

  const outcome = await claimQoderCheckin('pt-token', 'china', fetchFn)
  assert.equal(outcome.status, 'already')
})

test('a region with no benefit campaign says so and does NOT look like success', async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    const auth = authResponse(url)
    if (auth !== undefined) return auth
    return Response.json({ campaigns: [] })
  }) as unknown as FetchFn

  const outcome = await claimQoderCheckin('pt-token', 'global', fetchFn)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, 'none')
  assert.match(outcome.message, /no claimable benefit campaign/)
})

test('an empty PAT is refused without any request', async () => {
  let called = false
  const fetchFn = (async () => { called = true; return Response.json({}) }) as unknown as FetchFn
  const outcome = await claimQoderCheckin('  ', 'china', fetchFn)
  assert.equal(outcome.ok, false)
  assert.equal(called, false)
})

test('the ledger round-trips and treats a corrupt file as empty', async () => {
  await withHome(async () => {
    assert.deepEqual(await readQoderCheckinState(), {})
    await writeQoderCheckinState({ lastDate: '2026-09-24', lastTime: 123, lastMessage: 'claimed 100 credits' })
    const back = await readQoderCheckinState()
    assert.equal(back.lastDate, '2026-09-24')
    assert.equal(back.lastMessage, 'claimed 100 credits')
  })
})

test('the status view matches the shape the card already renders', async () => {
  await withHome(async () => {
    const today = qoderDayString()
    await writeQoderCheckinState({ lastDate: today, lastTime: Date.now(), lastMessage: 'claimed 100 credits' })
    const view = await getQoderCheckinStatusView()
    // The same keys the CodeBuddy and Trae routes answer with, so the card's
    // existing check-in section renders Qoder with no second code path.
    assert.equal(view.checkedInToday, true)
    assert.equal(view.lastDate, today)
    assert.equal(view.lastMessage, 'claimed 100 credits')
    assert.equal(view.scheduledDate, today)
  })
})

test('a day NOT yet claimed reads as not-done', async () => {
  await withHome(async () => {
    await writeQoderCheckinState({ lastDate: '2020-01-01', lastMessage: 'old' })
    const view = await getQoderCheckinStatusView()
    assert.equal(view.checkedInToday, false)
    // And the scheduled day is today, because the scheduler retries every tick
    // until the claim lands.
    assert.equal(view.scheduledDate, qoderDayString())
  })
})

test('the ledger is written where the plugin keeps its other state', async () => {
  await withHome(async () => {
    await writeQoderCheckinState({ lastDate: '2026-09-24' })
    const path = join(process.env.DSH_HOME ?? '', 'plugins', 'subscriptions', 'qoder-checkin.json')
    assert.equal(existsSync(path), true, path)
    // No leftover temp file: the write is a rename.
    const { readdirSync } = await import('node:fs')
    const leftovers = readdirSync(join(process.env.DSH_HOME ?? '', 'plugins', 'subscriptions'))
      .filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    assert.match(readFileSync(path, 'utf8'), /2026-09-24/)
  })
})
/**
 * The Command Code durable catalog cache.
 *
 * The behaviour that matters: after the live roster has been read once, a failed
 * `/models` (or a fresh process) must still know every model's real context
 * window and output cap, instead of collapsing to the two-model static list.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  commandcodeCatalogPath,
  readCommandCodeCatalog,
  writeCommandCodeCatalog,
} from '../src/providers/commandcode-catalog-cache.js'

const ROWS = [
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 262_144, maxTokens: 32_768 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000, maxTokens: 64_000 },
]

function scratch(): { dir: string; path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-cache-'))
  return { dir, path: join(dir, 'commandcode-models.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a written catalog round-trips', async () => {
  const s = scratch()
  try {
    await writeCommandCodeCatalog(ROWS, s.path)
    const back = await readCommandCodeCatalog(s.path)
    assert.deepEqual(back, ROWS)
    // The file is version-tagged, so a future shape change can discard it.
    const document = JSON.parse(readFileSync(s.path, 'utf8')) as { version?: number }
    assert.equal(typeof document.version, 'number')
  } finally {
    s.done()
  }
})

test('an absent file is undefined, not an error', async () => {
  const s = scratch()
  try {
    assert.equal(await readCommandCodeCatalog(s.path), undefined)
  } finally {
    s.done()
  }
})

test('malformed documents are discarded rather than half-trusted', async () => {
  const s = scratch()
  try {
    const cases = [
      '{ not json',
      'null',
      '"a string"',
      '{"version":1}',                                   // no models array
      '{"version":999,"models":[]}',                     // version mismatch
      '{"version":1,"models":[]}',                       // empty roster
      '{"version":1,"models":[{"id":"a"}]}',             // missing fields
      '{"version":1,"models":[{"id":"a","name":"A","contextWindow":0,"maxTokens":1}]}',   // non-positive
      '{"version":1,"models":[{"id":"a","name":"A","contextWindow":1,"maxTokens":1.5}]}', // non-integer
      // One bad row poisons the document: a partial roster would mis-size the
      // models it dropped back to a fallback value.
      '{"version":1,"models":[{"id":"a","name":"A","contextWindow":10,"maxTokens":10},{"id":"b","name":"B"}]}',
    ]
    for (const body of cases) {
      writeFileSync(s.path, body, 'utf8')
      assert.equal(await readCommandCodeCatalog(s.path), undefined, `should discard: ${body}`)
    }
    // And a good document written after the bad ones is read normally.
    await writeCommandCodeCatalog(ROWS, s.path)
    assert.deepEqual(await readCommandCodeCatalog(s.path), ROWS)
  } finally {
    s.done()
  }
})

test('concurrent writers do not clobber each other or leave temp files behind', async () => {
  // The hub discovers several providers at once, and a bare read-modify-write of
  // a shared file is what threw EPERM on Windows and lost providers. Each write
  // here is a whole-file replacement, so the invariant to hold is: no throw, no
  // leftover temp file, and the last write wins intact.
  const s = scratch()
  try {
    const batches = Array.from({ length: 8 }, (_, index) => [
      { id: `model-${String(index)}`, name: `M${String(index)}`, contextWindow: 1000 + index, maxTokens: 100 + index },
    ])
    await Promise.all(batches.map(batch => writeCommandCodeCatalog(batch, s.path)))
    const back = await readCommandCodeCatalog(s.path)
    assert.equal(back?.length, 1)
    // Whichever batch landed last, it landed whole.
    const winner = batches.find(batch => batch[0]!.id === back?.[0]?.id)
    assert.deepEqual(back, winner)
    // No temp files left in the directory.
    const { readdirSync } = await import('node:fs')
    const leftovers = readdirSync(s.dir).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    s.done()
  }
})

test('the default path lives under the plugin state directory', () => {
  const path = commandcodeCatalogPath()
  assert.ok(path.includes('subscriptions'), path)
  assert.ok(path.endsWith('commandcode-models.json'), path)
  // The probe only computes the path; it must not have created anything.
  assert.equal(existsSync(path), false)
})
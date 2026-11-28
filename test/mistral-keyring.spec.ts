/**
 * Importing the credential the Vibe CLI provisioned.
 *
 * Mistral's browser sign-in exists only inside that closed-source CLI, and its docs
 * say it stores the result in the OS keyring, falling back to `~/.vibe/.env`. So the
 * import path is: keyring first, env file second — and only a secret that could be
 * sent as a bearer key is accepted.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  importLocalMistralKey,
  looksLikeMistralKey,
  pickMistralKeyFromRows,
  readMistralKeyringKey,
} from '../src/providers/mistral-keyring.js'
import { vibeEnvPath } from '../src/providers/mistral-vibe.js'

const KEY = 'mstrl_v9ybsEgzYt3bFPG74SI3xlFZlI8MqBSD_4Alpho'

test('mistral keyring: a Vibe/Mistral entry is picked, an unrelated one is not', () => {
  const rows = [
    { target: 'LegacyGeneric:target=git:https://github.com', user: 'me', secret: 'not-a-mistral-key-but-long' },
    { target: 'vibe/api-key', user: 'mistral', secret: KEY },
    { target: 'another', user: 'other', secret: 'x' },
  ]
  assert.equal(pickMistralKeyFromRows(rows), KEY)
  assert.equal(pickMistralKeyFromRows([rows[0]!, rows[1]!].slice(0, 1)), undefined)
})

test('mistral keyring: unusable blobs are skipped rather than sent as a bearer', () => {
  assert.equal(looksLikeMistralKey(KEY), true)
  assert.equal(looksLikeMistralKey('short'), false)
  assert.equal(looksLikeMistralKey('has space in it 0123456789'), false)
  assert.equal(looksLikeMistralKey(''), false)
  // A non-key blob under a matching target must not stop the search.
  const rows = [
    { target: 'vibe', user: 'mistral', secret: 'not a key' },
    { target: 'vibe', user: 'mistral', secret: KEY },
  ]
  assert.equal(pickMistralKeyFromRows(rows), KEY)
})

test('mistral keyring: the script output is parsed as one row or many', async () => {
  const single = async (): Promise<string> => JSON.stringify({ target: 'vibe', user: 'mistral', secret: KEY })
  assert.equal(await readMistralKeyringKey(single), KEY)
  const empty = async (): Promise<string> => ''
  assert.equal(await readMistralKeyringKey(empty), undefined)
  const broken = async (): Promise<string> => 'not json'
  assert.equal(await readMistralKeyringKey(broken), undefined)
})

test('mistral keyring: the keyring wins over the env file, and the env file is the fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mistral-import-'))
  try {
    // Nothing anywhere.
    assert.equal(await importLocalMistralKey({ run: async () => '', home }), undefined)
    // Only the env file.
    mkdirSync(join(home, '.vibe'), { recursive: true })
    writeFileSync(vibeEnvPath(home), 'MISTRAL_API_KEY=mstrl_fromenv_0123456789\n')
    const fromEnv = await importLocalMistralKey({ run: async () => '', home })
    assert.equal(fromEnv?.source, 'env')
    assert.equal(fromEnv?.key, 'mstrl_fromenv_0123456789')
    // A keyring entry outranks it, as the CLI's own precedence puts it.
    const fromKeyring = await importLocalMistralKey({
      run: async () => JSON.stringify([{ target: 'vibe/api-key', user: 'mistral', secret: KEY }]),
      home,
    })
    assert.equal(fromKeyring?.source, 'keyring')
    assert.equal(fromKeyring?.key, KEY)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('mistral keyring: a failing runner falls through instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mistral-import-fail-'))
  try {
    const result = await importLocalMistralKey({
      run: async () => { throw new Error('powershell is missing') },
      home,
    })
    assert.equal(result, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

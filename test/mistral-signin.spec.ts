/**
 * One-click sign-in, as observed on the real CLI.
 *
 * Captured by driving `vibe --setup` in a pseudo-terminal (not guessed): it offers
 * "Launch browser / Use an API key", then "Mistral AI / Other", then opens
 *
 *   https://console.mistral.ai/codestral/cli/authenticate?process_id=<uuid>&complete_token=<token>
 *
 * and polls until the page has provisioned the credential, which it stores in the
 * OS keyring (or ~/.vibe/.env). The poll itself lives behind an authenticated
 * `/api` surface that answers 401 to an unauthenticated caller, so this route does
 * not call it: it runs the vendor's setup and adopts what that setup stores.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VIBE_INSTALL_HINT, findVibeCli, runVibeSignIn, vibeCandidates } from '../src/providers/mistral-signin.js'

test('mistral sign-in: the CLI is looked for where uv puts it', () => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-home-'))
  try {
    assert.equal(findVibeCli(home), undefined, 'nothing installed yet')
    const candidate = vibeCandidates(home)[0]
    assert.ok(candidate !== undefined)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(candidate, '')
    assert.equal(findVibeCli(home), candidate)
    assert.equal(existsSync(candidate), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('mistral sign-in: without the CLI the outcome says so instead of spawning', async () => {
  let spawned = 0
  const outcome = await runVibeSignIn({
    home: join(tmpdir(), 'vibe-absent'),
    spawn: () => { spawned++ },
  })
  assert.deepEqual(outcome, { kind: 'no-cli' })
  assert.equal(spawned, 0, 'nothing to start, so nothing is started')
})

test('mistral sign-in: it starts the vendor setup and adopts the credential when it lands', async () => {
  let started: string | undefined
  let polls = 0
  const outcome = await runVibeSignIn({
    home: join(tmpdir(), 'vibe-absent'),
    cliPath: 'C:/fake/vibe.exe',
    spawn: (command, args) => { started = `${command} ${args.join(' ')}` },
    timeoutMs: 1_000,
    intervalMs: 1,
    sleep: async () => {},
    // The credential appears on the third read, as it would once the browser step lands.
    importKey: async () => {
      polls++
      return polls < 3 ? undefined : { key: 'mstrl_live_0123456789', source: 'keyring' }
    },
  })
  assert.equal(started, 'C:/fake/vibe.exe --setup', 'the vendor setup is what runs')
  assert.deepEqual(outcome, { kind: 'found', key: 'mstrl_live_0123456789', source: 'keyring' })
  assert.ok(polls >= 3)
})

test('mistral sign-in: a sign-in that never completes times out rather than hanging', async () => {
  const outcome = await runVibeSignIn({
    home: join(tmpdir(), 'vibe-absent'),
    cliPath: 'C:/fake/vibe.exe',
    spawn: () => {},
    timeoutMs: 30,
    intervalMs: 5,
    sleep: async () => {},
    importKey: async () => undefined,
  })
  assert.deepEqual(outcome, { kind: 'timeout' })
})

test('mistral sign-in: the install hint names a command that exists', () => {
  assert.match(VIBE_INSTALL_HINT, /uv tool install .*mistral-vibe/)
})

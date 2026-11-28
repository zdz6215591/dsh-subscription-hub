/**
 * One-click sign-in: let Mistral's own client do the browser step, then take over.
 *
 * What was established by driving the real CLI (captured, not guessed):
 *
 *   vibe --setup  →  theme → "Choose your sign in method: Launch browser / Use an
 *   API key" → "Where do you sign in: Mistral AI / Other" → it opens
 *
 *     https://console.mistral.ai/codestral/cli/authenticate
 *       ?process_id=<uuid>&complete_token=<token>
 *
 *   and then polls until the page has provisioned the credential, which it saves to
 *   the OS keyring (or ~/.vibe/.env).
 *
 * Replicating that poll would mean calling a private, authenticated `/api` surface
 * — every path there answers 401 to an unauthenticated caller, so the endpoint, the
 * header shape and the minted credential's type are all unknown, and guessing against
 * a production console is not something this plugin should do. So the flow here is:
 * start the vendor's own setup (its browser login is the actual sign-in), then WATCH
 * the keyring and env file and adopt the credential the moment it appears. From the
 * DSH card that is one click; the browser step happens in the browser, as it must.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { importLocalMistralKey, windowsKeyringRunner } from './mistral-keyring.js'

/** Where `uv tool install` puts the CLI on Windows, plus the POSIX spelling. */
export function vibeCandidates(home: string = homedir()): string[] {
  return [
    join(home, '.local', 'bin', 'vibe.exe'),
    join(home, '.local', 'bin', 'vibe'),
  ]
}

/**
 * The Vibe CLI on this machine.
 *
 * @param home - home directory (injected for a test).
 * @returns the executable path, or undefined when it is not installed.
 */
export function findVibeCli(home: string = homedir()): string | undefined {
  return vibeCandidates(home).find(candidate => existsSync(candidate))
}

/** The install command quoted in errors, so a user can act on it. */
export const VIBE_INSTALL_HINT = 'uv tool install --python 3.14 mistral-vibe'

/** Runs a command detached, so the console window it opens can host the TUI. */
export type SpawnDetached = (command: string, args: readonly string[]) => void

const spawnDetached: SpawnDetached = (command, args) => {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

/** Outcome of waiting for the sign-in to land. */
export type WaitOutcome =
  | { kind: 'found'; key: string; source: 'keyring' | 'env' }
  | { kind: 'timeout' }
  | { kind: 'no-cli' }

/**
 * Start the vendor's setup and wait for the credential it provisions.
 *
 * @param options - injected for a test: cli path, spawn, clock control and home.
 * @returns the credential, or why it never arrived.
 */
export async function runVibeSignIn(options: {
  home?: string
  cliPath?: string
  spawn?: SpawnDetached
  timeoutMs?: number
  intervalMs?: number
  /** Injected so a test can drive the poll without waiting. */
  sleep?: (ms: number) => Promise<void>
  importKey?: typeof importLocalMistralKey
} = {}): Promise<WaitOutcome> {
  const home = options.home ?? homedir()
  const cli = options.cliPath ?? findVibeCli(home)
  if (cli === undefined) return { kind: 'no-cli' }
  ;(options.spawn ?? spawnDetached)(cli, ['--setup'])
  const timeoutMs = options.timeoutMs ?? 180_000
  const intervalMs = options.intervalMs ?? 2_000
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const readKey = options.importKey ?? importLocalMistralKey
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await readKey({ run: windowsKeyringRunner(), home })
    if (found !== undefined) return { kind: 'found', key: found.key, source: found.source }
    await sleep(intervalMs)
  }
  return { kind: 'timeout' }
}

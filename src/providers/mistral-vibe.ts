/**
 * Read the API key the Mistral **Vibe CLI** already holds.
 *
 * Mistral runs two wallets on one account (measured on a live key):
 *
 *   plan allowance  →  `vibe_budget`   (150 USD on the tested EDU plan)
 *   pay-as-you-go   →  `api_budget`    (15 USD on the same account)
 *
 * An API key created for the **Vibe CLI** draws the plan allowance first; a Studio
 * key draws the pay-as-you-go wallet. Two requests through this route moved
 * `api_budget` from 0.0003533 to 0.00077 and left `vibe_budget` at 0 — the same
 * thing the reference project's changelog records ("it showed only the Vibe budget,
 * so it read 0% while the API wallet was being spent").
 *
 * `vibe --setup` writes that key to `~/.vibe/.env`, so this route can pick it up
 * the way the Trae and JoyCode routes import their local sign-ins.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Names the Vibe CLI's env file uses for its key. */
const VIBE_KEY_NAMES = ['MISTRAL_API_KEY', 'VIBE_API_KEY', 'MISTRAL_VIBE_KEY'] as const

/**
 * Parse a dotenv-style file for a key, without touching the environment.
 *
 * @param text - file contents.
 * @returns the key, or undefined when the file names none.
 */
export function parseVibeEnv(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const name = trimmed.slice(0, separator).trim()
    if (!(VIBE_KEY_NAMES as readonly string[]).includes(name)) continue
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '') return value
  }
  return undefined
}

/** Where the Vibe CLI keeps its env file. */
export function vibeEnvPath(home: string = homedir()): string {
  return join(home, '.vibe', '.env')
}

/**
 * Read the Vibe CLI's key from this machine.
 *
 * @param home - home directory (injected for a test).
 * @returns the key, or undefined when the CLI has never been set up here.
 */
export async function readMistralVibeKey(home: string = homedir()): Promise<string | undefined> {
  try {
    return parseVibeEnv(await readFile(vibeEnvPath(home), 'utf8'))
  } catch {
    return undefined
  }
}

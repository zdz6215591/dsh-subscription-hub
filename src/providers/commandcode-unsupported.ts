/**
 * Models Command Code listed but then refused for this account (`MODEL_NOT_IN_PLAN`).
 *
 * The plan table (`commandcode-plan.ts`) is a snapshot: a model released after it
 * was written is unknown there, and this route deliberately fails OPEN on unknown
 * models — hiding a model somebody paid for is worse than offering one the server
 * may refuse. The refusal itself is the missing fact, so it is recorded here the
 * first time it happens and the model stops being offered for that account.
 *
 * Recorded per account (a different key is a clean slate) and expired, so an
 * upgrade picks the models up again without any user action.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** How long a refusal is remembered before the model is offered again. */
export const COMMANDCODE_UNSUPPORTED_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface Refusal {
  at: number
  reason?: string
}

interface Document {
  version: 1
  accounts: Record<string, Record<string, Refusal>>
}

/** Where the refusals live. */
export function commandCodeUnsupportedPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'commandcode-unsupported.json')
}

async function read(): Promise<Document> {
  try {
    const parsed: unknown = JSON.parse(await readFile(commandCodeUnsupportedPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, accounts: {} }
    const accounts = (parsed as { accounts?: unknown }).accounts
    if (typeof accounts !== 'object' || accounts === null) return { version: 1, accounts: {} }
    return { version: 1, accounts: accounts as Record<string, Record<string, Refusal>> }
  } catch {
    return { version: 1, accounts: {} }
  }
}

let chain: Promise<unknown> = Promise.resolve()

async function write(document: Document): Promise<void> {
  const path = commandCodeUnsupportedPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/**
 * Record that the plan refused a model.
 *
 * @param account - account key.
 * @param model - the refused model id.
 * @param reason - the vendor's own message.
 */
export async function recordCommandCodeUnsupported(account: string, model: string, reason?: string): Promise<void> {
  if (account === '' || model === '') return
  chain = chain.then(async () => {
    const document = await read()
    const forAccount = document.accounts[account] ?? (document.accounts[account] = {})
    forAccount[model] = { at: Date.now(), ...reason === undefined ? {} : { reason: reason.slice(0, 200) } }
    await write(document)
  }).catch(() => undefined)
  await chain
}

/**
 * The models this account must not be offered.
 *
 * @param account - account key.
 * @param now - current epoch ms (injected so a test can age a record).
 * @returns refused ids whose record is still fresh.
 */
export async function readCommandCodeUnsupported(account: string, now: number = Date.now()): Promise<ReadonlySet<string>> {
  const document = await read()
  const forAccount = document.accounts[account]
  if (forAccount === undefined) return new Set()
  const out = new Set<string>()
  for (const [model, refusal] of Object.entries(forAccount)) {
    if (now - refusal.at < COMMANDCODE_UNSUPPORTED_TTL_MS) out.add(model)
  }
  return out
}

/**
 * Forget every refusal for an account (a re-login re-tries everything).
 * @param account - account key.
 */
export async function clearCommandCodeUnsupported(account: string): Promise<void> {
  chain = chain.then(async () => {
    const document = await read()
    if (document.accounts[account] === undefined) return
    delete document.accounts[account]
    await write(document)
  }).catch(() => undefined)
  await chain
}

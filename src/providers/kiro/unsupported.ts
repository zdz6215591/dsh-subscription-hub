/**
 * Models Kiro listed but then refused to chat with.
 *
 * Measured, with two real credentials, in one afternoon:
 *
 *   API key    → `KiroControlPlaneBearerService.ListAvailableModels` returns 22
 *                models (Claude family included) and every one of them chats.
 *   sign-in    → `management /List-Available-Models` returns 9 (partner models
 *                only), while `q.<region>.amazonaws.com` lists the same 22 — and
 *                chat with a Claude id on that token answers INVALID_MODEL_ID.
 *
 * So what a credential can LIST is not what it can USE, and which side of that
 * line a model is on cannot be read from the catalogue. Rather than guess (and
 * rather than offer a row that fails the moment it is picked), this route records
 * the models Kiro itself refused and stops listing them for that account.
 *
 * The record is per account (a different key or sign-in is a clean slate) and
 * expires, so a fixed entitlement is picked up again without any user action.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** How long a refusal is remembered before the model is offered again. */
export const UNSUPPORTED_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** One recorded refusal. */
interface Refusal {
  /** Epoch ms of the refusal. */
  at: number
  /** Kiro's own reason, for the record. */
  reason?: string
}

interface Document {
  version: 1
  /** account key → model id → refusal. */
  accounts: Record<string, Record<string, Refusal>>
}

/**
 * Where the refusals live.
 * @returns `~/.dsh/plugins/subscriptions/kiro-unsupported-models.json`.
 */
export function kiroUnsupportedPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'kiro-unsupported-models.json')
}

async function read(): Promise<Document> {
  try {
    const parsed: unknown = JSON.parse(await readFile(kiroUnsupportedPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, accounts: {} }
    const accounts = (parsed as { accounts?: unknown }).accounts
    if (typeof accounts !== 'object' || accounts === null) return { version: 1, accounts: {} }
    return { version: 1, accounts: accounts as Record<string, Record<string, Refusal>> }
  } catch {
    return { version: 1, accounts: {} }
  }
}

let chain: Promise<unknown> = Promise.resolve()

/**
 * Record that Kiro refused to chat with a model on this account.
 *
 * @param account - account key.
 * @param model - the model id Kiro refused.
 * @param reason - Kiro's own message, when there is one.
 */
export async function recordKiroUnsupported(account: string, model: string, reason?: string): Promise<void> {
  if (account === '' || model === '') return
  chain = chain.then(async () => {
    const document = await read()
    const forAccount = document.accounts[account] ?? (document.accounts[account] = {})
    forAccount[model] = { at: Date.now(), ...reason === undefined ? {} : { reason } }
    const path = kiroUnsupportedPath()
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  }).catch(() => undefined)
  await chain
}

/**
 * The models this account must not be offered.
 *
 * @param account - account key.
 * @param now - current epoch ms (injected so a test can age a record).
 * @returns the refused model ids, refusals older than {@link UNSUPPORTED_TTL_MS} excluded.
 */
export async function readKiroUnsupported(account: string, now: number = Date.now()): Promise<ReadonlySet<string>> {
  const document = await read()
  const forAccount = document.accounts[account]
  if (forAccount === undefined) return new Set()
  const out = new Set<string>()
  for (const [model, refusal] of Object.entries(forAccount)) {
    if (now - refusal.at < UNSUPPORTED_TTL_MS) out.add(model)
  }
  return out
}

/**
 * Forget every refusal for an account, so a re-login re-tries everything.
 * @param account - account key.
 */
export async function clearKiroUnsupported(account: string): Promise<void> {
  chain = chain.then(async () => {
    const document = await read()
    if (document.accounts[account] === undefined) return
    delete document.accounts[account]
    const path = kiroUnsupportedPath()
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  }).catch(() => undefined)
  await chain
}

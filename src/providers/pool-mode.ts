/**
 * Global multi-account call mode for the subscription pool.
 *
 * A single, total setting that every subscription's account pool shares
 * (依次 = priority failover, 均衡 = quota-aware urgency scheduling) — it is NOT
 * configured per subscription. The value lives at
 * `~/.dsh/plugins/subscriptions/mode.json` (sibling to the auth store and
 * proxy.json) and drives the effective {@link PoolStrategy} of {@link PoolAdapter}.
 *
 * Precedence: a valid file value wins over the YAML `pool.strategy` config;
 * when neither is present the pool falls back to `quota_aware` (均衡). The
 * `poolGet` / `poolSet` RPC endpoints edit it from the web Settings →
 * Subscriptions page, and a saved mode re-tunes the running adapter
 * immediately via the `apply` callback.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PoolStrategy } from './pool.js'

/** View served to the client (also the persisted shape). */
export interface PoolModeView {
  /** The active global multi-account call mode. */
  mode: PoolStrategy
  /** The mode declared by the YAML `pool.strategy`, when present. */
  configured?: PoolStrategy
  /** Last load failure when the stored mode is unusable. */
  error?: string
}

/** One `poolSet` payload (no secrets). */
export interface PoolModeInput {
  mode: PoolStrategy
}

const DEFAULT_MODE: PoolStrategy = 'quota_aware'

function modeFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'mode.json')
}

function isPoolStrategy(value: unknown): value is PoolStrategy {
  return value === 'priority' || value === 'quota_aware'
}

/** Read the on-disk mode; a missing file falls back to {@link fallback}. */
async function loadConfigFile(path: string, fallback: PoolStrategy): Promise<PoolStrategy> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions pool mode at ${path} is not valid JSON; fix or delete the file`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('subscriptions pool mode must be a JSON object')
  }
  const record = parsed as { mode?: unknown }
  return isPoolStrategy(record.mode) ? record.mode : fallback
}

/** Persist a mode atomically with owner-only permissions. */
async function persistConfig(mode: PoolStrategy, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify({ mode }, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** The pool-mode operations the RPC endpoints and Settings page use. */
export interface PoolModeController {
  /** Kick off the on-disk load and re-tune the pool with the resolved mode. */
  bootstrap(): void
  /** Read the persistable view for the Settings page. */
  view(): Promise<PoolModeView>
  /** Persist a new global mode and apply it to the running adapter. */
  set(input: PoolModeInput): Promise<PoolModeView>
}

/**
 * Build a pool-mode controller. `configured` is the YAML `pool.strategy`
 * (may be undefined); a valid file value, once loaded, overrides it. `apply`
 * re-tunes the running {@link PoolAdapter} when a mode is saved or when the
 * startup load resolves.
 */
export function createPoolModeController(
  configured: PoolStrategy | undefined,
  apply: (mode: PoolStrategy) => void,
): PoolModeController {
  const fallback: PoolStrategy = configured ?? DEFAULT_MODE
  // Effective mode before the file load resolves is the fallback; afterwards
  // it becomes the file value (or stays the fallback on a missing/corrupt file).
  let effective = fallback
  let configError: string | undefined
  let ready: Promise<void> | undefined

  const ensureReady = (): Promise<void> => {
    ready ??= loadConfigFile(modeFilePath(), fallback).then(
      (mode) => { effective = mode },
      (error) => { configError = error instanceof Error ? error.message : String(error) },
    )
    return ready
  }

  return {
    bootstrap() {
      void ensureReady().then(() => { apply(effective) })
    },
    async view() {
      await ensureReady()
      return {
        mode: effective,
        ...configured === undefined ? {} : { configured },
        ...configError === undefined ? {} : { error: configError },
      }
    },
    async set(input) {
      await ensureReady()
      effective = input.mode
      configError = undefined
      await persistConfig(input.mode, modeFilePath())
      apply(input.mode)
      return {
        mode: input.mode,
        ...configured === undefined ? {} : { configured },
      }
    },
  }
}
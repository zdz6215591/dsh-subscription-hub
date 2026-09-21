/**
 * Cline provider surface: the ClinePass adapter plus its catalog, quota, and
 * per-model upstream-pin modules.
 *
 * Cline is registered as a single `cline` provider route. Unlike every other
 * route here it carries an extra capability: **per-model upstream pinning**,
 * which chooses (and fails over between) the gateway's backing providers for a
 * given model. See `pins.ts` for the wire contract.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ClineSession } from '../../auth/store.js'

export { ClineAdapter, CLINE_PREEMPT_MS } from './adapter.js'
export type { ClineAdapterOptions } from './adapter.js'
export {
  CLINE_BASE_URL,
  CLINE_EFFORTS,
  CLINE_MODEL_CATALOG,
  CLINE_MODEL_PREFIX,
  CLINE_RECOMMENDED_URL,
  clineModel,
  discoverClineModels,
  parseGatewayModels,
  parseRecommendedModels,
  toClineModelInfo,
} from './catalog.js'
export type { ClineModel } from './catalog.js'
export {
  CLINE_USAGE_PATH,
  CLINE_PLAN_PATH,
  fetchClineUsage,
  parseClinePlan,
  parseClineUsage,
} from './usage.js'
export {
  ClinePinStore,
  EMPTY_PIN,
  OPENROUTER_SORT,
  buildAttempts,
  classifyUpstreamError,
  clinePinPath,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  normalizePin,
  normalizeSort,
  parseRouting,
  parseTier0,
  slugify,
} from './pins.js'
export type {
  ClineAttempt,
  ClineModelMeta,
  ClinePin,
  ClinePinDocument,
  ClinePinMode,
  ClinePipeline,
  ClineSort,
  ClineUpstreamStatus,
  ClineUpstreamVerdict,
} from './pins.js'

/**
 * Cline credentials are static API keys with no refresh grant, so a refresh is
 * the identity: the gateway has no token endpoint and a key either works until
 * the user revokes it or never did.
 */
export async function refreshCline(session: ClineSession): Promise<ClineSession> {
  return session
}

/** A Cline key never becomes permanently invalid from a refresh attempt. */
export function isClinePermanentRefreshError(_error: unknown): boolean {
  return false
}

/** Validate a pasted key shape before it reaches the store. */
export function assertUsableClineKey(value: string, label: string): string {
  const key = value.trim()
  if (key === '') throw new LlmError(`${label}: Cline Pass API key is empty`, 'INVALID_CREDENTIAL')
  // Cline keys are `sk_…` shaped; reject obvious pastes of other things early
  // so a wrong value fails at the panel instead of on the first chat.
  if (!/^sk_[A-Za-z0-9_-]{8,}$/.test(key)) {
    throw new LlmError(`${label}: that does not look like a Cline Pass API key (expected sk_…)`, 'INVALID_CREDENTIAL')
  }
  return key
}

/**
 * Build a session from a pasted key. Cline has no expiry, so `expiresAt` is set
 * far in the future: the shared token manager treats a session as fresh unless
 * it is inside the preempt window, and a static key must never trigger a
 * "refresh" that cannot happen.
 */
export function sessionFromClineKey(apiKey: string, account: string, baseUrl?: string): ClineSession {
  return {
    accessToken: apiKey,
    refreshToken: apiKey,
    expiresAt: Date.now() + 3650 * 24 * 60 * 60 * 1000,
    account,
    ...baseUrl === undefined || baseUrl === '' ? {} : { baseUrl },
  }
}

/** Mask a key for display, keeping just enough to recognize it. */
export function maskClineKey(value: string): string {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

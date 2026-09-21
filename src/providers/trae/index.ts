/**
 * Trae provider surface: one adapter (channel-aware) plus the credential,
 * usage/check-in and protocol modules.
 *
 * Trae is registered as a single `trae` provider route whose accounts carry
 * their own `channel` (`solo` for TRAE SOLO CN, `ide` for the Trae CN IDE), so
 * both channels appear under one Settings card and one picker group.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { TraeSession } from '../../auth/store.js'
import { traeCandidates } from './credentials.js'

export { TraeAdapter, TRAE_PREEMPT_MS, toTraeMessages } from './adapter.js'
export type { TraeAdapterOptions } from './adapter.js'
export {
  TRAE_CHANNELS,
  TRAE_AUTH_STORAGE_KEY,
  TRAE_CLI_TOKEN_FILENAME,
  TRAE_CN_DEFAULT_HOST,
  decryptTraeStorageValue,
  discoverTraeCredentials,
  parseTraeAuthValue,
  parseTraeCliToken,
  parseTraeStorageDocument,
  normalizeTraeCredential,
  traeCandidates,
} from './credentials.js'
export type {
  TraeCandidate,
  TraeCandidateFailure,
  TraeChannel,
  TraeChannelDefinition,
  TraeCredential,
  TraeCredentialSource,
  TraeDiscoveryResult,
} from './credentials.js'
export {
  TRAE_APP_ID,
  TRAE_CHAT_BASE,
  TRAE_CHAT_PATH,
  TRAE_CLIENT_VERSION,
  TRAE_MODELS_PATH,
  TRAE_PAY_BASE,
  TRAE_PLUGIN_CHANNEL,
  TRAE_REMOTE_BASE,
  TRAE_SOLO_FUNCTION,
  TRAE_VERSION_CODE,
  TRAE_WIRE_EFFORTS,
  TraeSseDecoder,
  buildTraeChatBody,
  decodeTraeEvent,
  normalizeTraeToolCalls,
  traeEndpoint,
  traeHeaders,
} from './protocol.js'
export type {
  TraeChatBodyOptions,
  TraeMessage,
  TraeSseEvent,
  TraeStreamEvent,
  TraeToolCall,
  TraeToolCallDelta,
} from './protocol.js'
export { fetchTraeModels, mergeTraeModels, toTraeModelInfo, TRAE_FALLBACK_MODELS } from './catalog.js'
export type { TraeModel } from './catalog.js'
export {
  autoCheckinTrae,
  claimTraeCheckin,
  fetchTraeCheckinStatus,
  fetchTraeUsage,
  generateMorningTargetTime,
  getTraeCheckinStatusView,
  localDateString,
  parseTraeUsage,
  readTraeCheckinState,
  recordTraeCheckin,
  traeUsageToProviderUsage,
  writeTraeCheckinState,
} from './usage.js'
export type {
  TraeCheckinState,
  TraeCheckinStatus,
  TraeCheckinStatusView,
  TraeCreditPack,
  TraeUsageSnapshot,
} from './usage.js'
export { importTraeAccounts, traeImportFailureMessage } from './importer.js'
export type { TraeImportFailure, TraeImportResult } from './importer.js'

/**
 * Trae credentials are read from the local Trae installs, so there is no OAuth
 * refresh grant to run: the desktop app owns the token's lifetime and re-reading
 * `storage.json` picks up whatever it last persisted. Returning the session
 * unchanged keeps the shared token manager's contract (it only calls `refresh`
 * once the token is inside the preempt window) while making the import path
 * idempotent.
 */
export async function refreshTrae(session: TraeSession): Promise<TraeSession> {
  return session
}

/** A Trae credential never becomes permanently invalid from a refresh failure. */
export function isTraePermanentRefreshError(_error: unknown): boolean {
  return false
}

/**
 * Throw the diagnostic error for a machine with no Trae install, naming the
 * paths that were probed so a differing layout is diagnosable.
 */
export function traeNotSignedInError(): LlmError {
  const paths = traeCandidates().map(candidate => candidate.path)
  return new LlmError(
    `Trae: no local sign-in found. Install and sign in to TRAE SOLO CN or the Trae CN IDE, then click import. Probed: ${paths.join(', ')}`,
    'INVALID_CREDENTIAL',
  )
}

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
import { refreshTraeSession } from './refresh.js'

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
export { fetchTraeModels, toTraeModelInfo } from './catalog.js'
export type { TraeCatalogRead, TraeModel } from './catalog.js'
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
 * Refresh a Trae credential through the official ExchangeToken grant.
 *
 * This replaced a no-op whose comment claimed "the desktop app owns the token's
 * lifetime and re-reading `storage.json` picks up whatever it last persisted" —
 * false, because only a manual import re-reads that file. The consequence was
 * that a few hours after an import, chat, credits and check-in all failed with
 * upstream auth errors, never self-healed, and the card still reported the
 * account as signed in. See `refresh.ts` for the per-edition contract.
 * @param session - the stored session to renew.
 * @returns the same session with a fresh access token.
 * @throws {TraeRefreshRejected} when the grant is permanently refused.
 */
export async function refreshTrae(session: TraeSession): Promise<TraeSession> {
  // The token manager applies its own preempt window, so reaching here means the
  // access token is inside it; a missing refresh token is the real "cannot renew".
  return await refreshTraeSession(session)
}

export { isTraePermanentRefreshError } from './refresh.js'

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

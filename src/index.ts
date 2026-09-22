/**
 * dsh-subscription-hub: register OAuth-subscription LLM providers
 * (Codex, Claude, Grok, Copilot, Antigravity, Command Code, CodeBuddy, Zed)
 * on `ctx.llm`, and expose the `/subscriptions-auth` RPC channel the web
 * Settings page uses to run the logins. The token store lives at
 * `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-subscription-hub
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  GenerateOptions,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { DeviceFlowManager, type DeviceAttempt } from './auth/device-flow.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaudeCodeCredentials, refreshClaudeSynced } from './auth/claude-code-creds.js'
import { BadRequest, registerAuthRpc } from './auth/rpc.js'
import { CodexClientVersionCache } from './providers/codex-client-version.js'
import { ImageAccountPool } from './providers/image-pool.js'
import { recordStreamTokenUsage } from './stats/token-savings.js'
import type {
  AuthController,
  ClineAutoConfigureView,
  ImageBytesResult,
  LoginMethod,
  ModelDefaultsCatalog,
  ModelDefaultsController,
  ModelDefaultView,
  ProviderStatus,
  SpeedController,
  SpeedTier,
  VideoBytesResult,
} from './auth/rpc.js'
import {
  defaultEffortOf,
  loadModelDefaults,
  setDefaultEffort,
} from './model-defaults.js'
import {
  accountKeyOf,
  deleteAccountSession,
  listAccounts,
  saveAccountSession,
  setDefaultAccount,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  AgySession,
  ClaudeSession,
  ClineSession,
  CodexSession,
  CodeBuddySession,
  CommandCodeSession,
  CopilotSession,
  GrokSession,
  ProviderId,
  StoredSession,
  TraeSession,
  ZedSession,
} from './auth/store.js'
import { DISCOVERY_TIMEOUT_MS, validateModels, withTimeout } from './providers/common.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { AccountTokenManager } from './providers/accounts.js'
import type { AccountAwareAdapter } from './providers/accounts.js'
import { DEFAULT_RATE_LIMIT_MAX_WAIT_MS, resolveRateLimitWait } from './providers/rate-limit.js'
import type { RateLimitConfig } from './providers/rate-limit.js'
import { catalogStore } from './providers/catalog-store.js'
import { PoolAdapter } from './providers/pool.js'
import { registerWithAlias } from './tools/registration.js'
import { buildAccountPools, poolKey } from './providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry } from './providers/pool-health.js'
import { PoolUsageTracker } from './providers/pool-usage.js'
import { createPoolModeController } from './providers/pool-mode.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './providers/codex.js'
import {
  ClaudeAdapter,
  claudeFlow,
  CLAUDE_PREEMPT_MS,
  exchangeClaudeCode,
  fetchClaudeUsage,
  isClaudePermanentRefreshError,
  refreshClaude,
} from './providers/claude.js'
import {
  GrokAdapter,
  grokFlow,
  GROK_PREEMPT_MS,
  exchangeGrokCode,
  fetchGrokUsage,
  isGrokPermanentRefreshError,
  refreshGrok,
} from './providers/grok.js'
import {
  CopilotAdapter,
  COPILOT_PREEMPT_MS,
  completeCopilotLogin,
  copilotDeviceFlow,
  isCopilotPermanentRefreshError,
  refreshCopilot,
} from './providers/copilot.js'
import {
  AgyAdapter,
  AGY_PREEMPT_MS,
  agyFlow,
  exchangeAgyCode,
  fetchAgyUsage,
  isAgyPermanentRefreshError,
  refreshAgy,
} from './providers/agy.js'
import {
  CommandCodeAdapter,
  COMMANDCODE_PREEMPT_MS,
  fetchCommandCodeUsage,
  importCommandCodeCli,
  isCommandCodePermanentRefreshError,
  refreshCommandCode,
  sessionFromCommandCodePaste,
  startCommandCodeLogin,
} from './providers/commandcode.js'
import {
  CodeBuddyAdapter,
  CODEBUDDY_PREEMPT_MS,
  checkinCodeBuddy,
  completeCodeBuddyLogin,
  fetchCodeBuddyUsage,
  isCodeBuddyPermanentRefreshError,
  refreshCodeBuddy,
  startCodeBuddyLogin,
  autoCheckinCodeBuddy,
  getCodeBuddyCheckinStatus,
  recordManualCheckin,
} from './providers/codebuddy.js'
import {
  ClineAdapter,
  CLINE_BASE_URL,
  CLINE_MODEL_CATALOG,
  CLINE_PREEMPT_MS,
  ClinePinStore,
  assertUsableClineKey,
  extractAvailableProviders,
  parseRouting,
  fetchClineUsage,
  isClinePermanentRefreshError,
  maskClineKey,
  mergeUpstreams,
  refreshCline,
  sessionFromClineKey,
  validateChannelBody,
  classifyUpstreamError,
} from './providers/cline/index.js'
import type { ClineUpstreamStatus, ClineUpstreamVerdict } from './providers/cline/index.js'
import type { ClineChannelVerdicts } from './providers/cline/pins.js'
import { planClinePin } from './providers/cline/auto-configure.js'
import {
  TraeAdapter,
  TRAE_PREEMPT_MS,
  claimTraeCheckin,
  fetchTraeUsage,
  getTraeCheckinStatusView,
  autoCheckinTrae,
  importTraeAccounts,
  isTraePermanentRefreshError,
  recordTraeCheckin,
  refreshTrae,
  traeImportFailureMessage,
  traeNotSignedInError,
} from './providers/trae/index.js'
import type { TraeImportFailure } from './providers/trae/index.js'
import {
  ZedAdapter,
  ZED_PREEMPT_MS,
  fetchZedUsage,
  importZedDesktop,
  isZedPermanentRefreshError,
  refreshZed,
  sessionFromZedPaste,
} from './providers/zed.js'
import { filterVisible, hiddenIds, markProviderModelsRead, setModelVisible, syncDiscoveredModels } from './model-visibility.js'
import { modelVendor } from './model-vendor.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { createVideoGenerateTool, videosDirectory } from './tools/video-generate.js'
import { proxiedFetch, proxyGetConfig, proxySetConfig, proxyTestConnection } from './http.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { RateLimitConfig, RateLimitWait } from './providers/rate-limit.js'
export type { ProviderStatus } from './auth/rpc.js'
export type {
  AgySession,
  ClaudeSession,
  CodexSession,
  CodeBuddySession,
  CommandCodeSession,
  CopilotSession,
  GrokSession,
  ProviderId,
  ZedSession,
} from './auth/store.js'

export const name = 'dsh-subscription-hub'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
export const POOL_USAGE_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS
export { withTimeout } from './providers/common.js'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Provider routes to register; defaults to all eight. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Whether and how long a route waits out a closed rate-limit window. */
  rateLimit?: RateLimitConfig
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
    copilot?: ModelEntry[]
    agy?: ModelEntry[]
    commandcode?: ModelEntry[]
    cline?: ModelEntry[]
    codebuddy?: ModelEntry[]
    trae?: ModelEntry[]
    zed?: ModelEntry[]
  }
  /** Same-subscription account pools (and optional extra tier models). */
  pool?: {
    /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
    enabled?: boolean
    /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
    strategy?: 'priority' | 'quota_aware'
    /** A challenger must out-score the sticky member by this factor to take over (default 2). */
    switchMargin?: number
    /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
    autoAccounts?: boolean
    /** @deprecated Use {@link autoAccounts}. */
    autoFamilies?: boolean
    /** Explicit account lists for one catalog model (same provider); replaces the auto pool. */
    families?: Record<string, PoolMemberRef[]>
    /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
    tiers?: Record<string, PoolMemberRef[]>
  }
}

const providerIdSchema = z.union(['codex', 'claude', 'grok', 'copilot', 'agy', 'commandcode', 'cline', 'codebuddy', 'trae', 'zed'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
  wire: z.union(['chat-completions', 'responses']),
})

const poolMemberSchema: z<PoolMemberRef> = z.object({
  provider: providerIdSchema.required(),
  account: z.string(),
  model: z.string().required(),
})

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'claude', 'grok', 'agy', 'commandcode', 'cline', 'codebuddy', 'trae', 'copilot', 'zed']),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  rateLimit: z.object({
    wait: z.boolean().default(true),
    maxWaitMs: z.number().min(1).default(DEFAULT_RATE_LIMIT_MAX_WAIT_MS),
  }),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
    copilot: z.array(modelEntrySchema),
    agy: z.array(modelEntrySchema),
    commandcode: z.array(modelEntrySchema),
    cline: z.array(modelEntrySchema),
    codebuddy: z.array(modelEntrySchema),
    trae: z.array(modelEntrySchema),
    zed: z.array(modelEntrySchema),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    strategy: z.union(['priority', 'quota_aware']).default('quota_aware'),
    switchMargin: z.number().min(1).default(2),
    autoAccounts: z.boolean().default(true),
    autoFamilies: z.boolean(),
    families: z.dict(z.array(poolMemberSchema)),
    tiers: z.dict(z.array(poolMemberSchema)),
  }),
})

/** Built-in catalogs used when the config does not override a provider's models. */
export const DEFAULT_MODELS: Record<ProviderId, ModelEntry[]> = {
  codex: [
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  claude: [
    { id: 'claude-opus-5', name: 'Claude Opus 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', maxTokens: 64_000, contextWindow: 200_000 },
  ],
  // Static fallback only: the live CLI catalog (`cli-chat-proxy.grok.com`) is
  // authoritative and wins whenever discovery succeeds. The ids below are the
  // roster that catalog actually serves (verified live), each with its real
  // 500000-token window, so an offline start cannot offer retired ids or make
  // the harness compact to the old 256000 fallback.
  grok: [
    { id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 500_000, maxTokens: 32_000, inputModalities: ['text', 'image'] },
    { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', contextWindow: 500_000, maxTokens: 32_000, inputModalities: ['text', 'image'] },
    { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000, maxTokens: 32_000, inputModalities: ['text', 'image'] },
    { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500_000, maxTokens: 32_000, inputModalities: ['text', 'image'] },
  ],
  // Static fallback only: the live /models catalog (with per-model vision
  // flags and context windows) wins whenever discovery succeeds.
  copilot: [
    { id: 'gpt-4.1', name: 'GPT-4.1', inputModalities: ['text', 'image'] },
    { id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', inputModalities: ['text', 'image'] },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', inputModalities: ['text', 'image'] },
  ],
  agy: [
    { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', inputModalities: ['text', 'image'] },
  ],
  commandcode: [
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  ],
  // Static fallback only: the live recommended-models roster wins whenever
  // discovery succeeds. Every entry needs a positive contextWindow or the
  // whole provider catalog is rejected as INVALID_MODEL_CONTEXT.
  cline: [
    { id: 'cline-pass/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
    { id: 'cline-pass/glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_000_000 },
    { id: 'cline-pass/kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
  ],
  codebuddy: [
    { id: 'auto', name: 'CodeBuddy Auto' },
  ],
  // Static fallback only: the live get_detail_param roster wins whenever
  // discovery succeeds. Every entry needs a positive contextWindow or the
  // whole provider catalog is rejected as INVALID_MODEL_CONTEXT.
  trae: [
    { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
    { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  ],
  zed: [
    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return {
    codex: resolve('codex'),
    claude: resolve('claude'),
    grok: resolve('grok'),
    copilot: resolve('copilot'),
    agy: resolve('agy'),
    commandcode: resolve('commandcode'),
    cline: resolve('cline'),
    codebuddy: resolve('codebuddy'),
    trae: resolve('trae'),
    zed: resolve('zed'),
  }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'codex': {
      const codex = session as CodexSession
      // Sessions stored before identity claims were persisted still carry the
      // id token: decode the email on the fly instead of forcing a re-login.
      return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId
    }
    case 'claude': return (session as ClaudeSession).emailAddress
    case 'grok': return (session as GrokSession).account
    case 'copilot': return (session as CopilotSession).account
    case 'agy': return (session as AgySession).account
    case 'commandcode': return (session as CommandCodeSession).account
    case 'cline': return (session as ClineSession).account
    case 'codebuddy': return (session as CodeBuddySession).account
    case 'trae': return (session as TraeSession).account ?? (session as TraeSession).userId
    case 'zed': return (session as ZedSession).account ?? (session as ZedSession).userId
  }
}

/** The plan name a stored session carries, when the provider told us. */
function planOf(provider: ProviderId, session: StoredSession): string | undefined {
  switch (provider) {
    case 'codex': return (session as CodexSession).planType
    case 'claude': return (session as ClaudeSession).subscriptionType
    case 'grok': return undefined
    case 'copilot': return undefined
    case 'agy': return undefined
    case 'commandcode': return undefined
    case 'cline': return undefined
    case 'codebuddy': return undefined
    // The channel IS the plan distinction for Trae: the two CN surfaces are
    // separate products with their own rosters.
    case 'trae': return (session as TraeSession).channel === 'solo' ? 'TRAE SOLO CN' : 'Trae CN IDE'
    case 'zed': return undefined
  }
}

/** Per-provider per-account usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (account: string, signal: AbortSignal) => Promise<ProviderUsage>>>

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 *
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export class SubscriptionsAuthController implements AuthController {
  /** Last login failure per provider, surfaced as `detail` until the next success. */
  private lastError = new Map<ProviderId, string>()
  /**
   * Device-flow logins whose poll already settled but whose token exchange +
   * persist is still running. Between those two moments the attempt is gone
   * from the flow manager (busy=false) while no session exists yet
   * (loggedIn=false) — counting this window as busy keeps the Settings page
   * polling until the card can show the real outcome.
   */
  private finalizing = new Set<ProviderId>()

  /** In-flight OAuth completions, one per provider at most. */
  private completions = new Map<ProviderId, Promise<void>>()

  /**
   * Per-provider claim counter. Everything that takes ownership of a
   * provider's session — starting a login, importing Claude Code credentials,
   * cancelling, logging out — bumps it, and a session write carrying an older
   * number has been superseded and is dropped.
   *
   * The counter is what makes a late OAuth completion safe: an attempt leaves
   * `OAuthFlowManager`'s pending map the moment its callback delivers the
   * code, while the token exchange that follows can still run for seconds. For
   * that whole window `pending(provider)?.cancel()` is a no-op, so ownership
   * cannot be read off the flow manager.
   */
  private claims = new Map<ProviderId, number>()

  constructor(
    private readonly flows: OAuthFlowManager,
    /** Device-flow attempts (copilot); polled in the background like the loopback flows. */
    private readonly deviceFlows: DeviceFlowManager,
    /** Announces an auth-state change so catalog readers re-query (fires `llm/adapters-updated`). */
    private readonly onAuthChanged: (provider: ProviderId, account?: string) => void,
    /** Lazy attachment-store lookup for the `image` endpoint. */
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    /** Usage lookups for providers that expose a usage endpoint. */
    private readonly usageFetchers: UsageFetchers = {},
    /**
     * Reads the Claude Code session from its own store. Constructor-injected so
     * tests can drive both login paths without a real credential store; the
     * plugin itself always uses the default.
     */
    private readonly readClaudeCreds: () => ClaudeSession | undefined = readClaudeCodeCredentials,
    /**
     * The pool's usage cache, when the pool is enabled. Routing `usage`
     * through it (instead of the raw fetcher) means the Settings page shares
     * the same negative cache as `quota_aware` selection — reopening the
     * page can no longer re-hit an endpoint that is still cooling down from
     * a 429.
     */
    private readonly poolUsage: PoolUsageTracker | undefined = undefined,
  ) {}

  usage(provider: ProviderId, account: string, signal: AbortSignal, force = false): Promise<ProviderUsage> {
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    if (this.poolUsage === undefined) return fetcher(account, signal)
    return this.poolUsage.snapshotFor(provider, account, force)
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult> {
    // The RPC layer validated `name` down to a bare file name, so this join
    // cannot escape the videos directory.
    const data = await readFile(join(videosDirectory(), name), { signal })
    return { mediaType: 'video/mp4', dataBase64: data.toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const entries = await listAccounts(provider)
    // The plan name is shown by the usage section, so `detail` only carries errors.
    const detail = this.lastError.get(provider)
    return {
      busy: this.flows.isBusy(provider) || this.deviceFlows.isBusy(provider) || this.finalizing.has(provider),
      accounts: entries.map(({ key, session }, index) => {
        const account = accountOf(provider, session)
        const plan = planOf(provider, session)
        return {
          key,
          isDefault: index === 0,
          expiresAt: session.expiresAt,
          ...account === undefined ? {} : { account },
          ...plan === undefined ? {} : { plan },
        }
      }),
      ...detail === undefined ? {} : { detail },
    }
  }

  async login(provider: ProviderId, method?: LoginMethod): Promise<{ authorizeUrl: string; userCode?: string }> {
    if (provider === 'claude' && method !== 'oauth') {
      const imported = this.readClaudeCreds()
      if (imported !== undefined) {
        // An OAuth attempt may be in flight from an earlier click — the user
        // logged in through the CLI meanwhile. Claiming supersedes it whether
        // it is still waiting for its code or already exchanging one; the
        // cancel on top of that frees the listener, so `busy` clears and the
        // still-open browser tab cannot finish the flow.
        this.claim('claude')
        this.flows.pending('claude')?.cancel()
        // Keychain imports are bound: only they sync refreshes back to
        // Claude Code's credential store.
        const session: ClaudeSession = { ...imported, keychainBound: true }
        await this.persist('claude', session)
        this.lastError.delete('claude')
        this.onAuthChanged('claude', accountKeyOf('claude', session))
        return { authorizeUrl: '' }
      }
      if (method === 'keychain') {
        throw new Error('no Claude Code credentials found; run `claude` and log in first, or choose the browser flow')
      }
      // No Claude Code CLI / credential store — fall back to interactive OAuth.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'claude') {
      // Explicit browser flow: skip the credential import entirely.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'copilot') {
      // Device flow: no redirect URI — the UI shows the user code while the
      // background task polls GitHub for the token.
      const attempt = await this.deviceFlows.start(provider, copilotDeviceFlow())
      this.finalizing.add(provider)
      void this.completeDevice(provider, attempt)
      return { authorizeUrl: attempt.verificationUrl, userCode: attempt.userCode }
    }
    if (provider === 'codebuddy') {
      const started = await startCodeBuddyLogin()
      this.finalizing.add(provider)
      const claim = this.claim(provider)
      this.completions.set(provider, this.completeCodeBuddy(started.state, claim))
      return { authorizeUrl: started.authorizeUrl }
    }
    if (provider === 'commandcode') {
      if (method === 'oauth') {
        const started = await startCommandCodeLogin()
        this.finalizing.add(provider)
        const claim = this.claim(provider)
        this.completions.set(provider, this.completeCommandCode(started.wait, claim))
        return { authorizeUrl: started.authorizeUrl }
      }
      const session = await importCommandCodeCli()
      await this.persist('commandcode', session)
      this.lastError.delete('commandcode')
      this.onAuthChanged('commandcode', accountKeyOf('commandcode', session))
      return { authorizeUrl: '' }
    }
    if (provider === 'zed') {
      const session = await importZedDesktop()
      await this.persist('zed', session)
      this.lastError.delete('zed')
      this.onAuthChanged('zed', accountKeyOf('zed', session))
      return { authorizeUrl: '' }
    }
    if (provider === 'trae') {
      // Trae accounts are imported from the local Trae installs (TRAE SOLO CN
      // and the Trae CN IDE), not an OAuth flow this plugin drives. Import every
      // channel found in one pass so one button connects both.
      const { imported, failures } = await importTraeAccounts()
      if (imported.length === 0) {
        this.lastError.set('trae', traeImportFailureMessage(failures))
        throw traeNotSignedInError()
      }
      for (const entry of imported) {
        await this.persist('trae', entry.session)
        this.onAuthChanged('trae', accountKeyOf('trae', entry.session))
      }
      this.lastError.delete('trae')
      return { authorizeUrl: '' }
    }
    if (provider === 'cline') {
      // Cline has no OAuth grant and no device flow: its only login is a pasted
      // API key, which the panel collects through the manual-input field. This
      // branch exists so the shared "login" button opens that field instead of
      // trying to start an authorization-code flow that cannot exist.
      return { authorizeUrl: '' }
    }
    const spec = provider === 'grok' ? await grokFlow() : provider === 'agy' ? agyFlow : codexFlow
    const attempt = await this.flows.start(provider, spec)
    // Claimed only once the attempt exists: a rejected `start()` (one attempt
    // per provider) must not supersede the attempt already running.
    this.completions.set(provider, this.complete(provider, attempt, this.claim(provider)))
    return { authorizeUrl: attempt.authorizeUrl }
  }

  /**
   * Take ownership of a provider's session, superseding every older claim.
   * @param provider - the provider route.
   * @returns the claim number a later write checks itself against.
   */
  private claim(provider: ProviderId): number {
    const next = (this.claims.get(provider) ?? 0) + 1
    this.claims.set(provider, next)
    return next
  }

  /**
   * Drive one attempt to a stored session; records failures for the status
   * endpoint. The exchange runs unsupervised — the attempt is gone from the
   * flow manager as soon as its code arrives — so the result is stored only
   * while `claim` still owns the provider's session.
   */
  private async complete(provider: ProviderId, attempt: OAuthAttempt, claim: number): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const session = await this.exchange(provider, code, attempt)
      // Whoever claimed the session while the exchange ran owns it now, and
      // this result is stale. The check and the store call sit in one
      // synchronous stretch, and the store queues a write the moment it is
      // called, so a claim arriving after the check is ordered after this
      // write too.
      if (this.claims.get(provider) !== claim) return
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      // A failure is as stale as a success would have been: whoever claimed
      // the session while the exchange ran owns what the card shows, so a
      // superseded attempt must not put an error on a provider that has since
      // been imported, logged in again, or logged out.
      if (this.claims.get(provider) !== claim) return
      // A user-cancelled attempt is not a failure worth surfacing. Every
      // in-tree canceller claims first, so the guard above already covers
      // this; the check stands on its own so the invariant does not depend on
      // callers ordering the two.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    }
  }

  /** Drive one device-flow attempt to a stored session (the copilot path of {@link complete}). */
  private async completeDevice(provider: ProviderId, attempt: DeviceAttempt): Promise<void> {
    try {
      const githubToken = await attempt.waitToken()
      const session = await completeCopilotLogin(githubToken)
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      // A user-cancelled attempt is not a failure worth surfacing.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    } finally {
      this.finalizing.delete(provider)
    }
  }

  private async completeCodeBuddy(state: string, claim: number): Promise<void> {
    try {
      const session = await completeCodeBuddyLogin(state)
      if (this.claims.get('codebuddy') !== claim) return
      await this.persist('codebuddy', session)
      this.lastError.delete('codebuddy')
      this.onAuthChanged('codebuddy', accountKeyOf('codebuddy', session))
    } catch (error) {
      if (this.claims.get('codebuddy') !== claim) return
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set('codebuddy', errorChain(error))
      }
    } finally {
      this.finalizing.delete('codebuddy')
    }
  }

  private async completeCommandCode(wait: () => Promise<CommandCodeSession>, claim: number): Promise<void> {
    try {
      const session = await wait()
      if (this.claims.get('commandcode') !== claim) return
      await this.persist('commandcode', session)
      this.lastError.delete('commandcode')
      this.onAuthChanged('commandcode', accountKeyOf('commandcode', session))
    } catch (error) {
      if (this.claims.get('commandcode') !== claim) return
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set('commandcode', errorChain(error))
      }
    } finally {
      this.finalizing.delete('commandcode')
    }
  }

  private exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
    switch (provider) {
      case 'codex':
        return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
      case 'claude':
        return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
      case 'grok':
        return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
      case 'copilot':
        // Device flow: exchange happens in completeDevice, never here.
        return Promise.reject(new Error('copilot uses the device flow; no authorization code to exchange'))
      case 'agy':
        return exchangeAgyCode(code, attempt.pkce.verifier, attempt.redirectUri)
      case 'commandcode':
      case 'cline':
      case 'codebuddy':
      case 'trae':
      case 'zed':
        return Promise.reject(new Error(`${provider} does not use the authorization-code exchange`))
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // Keyed by the account's stable identity: re-logging the same account
    // updates in place, a different account appends.
    return saveAccountSession(provider, accountKeyOf(provider, session), session as never)
  }

  /**
   * Settle once no OAuth completion is running for a provider.
   *
   * @internal Exported for tests only: a login's token exchange outlives the
   * `login()` call that started it, and a test asserting on what it stored
   * would otherwise have to guess at a timeout.
   */
  async settled(provider: ProviderId): Promise<void> {
    await this.completions.get(provider)
  }

  async manual(provider: ProviderId, input: string): Promise<void> {
    if (provider === 'zed') {
      const session = await sessionFromZedPaste(input)
      await this.persist('zed', session)
      this.lastError.delete('zed')
      this.onAuthChanged('zed', accountKeyOf('zed', session))
      return
    }
    if (provider === 'commandcode') {
      const session = await sessionFromCommandCodePaste(input)
      await this.persist('commandcode', session)
      this.lastError.delete('commandcode')
      this.onAuthChanged('commandcode', accountKeyOf('commandcode', session))
      return
    }
    if (provider === 'cline') {
      // A Cline login IS a pasted key: there is no OAuth or device flow, so the
      // paste path doubles as the login path.
      const key = assertUsableClineKey(input, 'cline')
      const session = sessionFromClineKey(key, `cline-${maskClineKey(key)}`)
      await this.persist('cline', session)
      this.lastError.delete('cline')
      this.onAuthChanged('cline', accountKeyOf('cline', session))
      return
    }
    const attempt = this.flows.pending(provider)
    if (attempt === undefined) {
      throw new Error(`no ${provider} login attempt is in progress`)
    }
    attempt.manual(input)
  }

  cancel(provider: ProviderId): Promise<void> {
    // Claiming covers the attempt whose code already arrived: it is no longer
    // pending, but its token exchange may still be on its way to a store write.
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    return Promise.resolve()
  }

  async logout(provider: ProviderId, account: string): Promise<void> {
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    await deleteAccountSession(provider, account)
    this.lastError.delete(provider)
    this.onAuthChanged(provider, account)
  }

  async setDefault(provider: ProviderId, account: string): Promise<void> {
    await setDefaultAccount(provider, account)
    this.onAuthChanged(provider, account)
  }
}

export function apply(ctx: Context, config: Config): void {
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const rateLimit = resolveRateLimitWait(config.rateLimit, `${name}: rateLimit`)
  const catalog = resolveCatalog(config.models)
  // A non-empty configured catalog is an explicit override: it wins over live
  // discovery entirely (schemastery injects [] for omitted arrays, so only a
  // non-empty list counts as configured).
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const deviceFlows = new DeviceFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-subscription-hub: ${message}`)
  }
  // Optional: resolves ImageBlock references to bytes for vision-capable
  // models. Resolved per request — the attachments service may start after
  // this plugin's apply, so a one-time capture would stay undefined forever.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments') as AttachmentStore | undefined

  // Registration handles are kept so an auth-state change can re-announce the
  // route (`replace` fires `llm/adapters-updated`), which makes the web model
  // picker re-query `listModels` and show/hide the provider.
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, AccountAwareAdapter>()
  // Per-provider account token managers; also the pool's account lists.
  const accountTokens = new Map<ProviderId, AccountTokenManager<StoredSession>>()
  // Pool state, assigned when the pool route registers below; read here so an
  // auth change immediately recovers the account's cooling members and
  // refreshes its quota snapshot.
  let poolHealth: PoolHealthRegistry | undefined
  let poolUsage: PoolUsageTracker | undefined
  let poolAdapter: PoolAdapter | undefined
  const codexVersionCache = new CodexClientVersionCache(proxiedFetch)
  const imagePool = new ImageAccountPool({ onWarn })
  // Per-model upstream pins for Cline. Pins persist; the routing observations
  // the store also holds are derived data any probe can rebuild.
  const clinePins = new ClinePinStore()
  const authChanged = (provider: ProviderId, account?: string): void => {
    // Login, logout, and credential death all pass through here; a copilot
    // auth transition also drops the adapter's captured reasoning replay
    // state (isolation is already account-scoped — this is memory hygiene).
    if (provider === 'copilot') copilotAdapter?.clearReplayState()
    if (provider === 'codex') codexVersionCache.invalidate()
    if (provider === 'codex' || provider === 'grok') imagePool.clear(provider, account)
    adapters.get(provider)?.clearAccountCatalog(account)
    poolHealth?.clear(provider, account)
    poolUsage?.invalidate(provider, account)
    poolAdapter?.invalidate()
    // Re-announce only this provider. Replacing every route on every auth
    // change makes the composer model picker refetch all catalogs and flicker.
    handles.get(provider)?.replace([provider])
  }
  // Per-model default effort overrides: start the load so the adapters'
  // synchronous `defaultEffortOf` callbacks see the persisted state as soon
  // as the model picker resolves; a load failure leaves the overrides empty.
  void loadModelDefaults()
  // Token managers double as the tools' credential source, so they are
  // captured beside the registrations for the inject block below.
  let codexTokens: AccountTokenManager<CodexSession> | undefined
  let claudeTokens: AccountTokenManager<ClaudeSession> | undefined
  let grokTokens: AccountTokenManager<GrokSession> | undefined
  // Usage lookups resolve the session through the refresh-aware path, so an
  // expired access token renews instead of failing the lookup.
  const usageFetchers: UsageFetchers = {}
  // The composer Speed toggle's state: per-session, in-memory (a restart
  // restores standard routing), gated per request on the model's discovered
  // fast-tier support so a stale choice cannot leak onto a plain model.
  const speedBySession = new Map<string, SpeedTier>()
  let codexAdapter: CodexAdapter | undefined
  // Dropped on every copilot auth transition so replay state (captured
  // reasoning) never survives an account switch in memory.
  let copilotAdapter: CopilotAdapter | undefined

  function registerTrackedAdapter(provider: ProviderId, adapter: AccountAwareAdapter): void {
    const originalStream = adapter.stream.bind(adapter)
    adapter.stream = async function* (options: GenerateOptions) {
      for await (const chunk of originalStream(options)) {
        if (chunk.type === 'usage' && chunk.usage) {
          recordStreamTokenUsage(provider, options.model, chunk.usage)
        }
        yield chunk
      }
    }
    adapters.set(provider, adapter)
    handles.set(provider, ctx.llm.registerAdapter([provider], adapter))
  }

  for (const provider of providers) {
    switch (provider) {
      case 'codex': {
        const tokens = new AccountTokenManager<CodexSession>({
          provider: 'codex',
          displayName: 'ChatGPT (Codex)',
          makeOptions: () => ({
            preemptMs: CODEX_PREEMPT_MS,
            refresh: refreshCodex,
            isPermanent: isCodexPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('codex', account) },
        })
        codexTokens = tokens
        accountTokens.set('codex', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.codex = async (account, signal) =>
          fetchCodexUsage(await tokens.session(account), proxiedFetch, signal)
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          models: catalog.codex,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          resolveClientVersion: () => codexVersionCache.resolve(),
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('codex'),
          defaultEffortOf: (model: string) => defaultEffortOf('codex', model),
          pool: () => poolAdapter,
          speedFor: (sessionId: string | undefined, model: string): boolean | Promise<boolean> =>
            sessionId !== undefined
            && speedBySession.get(sessionId) === 'fast'
            && adapter.supportsFastTier(model),
        })
        codexAdapter = adapter
        registerTrackedAdapter('codex', adapter)
        break
      }
      case 'claude': {
        const tokens = new AccountTokenManager<ClaudeSession>({
          provider: 'claude',
          displayName: 'Claude (Subscription)',
          makeOptions: () => ({
            preemptMs: CLAUDE_PREEMPT_MS,
            // Only keychain-imported accounts sync with Claude Code's own
            // credential store; OAuth accounts refresh standalone so several
            // accounts never fight over the Keychain entry.
            refresh: session =>
              session.keychainBound === true ? refreshClaudeSynced(session, refreshClaude) : refreshClaude(session),
            isPermanent: isClaudePermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('claude', account) },
        })
        claudeTokens = tokens
        accountTokens.set('claude', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.claude = async (account, signal) =>
          fetchClaudeUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new ClaudeAdapter({
          models: catalog.claude,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('claude'),
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('claude'),
          defaultEffortOf: (model: string) => defaultEffortOf('claude', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('claude', adapter)
        break
      }
      case 'grok': {
        const tokens = new AccountTokenManager<GrokSession>({
          provider: 'grok',
          displayName: 'Grok (Subscription)',
          makeOptions: () => ({
            preemptMs: GROK_PREEMPT_MS,
            refresh: refreshGrok,
            isPermanent: isGrokPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('grok', account) },
        })
        grokTokens = tokens
        accountTokens.set('grok', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.grok = async (account, signal) =>
          fetchGrokUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new GrokAdapter({
          models: catalog.grok,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('grok'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('grok'),
          defaultEffortOf: (model: string) => defaultEffortOf('grok', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('grok', adapter)
        break
      }
      case 'copilot': {
        const tokens = new AccountTokenManager<CopilotSession>({
          provider: 'copilot',
          displayName: 'GitHub Copilot',
          makeOptions: () => ({
            preemptMs: COPILOT_PREEMPT_MS,
            refresh: refreshCopilot,
            isPermanent: isCopilotPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('copilot', account) },
        })
        accountTokens.set('copilot', tokens as AccountTokenManager<StoredSession>)
        copilotAdapter = new CopilotAdapter({
          models: catalog.copilot,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('copilot'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (per-model vision support,
          // context windows) survives restarts and network failures.
          catalogStore: catalogStore('copilot'),
          defaultEffortOf: (model: string) => defaultEffortOf('copilot', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('copilot', copilotAdapter)
        break
      }
      case 'agy': {
        const tokens = new AccountTokenManager<AgySession>({
          provider: 'agy',
          displayName: 'Antigravity',
          makeOptions: () => ({
            preemptMs: AGY_PREEMPT_MS,
            refresh: refreshAgy,
            isPermanent: isAgyPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('agy', account) },
        })
        accountTokens.set('agy', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.agy = async (account, signal) =>
          fetchAgyUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new AgyAdapter({
          models: catalog.agy,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('agy'),
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('agy'),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('agy', adapter)
        break
      }
      case 'commandcode': {
        const tokens = new AccountTokenManager<CommandCodeSession>({
          provider: 'commandcode',
          displayName: 'Command Code',
          makeOptions: () => ({
            preemptMs: COMMANDCODE_PREEMPT_MS,
            refresh: refreshCommandCode,
            isPermanent: isCommandCodePermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('commandcode', account) },
        })
        accountTokens.set('commandcode', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.commandcode = async (account, signal) =>
          fetchCommandCodeUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new CommandCodeAdapter({
          models: catalog.commandcode,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('commandcode'),
          onWarn,
          resolveAttachments,
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('commandcode', adapter)
        break
      }
      case 'cline': {
        // Cline is API-key only: a static `sk_…` credential with no OAuth grant
        // and no refresh contract, so the login path is a paste.
        const tokens = new AccountTokenManager<ClineSession>({
          provider: 'cline',
          displayName: 'Cline',
          makeOptions: () => ({
            preemptMs: CLINE_PREEMPT_MS,
            refresh: refreshCline,
            isPermanent: isClinePermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('cline', account) },
        })
        accountTokens.set('cline', tokens as unknown as AccountTokenManager<StoredSession>)
        usageFetchers.cline = async (account, signal) => {
          const session = await tokens.session(account)
          return fetchClineUsage(session.accessToken, session.baseUrl ?? CLINE_BASE_URL, signal)
        }
        const adapter = new ClineAdapter({
          models: catalog.cline,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          pins: clinePins,
          discovery: !overridden.has('cline'),
          onWarn,
          resolveAttachments,
          defaultEffortOf: (model: string) => defaultEffortOf('cline', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('cline', adapter)
        break
      }
      case 'codebuddy': {
        const tokens = new AccountTokenManager<CodeBuddySession>({
          provider: 'codebuddy',
          displayName: 'CodeBuddy',
          makeOptions: () => ({
            preemptMs: CODEBUDDY_PREEMPT_MS,
            refresh: refreshCodeBuddy,
            isPermanent: isCodeBuddyPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('codebuddy', account) },
        })
        accountTokens.set('codebuddy', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.codebuddy = async (account, signal) =>
          fetchCodeBuddyUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new CodeBuddyAdapter({
          models: catalog.codebuddy,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('codebuddy'),
          onWarn,
          resolveAttachments,
          defaultEffortOf: (model: string) => defaultEffortOf('codebuddy', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('codebuddy', adapter)
        break
      }
      case 'trae': {
        // Trae is a multi-channel provider: credentials come from the local
        // Trae installs (TRAE SOLO CN and the Trae CN IDE) rather than an OAuth
        // flow, and the two channels expose different model rosters on the same
        // gateway. The adapter is channel-aware; `refreshTrae` is a no-op
        // because a desktop credential is re-read from disk on demand.
        const tokens = new AccountTokenManager<TraeSession>({
          provider: 'trae',
          displayName: 'Trae',
          makeOptions: () => ({
            preemptMs: TRAE_PREEMPT_MS,
            refresh: refreshTrae,
            isPermanent: isTraePermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('trae', account) },
        })
        accountTokens.set('trae', tokens as unknown as AccountTokenManager<StoredSession>)
        usageFetchers.trae = async (account, signal) => {
          const session = await tokens.session(account)
          return fetchTraeUsage(session.accessToken, session.userId ?? '', signal, proxiedFetch)
        }
        const adapter = new TraeAdapter({
          models: catalog.trae,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          channel: 'solo',
          discovery: !overridden.has('trae'),
          onWarn,
          resolveAttachments,
          defaultEffortOf: (model: string) => defaultEffortOf('trae', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('trae', adapter)
        break
      }
      case 'zed': {
        const tokens = new AccountTokenManager<ZedSession>({
          provider: 'zed',
          displayName: 'Zed Pro',
          makeOptions: () => ({
            preemptMs: ZED_PREEMPT_MS,
            refresh: refreshZed,
            isPermanent: isZedPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('zed', account) },
        })
        accountTokens.set('zed', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.zed = async (account, signal) =>
          fetchZedUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new ZedAdapter({
          models: catalog.zed,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('zed'),
          onWarn,
          resolveAttachments,
          defaultEffortOf: (model: string) => defaultEffortOf('zed', model),
          pool: () => poolAdapter,
        })
        registerTrackedAdapter('zed', adapter)
        break
      }
    }
  }

  for (const [provider, adapter] of adapters) {
    const original = adapter.listModels.bind(adapter)
    adapter.listModels = async (id: string) => filterVisible(provider, await original(id))
  }

  // Same-subscription account pools: a catalog model with ≥2 accounts of
  // that provider is served through the pool (same id, same picker group).
  // Configured tiers are extra picker rows. Built whenever enabled; a
  // provider with fewer than two accounts simply has nothing to pool.
  const poolConfig = config.pool
  const autoAccounts = poolConfig?.autoAccounts ?? poolConfig?.autoFamilies ?? true
  // Global multi-account call mode (依次 / 均衡), settable from Settings →
  // Subscriptions. The file value wins over the YAML `pool.strategy`, if any.
  const poolMode = createPoolModeController(poolConfig?.strategy, (mode) => poolAdapter?.setStrategy(mode))
  // The adapter starts on the YAML value (or 均衡); bootstrap() re-tunes it to
  // any saved file value once the async load lands.
  const poolStrategy = poolConfig?.strategy ?? 'quota_aware'
  poolMode.bootstrap()
  if (poolConfig?.enabled !== false && adapters.size >= 1) {
    // Every poll gets a hard timeout: a cold usage cache AWAITS the first
    // fetch during member selection, and a hanging usage endpoint must
    // degrade the strategy (zero urgency), not stall the user's request.
    // Copilot has no usage endpoint, so its accounts resolve no fetcher and
    // score zero urgency — the natural last resort. Every other provider delegates
    // to its registered usage fetcher.
    const fetcherFor = (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
      const fetcher = usageFetchers[provider]
      if (fetcher === undefined) return undefined
      return () => fetcher(account, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
    }
    poolHealth = new PoolHealthRegistry()
    poolUsage = new PoolUsageTracker(fetcherFor)
    const families = async (): Promise<Map<string, PoolDefinition>> => {
      const pools = new Map<string, PoolDefinition>()
      if (autoAccounts) {
        // Discover each account's catalog separately: a model only pools the
        // accounts that actually list it (Plus is not asked to serve Pro-only
        // models). A hang or discovery failure sits that account out.
        const sources: Parameters<typeof buildAccountPools>[0] = {}
        await Promise.all([...adapters].map(async ([provider, adapter]) => {
          try {
            const accounts = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
            if (accounts.length < 2) return
            const catalogs = (await Promise.all(accounts.map(async account => {
              const models = await withTimeout(
                signal => adapter.listOwnModels(provider, account, signal),
                POOL_USAGE_TIMEOUT_MS,
              )
              return models === undefined ? undefined : { account, models }
            }))).filter(entry => entry !== undefined)
            if (catalogs.length >= 2) sources[provider] = { catalogs }
          } catch {
            // Discovery failures are already reported by the owning adapter.
          }
        }))
        for (const [key, definition] of buildAccountPools(sources)) pools.set(key, definition)
      }
      for (const [id, members] of Object.entries(poolConfig?.families ?? {})) {
        if (members.length === 0) continue
        const owner = members[0].provider
        const kept = members.filter(member => member.provider === owner)
        if (kept.length < members.length) {
          onWarn(`pool "${id}": cross-provider members are ignored; only ${owner} accounts are pooled`)
        }
        pools.set(poolKey(owner, id), { members: kept })
      }
      return pools
    }
    poolAdapter = new PoolAdapter({
      adapters: Object.fromEntries(adapters),
      health: poolHealth,
      usage: poolUsage,
      strategy: poolStrategy,
      switchMargin: poolConfig?.switchMargin ?? 2,
      defaultAccount: provider => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(undefined),
      families,
      tiers: poolConfig?.tiers ?? {},
      onWarn,
    })
  }

  const speed: SpeedController = {
    async speed(sessionId) {
      return {
        tier: speedBySession.get(sessionId) ?? 'standard',
        fastModels: await codexAdapter?.fastCapableModels() ?? [],
      }
    },
    async setSpeed(sessionId, tier) {
      if (tier === 'standard') speedBySession.delete(sessionId)
      else speedBySession.set(sessionId, tier)
    },
  }
  // Per-model default effort overrides (the Settings page's model pickers).
  // The catalog re-reads the live model info per model — same source as the
  // session model picker, so the offered effort levels match the picker
  // exactly, and the configured default merges in through the adapters.
  const modelDefaults: ModelDefaultsController = {
    async catalog(): Promise<ModelDefaultsCatalog[]> {
      const visible = new Set((await ctx.llm.listProviders()).map(provider => provider.id))
      const catalog: ModelDefaultsCatalog[] = []
      for (const provider of PROVIDER_IDS) {
        if (!visible.has(provider)) continue
        let models: readonly { id: string; name: string }[] = []
        try {
          models = await ctx.llm.listModels(provider)
        } catch {
          continue // provider unregistered or catalog unavailable; leave it out
        }
        // Configured tier rows resolve through the pool, which intersects its
        // members' own capabilities and never consults defaultEffortOf for the
        // tier id — an override on one would save cleanly and do nothing. Leave
        // them out rather than offer a control that cannot take effect.
        let tierIds: ReadonlySet<string> = new Set()
        try {
          const tiers = await poolAdapter?.modelsForProvider(provider)
          if (tiers !== undefined) tierIds = new Set(tiers.map(tier => tier.id))
        } catch {
          // A pool that cannot enumerate leaves every row listed; the worst
          // case is the pre-existing behaviour, not a missing card.
        }
        const views: ModelDefaultView[] = []
        for (const model of models) {
          if (tierIds.has(model.id)) continue
          let info: LlmResolvedModelInfo | undefined
          try {
            info = await ctx.llm.resolveModelInfo(provider, model.id)
          } catch {
            continue // one broken entry must not hide the rest
          }
          if (info === undefined) continue
          // `defaultEffortOf` rather than a bare index: model ids are catalog
          // data, and an id like `toString` would otherwise inherit a function.
          const override = defaultEffortOf(provider, model.id)
          views.push({
            id: model.id,
            name: model.name,
            efforts: info.reasoning?.efforts.map(effort => ({ id: effort.id, name: effort.name })) ?? [],
            ...override === undefined ? {} : { configured: override },
          })
        }
        catalog.push({ provider, models: views })
      }
      return catalog
    },
    async set(provider, model, effort) {
      // Garbage in, garbage out: accept only levels the model's own catalog
      // actually advertises (clearing with `undefined` always passes). A value
      // from elsewhere — a hand-edited store file — would otherwise ride on
      // every request and 400. An unknown effort fails the save instead of
      // silently saving something unusable.
      if (effort !== undefined) {
        let info: LlmResolvedModelInfo | undefined
        try {
          info = await ctx.llm.resolveModelInfo(provider, model)
        } catch {
          // Fall through when the catalog is unavailable: rejecting the save
          // here would make every write fail during an outage.
        }
        const offered = info?.reasoning?.efforts ?? []
        if (offered.length > 0 && !offered.some(entry => entry.id === effort)) {
          throw new BadRequest(`model ${model} does not advertise a "${effort}" reasoning effort`)
        }
      }
      await setDefaultEffort(provider, model, effort)
      // Re-announce the route so the model picker re-queries `listModels` and
      // reflects the new default immediately (same path as auth changes).
      handles.get(provider)?.replace([provider])
    },
  }
  registerAuthRpc(ctx, new SubscriptionsAuthController(
    flows, deviceFlows, authChanged, resolveAttachments, usageFetchers, undefined, poolUsage,
  ), speed, {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy, payload.providers),
  }, modelDefaults, {
    async checkin(provider, account) {
      if (provider === 'codebuddy') {
        const tokens = accountTokens.get('codebuddy')
        if (tokens === undefined) return { ok: false, message: 'CodeBuddy is not registered' }
        const res = await checkinCodeBuddy(await tokens.session(account) as CodeBuddySession)
        if (res.ok) await recordManualCheckin(res.message).catch(() => undefined)
        return res
      }
      if (provider === 'trae') {
        const tokens = accountTokens.get('trae')
        if (tokens === undefined) return { ok: false, message: 'Trae is not registered' }
        const session = await tokens.session(account) as TraeSession
        const res = await claimTraeCheckin(session.accessToken, session.userId ?? '')
        if (res.ok) await recordTraeCheckin(res.message).catch(() => undefined)
        return { ok: res.ok, message: res.message }
      }
      return { ok: false, message: 'Check-in is only available for CodeBuddy and Trae' }
    },
    async checkinStatus(provider) {
      if (provider === 'trae') return getTraeCheckinStatusView()
      return getCodeBuddyCheckinStatus()
    },
    async visibility(provider) {
      const adapter = adapters.get(provider)
      if (adapter === undefined) return []
      const models = await adapter.listOwnModels(provider)
      const modelIds = models.map(m => m.id)
      const { hidden, unread } = await syncDiscoveredModels(provider, modelIds)
      return models.map(model => {
        // The vendor is resolved here rather than in the browser, so the client
        // bundle carries no vendor table. It is absent when unknown, never guessed.
        const vendor = modelVendor(model.id)
        const modalities = model.inputModalities
        return {
          id: model.id,
          name: model.name,
          visible: !hidden.has(model.id),
          unread: unread.has(model.id),
          ...vendor === undefined ? {} : { vendor: { ...vendor } },
          ...modalities === undefined ? {} : { inputModalities: [...modalities] },
        }
      })
    },
    async markModelsRead(provider) {
      if (provider !== undefined) {
        await markProviderModelsRead(provider)
      }
      return { ok: true }
    },
    async clinePins() {
      const pinned = await clinePins.allPins()
      const known = new Set<string>(Object.keys(pinned))
      for (const meta of clinePins.allMeta()) known.add(meta.id)
      const adapter = adapters.get('cline') as ClineAdapter | undefined
      if (adapter !== undefined) {
        try {
          const models = await adapter.listOwnModels('cline')
          for (const m of models) known.add(m.id)
        } catch { /* fallback to catalog */ }
      }
      for (const m of CLINE_MODEL_CATALOG) known.add(m.id)
      return [...known].map((model) => {
        const meta = clinePins.metaOf(model)
        const pin = pinned[model]
        return {
          model,
          channels: meta.upstreams ?? [],
          upstreams: pin?.upstreams ?? [],
          exclude: pin?.exclude ?? [],
          pinMode: pin?.pinMode ?? 'strict',
          sort: pin?.sort ?? '',
          ...meta.pipeline === undefined ? {} : { pipeline: meta.pipeline },
          verdicts: meta.upstreamStatus ?? {},
        }
      })
    },
    async setClinePin(model, pin) {
      await clinePins.setPin(model, {
        upstreams: pin.upstreams,
        exclude: pin.exclude,
        pinMode: pin.pinMode,
        sort: pin.sort === 'cost' || pin.sort === 'ttft' || pin.sort === 'tps' ? pin.sort : '',
      })
    },
    async probeClineChannels(model) {
      // Discover the available upstream channels for one model.
      // 1. Send a lightweight probe request to discover routing facts (pipeline type,
      //    final serving provider, and fallbacks list).
      // 2. Harvest all available providers using an impossible-pin probe with the
      //    matching pipeline spelling.
      const sessions = accountTokens.get('cline')
      if (sessions === undefined) return { channels: [] }
      const accounts = await sessions.list()
      if (accounts.length === 0) return { channels: [] }
      const session = await sessions.session(accounts[0]!.key) as ClineSession
      const base = (session.baseUrl ?? CLINE_BASE_URL).replace(/\/+$/, '')
      const headers = {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      }
      let pipeline = clinePins.metaOf(model).pipeline ?? null
      let finalProvider: string | null = null
      let fallbacks: string[] = []
      try {
        const pingResponse = await proxiedFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply with OK' }],
            max_tokens: 256,
          }),
          signal: AbortSignal.timeout(30_000),
        })
        const pingJson = await pingResponse.json().catch(() => null)
        if (pingJson !== null) {
          const r = parseRouting(pingJson)
          if (r.pipeline !== null) pipeline = r.pipeline
          if (r.finalProvider !== null) finalProvider = r.finalProvider
          if (r.fallbacks.length > 0) fallbacks = r.fallbacks
          // The provider that actually served this request is proof it exists.
          // Some models are served only by a private upstream the gateway
          // rejects an impossible `only` filter for (`openai-compatible-private`,
          // the Xiaomi/InferenceNet direct pipelines), so the real response is
          // the only place those channels are named at all.
          clinePins.learnRouting(model, r)
        }
      } catch { /* ping failed or timed out; fall back to harvest */ }

      let harvest: string[] | null = null
      try {
        const harvestBody = {
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 16,
          stream: false,
          ...(pipeline === 'planner' || pipeline === null
            ? { providerOptions: { gateway: { only: ['__probe__'] } } }
            : { provider: { only: ['__probe__'] } }),
        }
        const harvestResponse = await proxiedFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(harvestBody),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await harvestResponse.text().catch(() => '')
        harvest = extractAvailableProviders(text, pipeline)
      } catch { /* harvest failed */ }

      const observed = clinePins.metaOf(model)
      const channels = mergeUpstreams(
        harvest ?? undefined,
        fallbacks.length > 0 ? fallbacks : undefined,
        finalProvider !== null ? [finalProvider] : undefined,
        observed.upstreams,
      )
      if (channels.length > 0) {
        clinePins.learn(model, {
          upstreams: channels,
          ...pipeline === null ? {} : { pipeline },
        })
      }
      return { channels, ...pipeline === null ? {} : { pipeline } }
    },
    async validateClineChannels(model) {
      const sessions = accountTokens.get('cline')
      if (sessions === undefined) return { verdicts: {} }
      const accounts = await sessions.list()
      if (accounts.length === 0) return { verdicts: {} }
      const session = await sessions.session(accounts[0]!.key) as ClineSession
      const base = (session.baseUrl ?? CLINE_BASE_URL).replace(/\/+$/, '')
      let meta = clinePins.metaOf(model)
      // If no channels are known yet, run a zero-cost probe first to populate the list
      if (!meta.upstreams || meta.upstreams.length === 0) {
        await this.probeClineChannels?.(model)
        meta = clinePins.metaOf(model)
      }
      const list = meta.upstreams ?? []
      const pipeline = meta.pipeline ?? null
      const verdicts: Record<string, ClineUpstreamVerdict> = {}
      const batchSize = 5
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize)
        await Promise.all(batch.map(async (slug) => {
          const t0 = Date.now()
          const body = validateChannelBody(model, slug, pipeline)
          try {
            const response = await proxiedFetch(`${base}/chat/completions`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${session.accessToken}`,
                'content-type': 'application/json',
                accept: 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(60_000),
            })
            const raw = await response.text().catch(() => '')
            let status: ClineUpstreamStatus = 'unknown'
            let note = ''
            if (!response.ok) {
              status = classifyUpstreamError(raw)
              note = raw.slice(0, 160)
            } else {
              try {
                const parsed = JSON.parse(raw) as Record<string, unknown>
                if (parsed.error && !parsed.data) {
                  const msg = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)
                  status = classifyUpstreamError(msg)
                  note = msg.slice(0, 160)
                } else if ((parsed.data as Record<string, unknown> | undefined)?.choices || parsed.choices) {
                  status = 'ok'
                }
              } catch {
                status = 'ok'
              }
            }
            const verdict: ClineUpstreamVerdict = { status, note, ms: Date.now() - t0, checkedAt: Date.now() }
            verdicts[slug] = verdict
            clinePins.learnUpstream(model, slug, status, note, Date.now() - t0)
          } catch (e) {
            const note = e instanceof Error ? e.message : String(e)
            const verdict: ClineUpstreamVerdict = { status: 'unknown', note, ms: Date.now() - t0, checkedAt: Date.now() }
            verdicts[slug] = verdict
            clinePins.learnUpstream(model, slug, 'unknown', note, Date.now() - t0)
          }
        }))
      }
      return { verdicts }
    },
    /**
     * One-click channel setup: probe, measure, pin the working channels fastest
     * first, exclude the broken, then verify with a real request.
     *
     * Pinning a dead channel is this route's main failure mode, and doing it by
     * hand means three separate actions per model (probe, validate, then pin each
     * channel in the right order). This does all of it from measurement rather
     * than from a hand-written list, and — the part that matters most — pins
     * NOTHING when no measurement says a channel works, leaving the model on
     * automatic routing instead.
     */
    async clineAutoConfigure(model) {
      const shape: ClineAutoConfigureView = {
        model, ok: false, stage: 'probe', error: '', pipeline: '',
        channels: [], pinned: [], excluded: [], available: [], rateLimited: [], unusable: [],
        verified: false, actual: '',
        summary: { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 },
      }

      const probe = await this.probeClineChannels?.(model)
      if (probe === undefined) return { ...shape, error: 'Cline pinning is unavailable' }
      shape.pipeline = probe.pipeline ?? ''
      shape.channels = [...probe.channels]
      shape.stage = 'discover'
      if (shape.channels.length === 0) {
        return {
          ...shape,
          error: 'the gateway disclosed no channels for this model; it stays on automatic routing',
        }
      }

      const validated = await this.validateClineChannels?.(model)
      // The ranking is a pure decision, so it lives in its own module where it
      // can be tested without any I/O.
      const plan = planClinePin(shape.channels, (validated?.verdicts ?? {}) as ClineChannelVerdicts)
      shape.available = plan.available
      shape.rateLimited = plan.rateLimited
      shape.unusable = plan.unusable
      shape.summary = plan.summary

      shape.stage = 'pin'
      await this.setClinePin?.(model, {
        upstreams: plan.upstreams,
        exclude: plan.exclude,
        pinMode: plan.pinMode,
        sort: plan.sort,
      })
      const stored = (await clinePins.allPins())[model]
      shape.pinned = [...(stored?.upstreams ?? [])]
      shape.excluded = [...(stored?.exclude ?? [])]

      if (plan.upstreams.length === 0) {
        return {
          ...shape,
          stage: 'done',
          error: 'no channel answered for this model; it stays on automatic routing',
        }
      }

      // Verification is a REAL request made AFTER the pin is saved, so it goes
      // through the config the next turn will use. Re-probing is exactly that:
      // the probe sends a plain completion request and learns which upstream
      // served it.
      shape.stage = 'verify'
      try {
        const verify = await this.probeClineChannels?.(model)
        const served = clinePins.metaOf(model).lastProvider ?? null
        shape.actual = served ?? ''
        shape.verified = verify !== undefined && verify.channels.length > 0 && served !== null
      } catch (error) {
        shape.verified = false
        shape.error = error instanceof Error ? error.message : String(error)
      }
      shape.stage = 'done'
      shape.ok = shape.verified && shape.pinned.length > 0
      if (!shape.verified && shape.error === '') {
        shape.error = 'the pin was saved but the verification request reported no serving upstream'
      }
      return shape
    },
    async setVisible(provider, model, visible) {
      await setModelVisible(provider, model, visible)
      handles.get(provider)?.replace([provider])
    },
    async refreshModels(provider) {
      if (provider === 'codex' || provider === undefined) {
        codexVersionCache.invalidate()
      }
      if (provider !== undefined) {
        adapters.get(provider)?.clearAccountCatalog()
        handles.get(provider)?.replace([provider])
      } else {
        for (const [, a] of adapters) a.clearAccountCatalog()
        for (const [id, h] of handles) h.replace([id])
      }
      return { ok: true }
    },
  }, poolMode)

  const codebuddyTokens = accountTokens.get('codebuddy') as AccountTokenManager<CodeBuddySession> | undefined
  if (codebuddyTokens !== undefined) {
    const tokens = codebuddyTokens
    const runCheckin = (): void => {
      void tokens.list().then(async accounts => {
        const sessions: CodeBuddySession[] = []
        for (const { key } of accounts) {
          try { sessions.push(await tokens.session(key)) } catch { /* skip dead accounts */ }
        }
        await autoCheckinCodeBuddy(sessions)
      }).catch(() => undefined)
    }
    runCheckin()
    // Check every minute so the morning check-in fires within 60s of the randomly chosen time before 8:00 AM
    const checkinTimer = setInterval(runCheckin, 60_000)
    ctx.effect(() => () => { clearInterval(checkinTimer) }, 'dsh-subscription-hub: codebuddy auto check-in')
  }

  // Trae's daily check-in follows the same CodeBuddy cadence: a random time
  // before 08:00, catching up on the next start if DSH was not running.
  const traeTokens = accountTokens.get('trae') as AccountTokenManager<TraeSession> | undefined
  if (traeTokens !== undefined) {
    const tokens = traeTokens
    const runTraeCheckin = (): void => {
      void tokens.list().then(async accounts => {
        const sessions: { accessToken: string; userId: string }[] = []
        for (const { key } of accounts) {
          try {
            const session = await tokens.session(key)
            sessions.push({ accessToken: session.accessToken, userId: session.userId ?? '' })
          } catch { /* skip dead accounts */ }
        }
        await autoCheckinTrae(sessions)
      }).catch(() => undefined)
    }
    runTraeCheckin()
    const traeCheckinTimer = setInterval(runTraeCheckin, 60_000)
    ctx.effect(() => () => { clearInterval(traeCheckinTimer) }, 'dsh-subscription-hub: trae auto check-in')
  }

  // Proactively keep keychain-bound Claude accounts synced with Claude Code's
  // own store (Keychain/file) every 5 minutes, so a session left idle between
  // requests does not go stale from a token rotation that happened outside
  // this plugin (the `claude` CLI refreshing on its own, or another
  // consumer). OAuth-only accounts refresh on demand and are not touched.
  if (claudeTokens !== undefined) {
    const tokens = claudeTokens
    const syncTimer = setInterval(() => {
      void tokens.list().then((accounts) => {
        for (const { key, session } of accounts) {
          if (session.keychainBound !== true) continue
          tokens.session(key).catch(() => {
            // Best-effort: TokenManager already surfaces failures via onRemoved.
          })
        }
      }, () => undefined)
    }, 5 * 60_000)
    ctx.effect(() => () => { clearInterval(syncTimer) }, 'dsh-subscription-hub: claude background sync timer')
  }

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // x_search and video_generate follow the grok provider; image_generate
  // prefers the codex provider and falls back to grok.
  ctx.inject(['tools'], (toolsCtx) => {
    if (grokTokens !== undefined) {
      registerWithAlias(toolsCtx.tools, createXSearchTool({ tokens: grokTokens }))
      registerWithAlias(toolsCtx.tools, createVideoGenerateTool({ tokens: grokTokens }))
    }
    if (codexTokens !== undefined || grokTokens !== undefined) {
      registerWithAlias(toolsCtx.tools, createImageGenerateTool({
        imagePool,
        ...codexTokens === undefined ? {} : { codexTokens },
        ...grokTokens === undefined ? {} : { grokTokens },
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
      }))
    }
  })
}

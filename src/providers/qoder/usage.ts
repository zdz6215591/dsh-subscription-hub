/**
 * Qoder subscriber profile, quota, plan and status — plus the hub's usage shape.
 *
 * Upstream reports a Qoder account's allowance as up to three independent credit
 * PACKAGES, not as one window:
 *
 *  - `userQuota` — the plan's own credits;
 *  - `orgResourcePackage` — the team pool, present only for organization seats;
 *  - `addOnQuota` — bonus credits granted beside the plan (the daily
 *    campaign's 100, for one).
 *
 * Each carries its own total, used and remaining, so collapsing them into one
 * number loses the account's real shape: the reference observed a live account
 * reporting two packages where the plugin showed one. They are therefore mapped
 * onto one {@link UsageWindow} each, plus pool-wide `remaining`/`limit` totals.
 *
 * Ported from `masknull/dsh-qoder-connect` `src/qoder/account.ts` and
 * `src/qoder/transport/account-reader.ts` (MIT). The reference's own
 * `QoderQuotaUsage` shape is preserved verbatim for the fields that come from
 * the wire; `qoderProviderUsage` is the hub-facing projection.
 *
 * @module dsh-subscription-hub/providers/qoder/usage
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../../http.js'
import type { ProviderUsage, UsageWindow } from '../common.js'
import type { QoderAuthService } from './auth.js'
import { isQoderAuthRejection, qoderError, QODER_ABORTED_CODE, QODER_MISSING_CREDENTIAL_CODE } from './errors.js'
import type { QoderLogger } from './logging.js'
import { getQoderUsageUrl, getQoderUserPlanUrl, getQoderUserStatusUrl } from './region.js'
import type { QoderRegion } from './region.js'
import { opaqueCredentialKey, openApiJsonRequest, retryMetadataRead, SingleFlight } from './request.js'

const defaultUsageTtlMs = 60_000
const defaultUsageTimeoutMs = 15_000

/** The authenticated subscriber's identity. */
export interface QoderSubscriberProfile {
  id: string
  name: string
  email: string
}

/** One credit package. */
export interface QoderQuota {
  total: number
  used: number
  remaining: number
  /** Percentage consumed, 0–100 (the wire may express it as a 0–1 ratio). */
  percentage: number
  unit: string
}

/** Every credit package the account holds, plus the account-wide figures. */
export interface QoderQuotaUsage {
  userQuota?: QoderQuota | undefined
  orgResourcePackage?: QoderQuota | undefined
  /**
   * Credits granted on top of the plan — the daily campaign's 100, for one.
   *
   * A separate bucket upstream reports beside `userQuota`; it carries its own
   * total and remaining, so leaving it out made the card show fewer packages
   * than the account actually holds (two on the web, one here).
   */
  addOnQuota?: QoderQuota | undefined
  totalUsagePercentage?: number | undefined
  isQuotaExceeded?: boolean | undefined
  expiresAt?: string | undefined
  raw?: unknown
}

/** The organization a seat belongs to, when the account is not personal. */
export interface QoderSubscriberOrganization {
  orgId: string
  orgName: string
  roleName?: string | undefined
  isSuspended?: boolean
  canManageSubscriptions?: boolean
  resourcePackageFeatureEnabled?: boolean
}

/** Per-feature entitlement flags. */
export interface QoderSubscriberFeatureAllowed {
  quest?: boolean
  wiki?: boolean
  codeReview?: boolean
}

/** The subscription plan. */
export interface QoderSubscriberPlan {
  userType: string
  planTierName: string
  planTier?: string
  isPersonalVersion: boolean
  isHighestTier?: boolean
  isRenewed?: boolean
  startDate?: string
  endDate?: string
  organization?: QoderSubscriberOrganization
  featureAllowed?: QoderSubscriberFeatureAllowed
  raw?: unknown
}

/** Account-level feature switches. */
export interface QoderSubscriberStatus {
  allowByok: number
  teamAllowByok?: number
  isPrivacyPolicyModifiable?: boolean
  raw?: unknown
}

/** One complete usage read. */
export interface QoderAccountInfo {
  profile: QoderSubscriberProfile
  usage?: QoderQuotaUsage
  plan?: QoderSubscriberPlan
  status?: QoderSubscriberStatus
  updatedAt: string
}

interface RawQuota {
  total?: number
  cap?: number
  used?: number
  remaining?: number
  percentage?: number
  unit?: string
  available?: boolean
}

interface RawUsageInfo {
  userQuota?: RawQuota
  orgResourcePackage?: RawQuota
  /** Bonus credits granted beside the plan (the daily campaign's 100). */
  addOnQuota?: RawQuota
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: number | string
  userType?: string
  upgradeUrl?: string
}

/**
 * Normalize one raw credit package.
 *
 * Total is read from `total`, then `cap`, then `used + remaining` — upstream
 * omits it on the organization package, which reports a cap and a remaining but
 * no total. A `percentage` below 1 alongside a total above 1 is read as a 0–1
 * ratio, which is how the live endpoint expresses 3% as `0.03`.
 * @param raw - the raw package, or undefined when the account has none.
 * @returns the normalized package, or undefined when there was nothing to read.
 */
export function normalizeQoderQuota(raw?: RawQuota): QoderQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total)
    ? raw.total
    : (typeof raw.cap === 'number' && Number.isFinite(raw.cap)
      ? raw.cap
      : (typeof raw.remaining === 'number' && typeof raw.used === 'number'
        ? raw.used + raw.remaining
        : 0))
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? raw.used : 0
  const remaining = typeof raw.remaining === 'number' && Number.isFinite(raw.remaining)
    ? raw.remaining
    : Math.max(0, total - used)

  let percentage: number
  if (typeof raw.percentage === 'number' && Number.isFinite(raw.percentage)) {
    percentage = raw.percentage <= 1 && total > 1 ? raw.percentage * 100 : raw.percentage
  } else {
    percentage = total > 0 ? (used / total) * 100 : 0
  }

  const unit = typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : 'credits'

  return { total, used, remaining, percentage, unit }
}

/**
 * Normalize an expiry, which upstream reports as either epoch milliseconds or a date string.
 * @param rawExpires - the raw value.
 * @returns the ISO-8601 instant, or undefined when nothing parseable was sent.
 */
export function normalizeQoderExpiresAt(rawExpires?: number | string): string | undefined {
  if (rawExpires === undefined || rawExpires === null) return undefined
  if (typeof rawExpires === 'number' && rawExpires > 0) {
    return new Date(rawExpires).toISOString()
  }
  if (typeof rawExpires === 'string' && rawExpires.length > 0) {
    const parsed = Date.parse(rawExpires)
    if (!Number.isNaN(parsed) && parsed > 0) return new Date(parsed).toISOString()
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

function normalizeOrganization(raw: unknown): QoderSubscriberOrganization | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const orgId = asString(obj.org_id) ?? asString(obj.orgId) ?? asString(obj.id)
  const orgName = asString(obj.org_name) ?? asString(obj.orgName) ?? asString(obj.name)
  if (!orgId || !orgName) return undefined
  const roleName = asString(obj.role_name) ?? asString(obj.roleName)
  return {
    orgId,
    orgName,
    ...roleName === undefined ? {} : { roleName },
    isSuspended: asBoolean(obj.is_suspended) ?? asBoolean(obj.isSuspended) ?? false,
    canManageSubscriptions: asBoolean(obj.can_manage_subscriptions) ?? asBoolean(obj.canManageSubscriptions) ?? false,
    resourcePackageFeatureEnabled: asBoolean(obj.resource_package_feature_enabled) ?? asBoolean(obj.resourcePackageFeatureEnabled) ?? false,
  }
}

function normalizeFeatureAllowed(raw: unknown): QoderSubscriberFeatureAllowed | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  return {
    quest: asBoolean(obj.quest) ?? false,
    wiki: asBoolean(obj.wiki) ?? false,
    codeReview: asBoolean(obj.code_review) ?? asBoolean(obj.codeReview) ?? false,
  }
}

/**
 * Normalize the `user/plan` payload.
 * @param raw - the parsed plan body.
 * @returns the plan, or undefined when it disclosed neither a user type nor a tier name.
 */
export function normalizeQoderPlan(raw: unknown): QoderSubscriberPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const userType = asString(obj.user_type) ?? asString(obj.userType)
  const planTierName = asString(obj.plan_tier_name) ?? asString(obj.planTierName) ?? asString(obj.plan_name) ?? asString(obj.planName)
  if (!userType || !planTierName) return undefined

  const organization = normalizeOrganization(obj.organization)
  const isPersonalVersion = asBoolean(obj.is_personal_version) ?? asBoolean(obj.isPersonalVersion) ?? (organization === undefined)
  const startDate = normalizeQoderExpiresAt(obj.start_date as number | string ?? obj.startDate as number | string)
  const endDate = normalizeQoderExpiresAt(obj.end_date as number | string ?? obj.endDate as number | string)
  const planTier = asString(obj.plan_tier) ?? asString(obj.planTier)
  const isHighestTier = asBoolean(obj.is_highest_tier) ?? asBoolean(obj.isHighestTier)
  const isRenewed = asBoolean(obj.is_renewed) ?? asBoolean(obj.isRenewed)
  const featureAllowed = normalizeFeatureAllowed(obj.feature_allowed ?? obj.featureAllowed)

  return {
    userType,
    planTierName,
    ...planTier !== undefined ? { planTier } : {},
    isPersonalVersion,
    ...isHighestTier !== undefined ? { isHighestTier } : {},
    ...isRenewed !== undefined ? { isRenewed } : {},
    ...startDate !== undefined ? { startDate } : {},
    ...endDate !== undefined ? { endDate } : {},
    ...organization !== undefined ? { organization } : {},
    ...featureAllowed !== undefined ? { featureAllowed } : {},
    raw,
  }
}

/**
 * Normalize the `user/status` payload.
 * @param raw - the parsed status body.
 * @returns the status, or undefined when the body was not an object.
 */
export function normalizeQoderStatus(raw: unknown): QoderSubscriberStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const featureSwitches = (obj.featureSwitches ?? obj.feature_switches) as Record<string, unknown> | undefined
  const teamSwitches = (obj.teamSwitches ?? obj.team_switches) as Record<string, unknown> | undefined
  const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0
  const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok)
  const isPrivacyPolicyModifiable = asBoolean(obj.isPrivacyPolicyModifiable ?? obj.is_data_policy_modifiable)

  return {
    allowByok,
    ...teamAllowByok !== undefined ? { teamAllowByok } : {},
    ...isPrivacyPolicyModifiable !== undefined ? { isPrivacyPolicyModifiable } : {},
    raw,
  }
}

/** Parse a wire package into a display window. */
function quotaWindow(kind: string, quota: QoderQuota | undefined, resetsAt: number | undefined): UsageWindow | undefined {
  if (quota === undefined) return undefined
  return {
    kind: 'other',
    scope: kind,
    usedPercent: Math.min(100, Math.max(0, quota.percentage)),
    remaining: quota.remaining,
    limit: quota.total,
    used: quota.used,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/**
 * Project one usage read onto the hub's `ProviderUsage` shape.
 *
 * Each credit package becomes its own window, and `remaining`/`limit` are the
 * sums across the packages actually present — the total allowance the account
 * holds, which is what the composer pill shows. `supported` is false only when
 * the read carried no package at all (the endpoint answered, the account has
 * nothing to report, or the read degraded).
 * @param account - one usage read.
 * @returns the hub-facing usage.
 */
export function qoderProviderUsage(account: QoderAccountInfo): ProviderUsage {
  const usage = account.usage
  if (usage === undefined) return { supported: false }
  const resetsAt = usage.expiresAt === undefined ? undefined : Date.parse(usage.expiresAt)
  const resetAt = resetsAt !== undefined && Number.isFinite(resetsAt) ? resetsAt : undefined

  const windows: UsageWindow[] = []
  for (const [scope, quota] of [
    ['plan', usage.userQuota],
    ['org', usage.orgResourcePackage],
    ['add-on', usage.addOnQuota],
  ] as const) {
    const window = quotaWindow(scope, quota, resetAt)
    if (window !== undefined) windows.push(window)
  }
  if (windows.length === 0) return { supported: false }

  let remaining = 0
  let limit = 0
  for (const window of windows) {
    remaining += window.remaining ?? 0
    limit += window.limit ?? 0
  }
  const plan = account.plan?.planTierName ?? account.plan?.planTier ?? account.plan?.userType
  return {
    supported: true,
    windows,
    remaining,
    limit,
    ...plan === undefined ? {} : { plan },
  }
}

/** Construction options for {@link QoderUsageReader}. */
export interface QoderUsageReaderOptions {
  /** The authenticated credential source, shared with the chat path. */
  authService: QoderAuthService
  /** Fetcher to use; defaults to the hub's proxy-aware fetch. */
  fetchFn?: typeof fetch | undefined
  /** How long one successful read is trusted. */
  ttlMs?: number | undefined
  /** Deadline for each underlying request. */
  timeoutMs?: number | undefined
  /** Which deployment to read. */
  region?: QoderRegion | undefined
  /** Diagnostic sink. */
  logger?: QoderLogger | undefined
}

/**
 * Cached, single-flight reader of one account's profile, quota, plan and status.
 *
 * The quota read is the only REQUIRED call; plan and status are additive and
 * degrade to undefined, because a subscription that cannot answer for its plan
 * still has a usable allowance, and failing the whole read would blank the card.
 * A cached job token the upstream has started rejecting is re-exchanged once.
 */
export class QoderUsageReader {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly region: QoderRegion
  private readonly logger: QoderLogger | undefined
  private readonly cache = new Map<string, { info: QoderAccountInfo; expiresAt: number }>()
  private readonly flights = new SingleFlight<QoderAccountInfo>()

  constructor(options: QoderUsageReaderOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetchFn ?? proxiedFetch
    this.ttlMs = options.ttlMs ?? defaultUsageTtlMs
    this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  /**
   * Read the account, from cache when a fresh entry exists.
   * @param pat - the account's Personal Access Token.
   * @param options - `force` bypasses the cache; `signal` cancels this caller.
   * @returns the completed read.
   * @throws LlmError `MISSING_CREDENTIAL` for an absent PAT.
   */
  async readAccount(
    pat: string,
    options?: { force?: boolean | undefined; signal?: AbortSignal | undefined },
  ): Promise<QoderAccountInfo> {
    if (!pat || typeof pat !== 'string') {
      throw qoderError(
        'Qoder Personal Access Token is missing or invalid.',
        QODER_MISSING_CREDENTIAL_CODE,
      )
    }

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    if (!options?.force) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.info
      }
    }

    return this.flights.run(
      cacheKey,
      options?.signal,
      sharedSignal => this.loadAccount(pat, sharedSignal, cacheKey),
      () => qoderError('Qoder account request was aborted.', QODER_ABORTED_CODE),
    )
  }

  /**
   * Drop cached usage: one PAT's entry, or every entry when omitted.
   * @param pat - the PAT to forget, or undefined to clear the whole cache.
   */
  clear(pat?: string): void {
    if (pat) {
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }

  private async loadAccount(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    try {
      return await this.loadAccountWith(pat, signal, cacheKey)
    } catch (error) {
      // The cached job token can outlive the upstream's acceptance of it; one
      // fresh exchange self-heals that window instead of surfacing the card's
      // quota read as an auth failure until the next credential save.
      if (!isQoderAuthRejection(error) || signal.aborted) throw error
      this.logger?.warn?.('[Qoder Account] Usage read rejected as unauthorized; exchanging a fresh job token and retrying once')
    }
    this.authService.clear(pat)
    return this.loadAccountWith(pat, signal, cacheKey)
  }

  private async loadAccountWith(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    const creds = await this.authService.getCredentials(pat, signal)
    const profile: QoderSubscriberProfile = {
      id: creds.userID,
      name: creds.name || 'Qoder User',
      email: creds.email || '',
    }

    const [usage, plan, status] = await Promise.all([
      retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, signal)),
      this.safeFetchPlan(creds.authToken, signal),
      this.safeFetchStatus(creds.authToken, creds.machineID, signal),
    ])

    const accountInfo: QoderAccountInfo = {
      profile,
      usage,
      ...plan !== undefined ? { plan } : {},
      ...status !== undefined ? { status } : {},
      updatedAt: new Date().toISOString(),
    }

    this.cache.set(cacheKey, {
      info: accountInfo,
      expiresAt: Date.now() + this.ttlMs,
    })

    return accountInfo
  }

  private async fetchUsage(jobToken: string, signal?: AbortSignal): Promise<QoderQuotaUsage> {
    const data = await openApiJsonRequest<RawUsageInfo>(this.fetchImpl, {
      url: getQoderUsageUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Usage',
      logCategory: 'account.usage',
    })

    return {
      userQuota: normalizeQoderQuota(data.userQuota),
      orgResourcePackage: normalizeQoderQuota(data.orgResourcePackage),
      addOnQuota: normalizeQoderQuota(data.addOnQuota),
      totalUsagePercentage: typeof data.totalUsagePercentage === 'number' ? data.totalUsagePercentage : undefined,
      isQuotaExceeded: typeof data.isQuotaExceeded === 'boolean' ? data.isQuotaExceeded : false,
      expiresAt: normalizeQoderExpiresAt(data.expiresAt),
      raw: data,
    }
  }

  private async fetchPlan(jobToken: string, signal?: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserPlanUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Plan',
      logCategory: 'account.plan',
    })
    return normalizeQoderPlan(data)
  }

  private async safeFetchPlan(jobToken: string, signal: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    try {
      return await this.fetchPlan(jobToken, signal)
    } catch (error) {
      if (signal.aborted) throw error
      this.logger?.warn?.('[Qoder Plan] Failed to load user plan (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  private async fetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserStatusUrl(this.region),
      token: jobToken,
      machineId,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Status',
      logCategory: 'account.status',
    })
    return normalizeQoderStatus(data)
  }

  private async safeFetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    try {
      return await this.fetchStatus(jobToken, machineId, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      this.logger?.warn?.('[Qoder Status] Failed to load user status (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }
}

/**
 * Read the account, or report `supported: false` when the credential was refused.
 *
 * The hub's per-provider usage hook returns a shape rather than throwing, so a
 * read that degrades (503 on the quota route, a revoked PAT) still leaves the
 * card renderable.
 * @param reader - the reader to use.
 * @param pat - the account's Personal Access Token.
 * @param signal - caller cancellation.
 * @returns the hub-facing usage.
 */
export async function fetchQoderUsage(
  reader: QoderUsageReader,
  pat: string,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  try {
    return qoderProviderUsage(await reader.readAccount(pat, { ...signal === undefined ? {} : { signal } }))
  } catch (error) {
    // Cancellation is the caller's own business; anything else is "no usage to show".
    if (error instanceof LlmError && error.code === QODER_ABORTED_CODE) throw error
    return { supported: false }
  }
}

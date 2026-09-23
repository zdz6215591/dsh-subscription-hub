/**
 * PAT exchange and in-memory Qoder job-token lifecycle.
 *
 * A Qoder credential is two-step: a long-lived Personal Access Token is
 * exchanged for a short-lived JOB token, and only the job token can sign a
 * gateway request. The job token is therefore cached in memory per (region,
 * PAT) — never persisted, because it expires on the provider's schedule and
 * re-deriving it costs one round trip — and refreshed inside a preempt window
 * so a request in flight does not have to fail first.
 *
 * The single-flight is the load-bearing part: the chat path, the catalog sweep
 * and the quota poll all want a token, and without sharing they would each mint
 * one. A departing waiter therefore must NOT be able to abort the exchange the
 * others are still waiting on — but a flight nobody is waiting for any more is
 * cancelled at once, because a job token minted for nobody is pure waste.
 *
 * Ported from `masknull/dsh-qoder-connect` `src/qoder/transport/auth.ts` (MIT);
 * the injected fetcher is named `fetchFn` and defaults to the hub's
 * proxy-aware fetch. One addition: {@link QoderAuthService.inspectPat} exposes
 * the exchange WITHOUT the cache, reporting the token's expiry, so a login
 * paste can validate a PAT and build a session from one round trip.
 *
 * @module dsh-subscription-hub/providers/qoder/auth
 */

import type { CosyCredentials } from './cosy.js'
import { getQoderExchangeUrl, getQoderUserInfoUrl } from './region.js'
import type { QoderRegion } from './region.js'
import { qoderError, QODER_ABORTED_CODE, QODER_MISSING_CREDENTIAL_CODE } from './errors.js'
import type { QoderLogger } from './logging.js'
import { getMachineId } from './machine-id.js'
import { opaqueCredentialKey, openApiJsonRequest, retryMetadataRead } from './request.js'
import { proxiedFetch } from '../../http.js'

/**
 * How long before expiry a cached job token is considered stale.
 *
 * Five minutes is longer than any single Qoder request, so an exchange is never
 * started with a token that would expire mid-flight.
 */
const expiryBufferMs = 5 * 60 * 1000
/**
 * Assumed lifetime when the exchange discloses neither `expires_at` nor
 * `expires_in`.
 *
 * A DEFECT inherited from the reference: nothing in the observed traffic
 * establishes a 24-hour job token, and a caller that trusts this number parks a
 * credential that may already be dead. It is harmless in this transport — every
 * request re-derives the job token from the PAT through this cache, and an
 * upstream 401 self-heals regardless — but a caller storing the value must not
 * treat it as authoritative.
 */
const defaultExpiryMs = 24 * 60 * 60 * 1000
const defaultAuthTimeoutMs = 15_000

interface CachedEntry {
  creds: CosyCredentials
  expiresAt: number
}

interface InFlightEntry {
  promise: Promise<CosyCredentials>
  controller: AbortController
  waiters: number
  settled: boolean
  timeout: ReturnType<typeof setTimeout>
}

/** Construction options for {@link QoderAuthService}. */
export interface QoderAuthServiceOptions {
  /** Fetcher to use; defaults to the hub's proxy-aware fetch. */
  fetchFn?: typeof fetch | undefined
  /** Deadline for one exchange + identity lookup. */
  timeoutMs?: number | undefined
  /** Machine-fingerprint resolver; defaults to {@link getMachineId}. */
  resolveMachineId?: (() => string) | undefined
  /** Which deployment to exchange against. */
  region?: QoderRegion | undefined
  /** Diagnostic sink. */
  logger?: QoderLogger | undefined
}

function abortedError(): Error {
  return qoderError('Qoder authentication was aborted.', QODER_ABORTED_CODE)
}

function missingPatError(): Error {
  return qoderError(
    'Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.',
    QODER_MISSING_CREDENTIAL_CODE,
  )
}

/** One exchange's outcome, with the token lifetime the exchange disclosed. */
export interface QoderJobToken {
  /** The account identity and job token to sign with. */
  credentials: CosyCredentials
  /** Epoch milliseconds the job token expires (see the 24-hour assumption note above). */
  expiresAt: number
}

/** What a validated PAT resolves to; the fields a stored session is built from. */
export interface QoderPatProbe {
  /** Upstream user id, from `/api/v1/userinfo`. */
  userId: string
  /** The exchanged job token; this is what a request authenticates with. */
  jobToken: string
  /** Epoch milliseconds the job token expires. */
  expiresAt: number
  /** Display name the account reported, when it reported one. */
  name?: string
  /** Account email the account reported, when it reported one. */
  email?: string
}

/**
 * Validate a Personal Access Token and read back what a session needs.
 *
 * The login/paste path uses this: a credential must be proven before it is
 * persisted, and the exchange is also what yields the identity row. It performs
 * the same two requests the transport does, WITHOUT touching the transport's
 * cache, so a refused PAT leaves no trace.
 * @param pat - the Personal Access Token the user pasted.
 * @param region - the deployment the token was minted against; a token from one
 *   deployment is refused by the other, so this must be the user's choice.
 * @param fetchFn - fetcher to use; defaults to the hub's proxy-aware fetch.
 * @param signal - caller cancellation.
 * @returns the identity and job token to build a session from.
 * @throws LlmError `MISSING_CREDENTIAL` for an empty PAT, `AUTH` when the PAT is
 *   refused (`AUTH` and `INVALID_CREDENTIAL` are the codes worth surfacing
 *   verbatim to the user), `TIMEOUT` when the deadline fired, `TRANSPORT`
 *   otherwise. All of them carry a message safe to show.
 */
export async function probeQoderPat(
  pat: string,
  region: QoderRegion = 'global',
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
): Promise<QoderPatProbe> {
  const trimmed = typeof pat === 'string' ? pat.trim() : ''
  if (trimmed === '') throw missingPatError()
  const service = new QoderAuthService({
    region,
    ...fetchFn === undefined ? {} : { fetchFn },
  })
  const { credentials, expiresAt } = await service.inspectPat(trimmed, signal)
  return {
    userId: credentials.userID,
    jobToken: credentials.authToken,
    expiresAt,
    ...credentials.name.length === 0 ? {} : { name: credentials.name },
    ...credentials.email.length === 0 ? {} : { email: credentials.email },
  }
}

async function waitForFlight(
  promise: Promise<CosyCredentials>,
  signal?: AbortSignal,
): Promise<CosyCredentials> {
  if (signal === undefined) return promise
  if (signal.aborted) throw abortedError()

  return new Promise<CosyCredentials>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * PAT → job-token exchange with an in-memory per-account cache.
 *
 * One instance per region: the cache key includes the region, so a global PAT
 * and a China PAT never share an entry even when they are the same string.
 */
export class QoderAuthService {
  private readonly cache = new Map<string, CachedEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly resolveMachineId: () => string
  private readonly region: QoderRegion
  private readonly logger: QoderLogger | undefined

  constructor(options: QoderAuthServiceOptions = {}) {
    this.fetchImpl = options.fetchFn ?? proxiedFetch
    this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs
    this.resolveMachineId = options.resolveMachineId ?? getMachineId
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  /**
   * Drop cached credentials: one PAT's entry, or every entry when omitted.
   * @param pat - the PAT to forget, or undefined to clear the whole cache.
   */
  clear(pat?: string): void {
    if (pat) {
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }

  /**
   * Exchange a fresh job token OUTSIDE the single-flight, for the self-heal
   * retry. The shared flight can be aborted by a departing concurrent waiter
   * (the quota poll, the catalog sweep), and a retry that joins it would then
   * be cancelled by a path that has nothing to do with the chat. The result
   * replaces the cache entry.
   * @param pat - the account's Personal Access Token.
   * @param signal - caller cancellation, or a fresh deadline when omitted.
   * @returns the freshly exchanged credentials.
   */
  async exchangeFresh(pat: string, signal?: AbortSignal): Promise<CosyCredentials> {
    this.clear(pat)
    const creds = await this.exchangeAndResolve(pat, signal ?? AbortSignal.timeout(this.timeoutMs))
    return creds
  }

  /**
   * Resolve usable credentials for one PAT, exchanging only when needed.
   * @param pat - the account's Personal Access Token.
   * @param signal - caller cancellation; cancelling one caller leaves the
   *   shared exchange running for the others.
   * @returns the account identity and job token to sign with.
   * @throws LlmError `MISSING_CREDENTIAL` for an absent PAT, `ABORTED` when the
   *   caller cancelled, `AUTH` when the exchange or identity lookup refused.
   */
  async getCredentials(
    pat: string,
    signal?: AbortSignal,
  ): Promise<CosyCredentials> {
    if (!pat || typeof pat !== 'string') throw missingPatError()
    if (signal?.aborted) throw abortedError()

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds

    let entry = this.inFlight.get(cacheKey)
    if (entry === undefined || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {} as InFlightEntry
      created.controller = controller
      created.waiters = 0
      created.settled = false
      created.timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
      created.promise = this.exchangeAndResolve(pat, controller.signal).finally(() => {
        created.settled = true
        clearTimeout(created.timeout)
        if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey)
      })
      entry = created
      this.inFlight.set(cacheKey, entry)
    }

    entry.waiters++
    try {
      return await waitForFlight(entry.promise, signal)
    } finally {
      entry.waiters--
      if (entry.waiters === 0 && !entry.settled) {
        if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey)
        entry.controller.abort('all callers aborted')
      }
    }
  }

  /**
   * Exchange and resolve identity without consulting or filling the cache.
   *
   * The login path uses this so a paste handler can validate a PAT and read the
   * job token's expiry from one round trip; caching it would also be harmless,
   * but a refused credential must leave no trace.
   * @param pat - the account's Personal Access Token.
   * @param signal - cancellation for both requests.
   * @returns the credentials and the disclosed (or assumed) expiry.
   */
  async inspectPat(pat: string, signal?: AbortSignal): Promise<QoderJobToken> {
    if (!pat || typeof pat !== 'string') throw missingPatError()
    return this.exchangeAndResolveJobToken(pat, signal ?? AbortSignal.timeout(this.timeoutMs))
  }

  private async exchangeAndResolve(
    pat: string,
    signal: AbortSignal,
  ): Promise<CosyCredentials> {
    const { credentials, expiresAt } = await this.exchangeAndResolveJobToken(pat, signal)
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    this.cache.set(cacheKey, { creds: credentials, expiresAt })
    return credentials
  }

  private async exchangeAndResolveJobToken(
    pat: string,
    signal: AbortSignal,
  ): Promise<QoderJobToken> {
    let jobToken: string
    let expiresAt = Date.now() + defaultExpiryMs

    const data = await openApiJsonRequest<{ token?: string; expires_at?: string; expires_in?: number }>(
      this.fetchImpl,
      {
        url: getQoderExchangeUrl(this.region),
        body: { personal_token: pat },
        signal,
        timeoutMs: this.timeoutMs,
        logger: this.logger,
        operation: 'Auth',
        logCategory: 'auth.exchange',
      },
    )
    if (!data.token) {
      throw qoderError('Qoder PAT exchange returned no job token.', 'AUTH')
    }
    jobToken = data.token
    if (data.expires_at) {
      const parsed = Date.parse(data.expires_at)
      if (!Number.isNaN(parsed)) expiresAt = parsed
    } else if (typeof data.expires_in === 'number' && data.expires_in > 0) {
      expiresAt = Date.now() + data.expires_in
    }

    const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal))
    return {
      credentials: {
        userID: userInfo.userID,
        authToken: jobToken,
        name: userInfo.name || 'Qoder User',
        email: userInfo.email,
        machineID: this.resolveMachineId(),
      },
      expiresAt,
    }
  }

  private async fetchUserInfo(
    jobToken: string,
    signal: AbortSignal,
  ): Promise<{ userID: string; email: string; name: string }> {
    const info = await openApiJsonRequest<{
      id?: string
      email?: string
      name?: string
      username?: string
    }>(this.fetchImpl, {
      url: getQoderUserInfoUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'UserInfo',
      logCategory: 'auth.user-info',
    })
    if (!info.id) {
      throw qoderError('Qoder identity lookup returned no user id.', 'AUTH')
    }
    return {
      userID: info.id,
      email: info.email ?? '',
      name: info.name ?? info.username ?? '',
    }
  }
}

/**
 * The desktop ATTEMPT lifecycle: which `cli:<uuid>` instance a turn may speak
 * for, and when this process has to open a NEW one.
 *
 * ## Why this exists (the live defect)
 *
 * Until 2026-09-29 the instance id was DERIVED from the credential
 * (`freebuffInstanceId`, FNV-1a of the token), so one account always presented
 * one `cli:<uuid>`. That is not what the CLI does, and the upstream keys its
 * whole session model on that value: `x-freebuff-desktop-attempt-id` is the
 * instance's uuid (`CV`: `D = QP($.instanceId)`, `if(D && H !== "GET")
 * L[QJA] = D`), so one attempt id = one session START. Live 2026-09-29:
 *
 *   - `POST …/session/admission` with the derived id answered, for every later
 *     turn, `409 {"status":"purchase_claim_released","accessTier":"limited",
 *     "desktopSessionCounts":{"premium":0,"unlimited":0},"desktopPurchases":[],
 *     "desktopRefunds":[]}` — the attempt's claim is gone and the upstream will
 *     not re-admit that attempt id; the account's slot is FREE (`premium:0`), so
 *     the refusal is about the dead attempt, not about capacity;
 *   - the same POST with a FRESH `cli:<uuid4>` answered
 *     `200 {"status":"active",…,"expiresAt":"…T01:40:22.188Z"}`;
 *   - a POST with a still-live instance re-admits it idempotently
 *     (`200 status:"active"`, same `admittedAt`/`expiresAt` — the hour is NOT
 *     extended), which is what makes a per-turn POST safe;
 *   - a POST that asks for a DIFFERENT model on a live instance answers
 *     `409 {"status":"purchase_claim_released",…,"desktopPurchases":[{"model":
 *     "<the held model>","expiresAt":…,"holderInstanceId":"cli:<the same>"}]}` —
 *     i.e. changing the model on a live instance releases its claim;
 *   - `DELETE /api/v1/freebuff/session/attempt` on a live attempt answers
 *     `200 {"status":"ended","desktopAttemptId":"<uuid>","refundReceiptId":…,
 *     "freebucksRefundPending":true}` and FREES the slot (a fresh attempt is
 *     admitted right after), while the closed attempt itself answers
 *     `409 {"error":"admission_attempt_closed","message":"This session start was
 *     cancelled before it finished. Start again to open a new session."}`
 *     forever.
 *
 * ## What the CLI does instead (the authority)
 *
 * The CLI mints a FRESH instance per process — `function wr(){return
 * `${eJH}${lm$()}`}` with `eJH = "cli:"` (`ZJA`) and `lm$` = `crypto.randomUUID`
 * — keeps it for the life of that session, and only replaces it when the session
 * is over:
 *
 *   - on `purchase_claim_released` the session effect marks the instance stale
 *     (`Q=!0`) and tells the user «This session was released. Choose a model to
 *     start a new session.»; the next start then mints `J = wr()`
 *     (`if(m||Q){… J=wr(), T=void 0, Q=!1}`);
 *   - on a model change it releases the slot first and then mints fresh
 *     (`zC` → `qs("rejoin",{releaseSlot: session.model !== model})` →
 *     `releaseSlot()` → `restart()` → `J = wr()`), or, if the release fails,
 *     says «You're already in an active session on X, and ending it failed, so
 *     the switch to Y was not applied. Run /end-session, then pick Y. (Sessions
 *     end on their own after 1 hour.)»;
 *   - while the session is active it records `{instanceId, model, expiresAt}`
 *     (`wJA`, which refuses a non-`cli:` id or a non-finite `expiresAt`) and
 *     heartbeats the SAME instance with `GET` + `x-freebuff-heartbeat: 1`.
 *
 * So the instance id belongs to a CLAIM, not to a credential. This module is
 * that claim: minted fresh, remembered while it is live, dropped the moment the
 * upstream says it is over.
 *
 * The reference agrees on the reuse half (`ref-freebuff2api/src/session.rs:116-126`:
 * an active session is returned as-is while `now + 5s < expires_at`; only a
 * session at/past expiry is re-created), which is where the 5 s preempt below
 * comes from.
 *
 * @module dsh-subscription-hub/providers/freebuff/claim
 */

import { createHash, randomUUID } from 'node:crypto'
import { FREEBUFF_CLI_INSTANCE_PREFIX, freebuffInstanceUuid } from './client.js'

/**
 * How long before a claim's disclosed `expiresAt` this process stops speaking
 * for it.
 *
 * The reference's own reuse rule is `Utc::now() + Duration::from_secs(5) <
 * expires` (`ref-freebuff2api/src/session.rs:120-121`), so a claim that is within
 * 5 s of its end is treated as over and the next turn opens a fresh attempt
 * instead of racing the expiry.
 */
export const FREEBUFF_CLAIM_PREEMPT_MS = 5_000

/**
 * One live presence at the upstream: the `cli:<uuid>` instance an admission was
 * accepted for, the model that admission bound it to, and when it ends.
 */
export interface FreebuffClaim {
  /** The attempt/instance id, `cli:<uuid4>` (the CLI's `wr()`). */
  instanceId: string
  /** The model the claim is bound to — the admission's `x-freebuff-model`. */
  model: string
  /** The admission's `expiresAt`, as an epoch instant, when it disclosed one. */
  expiresAt?: number
}

/** The stored record: a claim plus when this process started speaking for it. */
interface StoredClaim extends FreebuffClaim {
  /** `Date.now()` when the admission was accepted. */
  storedAt: number
}

/**
 * This process's claims, keyed by a hash of the Bearer so no raw token is kept
 * as a map key (the CLI hashes tokens for the same reason: `Rr = sha256`).
 *
 * Deliberately in-process, like the CLI's own `J` variable: the CLI's on-disk
 * records exist for crash RECOVERY across processes, which a plugin does not
 * need — and a claim this process forgets simply leaves its hour to expire. The
 * cost of that choice is named where it bites (a fresh process while the old
 * claim is still live is refused with `purchase_capacity` naming the holder).
 */
const claims = new Map<string, StoredClaim>()

/** The store key for a credential. */
function claimKey(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

/**
 * A FRESH instance id: the CLI's `wr()`, `"cli:" + crypto.randomUUID()`.
 *
 * `crypto.randomUUID()` already produces the version-4 / variant shape the
 * admission endpoint parses (live 2026-09-28 it answered
 * `400 {"error":"invalid_attempt_id"}` to a non-variant value), which is why the
 * derived id had to fake the nibbles by hand.
 * @returns a `cli:`-prefixed UUID v4.
 */
export function freebuffMintInstanceId(): string {
  return `${FREEBUFF_CLI_INSTANCE_PREFIX}${randomUUID()}`
}

/**
 * The claim this process may still speak for, or undefined.
 *
 * A claim whose disclosed `expiresAt` is within {@link FREEBUFF_CLAIM_PREEMPT_MS}
 * is treated as over and FORGOTTEN (so the next turn mints a fresh attempt)
 * rather than returned. A claim the upstream disclosed no expiry for stays
 * usable in-process: the CLI only needs `expiresAt` to hand a claim to a
 * different process (`wJA`).
 * @param credential - the Bearer the claim was admitted for.
 * @param now - the clock, injectable for tests.
 * @returns the live claim, or undefined.
 */
export function freebuffClaimOf(credential: string, now: number = Date.now()): FreebuffClaim | undefined {
  const key = claimKey(credential)
  const stored = claims.get(key)
  if (stored === undefined) return undefined
  if (stored.expiresAt !== undefined && now + FREEBUFF_CLAIM_PREEMPT_MS >= stored.expiresAt) {
    claims.delete(key)
    return undefined
  }
  return { instanceId: stored.instanceId, model: stored.model, ...stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt } }
}

/**
 * Remember an accepted admission.
 *
 * Only a `cli:`-prefixed instance is worth remembering: the attempt headers (and
 * the metadata's `surface`/`freebuff_multi_session`) ride the prefix, so a
 * server-assigned id belongs to the legacy single-session wire and is not
 * reusable here — the CLI draws the same line (`QP(H)` gates `wJA`/`_3A`).
 * @param credential - the Bearer the admission was made for.
 * @param claim - what the upstream answered.
 * @param now - the clock, injectable for tests.
 * @returns whether the claim was recorded.
 */
export function freebuffRecordClaim(
  credential: string,
  claim: FreebuffClaim,
  now: number = Date.now(),
): boolean {
  if (freebuffInstanceUuid(claim.instanceId) === undefined) return false
  claims.set(claimKey(credential), { ...claim, storedAt: now })
  return true
}

/**
 * Forget a claim — the whole claim for a credential, or one instance of it.
 *
 * The instance check matters: a reply about an attempt that has already been
 * replaced must not drop the claim its replacement just won.
 * @param credential - the Bearer.
 * @param instanceId - drop only when the stored claim is this instance.
 */
export function freebuffForgetClaim(credential: string, instanceId?: string): void {
  const key = claimKey(credential)
  const stored = claims.get(key)
  if (stored === undefined) return
  if (instanceId !== undefined && stored.instanceId !== instanceId) return
  claims.delete(key)
}

/**
 * The instance a READ (`GET /api/v1/freebuff/session`) speaks for.
 *
 * Read with the live claim's instance when there is one, so the read doubles as
 * the CLI's own 45 s heartbeat for that claim; otherwise a fresh, throwaway
 * `cli:<uuid>`, which the endpoint answers as an ordinary balance read (live
 * 2026-09-29: an unseen id and a released one both answered
 * `200 {"status":"none",…,"freebucks":{…}}`).
 * @param credential - the Bearer.
 * @returns the instance id for the read.
 */
export function freebuffReadInstanceId(credential: string): string {
  return freebuffClaimOf(credential)?.instanceId ?? freebuffMintInstanceId()
}

/**
 * Drop every recorded claim.
 *
 * For tests, which must not inherit a claim from the case before them (and for a
 * credential being removed, where its claim should not outlive it).
 */
export function freebuffResetClaims(): void {
  claims.clear()
}

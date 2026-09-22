/**
 * The Cline channel auto-configure plan: which channels to pin, in what order,
 * and which to exclude.
 *
 * Split out of the host RPC so the ranking is a pure function that can be tested
 * directly. It is the part of the one-click flow that can actually be wrong —
 * the probe and the validation are I/O, but turning their verdicts into a pin is
 * a decision, and a bad one pins a dead channel or discards a working one.
 *
 * Ported from yhshzh/dsh-cline-pass (MIT) `lib/panel.js` `setupAuto`, which
 * established the ranking and the "pin nothing when nothing works" rule.
 *
 * @module dsh-subscription-hub/providers/cline/auto-configure
 */

import type { ClineChannelVerdicts, ClineUpstreamStatus } from './pins.js'

/**
 * Verdict severity, lowest is best.
 *
 * `unknown` sits between `limited` and `bad`: a channel the probe listed but
 * validation never measured is not evidence that it works, so it is neither
 * offered as a candidate nor actively excluded. `auth` is worst because it means
 * the channel cannot serve anything until the credential changes.
 */
export const VERDICT_RANK: Readonly<Record<ClineUpstreamStatus, number>> = Object.freeze({
  ok: 0,
  limited: 1,
  unknown: 2,
  bad: 3,
  auth: 4,
})

/** The severity of one verdict, defaulting an unmeasured channel to `unknown`. */
export function rankVerdict(status: ClineUpstreamStatus | undefined): number {
  return status === undefined ? VERDICT_RANK.unknown : VERDICT_RANK[status]
}

/** The pin a plan asks the store to save. */
export interface ClineAutoPlan {
  /** Channels to try, in order: measured-ok first (fastest first), then limited. */
  upstreams: string[]
  /** Channels that cannot serve the model. */
  exclude: string[]
  pinMode: 'preferred'
  /** `ttft` when there is more than one candidate, since the order is by speed. */
  sort: string
  /** Channels measured `ok`, fastest first. */
  available: string[]
  /** Channels measured `limited`, fastest first. */
  rateLimited: string[]
  /** Channels that cannot serve the model. */
  unusable: string[]
  /** Verdict counts, so a caller can report what it found without re-counting. */
  summary: { ok: number; limited: number; bad: number; auth: number; unknown: number }
}

/**
 * Turn a probe's channel list and a validation's verdicts into a pin.
 *
 * A channel with no verdict counts as `unknown`, which is deliberately neither
 * pinned nor excluded — pinning it would be trusting an unmeasured channel, and
 * excluding it would discard one that may be fine.
 * @param channels - the channels the gateway disclosed.
 * @param verdicts - the measured verdict per channel.
 * @returns the plan; `upstreams` is empty when nothing answered.
 */
export function planClinePin(
  channels: readonly string[],
  verdicts: ClineChannelVerdicts,
): ClineAutoPlan {
  const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 }
  // Count every verdict that was measured, including one for a channel the
  // probe did not list — the counts describe the validation run, not the plan.
  for (const verdict of Object.values(verdicts)) {
    const status = verdict.status ?? 'unknown'
    if (status in summary) summary[status] += 1
  }

  const measuredMs = (channel: string): number => verdicts[channel]?.ms ?? Number.MAX_SAFE_INTEGER
  // Ties keep their original order, so an identical measurement does not shuffle
  // the pin between runs.
  const bySpeed = (list: readonly string[]): string[] =>
    [...list].sort((left, right) => measuredMs(left) - measuredMs(right))

  const available = channels.filter(channel => rankVerdict(verdicts[channel]?.status) === VERDICT_RANK.ok)
  const rateLimited = channels.filter(channel => rankVerdict(verdicts[channel]?.status) === VERDICT_RANK.limited)
  const unusable = channels.filter(channel => rankVerdict(verdicts[channel]?.status) >= VERDICT_RANK.bad)

  const fast = bySpeed(available)
  const slow = bySpeed(rateLimited)
  return {
    upstreams: [...fast, ...slow],
    exclude: unusable,
    pinMode: 'preferred',
    // A single candidate has nothing to sort between.
    sort: fast.length + slow.length > 1 ? 'ttft' : '',
    available: fast,
    rateLimited: slow,
    unusable,
    summary,
  }
}
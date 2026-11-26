/**
 * Command Code plan gating: which models an account's subscription may actually use.
 *
 * A Go-plan key lists 105 models and answers `403 MODEL_NOT_IN_PLAN` for most of
 * them. The reference provider solves this with two facts plus a rule:
 *
 *   - every model has a MINIMUM plan (`COMMANDCODE_MODEL_PLANS`, ported in
 *     `commandcode-plan-data.ts`), and plans nest: Go < GOAT < Pro < Provider/Max;
 *   - an account's tier comes from `/alpha/billing/subscriptions` (`planId`), and
 *     its on-demand credits from `/alpha/billing/credits`;
 *   - **the plan gate only applies at zero on-demand credits** — the CLI's own
 *     `evaluateModelAccess` lets every model through when the account holds any
 *     purchased or free credit.
 *
 * The rule fails OPEN in every uncertain case (no billing data, unknown plan,
 * unknown model): the server stays the authority, and hiding a model somebody paid
 * for is worse than offering one the server then refuses.
 */

import { COMMANDCODE_MODEL_PLANS } from './commandcode-plan-data.js'

export { COMMANDCODE_MODEL_PLANS } from './commandcode-plan-data.js'

/** Plan rank; a model is usable when its rank is at most the account's. */
export const COMMANDCODE_PLAN_ORDER: Readonly<Record<string, number>> = Object.freeze({
  go: 0,
  goat: 1,
  pro: 2,
  provider: 3,
  max: 4,
  ultra: 4,
})

/** Subscription plans as the billing service names them. */
export const COMMANDCODE_SUBSCRIPTION_PLANS: Readonly<Record<string, { name: string; monthlyCredits: number; tierWeight: number }>> = Object.freeze({
  'individual-go': { name: 'Go', monthlyCredits: 10, tierWeight: 0 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70, tierWeight: 1 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30, tierWeight: 2 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80, tierWeight: 2 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15, tierWeight: 3 },
  'individual-max': { name: 'Max', monthlyCredits: 150, tierWeight: 4 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300, tierWeight: 4 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40, tierWeight: 2 },
})

/** Plan-id prefixes, longest first — the CLI's own prefix-match order. */
const PLAN_PREFIXES = Object.keys(COMMANDCODE_SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length)

/**
 * The tier weight of a billing `planId`.
 *
 * @param planId - the subscription's plan id (a `priceId` is not one).
 * @returns the weight, or undefined when the plan is unknown.
 */
export function planTierWeight(planId: string | undefined): number | undefined {
  if (planId === undefined || planId === '') return undefined
  const exact = COMMANDCODE_SUBSCRIPTION_PLANS[planId]
  if (exact !== undefined) return exact.tierWeight
  for (const prefix of PLAN_PREFIXES) {
    if (planId.startsWith(prefix)) return COMMANDCODE_SUBSCRIPTION_PLANS[prefix]?.tierWeight
  }
  return undefined
}

/** The display name of a billing `planId`, when known. */
export function planDisplayName(planId: string | undefined): string | undefined {
  if (planId === undefined || planId === '') return undefined
  const exact = COMMANDCODE_SUBSCRIPTION_PLANS[planId]
  if (exact !== undefined) return exact.name
  for (const prefix of PLAN_PREFIXES) {
    if (planId.startsWith(prefix)) return COMMANDCODE_SUBSCRIPTION_PLANS[prefix]?.name
  }
  return undefined
}

/** What the picker needs to know about an account's access. */
export interface CommandCodeAccess {
  /** Tier weight on {@link COMMANDCODE_PLAN_ORDER}; undefined when unknown. */
  tierWeight?: number
  /** Purchased + free on-demand credits. */
  onDemandCredits: number
  /** `planId` as billed, for display. */
  planId?: string
  /** Display name of that plan. */
  planName?: string
}

/**
 * Whether the picker should list a model for an account with this access.
 *
 * @param modelId - the model id as the catalogue spells it.
 * @param access - the account's billing access, or undefined when unread.
 * @returns true unless the plan provably excludes the model.
 */
export function modelVisibleInPlan(modelId: string, access: CommandCodeAccess | undefined): boolean {
  // Any on-demand credit opens every model: the plan gate applies at zero balance.
  if (access !== undefined && access.onDemandCredits > 0) return true
  if (access === undefined || access.tierWeight === undefined || !Number.isFinite(access.tierWeight)) return true
  const required = COMMANDCODE_MODEL_PLANS[modelId]
  if (required === undefined) return true
  const weight = COMMANDCODE_PLAN_ORDER[required]
  if (weight === undefined) return true
  return weight <= access.tierWeight
}

/** A parsed billing answer, before the second call to the credits endpoint. */
export interface CommandCodeBillingRead {
  planId?: string
  planName?: string
  tierWeight?: number
}

/**
 * Read the plan from a `/alpha/billing/subscriptions` answer.
 *
 * @param payload - the parsed body.
 * @returns the plan facts known from it.
 */
export function parseCommandCodeSubscription(payload: unknown): CommandCodeBillingRead {
  const data = (typeof payload === 'object' && payload !== null ? payload : {}) as { data?: unknown }
  const subscription = (typeof data.data === 'object' && data.data !== null ? data.data : {}) as {
    planId?: unknown
    status?: unknown
  }
  const planId = typeof subscription.planId === 'string' ? subscription.planId : undefined
  const status = typeof subscription.status === 'string' ? subscription.status.toLowerCase() : ''
  const active = status === '' || status === 'active' || status === 'trialing'
  return {
    ...planId === undefined ? {} : { planId },
    ...planDisplayName(planId) === undefined ? {} : { planName: planDisplayName(planId) as string },
    ...!active ? {} : planTierWeight(planId) === undefined ? {} : { tierWeight: planTierWeight(planId) as number },
  }
}

/**
 * Read on-demand credits from a `/alpha/billing/credits` answer.
 *
 * Only PURCHASED and FREE credits count as on-demand: the monthly allowance is the
 * subscription itself, and counting it would open every model on a Go plan.
 *
 * @param payload - the parsed body.
 * @returns the credit total.
 */
export function parseCommandCodeOnDemandCredits(payload: unknown): number {
  const credits = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    credits?: { purchasedCredits?: unknown; freeCredits?: unknown }
  }
  const purchased = typeof credits.credits?.purchasedCredits === 'number' ? credits.credits.purchasedCredits : 0
  const free = typeof credits.credits?.freeCredits === 'number' ? credits.credits.freeCredits : 0
  return (Number.isFinite(purchased) ? purchased : 0) + (Number.isFinite(free) ? free : 0)
}

/**
 * Published per-token prices for the models the subscription routes serve, plus
 * the request-time rules that decide which rate applies.
 *
 * The savings estimate answers one question: what would this session have cost
 * at pay-as-you-go rates? That needs three things the old family-substring table
 * could not express — cache WRITE rates, time-of-day (peak/off-peak) rates, and
 * context-length tiers — and it needs them per MODEL rather than per vendor
 * substring, because the gateway routes (Cline, Command Code, Trae) resell
 * third-party models whose ids merely contain the vendor's name. Matching
 * `cline-pass/deepseek-v4.1-flash` against a `deepseek` substring rule was right
 * by accident; `cline-pass/mimo-v2.6-pro` matching nothing and taking the
 * generic default was wrong by accident.
 *
 * Source of the rates: the Command Code pricing page
 * (https://commandcode.ai/docs/resources/pricing-limits), whose embedded model
 * JSON is the only place the `timeOfDay` and `contextTiers` blocks exist. The
 * rows below are a vendored copy of that machine-readable table, cross-checked
 * against the rendered table by the reference project's sync script
 * (`ref-commandcode-provider/scripts/sync-model-prices.mjs`, whose `--check` mode
 * reports drift without writing). Re-sync from there when upstream moves; do not
 * hand-edit rates from memory.
 *
 * Three bucket rates are always published (`input`, `output`, `cacheRead`);
 * `cacheWrite` is published for a MINORITY of models. A row without it has
 * UNPRICED cache-write tokens: never invent a multiplier for them and never fold
 * them into the input rate. A published `0` is a different fact and is kept as a
 * real zero (the four GPT rows publish exactly that).
 *
 * Time-of-day rows carry a `peak` triplet: the page repeats the flat rates inside
 * its own `offPeak` block, so the top-level rates ARE the off-peak rates and only
 * the peak override is stored.
 *
 * @module dsh-subscription-hub/model-prices
 */

/** One billing bucket set, USD per 1,000,000 tokens. */
export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  /** Absent means the page publishes no cache-write rate: those tokens are unpriced. */
  cacheWrite?: number
}

/** One context band. `maxContext` is an inclusive prompt-token bound; the last band is unbounded. */
export interface ModelPriceTier {
  maxContext?: number
  rates: ModelRates
}

/** One vendored price row. */
export interface ModelPrice {
  id: string
  rates: ModelRates
  /** The peak-window override; absent for a time-of-day-free model. */
  peak?: ModelRates
  /** Context bands, ascending; the final band is unbounded. */
  tiers?: ModelPriceTier[]
}

/**
 * Peak windows in UTC hours (start inclusive, end exclusive).
 *
 * Weekday-only: see {@link isPeakPricingHour}. Peak is 7h per weekday and the
 * remaining 17h are off-peak at half price.
 */
export const PEAK_HOUR_RANGES: ReadonlyArray<readonly [number, number]> = [[1, 4], [6, 10]]

/**
 * Whether `at` (epoch ms) falls inside a peak-pricing window.
 *
 * Peak applies Monday–Friday UTC only, so a weekend timestamp is off-peak even
 * inside {@link PEAK_HOUR_RANGES}. Model-independent on purpose: whether the
 * window CHANGES this request's rate is a property of the row, which
 * {@link ratesFor} decides from its own `peak` block.
 * @param at - epoch milliseconds.
 * @returns true when the timestamp is in a weekday peak window.
 */
export function isPeakPricingHour(at: number): boolean {
  const time = new Date(at)
  const day = time.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = time.getUTCHours()
  return PEAK_HOUR_RANGES.some(([start, end]) => hour >= start && hour < end)
}

/** `[input, output, cacheRead, cacheWrite?]` */
type RateTuple = readonly [number, number, number] | readonly [number, number, number, number]
/** `[input, output, cacheRead]` */
type PeakTuple = readonly [number, number, number]

/** One vendored row: `rates`, an optional `peak` override, optional context bands. */
interface PriceRow {
  readonly id: string
  readonly rates: RateTuple
  readonly peak?: PeakTuple
  readonly tiers?: readonly { readonly maxContext?: number; readonly rates: RateTuple }[]
}

/**
 * Every published row, ordered by the page's own slug. All figures are USD per
 * 1,000,000 tokens.
 */
const PRICE_ROWS: readonly PriceRow[] = [
  { id: 'claude-fable-5', rates: [10, 50, 1, 12.5] },
  { id: 'claude-fable-5-1', rates: [10, 50, 0.25, 12.5] },
  { id: 'claude-haiku-4-5', rates: [1, 5, 0.1, 1.25] },
  { id: 'claude-opus-4-6', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-7', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-8', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-5', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-sonnet-4-6', rates: [3, 15, 0.3, 3.75] },
  { id: 'claude-sonnet-5', rates: [2, 10, 0.2, 2.5] },
  { id: 'deepseek-v4-flash', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006] },
  { id: 'deepseek-v4-flash-fast', rates: [0.28, 0.56, 0.07] },
  { id: 'deepseek-v4-flash-vision-exp', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006] },
  { id: 'deepseek-v4-pro', rates: [0.66, 1.98, 0.022], peak: [1.32, 3.96, 0.044] },
  { id: 'deepseek-v4.1-flash', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006] },
  { id: 'fugu-ultra', rates: [5, 30, 0.5] },
  { id: 'gemini-3.1-flash-lite', rates: [0.25, 1.5, 0.03] },
  { id: 'gemini-3.5-flash', rates: [1.5, 9, 0.15] },
  { id: 'gemini-3.5-flash-lite', rates: [0.3, 2.5, 0.03] },
  { id: 'gemini-3.6-flash', rates: [1.5, 7.5, 0.15] },
  { id: 'gemini-3.7-flash', rates: [1.5, 7.5, 0.15, 0.08334] },
  { id: 'gemini-3.8-flash', rates: [1.5, 7.5, 0.15] },
  { id: 'glm-5', rates: [1, 3.2, 0.2] },
  { id: 'glm-5.1', rates: [1.4, 4.4, 0.26] },
  { id: 'glm-5.2', rates: [1.4, 4.4, 0.26] },
  { id: 'glm-5.2-fast', rates: [3, 10.25, 0.5] },
  { id: 'glm-5.3', rates: [1.4, 4.4, 0.26] },
  { id: 'glm-5.3-flash', rates: [0.15, 0.5, 0.03] },
  { id: 'gpt-5.3-codex', rates: [2, 8, 0.5, 0] },
  { id: 'gpt-5.4', rates: [2.5, 15, 0.25, 0] },
  { id: 'gpt-5.4-mini', rates: [0.75, 4.5, 0.075, 0] },
  { id: 'gpt-5.5', rates: [5, 30, 0.5, 0] },
  { id: 'gpt-5.6-luna', rates: [0.2, 1.2, 0.02, 0.25], tiers: [{ maxContext: 272000, rates: [0.2, 1.2, 0.02, 0.25] }, { rates: [0.4, 1.8, 0.04, 0.5] }] },
  { id: 'gpt-5.6-sol', rates: [5, 30, 0.5, 6.25], tiers: [{ maxContext: 272000, rates: [5, 30, 0.5, 6.25] }, { rates: [10, 45, 1, 12.5] }] },
  { id: 'gpt-5.6-terra', rates: [2, 12, 0.2, 2.5], tiers: [{ maxContext: 272000, rates: [2, 12, 0.2, 2.5] }, { rates: [4, 18, 0.4, 5] }] },
  { id: 'gpt-6-astra', rates: [10, 50, 1, 12.5], tiers: [{ maxContext: 272000, rates: [10, 50, 1, 12.5] }, { rates: [20, 75, 2, 25] }] },
  { id: 'grok-4.5', rates: [2, 6, 0.5] },
  { id: 'grok-4.6', rates: [2, 6, 0.5], tiers: [{ maxContext: 200000, rates: [2, 6, 0.5] }, { rates: [4, 12, 1] }] },
  { id: 'inkling', rates: [1, 4.05, 0.17] },
  { id: 'inkling-small', rates: [0.5, 1.2, 0.1] },
  { id: 'kimi-k2.5', rates: [0.6, 3, 0.1] },
  { id: 'kimi-k2.6', rates: [0.95, 4, 0.16] },
  { id: 'kimi-k2.7-code', rates: [0.95, 4, 0.19] },
  { id: 'kimi-k2.7-code-highspeed', rates: [1.9, 8, 0.38] },
  { id: 'kimi-k3', rates: [3, 15, 0.3] },
  { id: 'mimo-v2.5', rates: [0.14, 0.28, 0.0028] },
  { id: 'mimo-v2.5-pro', rates: [0.435, 0.87, 0.0036] },
  { id: 'minimax-m2.5', rates: [0.3, 1.2, 0.03] },
  { id: 'minimax-m2.7', rates: [0.3, 1.2, 0.06] },
  { id: 'minimax-m3', rates: [0.3, 1.2, 0.06] },
  { id: 'muse-spark-1.1', rates: [1.25, 4.25, 0.15] },
  { id: 'muse-spark-1.2', rates: [1.25, 4.25, 0.15] },
  { id: 'muse-spark-1.2-contributor', rates: [0.1, 0.2, 0.002] },
  { id: 'muse-spark-1.3', rates: [1.25, 4.25, 0.15] },
  { id: 'muse-spark-1.3-contributor', rates: [0.1, 0.2, 0.002] },
  { id: 'nemotron-3-ultra', rates: [0.6, 2.4, 0.12] },
  { id: 'qwen-3.6-max', rates: [1.3, 7.8, 0.26, 1.63] },
  { id: 'qwen-3.6-plus', rates: [0.5, 3, 0.1], tiers: [{ maxContext: 256000, rates: [0.5, 3, 0.1] }, { rates: [2, 6, 0.2] }] },
  { id: 'qwen-3.7-flash', rates: [0.03, 0.13, 0.006, 0.038], tiers: [{ maxContext: 32000, rates: [0.03, 0.13, 0.006, 0.038] }, { maxContext: 256000, rates: [0.1, 0.4, 0.02, 0.125] }, { rates: [0.2, 0.8, 0.04, 0.25] }] },
  { id: 'qwen-3.7-max', rates: [2.5, 7.5, 0.5, 3.13] },
  { id: 'qwen-3.7-plus', rates: [0.4, 1.6, 0.08, 0.5], tiers: [{ maxContext: 256000, rates: [0.4, 1.6, 0.08, 0.5] }, { rates: [1.2, 4.8, 0.24, 1.5] }] },
  { id: 'qwen-3.8-27b', rates: [0.4, 3, 0.04] },
  { id: 'qwen-3.8-flash', rates: [0.16, 0.47, 0.016] },
  { id: 'qwen-3.8-max', rates: [2, 6, 0.25, 2.5] },
  { id: 'qwen-3.8-max-0902', rates: [2, 6, 0.25] },
  { id: 'step-3.5-flash', rates: [0.1, 0.3, 0.02] },
  { id: 'step-3.7-flash', rates: [0.2, 1.15, 0.04] },
  { id: 'tencent/hy3-paid', rates: [0.14, 0.58, 0.035] },
  { id: 'tencent/hy4-preview', rates: [0.834, 2.501, 0.042] },
]

function toRates(tuple: RateTuple): ModelRates {
  const [input, output, cacheRead, cacheWrite] = tuple
  return cacheWrite === undefined
    ? { input, output, cacheRead }
    : { input, output, cacheRead, cacheWrite }
}

function toPrice(row: PriceRow): ModelPrice {
  return {
    id: row.id,
    rates: toRates(row.rates),
    ...row.peak === undefined ? {} : { peak: toRates(row.peak) },
    ...row.tiers === undefined
      ? {}
      : { tiers: row.tiers.map(tier => (tier.maxContext === undefined ? { rates: toRates(tier.rates) } : { maxContext: tier.maxContext, rates: toRates(tier.rates) })) },
  }
}

/** Every row, as objects. */
export const MODEL_PRICES: readonly ModelPrice[] = PRICE_ROWS.map(toPrice)

/**
 * Index by row id AND by its bare form.
 *
 * The page mostly drops the vendor segment (so the hub's `hy4-preview` must find
 * the page's `tencent/hy4-preview`) and sometimes keeps it, so the lookup is
 * keyed both ways.
 */
const PRICE_INDEX: Map<string, ModelPrice> = new Map()
for (const price of MODEL_PRICES) {
  PRICE_INDEX.set(price.id, price)
  const bare = price.id.slice(price.id.indexOf('/') + 1)
  if (!PRICE_INDEX.has(bare)) PRICE_INDEX.set(bare, price)
}

/**
 * Plausible page slugs for one catalog id, most specific first.
 *
 * The page lowercases, usually drops the vendor segment, and sometimes inserts a
 * hyphen the catalog id lacks (`glm5` -> `glm-5`). A decorating suffix the page
 * does not carry (`-tiered` on the hub's Antigravity ids) is trimmed only AFTER
 * the exact spelling misses, so a row that legitimately ends in `-fast`, `-exp`
 * or `-vision-exp` is never shadowed by its shorter sibling.
 * @param model - the catalog model id.
 * @returns candidate slugs in lookup order.
 */
export function priceSlugCandidates(model: string): string[] {
  const lower = model.toLowerCase()
  const bare = lower.includes('/') ? lower.slice(lower.indexOf('/') + 1) : lower
  const hyphenated = (slug: string): string => slug.replace(/^([a-z]+)(\d)/, '$1-$2')
  const trimmed = (slug: string): string[] => [
    slug.replace(/-(tiered|latest|preview)$/, ''),
    slug.replace(/-\d{8}$/, ''),
  ]
  const out: string[] = []
  for (const base of [lower, bare]) {
    out.push(base, hyphenated(base), ...trimmed(base), ...trimmed(hyphenated(base)))
  }
  return [...new Set(out.filter(slug => slug !== ''))]
}

/** A coarse vendor-family fallback, used only when the published table has no row. */
export interface FamilyRate {
  key: string
  rates: ModelRates
}

/**
 * Family fallback rates, for ids the published table does not carry (a hub
 * brand name, a model that shipped after the last sync).
 *
 * This is a fallback, not the pricing model: it keys on a vendor substring, so
 * it cannot tell a resold model from the vendor's own, and it publishes no
 * cache-write rate. {@link resolveModelPrice} reports which source won so a
 * caller can say "approximate" instead of implying a published figure.
 */
const FAMILY_RATES: ReadonlyArray<readonly [string, RateTuple]> = [
  ['claude-opus', [15, 75, 0.5]],
  ['claude-sonnet', [3, 15, 0.3]],
  ['claude-haiku', [1, 5, 0.1]],
  ['gpt-6', [5, 20, 0.5]],
  ['gpt-5', [2.5, 10, 0.25]],
  ['gpt-4', [2.5, 10, 0.25]],
  ['grok', [2, 10, 0.2]],
  ['gemini-3-pro', [2, 12, 0.2]],
  ['gemini-3.1-pro', [2, 12, 0.2]],
  ['gemini-3.8-flash', [0.75, 3.75, 0.075]],
  ['gemini-3.7-flash', [0.75, 3.75, 0.075]],
  ['gemini-3-flash', [0.5, 3, 0.05]],
  ['gemini-2.5-flash', [0.3, 2.5, 0.03]],
  ['gemini-flash', [0.3, 2.5, 0.03]],
  ['deepseek', [0.15, 0.6, 0.003]],
  ['glm', [0.2, 0.8, 0.02]],
  ['hy3', [0.14, 0.58, 0.035]],
  ['hy4', [0.4, 1.5, 0.05]],
  ['doubao', [0.4, 1.5, 0.05]],
  ['seed', [0.4, 1.5, 0.05]],
  ['codebuddy', [0.4, 1.5, 0.05]],
]

/** The last resort when neither the table nor a family rule can price a model. */
const DEFAULT_RATES: ModelRates = { input: 2, output: 8, cacheRead: 0.2 }

/** Which source priced a model. */
export type PriceSource = 'catalog' | 'family' | 'default'

/** The outcome of pricing one model id. */
export interface ResolvedPrice {
  source: PriceSource
  /** The published row, present only for `catalog`. */
  price?: ModelPrice
  /** The family rule's key, present only for `family`. */
  family?: string
  rates: ModelRates
  peak?: ModelRates
  tiers?: ModelPriceTier[]
}

/**
 * Price one model id: published row first, family fallback second, generic last.
 * @param model - the catalog model id (a provider name is accepted as a last resort).
 * @returns the resolved price plus which source won.
 */
export function resolveModelPrice(model: string): ResolvedPrice {
  for (const slug of priceSlugCandidates(model || '')) {
    const price = PRICE_INDEX.get(slug)
    if (price !== undefined) {
      return {
        source: 'catalog',
        price,
        rates: price.rates,
        ...price.peak === undefined ? {} : { peak: price.peak },
        ...price.tiers === undefined ? {} : { tiers: price.tiers },
      }
    }
  }
  const lower = (model || '').toLowerCase()
  for (const [key, tuple] of FAMILY_RATES) {
    if (lower.includes(key)) return { source: 'family', family: key, rates: toRates(tuple) }
  }
  return { source: 'default', rates: DEFAULT_RATES }
}

/**
 * The rates one request is charged at.
 *
 * A tiered row returns its matching band and does NOT then apply `peak`: the page
 * publishes those two dimensions independently, no row carries both today, and
 * the reference records this ordering as a latent choice rather than a verified
 * upstream rule. Bands are ascending and the last is unbounded, which the vendored
 * table satisfies and the reference's sync asserts.
 * @param resolved - the resolved price.
 * @param at - the request time in epoch ms, or undefined when unknown (off-peak).
 * @param contextTokens - every prompt bucket of THIS request (input + cache read + cache write).
 * @returns the rates to bill with.
 */
export function ratesFor(resolved: ResolvedPrice, at: number | undefined, contextTokens: number): ModelRates {
  const tier = resolved.tiers?.find(band => band.maxContext === undefined || contextTokens <= band.maxContext)
  if (tier !== undefined) return tier.rates
  if (resolved.peak !== undefined && at !== undefined && isPeakPricingHour(at)) return resolved.peak
  return resolved.rates
}

/** One request's billed buckets, as the harness reports them. */
export interface BilledUsage {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

/** What one request costs, and how complete that figure is. */
export interface PricedUsage {
  usd: number
  source: PriceSource
  /** The row/rule that priced it, for reporting. */
  key: string
  /** True when the row published a cache-write rate, so those tokens are inside `usd`. */
  pricedCacheWrite: boolean
  /** Cache-write tokens charged at nothing because no published rate exists. */
  unpricedCacheWriteTokens: number
  /** True when the rate came from a family substring or the generic default. */
  approximate: boolean
  /** The context band's upper bound, when a tiered row priced this request. */
  tierMaxContext?: number
}

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Price one request's usage.
 * @param model - the catalog model id the request ran on.
 * @param at - the request time in epoch ms, or undefined when the transcript carries none.
 * @param usage - the billed buckets.
 * @returns the cost in USD plus the provenance a caller needs to label it.
 */
export function priceUsage(model: string, at: number | undefined, usage: BilledUsage): PricedUsage {
  const resolved = resolveModelPrice(model)
  const input = finite(usage.inputTokens)
  const output = finite(usage.outputTokens)
  const cacheRead = finite(usage.cacheReadTokens)
  const cacheWrite = finite(usage.cacheWriteTokens)
  const contextTokens = input + cacheRead + cacheWrite
  const rates = ratesFor(resolved, at, contextTokens)
  const tier = resolved.tiers?.find(band => band.maxContext === undefined || contextTokens <= band.maxContext)
  const pricedCacheWrite = rates.cacheWrite !== undefined
  const usd = (
    input * rates.input
    + output * rates.output
    + cacheRead * rates.cacheRead
    + (pricedCacheWrite ? cacheWrite * (rates.cacheWrite as number) : 0)
  ) / 1_000_000
  const key = resolved.source === 'catalog'
    ? resolved.price?.id ?? model
    : resolved.source === 'family' ? `family:${resolved.family ?? ''}` : 'default'
  return {
    usd,
    source: resolved.source,
    key,
    pricedCacheWrite,
    unpricedCacheWriteTokens: pricedCacheWrite ? 0 : cacheWrite,
    approximate: resolved.source !== 'catalog',
    ...tier?.maxContext === undefined ? {} : { tierMaxContext: tier.maxContext },
  }
}

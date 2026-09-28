/**
 * Freebuff (freebuff.com) pinned model table: the effort ladder each model
 * accepts, the context windows the vendor publishes, and which ids upstream has
 * PAUSED.
 *
 * ## Where these facts come from
 *
 * The reference gateway (`ref-freebuff2api`, a Rust reverse-engineering of the
 * Freebuff desktop client) carries a static authoritative table it keeps in step
 * with upstream's own `freebuff-models.ts` snapshot:
 *
 *   - model roster — `src/models.rs:18-39` (`HARDCODED_MODELS`), "上游实测可用".
 *   - effort ladders — `src/models.rs:123-125` (the three ladder constants) and
 *     `src/router.rs:113-133` (which ladder a model takes); the clamp rule this
 *     file implements is `src/router.rs:199-213`.
 *   - paused ids — `src/models.rs:260-320`: the rows flagged `available: false`
 *     carry the comment that they come from upstream's
 *     `FREEBUFF_PAUSED_FREE_MODEL_IDS`, and `src/router.rs` warns that a client
 *     keying on the RAW list serves dead models.
 *   - context windows — NOT in the reference: its `ModelMeta` struct
 *     (`src/models.rs:94-110`) has no window field at all, and its gateway has no
 *     context table. The numbers below are the vendor-published
 *     `FREEBUFF_MODEL_CONTEXT_WINDOWS` values from the upstream client bundle, so
 *     only the ids that table names get a window and every other row declares
 *     NONE rather than a guess.
 *
 * ## Why the ladder is advertised EXACTLY
 *
 * The clamp below is belt-and-braces. The roster advertises precisely the ladder
 * a model accepts, so the picker can never offer a value the upstream would
 * silently coerce; the clamp then exists for a value arriving from somewhere
 * else (a stale per-model default saved by `model-defaults`, a pool/alias route,
 * a hand-edited config). The reference clamps on EVERY request because its own
 * entry point forwards whatever a client sent (`src/router.rs:198-213`).
 *
 * @module dsh-subscription-hub/providers/freebuff/catalog
 */

/**
 * The effort ladder shared by the DeepSeek and GLM families.
 *
 * `src/models.rs:123` — `EFFORTS_GLM = ["low","high","max"]`. There is no
 * `medium` or `xhigh` in this ladder: the reference's own clamp
 * (`src/router.rs:199-213`) maps a request for either onto the ladder's LAST
 * entry, which is what this file does too.
 */
export const FREEBUFF_LADDER_STANDARD: readonly string[] = ['low', 'high', 'max']

/** `src/models.rs:124` — `EFFORTS_FULL = ["low","medium","high","xhigh","max"]`. */
export const FREEBUFF_LADDER_FULL: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * `src/models.rs:125` — `EFFORTS_MUSE = ["minimal","low","medium","high","xhigh"]`.
 *
 * Note this ladder has NO `max`: a request for `max` clamps to its last entry
 * `xhigh`, which the reference pins in its own test (`src/router.rs:286-289`).
 */
export const FREEBUFF_LADDER_MUSE: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

/**
 * The context windows the VENDOR publishes, per model id.
 *
 * Only ids in this map may carry a `contextWindow`. The reference's gateway
 * declares none at all (see the module doc), so every other id in
 * {@link FREEBUFF_MODELS} deliberately declares none: an absent number renders
 * as absent, while a guessed one is a claim about what the upstream accepts.
 *
 * A caveat worth stating in one place: upstream PRUNES context at 400k / 250k
 * rather than at the window it advertises, so this number is what the vendor
 * DOCUMENTS for the model, not the enforced request budget. It is still the
 * right number to publish — the harness compacts against the documented window,
 * and inventing the smaller pruning threshold would be a reading of upstream
 * behaviour nobody published.
 */
export const FREEBUFF_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'minimax/minimax-m3': 524_288,
  'deepseek/deepseek-v4-flash': 1_048_576,
  'deepseek/deepseek-v4-pro': 1_048_576,
  'openai/gpt-5.6-luna': 1_000_000,
  'openai/gpt-5.6-luna-es': 372_000,
  'meta/muse-spark-1.2-contributor': 1_000_000,
  'stealth/ox-alpha': 1_000_000,
  'z-ai/glm-5.3-flash': 1_000_000,
  'upstage/solar-pro4': 500_000,
})

/**
 * One pinned Freebuff model.
 *
 * `inputModalities` is deliberately ABSENT here rather than derived: the
 * reference's table does carry a `multimodal` column (`src/models.rs:130-331`),
 * but that column is its panel hint for its own image-upload surface
 * ("仅作面板图片上传可用性提示，非强制") and the fact list this route was built
 * from does not publish modality. `LlmModelInfo.inputModalities` treats an
 * absent value as UNKNOWN (not as "text only"), which is the honest state: the
 * harness asks the provider rather than being told a capability nobody stated.
 */
export interface FreebuffModel {
  /** Wire model id (also the display name — upstream publishes no label). */
  id: string
  /** The exact effort ladder this model accepts; absent means the field is omitted. */
  efforts?: readonly string[]
  /** Vendor-documented context window; absent when the vendor publishes none. */
  contextWindow?: number
  /** False when upstream has paused the model for the free tier. */
  available: boolean
}

/**
 * The ids upstream has PAUSED for the free tier.
 *
 * `src/models.rs:260-320` keeps these rows with `available: false` and a
 * fallback, and `src/router.rs:159-196` describes them as "已被上游暂停/下架".
 * They stay in {@link FREEBUFF_MODELS} so the route can still RECOGNISE an id a
 * caller names, but {@link freebuffRoster} never offers them: a roster that
 * lists a paused model is how a client keys on the raw list and picks a dead
 * model.
 */
export const FREEBUFF_PAUSED_MODEL_IDS: readonly string[] = [
  'google/gemini-3.8-flash',
  'deepseek/deepseek-v4-pro',
  'minimax/minimax-m3',
  'meta/muse-spark-1.3-contributor',
  'stealth/ox-alpha',
  'z-ai/glm-5.2',
]

const pausedSet = new Set(FREEBUFF_PAUSED_MODEL_IDS)

/** Build one row, attaching only the facts that exist for it. */
function row(id: string, efforts?: readonly string[]): FreebuffModel {
  const window = FREEBUFF_MODEL_CONTEXT_WINDOWS[id]
  return {
    id,
    ...efforts === undefined ? {} : { efforts },
    ...window === undefined ? {} : { contextWindow: window },
    available: !pausedSet.has(id),
  }
}

/**
 * The pinned table: every id in the reference's `HARDCODED_MODELS`
 * (`src/models.rs:18-39`), in that order, each with its ladder
 * (`src/models.rs:128-331`) and window (`FREEBUFF_MODEL_CONTEXT_WINDOWS`).
 *
 * The five ids with NO ladder are the reference's own "no efforts" rows:
 * `upstage/solar-pro4`, `minimax/minimax-m3`, `mimo/mimo-v2.5`,
 * `crof/kimi-k3-eco`, `z-ai/glm-5.2` (`src/router.rs:93` names exactly this set
 * for its own request path, and `src/models.rs:221-330` gives each `efforts:
 * None`). For those the `reasoning_effort` field is REMOVED from the body.
 */
export const FREEBUFF_MODELS: readonly FreebuffModel[] = [
  row('z-ai/glm-5.3-flash', FREEBUFF_LADDER_STANDARD),
  row('google/gemini-3.8-flash', FREEBUFF_LADDER_FULL),
  row('google/gemini-3.1-flash-lite', FREEBUFF_LADDER_FULL),
  row('google/gemini-3.5-flash-lite', FREEBUFF_LADDER_FULL),
  row('deepseek/deepseek-v4-flash', FREEBUFF_LADDER_STANDARD),
  row('deepseek/deepseek-v4-flash-max', FREEBUFF_LADDER_STANDARD),
  row('deepseek/deepseek-v4-pro', FREEBUFF_LADDER_STANDARD),
  row('deepseek/deepseek-v4-pro-max', FREEBUFF_LADDER_STANDARD),
  row('minimax/minimax-m3'),
  row('openai/gpt-5.6-luna', FREEBUFF_LADDER_FULL),
  row('openai/gpt-5.6-luna-es', FREEBUFF_LADDER_FULL),
  row('openai/gpt-5.6-luna-max', FREEBUFF_LADDER_FULL),
  row('upstage/solar-pro4'),
  row('meta/muse-spark-1.2-contributor', FREEBUFF_LADDER_MUSE),
  row('meta/muse-spark-1.3-contributor', FREEBUFF_LADDER_MUSE),
  row('anthropic/claude-fable-5', FREEBUFF_LADDER_FULL),
  row('stealth/ox-alpha', FREEBUFF_LADDER_STANDARD),
  row('crof/kimi-k3-eco'),
  row('z-ai/glm-5.2'),
  row('mimo/mimo-v2.5'),
]

const byId = new Map<string, FreebuffModel>(FREEBUFF_MODELS.map(model => [model.id, model]))

/**
 * The pinned row for an id, when the table describes it.
 * @param id - the model id as the caller names it.
 * @returns the row, or undefined for an id this table does not describe.
 */
export function freebuffModel(id: string): FreebuffModel | undefined {
  return byId.get(id.trim())
}

/**
 * The effort ladder a model accepts, or undefined when it accepts none.
 *
 * An id the table does NOT describe gets `undefined` — no ladder is claimed for
 * a model nobody published one for (the reference's prefix fallback,
 * `src/router.rs:117-132`, guesses a ladder for a dynamically discovered model;
 * that guess is exactly what a picker must not turn into a selectable level).
 * @param id - the model id.
 * @returns the ladder, or undefined.
 */
export function freebuffEfforts(id: string): readonly string[] | undefined {
  return freebuffModel(id)?.efforts
}

/**
 * The models this route OFFERS: everything not paused upstream.
 *
 * Paused rows remain identifiable through {@link freebuffModel} so a request
 * naming one gets a real answer rather than "unknown model", but they are absent
 * here (`src/models.rs:260-320` + `src/router.rs`'s dead-model warning).
 * @returns the available rows, in table order.
 */
export function freebuffRoster(): readonly FreebuffModel[] {
  return FREEBUFF_MODELS.filter(model => model.available)
}

/**
 * Apply the reference's effort rule to a requested level.
 *
 * The rule is `src/router.rs:199-213`, verbatim:
 *
 *   1. a requested value ∈ the ladder is sent UNCHANGED (`src/router.rs:202-204`);
 *   2. `max` | `xhigh` | `high` → the ladder's LAST entry (`src/router.rs:206-208`);
 *   3. `minimal` | `low` → the ladder's FIRST entry (`src/router.rs:209-211`);
 *   4. any other string → the ladder's FIRST entry (`src/router.rs:212`);
 *   5. no ladder → the field is REMOVED from the body entirely.
 *
 * The comparison is case-insensitive (the reference lowercases the request,
 * `src/router.rs:201`), which is why `"HIGH"` is `"high"` here rather than an
 * unknown string clamping to the bottom of the ladder.
 *
 * `undefined` means case 5 — the caller must NOT put a `reasoning_effort` field
 * on the body at all. Sending `reasoning_effort: null` is not the same thing:
 * the reference strips the key for exactly these five models.
 * @param model - the model id.
 * @param requested - the level the caller asked for, when it asked for one.
 * @returns the level to send, or undefined when the field must be omitted.
 */
export function freebuffEffortFor(model: string, requested?: string): string | undefined {
  const ladder = freebuffEfforts(model)
  if (ladder === undefined || ladder.length === 0) return undefined
  const first = ladder[0] as string
  const last = ladder[ladder.length - 1] as string
  if (requested === undefined) return undefined
  const wanted = requested.trim().toLowerCase()
  if (wanted === '') return undefined
  if (ladder.includes(wanted)) return wanted
  if (wanted === 'max' || wanted === 'xhigh' || wanted === 'high') return last
  if (wanted === 'minimal' || wanted === 'low') return first
  return first
}

/**
 * Whether upstream has paused a model for the free tier.
 * @param id - the model id.
 * @returns true when the id is in {@link FREEBUFF_PAUSED_MODEL_IDS}.
 */
export function isFreebuffPaused(id: string): boolean {
  return pausedSet.has(id.trim())
}

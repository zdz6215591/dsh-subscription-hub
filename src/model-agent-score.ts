/**
 * Agent Arena scores, keyed to the model ids this hub routes to.
 *
 * The score is **Net Improvement** from https://arena.ai/leaderboard/agent: a
 * treatment effect in percentage points against the average model, measured from
 * real Agent Mode sessions, with a 95% confidence interval. It answers "how good
 * is this model at actually driving tools?" — which is the question a model row
 * in a tool-using agent should answer and no other column does.
 *
 * ## Why a snapshot rather than a live fetch
 *
 * The board renders entirely client-side and its API refuses direct requests
 * (403 to every candidate endpoint), so reading it requires driving a real
 * browser. A DSH plugin must not do that: it would add seconds of latency to a
 * settings panel, break whenever the site changes, and lean on Cloudflare
 * tolerating us. So the numbers are vendored by `scripts/sync-arena-scores.mjs`
 * and read from here — fast, offline, and reviewable in a diff.
 *
 * ## Why only part of the board is here
 *
 * The board publishes 46 rows in rank order. The first 26 are self-consistent —
 * rank order and score order agree — and cover every family this hub serves.
 * Ranks 27-46 are **non-monotonic**: their scores ascend from 0.44% to 15.52%,
 * which would place a rank-46 model above rank 1. A leaderboard cannot mean
 * that, so those rows are quarantined in the sync script's output rather than
 * vendored: a number whose meaning is unclear is worse than no number, exactly
 * as an unpriceable session shows no price.
 *
 * ## Never a guess
 *
 * A model with no matching row gets NO score. Matching is exact on a normalized
 * key (owner segment and parentheticals removed), so `Qwen3.8-Flash` does not
 * silently inherit `Qwen3.8 Flash Next`'s 0.07%.
 *
 * @module dsh-subscription-hub/model-agent-score
 */

/** One vendored board row. */
export interface AgentScoreRow {
  /** Normalized lookup key: lowercase alphanumerics of the name without parentheticals. */
  key: string
  /** The board's own display name, for the tooltip. */
  label: string
  /** The effort variant the row measured, when the board names one. */
  effort?: string
  /** The board's rank, 1-based. */
  rank: number
  /** Net Improvement in percentage points. */
  score: number
  /** The 95% confidence interval half-width. */
  ci: number
  /** The vendor the board attributes the model to. */
  vendor: string
}

/** When the vendored board was read, and from where. */
export const AGENT_SCORE_SOURCE = {
  url: 'https://arena.ai/leaderboard/agent',
  generatedAt: '2026-09-22',
  /** Rows the sync script reads that are deliberately NOT vendored. See the module note. */
  quarantinedRanks: '27-46',
  metric: 'Net Improvement (percentage points vs the average model, 95% CI)',
} as const

/**
 * The verified head of the board, ranks 1-26.
 *
 * `key`/`label`/`effort` are derived from the board's own model names; `rank`,
 * `score` and `ci` are transcribed verbatim.
 */
export const AGENT_SCORE_ROWS: readonly AgentScoreRow[] = Object.freeze([
  { key: 'claudefable51', label: 'Claude Fable 5.1', effort: 'max', rank: 1, score: 13.71, ci: 1.72, vendor: 'Anthropic' },
  { key: 'gpt6astra', label: 'GPT 6 Astra', effort: 'max', rank: 2, score: 11.54, ci: 2.10, vendor: 'OpenAI' },
  { key: 'claudeopus5', label: 'Claude Opus 5', effort: 'high', rank: 3, score: 10.25, ci: 1.41, vendor: 'Anthropic' },
  { key: 'claudeopus5', label: 'Claude Opus 5', effort: 'max', rank: 4, score: 10.16, ci: 1.55, vendor: 'Anthropic' },
  { key: 'claudefable5', label: 'Claude Fable 5', effort: 'high', rank: 5, score: 8.81, ci: 1.25, vendor: 'Anthropic' },
  { key: 'claudeopus48', label: 'Claude Opus 4.8', effort: 'high', rank: 6, score: 8.19, ci: 1.27, vendor: 'Anthropic' },
  { key: 'gpt56sol', label: 'GPT 5.6 Sol', effort: 'xhigh', rank: 7, score: 7.10, ci: 1.28, vendor: 'OpenAI' },
  { key: 'kimik3', label: 'Kimi K3', effort: 'max', rank: 8, score: 6.22, ci: 0.62, vendor: 'Moonshot' },
  { key: 'claudesonnet5', label: 'Claude Sonnet 5', effort: 'high', rank: 9, score: 5.97, ci: 1.62, vendor: 'Anthropic' },
  { key: 'gpt55', label: 'GPT 5.5', effort: 'xhigh', rank: 10, score: 5.03, ci: 0.92, vendor: 'OpenAI' },
  { key: 'hy4preview', label: 'Hy4 preview', rank: 11, score: 5.01, ci: 1.02, vendor: 'Tencent' },
  { key: 'deepseekv41flash', label: 'DeepSeek V4.1 Flash', effort: 'max', rank: 12, score: 4.88, ci: 1.33, vendor: 'DeepSeek' },
  { key: 'gemini38flash', label: 'Gemini 3.8 Flash', effort: 'high', rank: 13, score: 4.71, ci: 1.91, vendor: 'Google' },
  { key: 'glm52', label: 'GLM 5.2', effort: 'max', rank: 14, score: 4.37, ci: 0.69, vendor: 'Z.ai' },
  { key: 'musespark13', label: 'Muse Spark 1.3', effort: 'max', rank: 15, score: 4.20, ci: 0.86, vendor: 'Meta' },
  { key: 'deepseekv4pro', label: 'DeepSeek V4 Pro', effort: 'high', rank: 16, score: 4.14, ci: 0.79, vendor: 'DeepSeek' },
  { key: 'qwen38max', label: 'Qwen3.8 Max', rank: 17, score: 3.30, ci: 0.84, vendor: 'Alibaba' },
  { key: 'glm53', label: 'GLM 5.3', effort: 'max', rank: 18, score: 3.05, ci: 0.62, vendor: 'Z.ai' },
  { key: 'grok45', label: 'Grok 4.5', rank: 19, score: 2.92, ci: 0.99, vendor: 'xAI' },
  { key: 'gpt55', label: 'GPT 5.5', rank: 20, score: 2.67, ci: 0.81, vendor: 'OpenAI' },
  { key: 'grok46', label: 'Grok 4.6', effort: 'xhigh', rank: 21, score: 2.01, ci: 1.05, vendor: 'xAI' },
  { key: 'deepseekv4flash', label: 'DeepSeek V4 Flash', effort: 'high', rank: 22, score: 1.80, ci: 0.73, vendor: 'DeepSeek' },
  { key: 'gpt56terra', label: 'GPT 5.6 Terra', effort: 'xhigh', rank: 23, score: 1.44, ci: 1.11, vendor: 'OpenAI' },
  { key: 'gpt54', label: 'GPT 5.4', effort: 'high', rank: 24, score: 1.26, ci: 0.80, vendor: 'OpenAI' },
  { key: 'glm53flash', label: 'GLM 5.3 Flash', rank: 25, score: 1.15, ci: 0.67, vendor: 'Z.ai' },
  { key: 'qwen38flashnext', label: 'Qwen3.8 Flash Next', rank: 26, score: 0.07, ci: 0.76, vendor: 'Alibaba' },
])

/**
 * Normalize a name or id into a lookup key.
 *
 * Parentheticals are dropped so the board's `(High)`/`(0813)` qualifiers do not
 * defeat a match, and everything that is not a letter or digit is removed so
 * `deepseek-v4-pro` and `Deepseek V4 Pro` agree.
 * @param value - a model id or a display name.
 * @returns the normalized key.
 */
export function agentScoreKey(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** A score resolved for one model. */
export interface AgentScore {
  score: number
  ci: number
  rank: number
  /** The board's own model name, e.g. `Claude Opus 5`. */
  label: string
  /** The effort variant measured, when the board names one. */
  effort?: string
  vendor: string
  /** True when the row's effort differs from the request's, so the tooltip can say so. */
  effortMismatch: boolean
}

/**
 * The score for one model, or undefined when the board does not list it.
 *
 * Resolution order, each step exact rather than fuzzy:
 * 1. the same base name at the same effort,
 * 2. the same base name with no effort qualifier on the board,
 * 3. the highest-scoring variant of that base name, flagged as a different effort.
 *
 * The owner segment of a `vendor/model` id is ignored for matching, because the
 * board names models without it.
 * @param modelId - the wire model id.
 * @param effort - the effort in effect, when the caller knows it.
 * @returns the score, or undefined when no row matches.
 */
export function agentScoreFor(modelId: string, effort?: string): AgentScore | undefined {
  const slash = modelId.lastIndexOf('/')
  const local = slash >= 0 ? modelId.slice(slash + 1) : modelId
  const key = agentScoreKey(local)
  if (key === '') return undefined
  const candidates = AGENT_SCORE_ROWS.filter(row => row.key === key)
  if (candidates.length === 0) return undefined
  const wanted = effort?.toLowerCase()
  const exact = wanted === undefined ? undefined : candidates.find(row => row.effort === wanted)
  const unqualified = candidates.find(row => row.effort === undefined)
  // Prefer an exact effort, then the board's own unqualified row, then the best
  // variant — and only the last of those is a mismatch worth flagging.
  const chosen = exact ?? unqualified ?? [...candidates].sort((a, b) => b.score - a.score)[0]!
  return {
    score: chosen.score,
    ci: chosen.ci,
    rank: chosen.rank,
    label: chosen.label,
    ...chosen.effort === undefined ? {} : { effort: chosen.effort },
    vendor: chosen.vendor,
    // Flagged whenever the measured variant is a QUALIFIED one the caller did not
    // ask for — including when the caller knows no effort at all, because the
    // reader is still looking at a number measured at a specific setting.
    effortMismatch: chosen.effort !== undefined && chosen.effort !== wanted,
  }
}
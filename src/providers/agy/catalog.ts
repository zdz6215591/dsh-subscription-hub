/**
 * Pinned agy model catalog (metadata only — dynamic discovery is primary).
 *
 * Adapted from OmniRoute's `AGY_PUBLIC_MODELS` (MIT, see NOTICE.md), which was
 * pinned from the live `v1internal:fetchAvailableModels` endpoint. The dynamic
 * endpoint supplies ids + quotaInfo; this catalog supplies the capability
 * metadata the endpoint omits (context length, output cap, reasoning/vision/
 * tool-calling). Tab-completion models are intentionally excluded.
 */

export interface CatalogModel {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  /**
   * The model reasons internally. This is NOT the same as exposing a level
   * picker: it is informational and deliberately not read by
   * `resolveAgyModel`, which keys the effort list off {@link thinking} only.
   * `gemini-2.5-pro` carries `true` while having no selector, because the
   * Antigravity `thinkingLevel` axis is a Gemini-3+ feature — its thinking is
   * a fixed token budget instead, so offering low/medium/high would send a
   * parameter the model does not accept.
   */
  supportsReasoning?: boolean
  supportsVision?: boolean
  toolCalling?: boolean
  /** Level-thinking: 'level' means single id + selectable low/medium/high via thinkingLevel. Omit = level bound to id. */
  thinking?: 'level'
}

export const AGY_PUBLIC_MODELS: readonly CatalogModel[] = [
  { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.6-flash-tiered', name: 'Gemini 3.6 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextLength: 1048576, maxOutputTokens: 64000, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6', contextLength: 1048576, maxOutputTokens: 64000, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', contextLength: 131072, maxOutputTokens: 32768, supportsReasoning: true, toolCalling: true, thinking: 'level' },
]

const CATALOG_BY_ID = new Map(AGY_PUBLIC_MODELS.map((m) => [m.id, m]))

/** Redundant sub-variant IDs from Google that duplicate folded base models. */
const REDUNDANT_AGY_VARIANTS = new Set([
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3-flash-agent',
  'gemini-3.5-flash-extra-low',
  'gemini-3.1-pro-low',
])

/** Strip thinking-level / variant suffixes from display names. */
export function cleanAgyDisplayName(name: string): string {
  return name
    .replace(/\s*\((?:High|Medium|Low|Thinking|Tiered)\)\s*$/i, '')
    .trim()
}

/** Check if a dynamic model ID is a redundant thinking-level variant. */
export function isRedundantAgyVariant(modelId: string): boolean {
  return REDUNDANT_AGY_VARIANTS.has(modelId)
}

/** Tab-completion models are discoverable but not chat-callable. */
export function isChatCallableModelId(modelId: string): boolean {
  return !modelId.startsWith('tab_') && !isRedundantAgyVariant(modelId)
}

export function catalogModel(modelId: string): CatalogModel | undefined {
  const direct = CATALOG_BY_ID.get(modelId)
  if (direct) return direct
  // Aliases for variants:
  if (modelId === 'gemini-3-flash-agent' || modelId === 'gemini-3.5-flash-extra-low' || modelId === 'gemini-3.5-flash') {
    return CATALOG_BY_ID.get('gemini-3.5-flash-low')
  }
  if (modelId === 'gemini-3.1-pro-low' || modelId === 'gemini-3.1-pro') {
    return CATALOG_BY_ID.get('gemini-pro-agent')
  }
  if (modelId.startsWith('gemini-3.6-flash')) {
    return CATALOG_BY_ID.get('gemini-3.6-flash-tiered')
  }
  return undefined
}

/**
 * Level-thinking models: one id + selectable low/medium/high via `thinkingLevel`.
 *
 * The pinned catalog is authoritative for every model it describes. A row
 * without the {@link CatalogModel.thinking} marker must NOT get a level picker
 * even when its id looks like a thinking model: `gemini-3.1-flash-lite` is a
 * catalog row with no thinking support, and the old order below (marker check,
 * then an unconditional prefix guess) handed it a low/medium/high selector —
 * sending `thinkingLevel` to a model that does not accept it is a 400.
 *
 * The prefix guess is kept only for ids the catalog does not know, i.e. a model
 * the endpoint ships after this pin was captured.
 */
export function isLevelThinkingModel(modelId: string): boolean {
  const cat = catalogModel(modelId)
  if (cat !== undefined) return cat.thinking === 'level'
  const lower = modelId.toLowerCase()
  return lower.startsWith('gemini-3') || lower.startsWith('claude-') || lower.startsWith('gpt-oss')
}

/**
 * Which reasoning efforts one Antigravity model actually accepts.
 *
 * Taken from the reference's own table
 * (`ref-dsh-plugin-subscriptions/src/translate/antigravity-thinking.ts` →
 * `antigravityReasoning`), which establishes these per FAMILY rather than offering one
 * set everywhere. The hub previously handed `low, medium, high` to every level-thinking
 * model, which over-offers on two families and under-offers on another:
 *
 *   claude-*                    only `high`     — the runtime takes one budget
 *   gpt-oss-*                   only `medium`   — likewise
 *   gemini-3.1-pro, pro-agent   `low`, `high`   — there is no third distinct level
 *   gemini-2.5*, gemini-3*      `low`, `medium`, `high`
 *   anything else               NONE            — no picker at all
 *
 * A model whose id ends in `-low` / `-medium` / `-high` has that level BOUND to it —
 * `gemini-3.5-flash-low` IS the low variant — so it offers that single level instead of
 * a choice it cannot make.
 *
 * `off` is included wherever there is any level. The reference's `antigravityThinking`
 * accepts `effort === 'off'` for every family and emits
 * `{ includeThoughts: false, thinkingBudget: 0 }`, so thinking can always be turned off;
 * leaving it out is why the picker previously had no way to disable thinking.
 *
 * @param modelId - the wire model id.
 * @returns the effort ids in display order, or an empty list when the model takes none.
 */
export function antigravityEfforts(modelId: string): readonly string[] {
  const lower = modelId.toLowerCase()
  const family: readonly string[] = lower.startsWith('claude-') ? ['high']
    : lower.startsWith('gpt-oss-') ? ['medium']
      : lower.startsWith('gemini-3.1-pro') || lower === 'gemini-pro-agent' ? ['low', 'high']
        : /^gemini-(?:2\.5|3)/.test(lower) ? ['low', 'medium', 'high']
          : []
  if (family.length === 0) return []
  // An id that names its own level is that level, and only that level.
  const bound = /-(low|medium|high)$/.exec(lower)?.[1]
  const levels = bound !== undefined && family.includes(bound) ? [bound] : family
  return ['off', ...levels]
}

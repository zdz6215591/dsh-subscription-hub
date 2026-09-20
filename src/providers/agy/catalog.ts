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

/** Level-thinking models: single id + selectable low/medium/high via thinkingLevel. */
export function isLevelThinkingModel(modelId: string): boolean {
  const cat = catalogModel(modelId)
  if (cat?.thinking === 'level') return true
  const lower = modelId.toLowerCase()
  return lower.startsWith('gemini-3') || lower.startsWith('claude-') || lower.startsWith('gpt-oss')
}

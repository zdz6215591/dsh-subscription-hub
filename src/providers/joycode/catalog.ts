/**
 * Pinned JoyCode (京东) model table — capabilities AND which wire path serves each model.
 *
 * JoyCode's own `modelList` endpoint publishes ids and token budgets but no
 * capability flags, so the table below is the capability source, taken verbatim
 * from the reference implementation's own published matrix
 * (`ref-joycode2api/pkg/openai/types.go: ModelCapabilities` / `ReasoningModels`)
 * and its routing rules (`pkg/joycode/client.go`).
 *
 * ## Three wire paths, not one
 *
 * The platform does not serve every model through one endpoint, and sending a
 * model to the wrong one is SILENT rather than fatal:
 *
 *   - `responses` — the GPT family. The chat path rejects these with upstream
 *     error 1032 ("the IDE routes them through `/api/saas/openai/v1/responses`").
 *   - `anthropic` — the Claude family. The OpenAI paths return EMPTY output for
 *     them, and the native path needs the `-hq` internal id (the bare label
 *     answers 6002).
 *   - `chat` — everything else.
 *
 * @module dsh-subscription-hub/providers/joycode/catalog
 */

/** Which upstream endpoint a model must be called on. */
export type JoyCodePath = 'chat' | 'responses' | 'anthropic'

/** One pinned JoyCode model. */
export interface JoyCodeModel {
  /** Display label — also the wire `model` value on the two OpenAI-shaped paths. */
  id: string
  /** The endpoint this model is served by. */
  path: JoyCodePath
  contextWindow: number
  maxOutputTokens: number
  vision: boolean
  /**
   * The upstream name this model takes on the Anthropic-shaped path. Present for
   * the Claude family only, where the label alone is refused (error 6002) and the
   * `-hq` id is what the endpoint serves.
   */
  anthropicId?: string
  /**
   * Advertised thinking levels, when the model reasons.
   *
   * The GPT family's five levels are VERIFIED distinct by the reference's own
   * test (`pkg/joycode/effort_test.go: TestEffortResponsesFiveDistinctLevels`
   * asserts `low`/`medium`/`high`/`xhigh`/`max` survive as five distinct values).
   * For the chat families the reference forwards the caller's level verbatim as
   * `reasoning_effort` and states that upstream acceptance alone does not prove
   * distinct levels — so this is the request vocabulary the wire takes, not a
   * claim that five distinct behaviours exist behind it.
   */
  efforts?: readonly string[]
}

/**
 * The reasoning vocabulary this route accepts.
 *
 * `off` is the hub's "no reasoning" and maps per path: `reasoning.effort: 'none'`
 * on the GPT family, `thinking: { type: 'disabled' }` on the chat families.
 */
export const JOYCODE_EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/** Models the reference's `ReasoningModels` map marks as reasoning. */
const CHAT_EFFORTS: readonly string[] = JOYCODE_EFFORTS

/** The published model table. `label (context / output)`. */
export const JOYCODE_MODELS: readonly JoyCodeModel[] = [
  // GPT family — Responses path, five verified distinct levels.
  { id: 'GPT-6 Astra', path: 'responses', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true, efforts: JOYCODE_EFFORTS },
  { id: 'GPT-5.6 Sol', path: 'responses', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true, efforts: JOYCODE_EFFORTS },

  // Claude family — native Anthropic path, `-hq` ids. The reference's capability
  // matrix marks them vision-only (no reasoning flag), so they advertise no level
  // picker: a level nobody has measured is worse than no control at all.
  { id: 'Claude-Opus-5', path: 'anthropic', contextWindow: 200_000, maxOutputTokens: 32_000, vision: true, anthropicId: 'Claude-Opus-5-hq' },
  { id: 'Claude-Opus-4.8', path: 'anthropic', contextWindow: 200_000, maxOutputTokens: 32_000, vision: true, anthropicId: 'Claude-Opus-4.8-hq' },
  { id: 'Claude-Opus-4.7', path: 'anthropic', contextWindow: 200_000, maxOutputTokens: 32_000, vision: true, anthropicId: 'Claude-Opus-4.7-hq' },
  { id: 'Claude-Sonnet-4.6', path: 'anthropic', contextWindow: 200_000, maxOutputTokens: 32_000, vision: true, anthropicId: 'Claude-Sonnet-4.6-hq' },
  { id: 'Claude-Opus-4.6', path: 'anthropic', contextWindow: 200_000, maxOutputTokens: 32_000, vision: true, anthropicId: 'Claude-Opus-4.6-hq' },

  // Chat path — the reasoning families.
  { id: 'JoyAI-Code-1.5', path: 'chat', contextWindow: 200_000, maxOutputTokens: 64_000, vision: false },
  { id: 'GLM-5.3', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: false, efforts: CHAT_EFFORTS },
  { id: 'GLM-5.2-jcloud', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: false, efforts: CHAT_EFFORTS },
  { id: 'Kimi-K3', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true, efforts: CHAT_EFFORTS },
  { id: 'Kimi-K3-jcloud', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true, efforts: CHAT_EFFORTS },
  { id: 'Kimi-K2.6', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true, efforts: CHAT_EFFORTS },
  { id: 'Kimi-K2.5', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true },
  { id: 'DeepSeek-V4-Pro', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: false, efforts: CHAT_EFFORTS },
  { id: 'MiniMax-M3', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: true, efforts: CHAT_EFFORTS },
  { id: 'MiniMax-M2.7', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: false, efforts: CHAT_EFFORTS },
  // Doubao is not in the reference's reasoning map, but its `ChatThinking` turns the
  // thinking switch ON whenever the caller sends an effort for it, so the picker is
  // the only way to reach that documented behaviour.
  { id: 'Doubao-Seed-2.0-pro', path: 'chat', contextWindow: 200_000, maxOutputTokens: 16_384, vision: false, efforts: CHAT_EFFORTS },
]

/** Case-insensitive lookup, accepting the `-hq` Anthropic spelling as an alias. */
const BY_ID = new Map<string, JoyCodeModel>()
for (const model of JOYCODE_MODELS) {
  BY_ID.set(model.id.toLowerCase(), model)
  if (model.anthropicId !== undefined) BY_ID.set(model.anthropicId.toLowerCase(), model)
}

/**
 * The pinned row for an id, when the table describes it.
 * @param id - the model id as the roster names it (or an `-hq` alias).
 * @returns the row, or undefined for an id this table does not describe.
 */
export function joyCodeModel(id: string): JoyCodeModel | undefined {
  return BY_ID.get(id.trim().toLowerCase())
}

/**
 * The code-completion-only model.
 *
 * It is discoverable upstream but cannot hold a chat or tool session: the
 * reference answers it with an explicit 400 rather than substituting another
 * model, and this route must do the same — silently swapping in a chat model
 * would answer a request nobody made.
 */
const COMPLETION_ONLY = 'joycode-base-v3'

/** Whether an id can hold a chat session (i.e. belongs in the roster). */
export function isJoyCodeChatModel(id: string): boolean {
  return id.trim().toLowerCase() !== COMPLETION_ONLY
}

/**
 * Which path an id must be called on.
 *
 * The pinned table is authoritative for every id it describes. An unknown id
 * falls back to the family prefix rules the reference uses, because a model
 * shipped after this pin still has to reach the right endpoint: a GPT-family id
 * on the chat path is a 1032, and a Claude-family id on the OpenAI paths
 * answers empty.
 * @param id - the model id.
 * @returns the endpoint family to call.
 */
export function joyCodePathFor(id: string): JoyCodePath {
  const pinned = joyCodeModel(id)
  if (pinned !== undefined) return pinned.path
  const lower = id.trim().toLowerCase()
  if (lower.startsWith('gpt')) return 'responses'
  if (lower.startsWith('claude')) return 'anthropic'
  return 'chat'
}

/**
 * The upstream name for the Anthropic-shaped path.
 *
 * A pinned Claude row carries its `-hq` id; an id that already spells its own
 * `-hq` suffix is passed through unchanged. Nothing is invented for an id the
 * table does not describe — the reference's silent fallback to `Claude-Opus-5-hq`
 * would answer with a model the caller never asked for.
 * @param id - the model id.
 * @returns the upstream model name to send.
 */
export function joyCodeAnthropicId(id: string): string {
  const pinned = joyCodeModel(id)
  if (pinned?.anthropicId !== undefined) return pinned.anthropicId
  return id.trim()
}

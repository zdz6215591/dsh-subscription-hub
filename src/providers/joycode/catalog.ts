/**
 * Pinned JoyCode (JD) model table — capabilities AND which wire path serves each model.
 *
 * ## Where these numbers come from
 *
 * The reference implementation probed every model against the LIVE upstream on
 * 2026-09-10/11 with calibrated token fillers and recorded the result per field
 * (`ref-joycode2api/pkg/dashboard/handler.go`, `modelCapabilities`): its `API`
 * column is the endpoint each model answered on, `Vision` was tested with a
 * base64 PNG, `Reasoning` records the model's own behaviour, `MaxOutput` is the
 * upstream's advertised `respMaxTokens`, and `MeasuredCtx` is a successful
 * input-token observation from a recall test.
 *
 * That table supersedes the older `pkg/openai/types.go` matrix this file first
 * used: there every model advertises a 64k OUTPUT cap (not 16k/32k), and several
 * vision flags differ.
 *
 * ## Two context numbers, on purpose
 *
 * `contextWindow` is the upstream's OWN label (`maxTotalTokens`, 200 000 for
 * every model). The recall probes accepted ~0.9–1.0 MILLION input tokens and
 * their notes record an upstream error at 1 000 000 ("与上游 1M 限制一致"), so the
 * label understates reality. This route declares the published label, not the
 * larger measurement: an understated window makes the harness compact early,
 * while an overstated one breaks a request — and a probe observation is not a
 * documented limit. The live model list's own `maxTotalTokens` wins when present.
 *
 * ## Three wire paths, not one
 *
 * Sending a model to the wrong endpoint is silent rather than fatal:
 *
 *   - `responses` — the GPT family. The chat path rejects these with error 1032.
 *   - `anthropic` — the Claude family. The OpenAI paths return EMPTY output, and
 *     the native path needs the `-hq` internal id (the bare label answers 6002).
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
  /** Whether the model accepts image input (probe: base64 PNG). */
  vision: boolean
  /** Whether the model reasons at all (probe). NOT a level axis — see `efforts`. */
  reasoning: boolean
  /**
   * The upstream name this model takes on the Anthropic-shaped path. Present for
   * the Claude family only, where the label alone is refused (error 6002).
   */
  anthropicId?: string
  /**
   * Advertised thinking levels, when a level axis is documented.
   *
   * Only the GPT family has one: it is served by OpenAI's Responses API, whose
   * `reasoning.effort` vocabulary is published, and the reference's own test
   * (`pkg/joycode/effort_test.go`) pins all five values as surviving translation
   * to `low`/`medium`/`high`/`xhigh`/`max`. What each level DOES upstream is not
   * separately verified — the level is forwarded as-is.
   *
   * The chat families reason without any documented level axis, so they advertise
   * none: their rows say `reasoning: true` and stop there. The reference's own
   * comment calls its reasoning map "legacy capability metadata, not a
   * request-parameter allowlist" and warns that upstream acceptance alone does not
   * prove distinct levels.
   */
  efforts?: readonly string[]
}

/**
 * The reasoning vocabulary this route accepts.
 *
 * `off` is the hub's "no reasoning"; the GPT family maps it to
 * `reasoning.effort: 'none'`.
 */
export const JOYCODE_EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/** The upstream's advertised output cap for every model in the probe table. */
const MAX_OUTPUT = 64_000

/** The upstream's own `maxTotalTokens` label, which every probed model carries. */
const ADVERTISED_CONTEXT = 200_000

/** The published model table. */
export const JOYCODE_MODELS: readonly JoyCodeModel[] = [
  // GPT family — Responses path; the only family with a documented level axis.
  { id: 'GPT-6 Astra', path: 'responses', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: true, efforts: JOYCODE_EFFORTS },
  { id: 'GPT-5.6 Sol', path: 'responses', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: true, efforts: JOYCODE_EFFORTS },

  // Claude family — native Anthropic path with `-hq` ids. The probe records these
  // as non-reasoning, so no level picker exists and no thinking parameter is sent.
  { id: 'Claude-Opus-5', path: 'anthropic', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: false, anthropicId: 'Claude-Opus-5-hq' },
  { id: 'Claude-Opus-4.8', path: 'anthropic', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: false, anthropicId: 'Claude-Opus-4.8-hq' },
  // These three are NOT in the current catalog — the reference keeps them as
  // historical configuration without promising availability. They stay here so a
  // live row that reappears is served on the right path with the right id.
  { id: 'Claude-Opus-4.7', path: 'anthropic', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: false, anthropicId: 'Claude-Opus-4.7-hq' },
  { id: 'Claude-Sonnet-4.6', path: 'anthropic', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: false, anthropicId: 'Claude-Sonnet-4.6-hq' },
  { id: 'Claude-Opus-4.6', path: 'anthropic', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: false, anthropicId: 'Claude-Opus-4.6-hq' },

  // Chat path. `reasoning: true` means the model reasons; it does NOT mean a
  // level picker exists, which is why none of these rows carries `efforts`.
  { id: 'GLM-5.3', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: false, reasoning: true },
  { id: 'GLM-5.2-jcloud', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: false, reasoning: true },
  { id: 'Kimi-K3', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: true },
  { id: 'Kimi-K3-jcloud', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: true, reasoning: true },
  { id: 'DeepSeek-V4-Pro', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: false, reasoning: true },
  { id: 'MiniMax-M3', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: false, reasoning: true },
  { id: 'Doubao-Seed-2.0-pro', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: false, reasoning: false },
  { id: 'JoyAI-Code-1.5', path: 'chat', contextWindow: ADVERTISED_CONTEXT, maxOutputTokens: MAX_OUTPUT, vision: false, reasoning: false },
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
 * on the chat path is a 1032, and a Claude-family id on the OpenAI paths answers
 * empty.
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

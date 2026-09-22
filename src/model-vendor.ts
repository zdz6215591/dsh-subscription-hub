/**
 * Model → vendor attribution for the model list.
 *
 * The picker's rows name a model but not who makes it, and with ten routes behind
 * one list the vendor is exactly what a reader wants at a glance. This module
 * answers one question — "which company is this model from?" — from the model id
 * alone, because that is all both the host payload and the client have.
 *
 * Two rules keep it honest:
 *
 * 1. **A `vendor/model` id is authoritative.** The gateway's own catalog spells
 *    the owner out (`deepseek/deepseek-v4-pro`, `Qwen/Qwen3.8-Max`), so that
 *    segment wins over any heuristic.
 * 2. **An unknown id gets NO vendor, never a guess.** A wrong company label is
 *    worse than a missing one, so the caller renders nothing. This mirrors the
 *    price table's rule that a model it cannot price shows no figure.
 *
 * Client-safe by construction: no node imports, so the browser bundle and the
 * host both use the same table.
 *
 * @module dsh-subscription-hub/model-vendor
 */

/** One vendor's display identity. */
export interface ModelVendor {
  /** Stable key, used for the icon lookup and as a React key. */
  id: string
  /** Display name, shown as the icon's tooltip. */
  label: string
  /**
   * One or two letters for the borderless monogram mark.
   *
   * Deliberately a monogram rather than a reproduction of each company's logo:
   * these are third-party trademarks, and a hand-drawn lookalike that renders
   * subtly wrong is worse than a clean initial that is always right. The mark is
   * `aria-hidden` and the vendor's name rides the tooltip and the row's
   * accessible name, so nothing depends on the glyph.
   */
  mono: string
}

function vendor(id: string, label: string, mono: string): ModelVendor {
  return { id, label, mono }
}

/** Vendors this hub can actually route to, keyed by the owner segment of an id. */
const BY_OWNER: Readonly<Record<string, ModelVendor>> = Object.freeze({
  anthropic: vendor('anthropic', 'Anthropic', 'A'),
  openai: vendor('openai', 'OpenAI', 'O'),
  azureopenai: vendor('openai', 'OpenAI', 'O'),
  google: vendor('google', 'Google', 'G'),
  googlevertex: vendor('google', 'Google', 'G'),
  googlevertexglobal: vendor('google', 'Google', 'G'),
  xai: vendor('xai', 'xAI', 'X'),
  deepseek: vendor('deepseek', 'DeepSeek', 'D'),
  qwen: vendor('qwen', 'Alibaba Qwen', 'Q'),
  alibaba: vendor('qwen', 'Alibaba Qwen', 'Q'),
  moonshotai: vendor('moonshot', 'Moonshot AI', 'M'),
  moonshot: vendor('moonshot', 'Moonshot AI', 'M'),
  'z-ai': vendor('zhipu', 'Z.ai', 'Z'),
  zhipu: vendor('zhipu', 'Z.ai', 'Z'),
  minimaxai: vendor('minimax', 'MiniMax', 'M'),
  minimax: vendor('minimax', 'MiniMax', 'M'),
  meta: vendor('meta', 'Meta', 'M'),
  'meta-llama': vendor('meta', 'Meta', 'M'),
  mistralai: vendor('mistral', 'Mistral AI', 'M'),
  mistral: vendor('mistral', 'Mistral AI', 'M'),
  inclusionai: vendor('inclusionai', 'InclusionAI', 'I'),
  meituan: vendor('meituan', 'Meituan', 'M'),
  longcat: vendor('meituan', 'Meituan', 'M'),
  xiaomi: vendor('xiaomi', 'Xiaomi', 'X'),
  mimo: vendor('xiaomi', 'Xiaomi', 'X'),
  stepfun: vendor('stepfun', 'StepFun', 'S'),
  bytedance: vendor('bytedance', 'ByteDance', 'B'),
  byteplus: vendor('bytedance', 'ByteDance', 'B'),
  doubao: vendor('bytedance', 'ByteDance', 'B'),
  amazon: vendor('amazon', 'Amazon', 'A'),
  nvidia: vendor('nvidia', 'NVIDIA', 'N'),
  cohere: vendor('cohere', 'Cohere', 'C'),
  microsoft: vendor('microsoft', 'Microsoft', 'M'),
  tencent: vendor('tencent', 'Tencent', 'T'),
  hunyuan: vendor('tencent', 'Tencent', 'T'),
  baidu: vendor('baidu', 'Baidu', 'B'),
  ernie: vendor('baidu', 'Baidu', 'B'),
  iflytek: vendor('iflytek', 'iFlytek', 'i'),
  spark: vendor('iflytek', 'iFlytek', 'i'),
  zhipuai: vendor('zhipu', 'Z.ai', 'Z'),
  kimi: vendor('moonshot', 'Moonshot AI', 'M'),
  '01-ai': vendor('01ai', '01.AI', '0'),
  yi: vendor('01ai', '01.AI', '0'),
  openrouter: vendor('openrouter', 'OpenRouter', 'O'),
  baseten: vendor('baseten', 'Baseten', 'B'),
  groq: vendor('groq', 'Groq', 'G'),
  together: vendor('together', 'Together AI', 'T'),
  fireworks: vendor('fireworks', 'Fireworks', 'F'),
  perplexity: vendor('perplexity', 'Perplexity', 'P'),
  ai21: vendor('ai21', 'AI21 Labs', 'A'),
  nvidia_nim: vendor('nvidia', 'NVIDIA', 'N'),
})

/**
 * Id-prefix fallbacks, tried longest-first.
 *
 * Only for an id with no owner segment. Each entry is a family this hub really
 * routes to, so the table cannot silently drift into guessing about models the
 * plugin has never seen.
 */
const BY_PREFIX: readonly (readonly [string, ModelVendor])[] = Object.freeze([
  ['claude', vendor('anthropic', 'Anthropic', 'A')],
  ['gpt-', vendor('openai', 'OpenAI', 'O')],
  ['codex', vendor('openai', 'OpenAI', 'O')],
  ['o1-', vendor('openai', 'OpenAI', 'O')],
  ['o3-', vendor('openai', 'OpenAI', 'O')],
  ['o4-', vendor('openai', 'OpenAI', 'O')],
  ['gemini', vendor('google', 'Google', 'G')],
  ['grok', vendor('xai', 'xAI', 'X')],
  ['deepseek', vendor('deepseek', 'DeepSeek', 'D')],
  ['qwen', vendor('qwen', 'Alibaba Qwen', 'Q')],
  ['glm', vendor('zhipu', 'Z.ai', 'Z')],
  ['kimi', vendor('moonshot', 'Moonshot AI', 'M')],
  ['moonshot', vendor('moonshot', 'Moonshot AI', 'M')],
  ['minimax', vendor('minimax', 'MiniMax', 'M')],
  ['doubao', vendor('bytedance', 'ByteDance', 'B')],
  ['seed-', vendor('bytedance', 'ByteDance', 'B')],
  ['llama', vendor('meta', 'Meta', 'M')],
  ['mistral', vendor('mistral', 'Mistral AI', 'M')],
  ['longcat', vendor('meituan', 'Meituan', 'M')],
  ['mimo', vendor('xiaomi', 'Xiaomi', 'X')],
  ['step-', vendor('stepfun', 'StepFun', 'S')],
  ['hunyuan', vendor('tencent', 'Tencent', 'T')],
  ['ernie', vendor('baidu', 'Baidu', 'B')],
  ['nova-', vendor('amazon', 'Amazon', 'A')],
  ['ling-', vendor('inclusionai', 'InclusionAI', 'I')],
  ['muse-spark', vendor('meta', 'Meta', 'M')],
  ['phi-', vendor('microsoft', 'Microsoft', 'M')],
  ['command-', vendor('cohere', 'Cohere', 'C')],
])

/** The owner segment of a `vendor/model` id, lowercased and trimmed. */
function ownerSegment(modelId: string): string | undefined {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return undefined
  const owner = modelId.slice(0, slash).trim().toLowerCase()
  return owner === '' ? undefined : owner
}

/** The model's own name: everything after the LAST separator, or the whole id. */
function localSegment(modelId: string): string {
  const slash = modelId.lastIndexOf('/')
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

/**
 * Resolve the vendor for one model id.
 *
 * An explicit owner segment wins, then the prefix table, then the segment itself
 * when it names a vendor this hub knows. Anything else answers `undefined`, and
 * the caller must render no vendor rather than a guess.
 * @param modelId - the wire model id, e.g. `deepseek/deepseek-v4-pro`.
 * @returns the vendor, or undefined when the id names none this table knows.
 */
export function modelVendor(modelId: string): ModelVendor | undefined {
  const owner = ownerSegment(modelId)
  // Rule 1: the catalog's own owner segment is authoritative.
  if (owner !== undefined) {
    const known = BY_OWNER[owner]
    if (known !== undefined) return known
    // A `~account:`-style or unknown prefix falls through to the family rules
    // below rather than inventing a vendor from an arbitrary segment.
  }
  // Rule 1b: the model's own name decides by family. The LAST segment is the
  // model, so a nested id still resolves and only the owner check above reads the
  // first one — the same split `agentScoreFor` uses, so the two cannot disagree
  // about which part of an id names the model.
  const local = localSegment(modelId).toLowerCase()
  for (const [prefix, entry] of BY_PREFIX) {
    if (local.startsWith(prefix)) return entry
  }
  return undefined
}

/**
 * The vendors present in a model list, in first-seen order.
 *
 * Used to build the legend strip above the list, so a reader can see at a glance
 * which companies the roster spans without hovering every row.
 * @param modelIds - the ids to scan.
 * @returns the distinct vendors, each once.
 */
export function vendorsOf(modelIds: readonly string[]): ModelVendor[] {
  const seen = new Map<string, ModelVendor>()
  for (const id of modelIds) {
    const entry = modelVendor(id)
    if (entry !== undefined && !seen.has(entry.id)) seen.set(entry.id, entry)
  }
  return [...seen.values()]
}
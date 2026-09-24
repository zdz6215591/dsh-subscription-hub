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
   * The vendor's lab slug in models.dev, when models.dev publishes that lab.
   *
   * The slug is the ATTRIBUTION fact — which lab makes the model — and it is
   * what the icon resolves through (`https://models.dev/logos/labs/{lab}.svg`).
   * It is not a claim that a logo exists: models.dev lists labs whose logo
   * asset is only the generic placeholder, and for those the row renders no
   * mark at all rather than a drawn substitute. See `lab-logo.ts` for the rule
   * and `client/lab-badges.ts` for which slugs really have a logo.
   *
   * Absent for a vendor with no models.dev lab at all (`groq`, `baseten`, …) —
   * and also for an id this table cannot attribute, which is the point: a wrong
   * company is worse than no company.
   */
  lab?: string
}

function vendor(id: string, label: string, lab?: string): ModelVendor {
  return { id, label, ...lab === undefined ? {} : { lab } }
}

/** Vendors this hub can actually route to, keyed by the owner segment of an id. */
const BY_OWNER: Readonly<Record<string, ModelVendor>> = Object.freeze({
  anthropic: vendor('anthropic', 'Anthropic', 'anthropic'),
  openai: vendor('openai', 'OpenAI', 'openai'),
  azureopenai: vendor('openai', 'OpenAI', 'openai'),
  google: vendor('google', 'Google', 'google'),
  googlevertex: vendor('google', 'Google', 'google'),
  googlevertexglobal: vendor('google', 'Google', 'google'),
  xai: vendor('xai', 'xAI', 'xai'),
  deepseek: vendor('deepseek', 'DeepSeek', 'deepseek'),
  qwen: vendor('qwen', 'Alibaba Qwen', 'alibaba'),
  alibaba: vendor('qwen', 'Alibaba Qwen', 'alibaba'),
  moonshotai: vendor('moonshot', 'Moonshot AI', 'moonshotai'),
  moonshot: vendor('moonshot', 'Moonshot AI', 'moonshotai'),
  'z-ai': vendor('zhipu', 'Z.ai', 'zhipuai'),
  zhipu: vendor('zhipu', 'Z.ai', 'zhipuai'),
  minimaxai: vendor('minimax', 'MiniMax', 'minimax'),
  minimax: vendor('minimax', 'MiniMax', 'minimax'),
  meta: vendor('meta', 'Meta', 'meta'),
  'meta-llama': vendor('meta', 'Meta', 'meta'),
  mistralai: vendor('mistral', 'Mistral AI', 'mistral'),
  mistral: vendor('mistral', 'Mistral AI', 'mistral'),
  inclusionai: vendor('inclusionai', 'InclusionAI', 'inclusionai'),
  meituan: vendor('meituan', 'Meituan', 'meituan'),
  longcat: vendor('meituan', 'Meituan', 'meituan'),
  xiaomi: vendor('xiaomi', 'Xiaomi', 'xiaomi'),
  mimo: vendor('xiaomi', 'Xiaomi', 'xiaomi'),
  stepfun: vendor('stepfun', 'StepFun', 'stepfun'),
  bytedance: vendor('bytedance', 'ByteDance', 'bytedance-seed'),
  byteplus: vendor('bytedance', 'ByteDance', 'bytedance-seed'),
  doubao: vendor('bytedance', 'ByteDance', 'bytedance-seed'),
  amazon: vendor('amazon', 'Amazon', 'amazon'),
  nvidia: vendor('nvidia', 'NVIDIA', 'nvidia'),
  cohere: vendor('cohere', 'Cohere', 'cohere'),
  microsoft: vendor('microsoft', 'Microsoft', 'microsoft'),
  tencent: vendor('tencent', 'Tencent', 'tencent'),
  hunyuan: vendor('tencent', 'Tencent', 'tencent'),
  zhipuai: vendor('zhipu', 'Z.ai', 'zhipuai'),
  kimi: vendor('moonshot', 'Moonshot AI', 'moonshotai'),
  perplexity: vendor('perplexity', 'Perplexity', 'perplexity'),
  ai21: vendor('ai21', 'AI21 Labs', 'ai21'),
  nvidia_nim: vendor('nvidia', 'NVIDIA', 'nvidia'),
  // No models.dev lab owns these, so they carry no lab slug and therefore draw no
  // icon: attributing one of them to a lab by guesswork is exactly the failure
  // this table exists to avoid.
  baidu: vendor('baidu', 'Baidu'),
  ernie: vendor('baidu', 'Baidu'),
  iflytek: vendor('iflytek', 'iFlytek'),
  spark: vendor('iflytek', 'iFlytek'),
  '01-ai': vendor('01ai', '01.AI'),
  yi: vendor('01ai', '01.AI'),
  openrouter: vendor('openrouter', 'OpenRouter'),
  baseten: vendor('baseten', 'Baseten'),
  groq: vendor('groq', 'Groq'),
  together: vendor('together', 'Together AI'),
  fireworks: vendor('fireworks', 'Fireworks'),
})

/**
 * Id-prefix fallbacks, tried longest-first.
 *
 * Only for an id with no owner segment. Each entry is a family this hub really
 * routes to, so the table cannot silently drift into guessing about models the
 * plugin has never seen.
 */
const BY_PREFIX: readonly (readonly [string, ModelVendor])[] = Object.freeze([
  ['claude', vendor('anthropic', 'Anthropic', 'anthropic')],
  ['gpt-', vendor('openai', 'OpenAI', 'openai')],
  ['codex', vendor('openai', 'OpenAI', 'openai')],
  ['o1-', vendor('openai', 'OpenAI', 'openai')],
  ['o3-', vendor('openai', 'OpenAI', 'openai')],
  ['o4-', vendor('openai', 'OpenAI', 'openai')],
  ['gemini', vendor('google', 'Google', 'google')],
  ['grok', vendor('xai', 'xAI', 'xai')],
  ['deepseek', vendor('deepseek', 'DeepSeek', 'deepseek')],
  ['qwen', vendor('qwen', 'Alibaba Qwen', 'alibaba')],
  ['glm', vendor('zhipu', 'Z.ai', 'zhipuai')],
  ['kimi', vendor('moonshot', 'Moonshot AI', 'moonshotai')],
  ['moonshot', vendor('moonshot', 'Moonshot AI', 'moonshotai')],
  ['minimax', vendor('minimax', 'MiniMax', 'minimax')],
  ['doubao', vendor('bytedance', 'ByteDance', 'bytedance-seed')],
  ['seed-', vendor('bytedance', 'ByteDance', 'bytedance-seed')],
  ['llama', vendor('meta', 'Meta', 'meta')],
  ['mistral', vendor('mistral', 'Mistral AI', 'mistral')],
  ['longcat', vendor('meituan', 'Meituan', 'meituan')],
  ['mimo', vendor('xiaomi', 'Xiaomi', 'xiaomi')],
  ['step-', vendor('stepfun', 'StepFun', 'stepfun')],
  ['hunyuan', vendor('tencent', 'Tencent', 'tencent')],
  ['ernie', vendor('baidu', 'Baidu')],
  ['nova-', vendor('amazon', 'Amazon', 'amazon')],
  ['ling-', vendor('inclusionai', 'InclusionAI', 'inclusionai')],
  ['muse-spark', vendor('meta', 'Meta', 'meta')],
  ['phi-', vendor('microsoft', 'Microsoft', 'microsoft')],
  ['command-', vendor('cohere', 'Cohere', 'cohere')],
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
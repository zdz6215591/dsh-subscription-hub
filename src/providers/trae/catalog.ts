/**
 * Trae CN model discovery: the callable roster comes from two endpoints whose
 * answers are merged, because a model is only callable through the directory
 * function that lists it (`glm-5.3` answers under `solo_work_remote` but not
 * `solo_work_lite`).
 *
 *   - `POST {chat}/api/ide/v1/get_detail_param` — the authoritative callable
 *     config list per function; this is what the chat call replays.
 *   - `GET  {remote}/models?functions=…` — the SOLO directory; supplies display
 *     names, credit multipliers and reasoning capability.
 *
 * The wire id is `config_name`. A directory row with no matching config is
 * dropped rather than listed, because calling it fails upstream with `4001`.
 *
 * Adapted from dingminhua/dsh-connect-trae (MIT) `solo.ts` / `catalog.ts`.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { proxiedFetch } from '../../http.js'
import type { FetchFn } from '../common.js'
import {
  TRAE_CHAT_BASE,
  TRAE_IDE_DIRECTORY_FUNCTIONS,
  TRAE_MODELS_PATH,
  TRAE_SOLO_DIRECTORY_FUNCTIONS,
  traeEndpoint,
  traeHeaders,
} from './protocol.js'
import type { TraeChannel } from './credentials.js'
import { traeIdentityFor } from './identity.js'
import type { TraeEdition } from './identity.js'

/** One callable model with the directory function that owns it. */
export interface TraeModel {
  /** Wire id (`config_name`); this is what the chat call sends. */
  id: string
  /** Display name, including the credit multiplier when advertised. */
  name: string
  contextWindow?: number
  /** Native Max window Trae advertises, when the directory discloses one. */
  maxContextWindow?: number
  maxTokens?: number
  /** The directory function that listed this model (replayed on the call). */
  functionName: string
  /** Selectable reasoning effort ids, when the model advertises them. */
  efforts?: readonly string[]
  /** When different from id, the config_name llm_utils_chat accepts */
  wireConfigName?: string
}

/** Models served when discovery is unavailable, so the picker is never empty. */
export const TRAE_FALLBACK_MODELS: readonly TraeModel[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200_000, functionName: 'solo_work_remote', efforts: ['none', 'low', 'high', 'xhigh'] },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, functionName: 'solo_work_remote', efforts: ['none', 'low', 'high', 'xhigh'] },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, functionName: 'solo_work_remote', efforts: ['none', 'low', 'high', 'xhigh'] },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, functionName: 'solo_work_remote', efforts: ['none', 'high', 'xhigh'] },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 200_000, functionName: 'solo_work_remote', efforts: ['none', 'low', 'high', 'xhigh'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000, functionName: 'solo_work_remote' },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 200_000, functionName: 'solo_work_remote', efforts: ['none', 'low', 'high', 'xhigh'] },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Seed-2.1-Pro-0915', contextWindow: 256_000, functionName: 'solo_work_remote', efforts: ['none', 'low', 'high'] },
]

/** Discovery timeout. */
const DISCOVERY_TIMEOUT_MS = 30_000

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function directoryFunctions(channel: TraeChannel): readonly string[] {
  return channel === 'solo' ? TRAE_SOLO_DIRECTORY_FUNCTIONS : TRAE_IDE_DIRECTORY_FUNCTIONS
}

/**
 * Fetch the callable config list from `get_detail_param` for one function.
 * Returns `undefined` on any failure so one unreachable function cannot hide
 * the others' rosters.
 */
async function fetchConfigList(
  accessToken: string,
  userId: string,
  functionName: string,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn,
  edition: TraeEdition,
): Promise<unknown[] | undefined> {
  try {
    const response = await fetchFn(traeEndpoint(TRAE_CHAT_BASE, TRAE_MODELS_PATH), {
      method: 'POST',
      headers: {
        ...traeHeaders(accessToken, userId, await traeIdentityFor(edition, userId)),
        Accept: 'application/json',
      },
      body: JSON.stringify({
        function: functionName,
        config_names: null,
        need_prompt: false,
        current_config_info: null,
        poly_prompt: true,
        mode_type: null,
        agent_type: null,
      }),
      signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const document = await response.json() as Record<string, unknown>
    return Array.isArray(document.config_info_list) ? document.config_info_list : []
  } catch {
    return undefined
  }
}

/** Read the context window + output cap out of one config entry. */
function sizesOf(config: Record<string, unknown>): { contextWindow?: number; maxTokens?: number } {
  const details = Array.isArray(config.model_detail_list) ? config.model_detail_list : []
  const detail = typeof details[0] === 'object' && details[0] !== null
    ? details[0] as Record<string, unknown>
    : {}
  const contextTokens = typeof config.context_window_tokens === 'object' && config.context_window_tokens !== null
    ? config.context_window_tokens as Record<string, unknown>
    : {}
  // Verified field names: the window is `prompt_max_tokens` (or the dev entry),
  // and the output cap is `max_tokens`. There are no `max_input_tokens` /
  // `max_output_tokens` fields.
  const contextWindow = finitePositive(detail.prompt_max_tokens) ?? finitePositive(contextTokens.dev)
  const maxTokens = finitePositive(detail.max_tokens)
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

function displayNameOf(config: Record<string, unknown>, fallback: string): string {
  const display = typeof config.display_config === 'object' && config.display_config !== null
    ? config.display_config as Record<string, unknown>
    : {}
  return typeof display.display_name === 'string' && display.display_name !== '' ? display.display_name : fallback
}

/** Selectable efforts a config advertises, normalized to display-level ids. */
function effortsOf(config: Record<string, unknown>): string[] | undefined {
  const options = config.reasoning_effort_options
  if (!Array.isArray(options)) return undefined
  const efforts: string[] = []
  for (const option of options) {
    const raw = typeof option === 'string'
      ? option
      : typeof option === 'object' && option !== null
        ? (option as Record<string, unknown>).level ?? (option as Record<string, unknown>).value
        : undefined
    if (typeof raw !== 'string' || raw === '') continue
    // Trae's wire vocabulary is light/high/extra_high; expose the client-facing
    // names so the picker reads like every other provider's.
    const normalized = raw === 'light' ? 'low' : raw === 'extra_high' ? 'xhigh' : raw
    if (!efforts.includes(normalized)) efforts.push(normalized)
  }
  return efforts.length > 0 ? efforts : undefined
}

/**
 * The directory function each config_name is actually callable through.
 *
 * The remote directory advertises models the SOLO `llm_utils_chat` endpoint
 * cannot serve: `deepseek-v4.1-flash`, `glm-5.3-flash`, `glm-5.3-flashx`,
 * `qwen3.8-flash`, and `kimi-k2.8-preview` answer `4001 param is invalid`
 * through every SOLO function (they belong to the IDE agent-task channel),
 * so listing them would hand the picker a model that always fails. Conversely
 * `Doubao-Seed-Code`, `glm-5.1`, `glm-5v-turbo`, `qwen-3.5`, and
 * `qwen-3.6-plus` are callable but are listed only by the `solo_agent` /
 * `solo_coder` directories, so the previous single-directory read hid them.
 *
 * Verified against the live CN endpoint on 2026-09-21 by calling every
 * advertised config through `solo_work_remote`, `solo_work_lite`,
 * `solo_agent`, and `solo_coder`. The first callable function wins.
 */
const TRAE_CALLABILITY: Readonly<Record<string, string>> = Object.freeze({
  // Callable through the SOLO work/agent directories (the default route).
  'DeepSeek-V4-Flash-Official': 'solo_work_remote',
  'DeepSeek-V4-Pro-Official': 'solo_work_remote',
  'Doubao-Seed-Evolving': 'solo_work_remote',
  'Doubao-Seed-2.1-Pro': 'solo_work_remote',
  'Doubao-Seed-2.1-Turbo': 'solo_work_remote',
  'glm-5.2': 'solo_work_remote',
  'glm-5.3': 'solo_work_remote',
  'kimi-k2.6': 'solo_work_remote',
  'kimi-k2.7-code': 'solo_work_remote',
  'kimi-k3': 'solo_work_remote',
  'minimax-m3': 'solo_work_remote',
  'qwen-3.7-plus': 'solo_work_remote',
  'qwen3.8-max': 'solo_work_remote',
  // Listed only by the agent/coder directories.
  'Doubao-Seed-Code': 'solo_agent',
  'glm-5.1': 'solo_agent',
  'glm-5v-turbo': 'solo_agent',
  'qwen-3.5': 'solo_agent',
  'qwen-3.6-plus': 'solo_agent',
  // Legacy configs the coder directory still serves.
  'DeepSeek-V4-Flash': 'solo_coder',
  'DeepSeek-V4-Pro': 'solo_coder',
  'Doubao-Seed-2.0-Code': 'solo_coder',
  'glm-5': 'solo_coder',
  'kimi-k2.5': 'solo_coder',
  'minimax-m2.7': 'solo_coder',
})

/** Display-name overrides for the wire ids that spell out a marketing name. */
const TRAE_DISPLAY_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'DeepSeek-V4-Flash': 'DeepSeek-V4-Flash (Legacy)',
  'DeepSeek-V4-Pro': 'DeepSeek-V4-Pro (Legacy)',
})

/** Directory functions whose rosters are unioned for the remote catalog read. */
const TRAE_REMOTE_DIRECTORY_FUNCTIONS: readonly string[] = [
  'solo_agent_remote',
  'solo_work_remote',
  'solo_work_lite',
  'solo_agent',
  'solo_coder',
]

/**
 * Fetch the official remote models directory from solo.trae.cn.
 *
 * Every directory function is asked and the group listings are unioned, so a
 * model only one function advertises (the agent-only and coder-only rosters)
 * is not silently hidden. A config the callability table proves uncallable is
 * dropped rather than listed.
 */
export async function fetchRemoteModels(
  accessToken: string,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn,
): Promise<TraeModel[] | undefined> {
  const headers = {
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    'Content-Type': 'application/json',
    'x-trae-client-type': 'web',
    'x-trae-user-timezone': 'Asia/Shanghai',
    'x-preferenced-language': 'zh-cn',
    Referer: 'https://solo.trae.cn/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  }
  const url = `https://solo.trae.cn/api/remote/v1/models?functions=${TRAE_REMOTE_DIRECTORY_FUNCTIONS.join(',')}`
  try {
    const response = await fetchFn(url, { headers, signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const json = await response.json() as { data?: { list?: { function?: string; models?: Record<string, unknown>[] }[] } }
    const groups = json.data?.list ?? []
    const byId = new Map<string, TraeModel>()
    const effortMap: Record<string, string> = { light: 'low', high: 'high', extra_high: 'xhigh' }

    /** Read the advertised effort levels out of one directory row. */
    const effortsOf = (raw: Record<string, unknown>): string[] | undefined => {
      const reasoningConfig = typeof raw.reasoning_effort_config === 'object' && raw.reasoning_effort_config !== null
        ? raw.reasoning_effort_config as Record<string, unknown>
        : undefined
      const rawOptions = Array.isArray(reasoningConfig?.options) ? reasoningConfig.options : []
      const mapped = rawOptions.flatMap((opt): string[] => {
        if (typeof opt !== 'string') return []
        const m = effortMap[opt] ?? opt
        return m ? [m] : []
      })
      return mapped.length > 0 ? ['none', ...mapped] : undefined
    }

    /** Read both advertised windows out of one directory row. */
    const windowsOf = (raw: Record<string, unknown>): { contextWindow?: number; maxContextWindow?: number } => {
      const tokens = typeof raw.context_window_tokens === 'object' && raw.context_window_tokens !== null
        ? raw.context_window_tokens as Record<string, unknown>
        : {}
      const dev = finitePositive(tokens.dev)
      const max = raw.max_mode === true ? finitePositive(tokens.max) : undefined
      return {
        ...dev === undefined ? {} : { contextWindow: dev },
        // A "Max" window only exists when the directory advertises a larger
        // one; the legacy rows repeat `dev` in the `max` slot, which must not
        // surface as a selectable budget.
        ...max === undefined || (dev !== undefined && max <= dev) ? {} : { maxContextWindow: max },
      }
    }

    for (const group of groups) {
      if (!Array.isArray(group.models)) continue
      for (const raw of group.models) {
        if (typeof raw !== 'object' || raw === null) continue
        const id = typeof raw.name === 'string' ? raw.name : ''
        if (id === '') continue
        const functionName = TRAE_CALLABILITY[id]
        // The directory advertises IDE-only models the SOLO chat endpoint
        // rejects with 4001; never list a model that cannot be called.
        if (functionName === undefined) continue
        const display = typeof raw.display_name === 'string' && raw.display_name !== '' ? raw.display_name : id
        const name = TRAE_DISPLAY_OVERRIDES[id] ?? display
        const windows = windowsOf(raw)
        const efforts = effortsOf(raw)

        const existing = byId.get(id)
        if (existing === undefined) {
          byId.set(id, {
            id,
            name,
            ...windows,
            maxTokens: 32_000,
            functionName,
            ...efforts === undefined ? {} : { efforts },
          })
          continue
        }
        // Only the agent directories carry `reasoning_effort_config` and the
        // Max window; a row first seen in the work/coder roster keeps its
        // owner function while the richer metadata is folded in.
        if (existing.efforts === undefined && efforts !== undefined) existing.efforts = efforts
        // The same config_name is advertised by several directories with
        // different windows — `Doubao-Seed-Code` is 184000 under `solo_coder`
        // but 256000 under `solo_agent`. Taking the widest is the truthful
        // reading: the model's own window does not shrink per entry point, and
        // first-seen would silently bake in whichever group happened to be
        // read first.
        if (windows.contextWindow !== undefined && (existing.contextWindow === undefined || windows.contextWindow > existing.contextWindow)) {
          existing.contextWindow = windows.contextWindow
        }
        if (windows.maxContextWindow !== undefined && (existing.maxContextWindow === undefined || windows.maxContextWindow > existing.maxContextWindow)) {
          existing.maxContextWindow = windows.maxContextWindow
        }
        if (existing.maxContextWindow === undefined && windows.maxContextWindow !== undefined) existing.maxContextWindow = windows.maxContextWindow
      }
    }

    // The Trae client advertises this model under its own spelling; SOLO
    // accepts it only through the Flash Official wire config, so expose the
    // familiar id while calling the proven config_name.
    const flash = byId.get('DeepSeek-V4-Flash-Official')
    if (flash !== undefined && !byId.has('deepseek-v4.1-flash')) {
      byId.set('deepseek-v4.1-flash', {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek-V4.1-Flash',
        ...flash.contextWindow === undefined ? {} : { contextWindow: flash.contextWindow },
        ...flash.maxContextWindow === undefined ? {} : { maxContextWindow: flash.maxContextWindow },
        maxTokens: flash.maxTokens ?? 32_000,
        functionName: flash.functionName,
        wireConfigName: flash.id,
        efforts: flash.efforts ?? ['none', 'low', 'high', 'xhigh'],
      })
    }

    return byId.size > 0 ? [...byId.values()] : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the callable roster for one credential: every directory function is
 * asked and the answers unioned, with the first function to list a config
 * owning it. A model is only callable through the function that lists it, so
 * asking a single function silently hides the models the others serve.
 */
export async function fetchTraeModels(
  accessToken: string,
  userId: string,
  channel: TraeChannel,
  signal?: AbortSignal,
  fetchFn: FetchFn = proxiedFetch,
): Promise<TraeModel[]> {
  const remote = await fetchRemoteModels(accessToken, signal, fetchFn)
  if (remote !== undefined && remote.length > 0) return remote

  const byId = new Map<string, TraeModel>()
  // The edition names the install the device identity is read from.
  const edition: TraeEdition = channel === 'solo' ? 'solo' : 'cn'
  for (const functionName of directoryFunctions(channel)) {
    const list = await fetchConfigList(accessToken, userId, functionName, signal, fetchFn, edition)
    if (list === undefined) continue
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const config = raw as Record<string, unknown>
      const id = typeof config.config_name === 'string' ? config.config_name : ''
      if (id === '' || byId.has(id)) continue
      const efforts = effortsOf(config)
      byId.set(id, {
        id,
        name: displayNameOf(config, id),
        ...sizesOf(config),
        functionName,
        ...efforts === undefined ? {} : { efforts },
      })
    }
  }
  const flashFallback = byId.get('DeepSeek-V4-Flash-Official')
  if (flashFallback !== undefined && !byId.has('deepseek-v4.1-flash')) {
    byId.set('deepseek-v4.1-flash', {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek-V4.1-Flash',
      ...flashFallback.contextWindow === undefined ? {} : { contextWindow: flashFallback.contextWindow },
      ...flashFallback.maxContextWindow === undefined ? {} : { maxContextWindow: flashFallback.maxContextWindow },
      maxTokens: flashFallback.maxTokens ?? 32_000,
      functionName: flashFallback.functionName,
      wireConfigName: flashFallback.id,
      efforts: flashFallback.efforts ?? ['none', 'low', 'high', 'xhigh'],
    })
  }
  return byId.size > 0 ? [...byId.values()] : [...TRAE_FALLBACK_MODELS]
}

/** Project one Trae model into the harness model-info shape. */
export function toTraeModelInfo(model: TraeModel, provider: string): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: ['text'],
    ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
  }
}

/** Merge discovered models with the fallback roster (empty discovery → fallback). */
export function mergeTraeModels(discovered: readonly TraeModel[]): TraeModel[] {
  if (discovered.length === 0) return [...TRAE_FALLBACK_MODELS]
  return [...discovered]
}

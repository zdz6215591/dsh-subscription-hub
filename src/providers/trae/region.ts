/**
 * Trae's region model: two service buckets, and the gateways each one uses.
 *
 * Trae is effectively two services behind one product. The CN service and the
 * international ("ai") service expose the SAME wire shapes, so a single adapter
 * serves both — but their gateways, model rosters and refresh contracts differ,
 * and a CN credential pointed at an international gateway simply fails.
 *
 * The region is therefore derived from the CREDENTIAL ITSELF, in three levels,
 * so no user configuration is ever needed:
 *
 * 1. the `userRegion` claim the desktop storage carries (`{"region":"CN"}` or a
 *    bare lowercase `"sg"`),
 * 2. the credential's own host suffix (`.trae.ai` vs `.trae.cn`),
 * 3. the edition label the import read it from.
 *
 * Ported from dingminhua/dsh-connect-trae (MIT) `src/region.ts`, whose
 * `docs/INTL_SG_EVIDENCE.md` records the gateway bases as observed from the
 * official app's own calls on 2026-09-15.
 *
 * **Verification boundary:** the CN gateways are exercised by this hub's own
 * live tests. The international ones are transcribed from that evidence, not
 * verified here — no international credential was available to probe. They are
 * therefore only ever selected for a credential that claims the ai region, so a
 * CN account cannot be routed onto an unverified gateway.
 *
 * @module dsh-subscription-hub/providers/trae/region
 */

import type { TraeEdition } from './identity.js'

/** The service bucket a credential belongs to. */
export type TraeRegion = 'cn' | 'ai'

/** One region's upstream bases. */
export interface TraeRegionGateways {
  /** Chat + agent API base (the `llm_utils_chat` family). */
  readonly chat: string
  /** SOLO remote model directory base. */
  readonly remote: string
  /** Pay/status API base, used when the credential names no host of its own. */
  readonly pay: string
}

/**
 * Gateway bases per region.
 *
 * The international gateways are shared by both international installs (the
 * Trae desktop app and TRAE SOLO). The mchost shards behind them answer the same
 * bytes but are internal, so the single stable entry point is used.
 */
export const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>> = Object.freeze({
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  // Transcribed from the reference's evidence, not probed from here.
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
})

/** Region of an edition label: the international installs belong to `ai`. */
export function regionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

/**
 * Region from the credential's `userRegion` claim.
 *
 * The desktop storage spells it as an object (`{"region":"CN"}`) while the app's
 * own logs spell it bare and lowercase (`"sg"`), so both shapes are accepted.
 * @param value - the raw claim, whatever shape it arrived in.
 * @returns the region, or undefined when the value names none this build knows.
 */
export function regionOfUserRegion(value: unknown): TraeRegion | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  if (typeof raw !== 'string') return undefined
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'cn') return 'cn'
  // `ai` is accepted because the app logs use it as a synonym for `sg`.
  if (lowered === 'sg' || lowered === 'ai') return 'ai'
  return undefined
}

/**
 * Region from a credential host.
 * @param host - the host, with or without a scheme.
 * @returns the region, or undefined when the host names neither.
 */
export function regionOfHost(host: string | undefined): TraeRegion | undefined {
  if (host === undefined) return undefined
  const trimmed = host.trim()
  if (trimmed === '') return undefined
  let hostname: string
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return undefined
  }
  if (hostname === 'trae.ai' || hostname.endsWith('.trae.ai')) return 'ai'
  // The bare `trae.com.cn` is listed explicitly as well as its subdomains: the
  // `endsWith('.trae.com.cn')` form alone misses the apex, which is a real host
  // the CN service answers on.
  if (hostname === 'trae.cn' || hostname.endsWith('.trae.cn')) return 'cn'
  if (hostname === 'trae.com.cn' || hostname.endsWith('.trae.com.cn')) return 'cn'
  return undefined
}

/**
 * The region of one credential: the claim wins, the host suffix is the fallback,
 * the edition label is the last resort.
 * @param credential - the credential's own facts.
 * @returns the region to route this credential with.
 */
export function regionOfCredential(credential: {
  edition: TraeEdition
  host?: string
  userRegion?: string
}): TraeRegion {
  return regionOfUserRegion(credential.userRegion)
    ?? regionOfHost(credential.host)
    ?? regionOfEdition(credential.edition)
}

/**
 * The gateways for one credential, preferring the credential's own host for the
 * pay endpoints.
 *
 * The pay endpoints are the web dashboard's own and are per-region; a credential
 * that named its host is the better authority than the table, because a
 * relocated account keeps answering on the host it authenticated against.
 * @param credential - the credential's own facts.
 * @returns the bases to use.
 */
export function gatewaysFor(credential: {
  edition: TraeEdition
  host?: string
  userRegion?: string
}): TraeRegionGateways {
  const region = regionOfCredential(credential)
  const table = REGION_GATEWAYS[region]
  const host = credential.host?.trim().replace(/\/+$/, '')
  if (host === undefined || host === '') return table
  // Only the pay base follows the credential's host; chat and remote come from
  // the table because those are the addresses the gateway itself serves.
  return { chat: table.chat, remote: table.remote, pay: host }
}
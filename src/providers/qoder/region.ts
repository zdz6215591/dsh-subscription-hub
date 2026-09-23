/**
 * Qoder deployments and every upstream URL the transport can address.
 *
 * Qoder ships two independent service regions. They are not mirrors of one
 * another: each has its own API gateway, its own OpenAPI (account/quota)
 * host, and its own center service (the durable image object store), and a
 * credential minted for one region is not accepted by the other. The region is
 * therefore immutable transport state, chosen once when an account is added —
 * never re-derived per request.
 *
 * Ported verbatim from `masknull/dsh-qoder-connect` `src/qoder/region.ts` and
 * `src/qoder/transport/endpoints.ts` (MIT), whose addresses were read off the
 * shipped qodercli client. Nothing here is inferred: an address the reference
 * does not carry does not exist.
 *
 * @module dsh-subscription-hub/providers/qoder/region
 */

/** Qoder upstream deployment selected for one immutable transport instance. */
export type QoderRegion = 'global' | 'china'

/** The three hosts one Qoder region serves. */
export interface QoderRegionEndpoints {
  /** Model gateway: chat streaming and the model catalog live under `/algo` here. */
  baseUrl: string
  /** Account API: PAT exchange, identity, quota, plan, and status. */
  openApiUrl: string
  /** Center service that owns durable image objects for multimodal input. */
  centerUrl: string
}

/** Addresses of both deployments, exactly as the reference records them. */
export const qoderRegionEndpoints: Record<QoderRegion, QoderRegionEndpoints> = {
  global: {
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    centerUrl: 'https://center.qoder.sh',
  },
  china: {
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    centerUrl: 'https://gateway.qoder.com.cn',
  },
}

/** Signed path of the center image upload route; it never carries an `/algo` prefix. */
export const qoderImageUploadPath = '/api/v2/image/upload'

/** Path of the center web search route. */
export const qoderWebSearchPath = '/api/v1/webSearch/oneSearch'

/** Global gateway base URL (the default region's `baseUrl`). */
export const qoderGlobalBaseUrl = qoderRegionEndpoints.global.baseUrl
/** Global OpenAPI base URL (the default region's `openApiUrl`). */
export const qoderGlobalOpenApiUrl = qoderRegionEndpoints.global.openApiUrl

/**
 * Resolve one region's three hosts.
 * @param region - the deployment; defaults to `global` when omitted.
 * @returns the region's endpoint table.
 */
export function resolveQoderEndpoints(region: QoderRegion = 'global'): QoderRegionEndpoints {
  return qoderRegionEndpoints[region] ?? qoderRegionEndpoints.global
}

/**
 * Build the streaming chat URL (`Encode=1` selects the WAF body encoding).
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified chat endpoint.
 */
export function getQoderChatUrl(region: QoderRegion = 'global'): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  return `${baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
}

/**
 * Build the model catalog URL (`Encode=1` selects the WAF body encoding).
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified catalog endpoint.
 */
export function getQoderModelListUrl(region: QoderRegion = 'global'): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  return `${baseUrl}algo/api/v2/model/list?Encode=1`
}

/**
 * Build the center image upload URL.
 *
 * qodercli's WASM `prepareRequest` adds `/algo` to the HTTP URL but not to the
 * signed path, so the prefix belongs in the address and is stripped again by
 * {@link computeSigPath} at signature time.
 * @param region - the deployment; defaults to `global`.
 * @param requestId - optional upload correlation id appended as a query parameter.
 * @returns the fully qualified upload endpoint.
 */
export function getQoderImageUploadUrl(region: QoderRegion = 'global', requestId?: string): string {
  const { centerUrl } = resolveQoderEndpoints(region)
  const base = `${centerUrl.replace(/\/+$/u, '')}/algo${qoderImageUploadPath}`
  return requestId === undefined ? base : `${base}?request_id=${encodeURIComponent(requestId)}`
}

/**
 * Build the PAT → job-token exchange URL.
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified exchange endpoint.
 */
export function getQoderExchangeUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v1/jobToken/exchange`
}

/**
 * Build the identity lookup URL.
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified userinfo endpoint.
 */
export function getQoderUserInfoUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v1/userinfo`
}

/**
 * Build the credit/quota usage URL.
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified usage endpoint.
 */
export function getQoderUsageUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v2/quota/usage`
}

/**
 * Build the subscription plan URL.
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified plan endpoint.
 */
export function getQoderUserPlanUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v2/user/plan`
}

/**
 * Build the account feature-flag URL.
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified status endpoint.
 */
export function getQoderUserStatusUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v3/user/status`
}

/**
 * Build the center web search URL (`Encode=1` selects the WAF body encoding).
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified web search endpoint.
 */
export function getQoderWebSearchUrl(region: QoderRegion = 'global'): string {
  const { centerUrl } = resolveQoderEndpoints(region)
  return `${centerUrl.replace(/\/+$/u, '')}/algo${qoderWebSearchPath}?Encode=1`
}

/**
 * Build the campaign list URL.
 * @param region - the deployment; defaults to `global`.
 * @returns the fully qualified campaigns endpoint.
 */
export function getQoderCampaignsUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/sash/api/v1/me/campaigns`
}

/**
 * Build the campaign claim URL.
 * @param region - the deployment; defaults to `global`.
 * @param campaignId - the campaign to claim.
 * @returns the fully qualified claim endpoint.
 */
export function getQoderClaimCampaignUrl(region: QoderRegion = 'global', campaignId: string): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`
}

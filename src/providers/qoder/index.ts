/**
 * Qoder provider surface: the whole ported Qoder protocol behind one clean seam.
 *
 * This directory is self-contained. Nothing outside it is imported except the
 * hub's own generic plumbing (`../../http.js` for proxy routing,
 * `../common.js` for the `ProviderUsage` shape, `../rate-limit.js` for the
 * subscription retry policy) and the two harness packages every provider uses.
 * The integration therefore only needs this module.
 *
 * The reference plugin this was ported from (`masknull/dsh-qoder-connect`, MIT)
 * speaks two protocols side by side — Qoder Global and Qoder China — as two
 * registered providers. They are the SAME wire protocol against different hosts,
 * while a PAT is minted for exactly one of them, so this port keeps them as one
 * adapter with a `region` option that accepts either a fixed region or a
 * per-account resolver: a single `qoder` route serves both deployments, each
 * account addressed at the host its own credential belongs to.
 *
 * @module dsh-subscription-hub/providers/qoder
 */

export { QoderAdapter, defaultStreamIdleTimeoutMs } from './adapter.js'
export type { QoderAdapterOptions, QoderRegionResolver } from './adapter.js'

export {
  getQoderCampaignsUrl,
  getQoderChatUrl,
  getQoderClaimCampaignUrl,
  getQoderExchangeUrl,
  getQoderImageUploadUrl,
  getQoderModelListUrl,
  getQoderUsageUrl,
  getQoderUserInfoUrl,
  getQoderUserPlanUrl,
  getQoderUserStatusUrl,
  getQoderWebSearchUrl,
  qoderGlobalBaseUrl,
  qoderGlobalOpenApiUrl,
  qoderImageUploadPath,
  qoderRegionEndpoints,
  qoderWebSearchPath,
  resolveQoderEndpoints,
} from './region.js'
export type { QoderRegion, QoderRegionEndpoints } from './region.js'

export { getMachineId, qoderMachineIdPath } from './machine-id.js'

export {
  isQoderAuthRejection,
  isQoderPermanentRefreshError,
  qoderError,
  qoderHttpError,
  qoderRequestId,
  retryAfterMs,
  QODER_ABORTED_CODE,
  QODER_MISSING_CREDENTIAL_CODE,
  QODER_PREEMPT_MS,
  QODER_PROTOCOL_ERROR_CODE,
  QODER_TRANSPORT_CODE,
  QODER_UNSUPPORTED_CODE,
} from './errors.js'
export type { QoderErrorResponse } from './errors.js'

export { logParsedResponse, redactLogPayload, redactLogValue } from './logging.js'
export type { QoderLogger } from './logging.js'

export { qoderDecodeBody, qoderDecodeBodyBuffer, qoderEncodeBody } from './encoding.js'

export { buildAuthHeaders, computeSigPath, defaultUserAgent, qoderClientType, qoderDesktopClientType, qoderIdeVersion } from './cosy.js'
export type { CosyCredentials } from './cosy.js'

export { QoderThinkingParser } from './thinking.js'
export type { QoderContentSegment } from './thinking.js'

export { translateTools, validateAndTranslateMessages, validateMessageShapes } from './translate.js'
export type { QoderImageAttachments, QoderImageResolver, QoderTranslateContext } from './translate.js'

export { buildQoderRequestBody, translateQoderMessages, validateQoderRequest, validateQoderRequestShape } from './serialize.js'

export { defaultMaxSseBufferChars, parseQoderSse } from './sse.js'
export type { QoderSseOptions } from './sse.js'

export {
  defaultMaxErrorBytes,
  defaultMaxJsonBytes,
  defaultMetadataTimeoutMs,
  defaultResponseHeaderTimeoutMs,
  opaqueCredentialKey,
  openApiJsonRequest,
  qoderDefaultFetch,
  readLimitedText,
  retryMetadataRead,
  SingleFlight,
  withDeadline,
} from './request.js'
export type { OpenApiJsonRequestOptions } from './request.js'

export { probeQoderPat, QoderAuthService } from './auth.js'
export {
  autoCheckinQoder,
  claimQoderCheckin,
  fetchQoderCampaigns,
  getQoderCheckinStatusView,
  qoderCheckinStatePath,
  qoderDayString,
  readQoderCheckinState,
  writeQoderCheckinState,
} from './checkin.js'
export type { QoderCampaign, QoderCheckinOutcome, QoderCheckinState, QoderCheckinStatusView } from './checkin.js'
export type { QoderAuthServiceOptions, QoderJobToken, QoderPatProbe } from './auth.js'

export {
  defaultMaxTokens,
  defaultModels,
  fetchQoderModels,
  hasSameQoderDiscoveryMetadata,
  mergeQoderDiscoveryMetadata,
  normalizeQoderModels,
} from './catalog.js'
export type { CatalogConflict, FetchQoderModelsOptions, QoderCatalogModel } from './catalog.js'

export { streamQoderChat } from './chat.js'
export type { QoderChatDependencies } from './chat.js'

export {
  buildQoderImageMultipart,
  defaultImageUploadConcurrency,
  defaultImageUploadTimeoutMs,
  defaultImageUrlCacheCapacity,
  defaultImageUrlCacheTtlMs,
  QoderImageUploader,
  readQoderImageUrl,
} from './image-upload.js'
export type { QoderImageUploaderOptions, QoderMultipartBody } from './image-upload.js'

export {
  fetchQoderUsage,
  normalizeQoderExpiresAt,
  normalizeQoderPlan,
  normalizeQoderQuota,
  normalizeQoderStatus,
  qoderProviderUsage,
  QoderUsageReader,
} from './usage.js'
export type {
  QoderAccountInfo,
  QoderQuota,
  QoderQuotaUsage,
  QoderSubscriberFeatureAllowed,
  QoderSubscriberOrganization,
  QoderSubscriberPlan,
  QoderSubscriberProfile,
  QoderSubscriberStatus,
  QoderUsageReaderOptions,
} from './usage.js'

export type {
  QoderBusiness,
  QoderChatContext,
  QoderInnerChunk,
  QoderModelConfig,
  QoderSseEnvelope,
  QoderWireContent,
  QoderWireImagePart,
  QoderWireMessage,
  QoderWireRequest,
  QoderWireTextPart,
  QoderWireTool,
  QoderWireToolCall,
} from './wire-types.js'

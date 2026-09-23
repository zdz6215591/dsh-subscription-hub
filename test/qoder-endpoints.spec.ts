/**
 * The region table and every URL builder.
 *
 * These addresses are transcribed from the shipped qodercli client via the
 * reference plugin; nothing here was inferred. The tests therefore pin the
 * TABLE and the builders' shape — a copy-paste slip between the two
 * deployments would route a working credential at a service that cannot answer
 * for it, which reads as a broken token rather than a routing mistake.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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
  resolveQoderEndpoints,
} from '../src/providers/qoder/region.js'
import { computeSigPath } from '../src/providers/qoder/cosy.js'

test('resolveQoderEndpoints returns expected endpoints for global and china', () => {
  const globalEndpoints = resolveQoderEndpoints('global')
  assert.equal(globalEndpoints.baseUrl, 'https://api3.qoder.sh/')
  assert.equal(globalEndpoints.openApiUrl, 'https://openapi.qoder.sh')
  assert.equal(globalEndpoints.centerUrl, 'https://center.qoder.sh')

  const chinaEndpoints = resolveQoderEndpoints('china')
  assert.equal(chinaEndpoints.baseUrl, 'https://gateway.qoder.com.cn/')
  assert.equal(chinaEndpoints.openApiUrl, 'https://openapi.qoder.com.cn')
  assert.equal(chinaEndpoints.centerUrl, 'https://gateway.qoder.com.cn')

  // Defaults to global when unspecified
  assert.deepEqual(resolveQoderEndpoints(), globalEndpoints)
  assert.equal(qoderGlobalBaseUrl, globalEndpoints.baseUrl)
  assert.equal(qoderGlobalOpenApiUrl, globalEndpoints.openApiUrl)
})

test('getQoderChatUrl builds chat URLs for global and china', () => {
  assert.equal(
    getQoderChatUrl('global'),
    'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
  )
  assert.equal(
    getQoderChatUrl('china'),
    'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
  )
  assert.equal(getQoderChatUrl(), getQoderChatUrl('global'))
})

test('getQoderModelListUrl builds model catalog URLs for global and china', () => {
  assert.equal(
    getQoderModelListUrl('global'),
    'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1',
  )
  assert.equal(
    getQoderModelListUrl('china'),
    'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1',
  )
  assert.equal(getQoderModelListUrl(), getQoderModelListUrl('global'))
})

test('getQoderExchangeUrl builds token exchange URLs for global and china', () => {
  assert.equal(
    getQoderExchangeUrl('global'),
    'https://openapi.qoder.sh/api/v1/jobToken/exchange',
  )
  assert.equal(
    getQoderExchangeUrl('china'),
    'https://openapi.qoder.com.cn/api/v1/jobToken/exchange',
  )
  assert.equal(getQoderExchangeUrl(), getQoderExchangeUrl('global'))
})

test('getQoderUserInfoUrl builds userinfo URLs for global and china', () => {
  assert.equal(
    getQoderUserInfoUrl('global'),
    'https://openapi.qoder.sh/api/v1/userinfo',
  )
  assert.equal(
    getQoderUserInfoUrl('china'),
    'https://openapi.qoder.com.cn/api/v1/userinfo',
  )
  assert.equal(getQoderUserInfoUrl(), getQoderUserInfoUrl('global'))
})

test('getQoderUsageUrl builds quota usage URLs for global and china', () => {
  assert.equal(
    getQoderUsageUrl('global'),
    'https://openapi.qoder.sh/api/v2/quota/usage',
  )
  assert.equal(
    getQoderUsageUrl('china'),
    'https://openapi.qoder.com.cn/api/v2/quota/usage',
  )
  assert.equal(getQoderUsageUrl(), getQoderUsageUrl('global'))
})

test('getQoderUserPlanUrl builds user plan URLs for global and china', () => {
  assert.equal(
    getQoderUserPlanUrl('global'),
    'https://openapi.qoder.sh/api/v2/user/plan',
  )
  assert.equal(
    getQoderUserPlanUrl('china'),
    'https://openapi.qoder.com.cn/api/v2/user/plan',
  )
  assert.equal(getQoderUserPlanUrl(), getQoderUserPlanUrl('global'))
})

test('getQoderUserStatusUrl builds user status URLs for global and china', () => {
  assert.equal(
    getQoderUserStatusUrl('global'),
    'https://openapi.qoder.sh/api/v3/user/status',
  )
  assert.equal(
    getQoderUserStatusUrl('china'),
    'https://openapi.qoder.com.cn/api/v3/user/status',
  )
  assert.equal(getQoderUserStatusUrl(), getQoderUserStatusUrl('global'))
})

test('computeSigPath strips the /algo prefix from both regions\' chat URLs', () => {
  assert.equal(computeSigPath('https://api3.qoder.sh/algo/api/v2/service'), '/api/v2/service')
  assert.equal(
    computeSigPath(getQoderChatUrl('global')),
    '/api/v2/service/pro/sse/agent_chat_generation',
  )
  assert.equal(
    computeSigPath(getQoderChatUrl('china')),
    '/api/v2/service/pro/sse/agent_chat_generation',
  )
  // The image path never carries /algo in the signature, even though the HTTP
  // address does: qodercli's WASM prepareRequest adds the prefix to one and not
  // the other.
  assert.equal(computeSigPath(getQoderImageUploadUrl('global')), qoderImageUploadPath)
})

test('the center image URL takes the /algo prefix on the address but not on the signature', () => {
  assert.equal(getQoderImageUploadUrl('global'), 'https://center.qoder.sh/algo/api/v2/image/upload')
  assert.equal(getQoderImageUploadUrl('china'), 'https://gateway.qoder.com.cn/algo/api/v2/image/upload')
  assert.equal(
    getQoderImageUploadUrl('global', 'req 1'),
    'https://center.qoder.sh/algo/api/v2/image/upload?request_id=req%201',
  )
})

test('the web search and campaign URLs are built from their own bases', () => {
  assert.equal(
    getQoderWebSearchUrl('global'),
    'https://center.qoder.sh/algo/api/v1/webSearch/oneSearch?Encode=1',
  )
  assert.equal(
    getQoderWebSearchUrl('china'),
    'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1',
  )
  assert.equal(getQoderCampaignsUrl('global'), 'https://openapi.qoder.sh/sash/api/v1/me/campaigns')
  assert.equal(getQoderCampaignsUrl('china'), 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns')
  assert.equal(
    getQoderClaimCampaignUrl('global', 'daily/1'),
    'https://openapi.qoder.sh/sash/api/v1/me/campaigns/daily%2F1/claim',
  )
})

test('the two deployments never share a host', () => {
  for (const key of ['baseUrl', 'openApiUrl'] as const) {
    assert.notEqual(qoderRegionEndpoints.global[key], qoderRegionEndpoints.china[key], key)
  }
  assert.ok(qoderRegionEndpoints.global.baseUrl.includes('.qoder.sh'))
  assert.ok(qoderRegionEndpoints.china.baseUrl.includes('.qoder.com.cn'))
})

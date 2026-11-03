/**
 * Kiro wire constants and the AWS-JSON control-plane calls.
 *
 * Kiro has no OpenAPI and no documented HTTP surface; these shapes come from
 * what `kiro-cli` sends (and what the reference plugin in
 * `magpie-community/plugins#packages/kiro` reproduces):
 *
 *   - the CONVERSATION lives on the runtime host of the account's region,
 *     `POST https://runtime.<region>.kiro.dev/generateAssistantResponse`, and
 *     answers an AWS event stream (see `eventstream.ts`);
 *   - everything else — the model roster, the profile, the credit allowance —
 *     is an AWS JSON 1.0 call, `POST https://management.<region>.kiro.dev/`
 *     with the operation named in `X-Amz-Target`, and `?origin=KIRO_CLI` when
 *     the operation takes a query.
 *
 * An API key (`ksk_…`) is sent as `Authorization: Bearer <key>` plus
 * `tokentype: API_KEY`, exactly as `kiro-cli` sends one, and names no profile
 * in its calls.
 */

/** Regions `kiro-cli` asks for an API key's profile, in its order. */
export const KIRO_KEY_REGIONS: readonly string[] = Object.freeze(['us-east-1', 'eu-central-1'])

/** Region used when no profile names one. */
export const KIRO_DEFAULT_REGION = 'us-east-1'

/** The API key prefix Kiro issues. */
export const KIRO_KEY_PREFIX = 'ksk_'

/** Conversation path on the runtime host. */
export const KIRO_CHAT_PATH = '/generateAssistantResponse'

/** What a conversation answers. */
export const KIRO_STREAM_CONTENT_TYPE = 'application/vnd.amazon.eventstream'

/** Origin marker every Kiro operation sends. */
export const KIRO_ORIGIN = 'KIRO_CLI'

/** Runtime host for one region. */
export function kiroRuntime(region: string): string {
  return `https://runtime.${region}.kiro.dev`
}

/** Management (control plane) host for one region. */
export function kiroManagement(region: string): string {
  return `https://management.${region}.kiro.dev`
}

/**
 * The region a profile ARN names.
 *
 * ARNs look like `arn:aws:codewhisperer:<region>:<account>:profile/<id>`; the
 * region there is authoritative for the conversation host, because a key minted
 * in eu-central-1 answers 403 on us-east-1.
 *
 * @param arn - the profile ARN, when one is known.
 * @param fallback - region to use when the ARN names none.
 * @returns the region.
 */
export function regionOfProfileArn(arn: string | undefined, fallback: string = KIRO_DEFAULT_REGION): string {
  const parts = String(arn ?? '').split(':')
  // arn : partition : service : region : account : resource
  const region = parts.length >= 6 ? parts[3] : ''
  return region === '' ? fallback : region
}

/**
 * Auth headers for a Kiro call.
 *
 * @param key - the API key.
 * @param tokenType - `API_KEY` for `ksk_` keys; empty for a plain bearer.
 * @returns the headers.
 */
export function kiroAuthHeaders(key: string, tokenType = 'API_KEY'): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
  if (tokenType !== '') headers.tokentype = tokenType
  return headers
}

/**
 * The AWS SDK headers `kiro-cli` puts on a runtime call.
 *
 * The user agent names the CLI's own client (`api/codewhispererstreaming`), and
 * the invocation id is per request. These are not decoration: the runtime
 * rejects some operations without the client identity.
 *
 * @param invocationId - unique id for this attempt.
 * @returns the headers.
 */
export function kiroSdkHeaders(invocationId: string): Record<string, string> {
  const suffix = invocationId.replaceAll('-', '')
  const userAgent = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${suffix}`
  return {
    'amz-sdk-invocation-id': invocationId,
    'amz-sdk-request': 'attempt=1; max=1',
    'x-amz-user-agent': userAgent,
    'User-Agent': userAgent,
  }
}

/** One AWS-JSON control-plane call (always a POST to the host root). */
export interface KiroControlCall {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/**
 * Build a control-plane call (`List-Available-Models`, `GetProfile`, …).
 *
 * @param region - region whose management host serves it.
 * @param key - API key.
 * @param target - `X-Amz-Target` operation name.
 * @param body - JSON body (AWS JSON 1.0 allows `{}` for a parameterless call).
 * @param query - query parameters, when the operation takes them.
 * @returns the request descriptor.
 */
export function kiroControlCall(
  region: string,
  key: string,
  target: string,
  body: Record<string, unknown> = {},
  query?: Record<string, string>,
): KiroControlCall {
  const base = `${kiroManagement(region)}/`
  const url = query === undefined ? base : `${base}?${new URLSearchParams(query).toString()}`
  return {
    url,
    method: 'POST',
    headers: {
      ...kiroAuthHeaders(key),
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': target,
      'x-amzn-codewhisperer-optout': 'false',
    },
    body: JSON.stringify(body),
  }
}

/** `GetProfile`'s answer, as far as this route reads it. */
export interface KiroProfileAnswer {
  profile?: { arn?: string; profileName?: string }
}

/**
 * Find an API key's profile ARN the way `kiro-cli` does.
 *
 * `GetProfile` is asked in us-east-1 first, then eu-central-1. A key that names
 * no profile in either — an account with no CodeWhisperer profile answers 400 —
 * is used in us-east-1 with no profile at all, which is exactly how `kiro-cli`
 * proceeds; failing here instead would refuse a key that works.
 *
 * @param fetchFn - fetch to use (injected for tests).
 * @param key - API key.
 * @returns the profile ARN, or `''` when the key names none.
 */
export async function discoverKiroProfile(fetchFn: typeof fetch, key: string): Promise<string> {
  for (const region of KIRO_KEY_REGIONS) {
    try {
      const call = kiroControlCall(region, key, 'AmazonCodeWhispererService.GetProfile')
      const response = await fetchFn(call.url, {
        method: 'POST',
        headers: call.headers,
        body: call.body,
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) continue
      const answer = await response.json() as KiroProfileAnswer
      const arn = answer.profile?.arn
      if (typeof arn === 'string' && arn !== '') return arn
    } catch {
      // A region that does not answer is one the key is not in; try the next.
    }
  }
  return ''
}

/**
 * Find the profile a signed-in token uses (Google/GitHub and AWS sign-ins).
 *
 * A key names its profile with GetProfile; a signed-in token instead LISTS the
 * account's profiles (List-Available-Profiles) and takes the first, in
 * us-east-1 then eu-central-1 — the reference does the same.
 *
 * @param fetchFn - fetch to use.
 * @param token - access token.
 * @returns the profile ARN, or ` '' ` when the account names none.
 */
export async function discoverKiroProfileForToken(fetchFn: typeof fetch, token: string): Promise<string> {
  for (const region of KIRO_KEY_REGIONS) {
    const profiles = await kiroProfilesForToken(fetchFn, region, token)
    const first = profiles[0]
    if (first !== undefined) return first
  }
  return ''
}
/** One REST call against Kiro's management plane (the signed-in token's shape). */
export interface KiroRestCall {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/**
 * Build a management-plane call for a SIGNED-IN token (Google/GitHub or AWS).
 *
 * This is a different API from the API key's: the key speaks AWS JSON 1.0 at the
 * host root with `X-Amz-Target`, while a signed-in token speaks REST paths —
 * `GET /List-Available-Models?origin=KIRO_CLI&profileArn=…`. Sending the key's
 * shape with a signed-in token is what answers
 * `AccessDeniedException: Invalid token`, because the control-plane bearer
 * operation is not the one that token may call.
 *
 * @param region - account region.
 * @param token - access token.
 * @param operation - REST path, e.g. `List-Available-Models`.
 * @param params - query parameters.
 * @param body - JSON body for the operations that take one.
 * @returns the request descriptor.
 */
export function kiroManagementCall(
  region: string,
  token: string,
  operation: string,
  params: Record<string, string> = {},
  body?: Record<string, unknown>,
): KiroRestCall {
  const query = Object.keys(params).length === 0 ? '' : `?${new URLSearchParams(params).toString()}`
  return {
    url: `${kiroManagement(region)}/${operation}${query}`,
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...kiroAuthHeaders(token, ''),
      Accept: 'application/json',
      ...body === undefined ? {} : { 'Content-Type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  }
}

/**
 * Read a signed-in token's profiles.
 *
 * `POST /List-Available-Profiles` with an empty body; the first profile is the
 * one this route uses, exactly as the reference does.
 *
 * @param fetchFn - fetch to use.
 * @param region - region to ask.
 * @param token - access token.
 * @returns the profile ARNs the account lists.
 */
export async function kiroProfilesForToken(fetchFn: typeof fetch, region: string, token: string): Promise<string[]> {
  const call = kiroManagementCall(region, token, 'List-Available-Profiles', {}, {})
  const response = await fetchFn.call(undefined, call.url, {
    method: call.method,
    headers: call.headers,
    ...call.body === undefined ? {} : { body: call.body },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return []
  const answer = await response.json() as { profiles?: { arn?: string }[] }
  return (answer.profiles ?? [])
    .map(profile => profile.arn)
    .filter((arn): arn is string => typeof arn === 'string' && arn !== '')
}
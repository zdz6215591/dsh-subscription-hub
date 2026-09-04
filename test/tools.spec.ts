/**
 * Unit tests for the codex identity claims and the two subscription tools:
 * unsigned-JWT claim decoding, request building, response parsing, and the
 * error paths — all via injected fetch, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { codexProfileClaims } from '../src/providers/codex.js'
import type { FetchFn } from '../src/providers/common.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { CodexSession, GrokSession } from '../src/auth/store.js'
import {
  buildXSearchRequest,
  createXSearchTool,
  parseXSearchResponse,
} from '../src/tools/x-search.js'
import {
  buildGrokImageGenerateBody,
  buildImageGenerateBody,
  createImageGenerateTool,
  parseImageGenerateResponse,
  sniffImageMediaType,
} from '../src/tools/image-generate.js'
import {
  buildVideoGenerateBody,
  createVideoGenerateTool,
  parseVideoStartResponse,
  parseVideoStatusResponse,
} from '../src/tools/video-generate.js'

/** Mint an unsigned JWT carrying the given payload. */
function unsignedJwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
}

/** Minimal execution context: the tools read only `signal`. */
function fakeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S | undefined,
): AccountTokenManager<S> {
  let stored = initial
  return new AccountTokenManager<S>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve(stored === undefined ? [] : [{ key: 'acct', session: stored }]),
      get: () => Promise.resolve(stored),
      save: (_account, session) => {
        stored = session
        return Promise.resolve()
      },
      remove: () => {
        stored = undefined
        return Promise.resolve()
      },
    },
  })
}

function jsonFetch(payload: unknown, status = 200): { fetchFn: FetchFn; lastBody: () => unknown } {
  let body: unknown
  const fetchFn: FetchFn = ((_url: string, init?: RequestInit) => {
    body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }) as FetchFn
  return { fetchFn, lastBody: () => body }
}

const codexSession: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.x.ai/token',
}

test('codexProfileClaims: top-level email and plan type', () => {
  const token = unsignedJwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-1' },
  })
  assert.deepEqual(codexProfileClaims(token), { emailAddress: 'user@example.com', planType: 'pro' })
})

test('codexProfileClaims: profile-namespaced email fallback and precedence', () => {
  const namespaced = unsignedJwt({
    'https://api.openai.com/profile': { email: 'profile@example.com' },
  })
  assert.deepEqual(codexProfileClaims(namespaced), { emailAddress: 'profile@example.com' })
  const both = unsignedJwt({
    email: 'top@example.com',
    'https://api.openai.com/profile': { email: 'profile@example.com' },
  })
  assert.equal(codexProfileClaims(both).emailAddress, 'top@example.com')
})

test('codexProfileClaims: missing or malformed tokens yield no claims', () => {
  assert.deepEqual(codexProfileClaims(undefined), {})
  assert.deepEqual(codexProfileClaims('not-a-jwt'), {})
  assert.deepEqual(codexProfileClaims(unsignedJwt({ sub: 'x' })), {})
})

test('buildXSearchRequest: validation and normalization', () => {
  assert.throws(() => buildXSearchRequest({ query: '  ' }), /non-empty/)
  assert.throws(
    () => buildXSearchRequest({ query: 'q', allowed_x_handles: ['a'], excluded_x_handles: ['b'] }),
    /cannot be used together/,
  )
  assert.throws(
    () => buildXSearchRequest({ query: 'q', allowed_x_handles: Array.from({ length: 11 }, (_, i) => `h${i}`) }),
    /at most 10/,
  )
  const request = buildXSearchRequest({
    query: ' news ',
    allowed_x_handles: ['@OpenAI', 'xai'],
    from_date: '2026-01-01',
    enable_video_understanding: true,
  })
  assert.equal(request.query, 'news')
  assert.deepEqual(request.tool, {
    type: 'x_search',
    allowed_x_handles: ['OpenAI', 'xai'],
    from_date: '2026-01-01',
    enable_video_understanding: true,
  })
})

test('parseXSearchResponse: answer, citations, inline annotations deduped', () => {
  const parsed = parseXSearchResponse({
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'the answer',
        annotations: [
          { type: 'url_citation', url: 'https://x.com/a/status/1' },
          { type: 'url_citation', url: 'https://x.com/b/status/2' },
        ],
      }],
    }],
    citations: ['https://x.com/b/status/2', 'https://x.com/c/status/3'],
  })
  assert.equal(parsed.answer, 'the answer')
  assert.deepEqual(parsed.citations, ['https://x.com/b/status/2', 'https://x.com/c/status/3', 'https://x.com/a/status/1'])
})

test('x_search execute: success, error status, and logged-out', async () => {
  const { fetchFn, lastBody } = jsonFetch({ output_text: 'hello from X', citations: ['https://x.com/a/1'] })
  const tool = createXSearchTool({ tokens: memoryTokens(grokSession), fetchFn })
  const value = await tool.execute({ query: 'OpenAI' }, fakeExec()) as { answer: string; citations: string[] }
  assert.deepEqual(value, { answer: 'hello from X', citations: ['https://x.com/a/1'] })
  const body = lastBody() as { model: string; tools: { type: string }[]; store: boolean }
  assert.equal(body.model, 'grok-4')
  assert.deepEqual(body.tools, [{ type: 'x_search' }])
  assert.equal(body.store, false)

  const failing = createXSearchTool({ tokens: memoryTokens(grokSession), fetchFn: jsonFetch('rate limited', 429).fetchFn })
  await assert.rejects(
    () => failing.execute({ query: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )

  const loggedOut = createXSearchTool({ tokens: memoryTokens<GrokSession>(undefined), fetchFn })
  await assert.rejects(
    () => loggedOut.execute({ query: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('x_search presentCall/presentResult shapes', async () => {
  const tool = createXSearchTool({ tokens: memoryTokens(grokSession), fetchFn: jsonFetch({}).fetchFn })
  assert.deepEqual(tool.presentCall?.({ query: 'OpenAI' }), {
    card: 'generic',
    title: 'x_search: OpenAI',
    kind: 'search',
  })
  const view = tool.presentResult?.({ query: 'OpenAI' }, {
    isError: false,
    content: [],
    meta: { answer: 'a', citations: ['https://x.com/a/1'] },
  })
  assert.deepEqual(view, {
    card: 'web',
    kind: 'search',
    sources: [{ url: 'https://x.com/a/1' }],
    answer: 'a',
    truncated: false,
  })
})

test('buildImageGenerateBody: validation and pass-through', () => {
  assert.throws(() => buildImageGenerateBody({ prompt: ' ' }), /non-empty/)
  assert.deepEqual(buildImageGenerateBody({ prompt: 'a square', size: '1024x1024', quality: 'low' }), {
    prompt: 'a square',
    model: 'gpt-image-2',
    size: '1024x1024',
    quality: 'low',
  })
  assert.deepEqual(buildImageGenerateBody({ prompt: 'p' }), { prompt: 'p', model: 'gpt-image-2' })
})

test('buildGrokImageGenerateBody: size→aspect_ratio and quality folding', () => {
  assert.throws(() => buildGrokImageGenerateBody({ prompt: ' ' }), /non-empty/)
  assert.deepEqual(buildGrokImageGenerateBody({ prompt: 'a square', size: '1024x1536', quality: 'high' }), {
    prompt: 'a square',
    model: 'grok-imagine-image-2.0',
    response_format: 'b64_json',
    aspect_ratio: '2:3',
    quality: 'medium',
  })
  assert.deepEqual(buildGrokImageGenerateBody({ prompt: 'p', quality: 'auto' }), {
    prompt: 'p',
    model: 'grok-imagine-image-2.0',
    response_format: 'b64_json',
  })
})

test('sniffImageMediaType: png, jpeg, webp, and the png default', () => {
  assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp')
  assert.equal(sniffImageMediaType(Buffer.from([1, 2, 3])), 'image/png')
})

test('image_generate: grok fallback when codex is logged out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-images-'))
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
  const requests: { url: string; body: unknown }[] = []
  const fetchFn: FetchFn = ((url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Promise.resolve(new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }] }), { status: 200 }))
  }) as FetchFn

  // Codex configured but logged out, grok logged in → the grok endpoint serves.
  const tool = createImageGenerateTool({
    codexTokens: memoryTokens<CodexSession>(undefined),
    grokTokens: memoryTokens(grokSession),
    fetchFn,
    imagesDir: dir,
  })
  const value = await tool.execute({ prompt: 'a cat', size: '1536x1024' }, fakeExec()) as { paths: string[] }
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.x.ai/v1/images/generations')
  assert.deepEqual(requests[0].body, {
    prompt: 'a cat',
    model: 'grok-imagine-image-2.0',
    response_format: 'b64_json',
    aspect_ratio: '3:2',
  })
  assert.ok(value.paths[0].endsWith('.jpg'), 'sniffed jpeg extension')
  assert.deepEqual(readFileSync(value.paths[0]), jpeg)

  // Codex logged in → codex wins even with grok configured.
  const codexFirst = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    grokTokens: memoryTokens(grokSession),
    fetchFn,
    imagesDir: dir,
  })
  await codexFirst.execute({ prompt: 'a cat' }, fakeExec())
  assert.equal(requests[1].url, 'https://chatgpt.com/backend-api/codex/images/generations')

  // provider: 'grok' → grok preferred even with codex logged in.
  await codexFirst.execute({ prompt: 'a cat', provider: 'grok' }, fakeExec())
  assert.equal(requests[2].url, 'https://api.x.ai/v1/images/generations')

  // provider: 'grok' with grok logged out → codex serves as fallback.
  const grokPreferred = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    grokTokens: memoryTokens<GrokSession>(undefined),
    fetchFn,
    imagesDir: dir,
  })
  await grokPreferred.execute({ prompt: 'a cat', provider: 'grok' }, fakeExec())
  assert.equal(requests[3].url, 'https://chatgpt.com/backend-api/codex/images/generations')

  // Neither logged in → the standard log-in hint.
  const loggedOut = createImageGenerateTool({
    codexTokens: memoryTokens<CodexSession>(undefined),
    grokTokens: memoryTokens<GrokSession>(undefined),
    fetchFn,
    imagesDir: dir,
  })
  await assert.rejects(
    () => loggedOut.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('parseImageGenerateResponse: b64 decode, revised prompt, empty data', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const parsed = parseImageGenerateResponse({
    data: [{ b64_json: png.toString('base64'), revised_prompt: 'better prompt' }],
  })
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].data, png)
  assert.equal(parsed[0].revisedPrompt, 'better prompt')
  assert.throws(() => parseImageGenerateResponse({ data: [] }), /no image data/)
  assert.throws(() => parseImageGenerateResponse({}), /no image data/)
})

test('image_generate execute: writes files, error status, and logged-out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subscriptions-images-'))
  const png = Buffer.from([1, 2, 3])
  const { fetchFn, lastBody } = jsonFetch({ created: 1, data: [{ b64_json: png.toString('base64') }] })
  const tool = createImageGenerateTool({ codexTokens: memoryTokens(codexSession), fetchFn, imagesDir: dir })
  const value = await tool.execute(
    { prompt: 'a tiny red square', size: '1024x1024', quality: 'low' },
    fakeExec(),
  ) as { paths: string[] }
  assert.equal(value.paths.length, 1)
  assert.ok(value.paths[0].startsWith(dir))
  assert.deepEqual(readFileSync(value.paths[0]), png)
  assert.equal(readdirSync(dir).length, 1)
  const body = lastBody() as Record<string, unknown>
  assert.deepEqual(body, { prompt: 'a tiny red square', model: 'gpt-image-2', size: '1024x1024', quality: 'low' })

  const failing = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    fetchFn: jsonFetch('bad request', 400).fetchFn,
    imagesDir: dir,
  })
  await assert.rejects(
    () => failing.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'HTTP_400',
  )

  const loggedOut = createImageGenerateTool({
    codexTokens: memoryTokens<CodexSession>(undefined),
    fetchFn,
    imagesDir: dir,
  })
  await assert.rejects(
    () => loggedOut.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('image_generate presentCall', () => {
  const tool = createImageGenerateTool({ codexTokens: memoryTokens(codexSession), fetchFn: jsonFetch({}).fetchFn })
  assert.deepEqual(tool.presentCall?.({ prompt: 'a cat' }), {
    card: 'generic',
    title: 'image_generate: a cat',
  })
})

/** Fake attachment store: saveImage returns a deterministic ref. */
function fakeAttachments() {
  const saved: { name?: string }[] = []
  const store = {
    saveImage: (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      saved.push({ ...input.name === undefined ? {} : { name: input.name } })
      return Promise.resolve({
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: input.data.length,
        width: 2,
        height: 3,
        ...input.name === undefined ? {} : { name: input.name },
      })
    },
  }
  return { store, saved }
}

/** Fake exec carrying an agent routed at the given provider/model. */
function routedExec(provider: string, model: string, extra: Record<string, unknown> = {}): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: {
      session: { requestHeader: () => ({ config: { provider, model } }) },
      options: { provider, model },
    },
    ...extra,
  } as unknown as ToolRunContext
}

/** Fake llm service whose resolveModelInfo reports the given modalities. */
function fakeLlm(inputModalities: string[] | undefined) {
  return {
    resolveModelInfo: () => Promise.resolve({
      provider: 'codex',
      id: 'm',
      name: 'm',
      ...inputModalities === undefined ? {} : { inputModalities },
    }),
  }
}

const PNG_BYTES = Buffer.from([1, 2, 3])

test('image_generate: image-capable route commits attachments and returns image refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-images-'))
  const { store, saved } = fakeAttachments()
  const { fetchFn } = jsonFetch({ created: 1, data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  const tool = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    fetchFn,
    imagesDir: dir,
    resolveAttachments: () => store as never,
    resolveLlm: () => fakeLlm(['text', 'image']) as never,
  })
  const value = await tool.execute(
    { prompt: 'a square' },
    routedExec('codex', 'gpt-5.6-sol'),
  ) as { paths: string[]; images?: { attachmentId: string; mediaType: string }[] }
  assert.equal(saved.length, 1)
  assert.equal(value.images?.length, 1)
  assert.equal(value.images?.[0].attachmentId, 'att-1')
  assert.equal(value.images?.[0].mediaType, 'image/png')
})

test('image_generate: text-only route degrades to text without saving attachments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-images-'))
  const { store, saved } = fakeAttachments()
  const { fetchFn } = jsonFetch({ created: 1, data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  const tool = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    fetchFn,
    imagesDir: dir,
    resolveAttachments: () => store as never,
    resolveLlm: () => fakeLlm(['text']) as never,
  })
  const value = await tool.execute(
    { prompt: 'a square' },
    routedExec('codex', 'gpt-text-only'),
  ) as { paths: string[]; images?: unknown[] }
  assert.equal(value.paths.length, 1, 'files are still written')
  assert.equal(value.images, undefined)
  assert.equal(saved.length, 0, 'no attachment commit on a text-only route')

  // No llm service at all → same text-only degradation (non-throwing).
  const noLlm = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    fetchFn,
    imagesDir: dir,
    resolveAttachments: () => store as never,
    resolveLlm: () => undefined,
  })
  const degraded = await noLlm.execute({ prompt: 'a square' }, routedExec('codex', 'gpt-5.6-sol')) as { images?: unknown[] }
  assert.equal(degraded.images, undefined)
})

test('image_generate render: image blocks when value.images present, text-only otherwise', () => {
  const tool = createImageGenerateTool({ codexTokens: memoryTokens(codexSession), fetchFn: jsonFetch({}).fetchFn })
  const withImages = tool.output.render({ prompt: 'p' }, {
    paths: ['/tmp/a.png'],
    images: [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, width: 2, height: 3, name: 'a.png' }],
  } as never)
  assert.equal(withImages.length, 2)
  assert.equal(withImages[0].type, 'text')
  assert.deepEqual(withImages[1], {
    type: 'image',
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, width: 2, height: 3, name: 'a.png' },
  })
  const textOnly = tool.output.render({ prompt: 'p' }, { paths: ['/tmp/a.png'] } as never)
  assert.equal(textOnly.length, 1)
  assert.equal(textOnly[0].type, 'text')
})

/** Fetch stub answering a fixed sequence of responses, recording every request. */
function sequenceFetch(responses: Response[]): {
  fetchFn: FetchFn
  requests: { url: string; method: string; body?: unknown }[]
} {
  const requests: { url: string; method: string; body?: unknown }[] = []
  const queue = [...responses]
  const fetchFn: FetchFn = ((url: string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) },
    })
    const next = queue.shift()
    if (next === undefined) throw new Error('sequenceFetch: no responses left')
    return Promise.resolve(next)
  }) as FetchFn
  return { fetchFn, requests }
}

test('buildVideoGenerateBody: validation and pass-through', () => {
  assert.throws(() => buildVideoGenerateBody({ prompt: ' ' }), /non-empty/)
  assert.throws(() => buildVideoGenerateBody({ prompt: 'p', duration: 0 }), /between 1 and 15/)
  assert.throws(() => buildVideoGenerateBody({ prompt: 'p', duration: 16 }), /between 1 and 15/)
  assert.throws(() => buildVideoGenerateBody({ prompt: 'p', duration: 2.5 }), /between 1 and 15/)
  assert.deepEqual(
    buildVideoGenerateBody({
      prompt: 'a wave',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
      image_url: 'https://example.com/still.png',
    }),
    {
      prompt: 'a wave',
      model: 'grok-imagine-video-1.5',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
      image: { url: 'https://example.com/still.png' },
    },
  )
  assert.deepEqual(buildVideoGenerateBody({ prompt: 'p' }), { prompt: 'p', model: 'grok-imagine-video-1.5' })
})

test('parseVideoStartResponse / parseVideoStatusResponse', () => {
  assert.equal(parseVideoStartResponse({ request_id: 'req-1' }), 'req-1')
  assert.throws(() => parseVideoStartResponse({}), /no request_id/)

  assert.deepEqual(parseVideoStatusResponse({ status: 'pending' }), { status: 'pending' })
  assert.deepEqual(
    parseVideoStatusResponse({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', duration: 8 } }),
    { status: 'done', url: 'https://vidgen.x.ai/v.mp4', duration: 8 },
  )
  assert.throws(() => parseVideoStatusResponse({ status: 'done', video: {} }), /no video URL/)
  assert.deepEqual(
    parseVideoStatusResponse({ status: 'failed', error: { message: 'moderated' } }),
    { status: 'failed', detail: 'moderated' },
  )
  assert.deepEqual(parseVideoStatusResponse({ status: 'expired' }), { status: 'expired' })
  assert.throws(() => parseVideoStatusResponse({ status: 'weird' }), /unexpected status/)
})

test('video_generate execute: submit, poll to done, download and save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subscriptions-videos-'))
  const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
  const { fetchFn, requests } = sequenceFetch([
    new Response(JSON.stringify({ request_id: 'req-1' }), { status: 200 }),
    new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
    new Response(JSON.stringify({
      status: 'done',
      video: { url: 'https://vidgen.x.ai/v.mp4', duration: 8 },
    }), { status: 200 }),
    new Response(mp4, { status: 200 }),
  ])
  const tool = createVideoGenerateTool({
    tokens: memoryTokens(grokSession),
    fetchFn,
    videosDir: dir,
    pollIntervalMs: 0,
  })
  const value = await tool.execute(
    { prompt: 'a crashing wave', duration: 8, resolution: '720p' },
    fakeExec(),
  ) as { path: string; url: string; duration?: number }
  assert.ok(value.path.startsWith(dir))
  assert.ok(value.path.endsWith('.mp4'))
  assert.equal(value.url, 'https://vidgen.x.ai/v.mp4')
  assert.equal(value.duration, 8)
  assert.deepEqual(readFileSync(value.path), mp4)
  assert.equal(readdirSync(dir).length, 1)

  assert.equal(requests.length, 4)
  assert.equal(requests[0].url, 'https://api.x.ai/v1/videos/generations')
  assert.deepEqual(requests[0].body, {
    prompt: 'a crashing wave',
    model: 'grok-imagine-video-1.5',
    duration: 8,
    resolution: '720p',
  })
  assert.equal(requests[1].url, 'https://api.x.ai/v1/videos/req-1')
  assert.equal(requests[2].url, 'https://api.x.ai/v1/videos/req-1')
  assert.equal(requests[3].url, 'https://vidgen.x.ai/v.mp4')
})

test('video_generate execute: failed status, poll timeout, error status, logged-out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subscriptions-videos-'))
  const failed = createVideoGenerateTool({
    tokens: memoryTokens(grokSession),
    fetchFn: sequenceFetch([
      new Response(JSON.stringify({ request_id: 'req-2' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'failed', error: { message: 'moderated' } }), { status: 200 }),
    ]).fetchFn,
    videosDir: dir,
    pollIntervalMs: 0,
  })
  await assert.rejects(() => failed.execute({ prompt: 'x' }, fakeExec()), /failed \(request req-2\): moderated/)

  const timedOut = createVideoGenerateTool({
    tokens: memoryTokens(grokSession),
    fetchFn: sequenceFetch([
      new Response(JSON.stringify({ request_id: 'req-3' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
    ]).fetchFn,
    videosDir: dir,
    pollIntervalMs: 0,
    maxWaitMs: 0,
  })
  await assert.rejects(() => timedOut.execute({ prompt: 'x' }, fakeExec()), /timed out/)

  const rateLimited = createVideoGenerateTool({
    tokens: memoryTokens(grokSession),
    fetchFn: jsonFetch('rate limited', 429).fetchFn,
    videosDir: dir,
  })
  await assert.rejects(
    () => rateLimited.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )

  const loggedOut = createVideoGenerateTool({
    tokens: memoryTokens<GrokSession>(undefined),
    fetchFn: jsonFetch({}).fetchFn,
    videosDir: dir,
  })
  await assert.rejects(
    () => loggedOut.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('video_generate presentCall and render', () => {
  const tool = createVideoGenerateTool({ tokens: memoryTokens(grokSession), fetchFn: jsonFetch({}).fetchFn })
  assert.deepEqual(tool.presentCall?.({ prompt: 'a crashing wave' }), {
    card: 'generic',
    title: 'video_generate: a crashing wave',
  })
  const rendered = tool.output.render({ prompt: 'p' }, {
    path: '/tmp/v.mp4',
    url: 'https://vidgen.x.ai/v.mp4',
    duration: 8,
  } as never)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match((rendered[0] as { text: string }).text, /Saved video to \/tmp\/v\.mp4 \(8s\)/)
  const meta = tool.output.presentationMeta?.({ prompt: 'p' }, {
    path: '/tmp/v.mp4',
    url: 'https://vidgen.x.ai/v.mp4',
    duration: 8,
  } as never)
  assert.deepEqual(meta, { fileName: 'v.mp4', duration: 8 })
})

test('image_generate: nested dispatch defers no context (code mode injects image results itself)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-images-'))
  const { store } = fakeAttachments()
  const { fetchFn } = jsonFetch({ created: 1, data: [{ b64_json: PNG_BYTES.toString('base64') }] })
  const tool = createImageGenerateTool({
    codexTokens: memoryTokens(codexSession),
    fetchFn,
    imagesDir: dir,
    resolveAttachments: () => store as never,
    resolveLlm: () => fakeLlm(['text', 'image']) as never,
  })
  const deferred: { content: { type: string }[] }[] = []
  const exec = routedExec('codex', 'gpt-5.6-sol', {
    parent: Symbol('parent'),
    deferContext: (message: { content: { type: string }[] }) => deferred.push(message),
  })
  const value = await tool.execute({ prompt: 'a square' }, exec) as { images?: unknown[] }
  // The render output carries the image block; the harness's code mode defers
  // image-bearing sub-results itself, so the tool must not defer a duplicate.
  assert.equal((value.images ?? []).length, 1)
  assert.equal(deferred.length, 0)
})

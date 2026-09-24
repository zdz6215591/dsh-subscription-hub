/**
 * Trae provider tests: credential discovery/decryption, the wire protocol
 * (headers, body, SSE decoding, tool-call normalization), the model catalog
 * merge, and the usage/check-in parsing.
 *
 * The decryption fixture is generated in-test with the same KDF the Trae
 * client uses, so the test proves the implementation round-trips the real
 * container format rather than asserting against a captured ciphertext.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRAE_AUTH_STORAGE_KEY,
  decryptTraeStorageValue,
  parseTraeAuthValue,
  parseTraeCliToken,
  parseTraeStorageDocument,
  traeCandidates,
  discoverTraeCredentials,
} from '../src/providers/trae/credentials.js'
import {
  TRAE_WIRE_EFFORTS,
  TraeSseDecoder,
  buildTraeChatBody,
  decodeTraeEvent,
  normalizeTraeToolCalls,
  traeEndpoint,
  traeHeaders,
} from '../src/providers/trae/protocol.js'
import { mergeTraeModelSources, fetchTraeModels, fetchRemoteModels } from '../src/providers/trae/catalog.js'
import type { TraeModel } from '../src/providers/trae/catalog.js'
import { toTraeMessages } from '../src/providers/trae/adapter.js'
import type { FetchFn } from '../src/providers/common.js'
import {
  claimTraeCheckin,
  fetchTraeCheckinStatus,
  generateMorningTargetTime,
  localDateString,
  parseTraeUsage,
  traeUsageToProviderUsage,
} from '../src/providers/trae/usage.js'

// ---------------------------------------------------------------------------
// The four salt tables, reproduced here so the fixture is built exactly the way
// the Trae client builds its container (a mismatch fails the integrity check).
// ---------------------------------------------------------------------------

const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])

/** Encrypt a JSON document into the Trae `tc` container (magic `aes`). */
function encryptTraeStorageValue(plaintext: string): string {
  const random = randomBytes(32)
  const salt = Buffer.from(SALT_A.map((value, index) => value ^ (SALT_B[index] ?? 0)))
  const first = createHash('sha512').update(random).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const body = Buffer.from(plaintext, 'utf8')
  const digest = createHash('sha512').update(body).digest()
  const cipher = createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([digest, body])), cipher.final()])
  return Buffer.concat([Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]), random, encrypted]).toString('base64')
}

test('decryptTraeStorageValue round-trips the real tc container', () => {
  const document = JSON.stringify({
    token: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiredAt: 1_800_000_000_000,
    userId: 'user-123',
    host: 'https://api.trae.cn',
    userRegion: { region: 'CN' },
    account: { username: 'tester' },
  })
  const encoded = encryptTraeStorageValue(document)
  assert.equal(decryptTraeStorageValue(encoded), document)
  assert.deepEqual(parseTraeAuthValue(encoded), JSON.parse(document))
})

test('decryptTraeStorageValue rejects a bad header and a corrupted payload', () => {
  // Unknown magic.
  const wrongMagic = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6]), randomBytes(200)]).toString('base64')
  assert.throws(() => decryptTraeStorageValue(wrongMagic), /unsupported Trae auth encryption header/)
  // Too short to hold a header + random + ciphertext.
  assert.throws(() => decryptTraeStorageValue(Buffer.alloc(50).toString('base64')), /too short/)
  // A flipped ciphertext byte must never yield the original plaintext: AES-CBC
  // padding or the SHA-512 integrity check rejects it.
  const valid = Buffer.from(encryptTraeStorageValue('{"token":"t"}'), 'base64')
  valid[valid.length - 1] ^= 0xff
  assert.throws(() => decryptTraeStorageValue(valid.toString('base64')), /integrity check failed|bad decrypt/)
})

test('parseTraeAuthValue accepts the SG plaintext form', () => {
  const plaintext = '{"token":"sg-token","userId":"u"}'
  assert.deepEqual(parseTraeAuthValue(plaintext), { token: 'sg-token', userId: 'u' })
})

test('parseTraeStorageDocument reads the iCubeAuthInfo key', () => {
  const inner = '{"token":"inner-token","userId":"u-1"}'
  const storage = JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: inner, 'other.key': 'ignored' })
  assert.deepEqual(parseTraeStorageDocument(storage), { token: 'inner-token', userId: 'u-1' })
  assert.throws(
    () => parseTraeStorageDocument(JSON.stringify({ nope: 1 })),
    /has no iCubeAuthInfo/,
  )
})

test('parseTraeCliToken reads data.user_id and exp from a bare JWT', () => {
  const payload = Buffer.from(JSON.stringify({ data: { user_id: 'cli-user' }, exp: 1_900_000_000 })).toString('base64url')
  const token = `header.${payload}.signature`
  assert.deepEqual(parseTraeCliToken(token), {
    accessToken: token,
    userId: 'cli-user',
    expiresAtMs: 1_900_000_000_000,
  })
  // A JSON envelope carrying the token is accepted too.
  assert.equal(parseTraeCliToken(JSON.stringify({ token })).userId, 'cli-user')
  assert.throws(() => parseTraeCliToken('not-a-jwt'), /three-part JWT/)
})

test('traeCandidates enumerates every install, CN first, with its own edition', () => {
  const candidates = traeCandidates('win32', 'C:\\Users\\tester', { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' })
  const desktop = candidates.filter(candidate => candidate.source === 'desktop')
  const paths = desktop.map(candidate => candidate.path)
  assert.equal(paths.some(p => p.includes('TRAE SOLO CN')), true, 'TRAE SOLO CN must be probed')
  assert.equal(paths.some(p => p.includes('Trae CN')), true, 'Trae CN IDE must be probed')
  // The international installs are probed too, and each is a SEPARATE candidate
  // carrying its own edition: importing the wrong label would route the account
  // at the wrong gateway.
  assert.equal(paths.some(p => /[\\/]Trae[\\/]User/.test(p)), true, 'Trae (intl) must be probed')
  assert.equal(paths.some(p => p.includes('TRAE SOLO\\User')), true, 'TRAE SOLO (intl) must be probed')
  // The CN installs come first, so an existing user's account keys do not move.
  assert.deepEqual(desktop.slice(0, 2).map(c => c.edition), ['solo', 'cn'])
  // Both channel families are represented, and every edition appears once.
  assert.deepEqual([...new Set(desktop.map(c => c.channel))].sort(), ['ide', 'solo'])
  assert.deepEqual(desktop.map(c => c.edition).sort(), ['cn', 'sg', 'solo', 'solo-sg'])
})

test('discoverTraeCredentials imports both channels and reports misses', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trae-'))
  try {
    const soloUser = join(home, 'AppData', 'Roaming', 'TRAE SOLO CN', 'User', 'globalStorage')
    const ideUser = join(home, 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage')
    mkdirSync(soloUser, { recursive: true })
    mkdirSync(ideUser, { recursive: true })
    const soloAuth = JSON.stringify({ token: 'solo-token', refreshToken: 'solo-refresh', expiredAt: 1_900_000_000_000, userId: 'same-user', host: 'https://api.trae.cn', account: { username: 'solo@example.com' } })
    const ideAuth = JSON.stringify({ token: 'ide-token', refreshToken: 'ide-refresh', expiredAt: 1_900_000_000_000, userId: 'same-user', host: 'https://api.trae.cn', account: { username: 'ide@example.com' } })
    writeFileSync(join(soloUser, 'storage.json'), JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: encryptTraeStorageValue(soloAuth) }), 'utf8')
    writeFileSync(join(ideUser, 'storage.json'), JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: ideAuth }), 'utf8')

    const candidates = traeCandidates('win32', home, { APPDATA: join(home, 'AppData', 'Roaming') })
    const { credentials, failures } = await discoverTraeCredentials(candidates)
    assert.equal(credentials.length, 2, 'both channels must be discovered')
    const solo = credentials.find(c => c.channel === 'solo')
    const ide = credentials.find(c => c.channel === 'ide')
    assert.equal(solo?.accessToken, 'solo-token')
    assert.equal(ide?.accessToken, 'ide-token', 'the IDE channel reads the plaintext form')
    // Absent paths are reported as `missing`, never as hard failures.
    assert.equal(failures.every(failure => failure.reason === 'missing' || failure.reason === 'invalid'), true)
    assert.equal(failures.some(failure => failure.path.includes('TRAE SOLO CN')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

test('traeHeaders carries the identity, version and trace contract', () => {
  // The device pair now comes from the resolved identity. It is passed in rather
  // than generated per process, and the two fields are deliberately different
  // values: the old code sent the SAME 32-char string for both.
  const identity = { machineId: 'f'.repeat(64), deviceId: 'a'.repeat(32) }
  const headers = traeHeaders('token-abc', 'user-9', identity)
  assert.equal(headers.Authorization, 'Cloud-IDE-JWT token-abc')
  assert.equal(headers['X-Ide-Token'], 'token-abc')
  assert.equal(headers['X-Cloudide-Token'], 'token-abc')
  assert.equal(headers['x-uid'], 'user-9')
  assert.equal(headers['x-app-id'], '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
  assert.equal(headers['x-plugin-channel'], 'icube-ai')
  // The upstream binds these as numbers; a dotted build string is rejected.
  assert.match(headers['x-app-version-code'], /^\d+$/)
  assert.match(headers['x-ide-version-code'], /^\d+$/)
  assert.match(headers['x-flow-traceparent'], /^04-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.equal(headers['request-traffic-type'], 'prod')
})

test('buildTraeChatBody emits only the fields the upstream binds', () => {
  const body = buildTraeChatBody({
    model: 'glm-5.2',
    functionName: 'solo_work_remote',
    messages: [
      { role: 'system', text: 'be brief' },
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'pwsh', arguments: '{"a":1}' }] },
      { role: 'tool', text: 'output', toolCallId: 'call-1' },
    ],
    tools: [{ name: 'pwsh', description: 'run', parameters: { type: 'object', properties: {} } }],
    reasoningEffort: 'low',
  })
  assert.equal(body.model, 'glm-5.2')
  assert.equal(body.config_name, 'glm-5.2')
  assert.equal(body.function, 'solo_work_remote')
  assert.equal(body.stream, true)
  // `light` is the wire spelling of the low level.
  assert.equal(body.reasoning_effort, TRAE_WIRE_EFFORTS.low)
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 4)
  assert.deepEqual(messages[0], { role: 'system', content: [{ type: 'text', text: 'be brief' }] })
  // Tool calls use `function_call`, not OpenAI's `function`.
  const assistant = messages[2] as { tool_calls: Array<Record<string, unknown>> }
  assert.deepEqual(assistant.tool_calls[0], {
    id: 'call-1',
    type: 'function',
    function_call: { name: 'pwsh', arguments: '{"a":1}' },
  })
  assert.equal((messages[3] as Record<string, unknown>).tool_call_id, 'call-1')
  // Tool parameters travel as a JSON STRING.
  const tools = body.tools as Array<Record<string, Record<string, unknown>>>
  assert.equal(typeof tools[0]!.function!.parameters, 'string')
  // Optional OpenAI fields must never be emitted.
  for (const forbidden of ['temperature', 'top_p', 'tool_choice', 'response_format', 'max_tokens']) {
    assert.equal(forbidden in body, false, `${forbidden} must not be sent`)
  }
})

test('buildTraeChatBody omits reasoning_effort when no level is selected', () => {
  const body = buildTraeChatBody({ model: 'x', functionName: 'f', messages: [{ role: 'user', text: 'hi' }] })
  assert.equal('reasoning_effort' in body, false)
  assert.equal('tools' in body, false)
})

test('TraeSseDecoder handles CRLF, split chunks and multi-line data', () => {
  const decoder = new TraeSseDecoder()
  const events = [
    ...decoder.push('event: output\r\ndata: {"response":"he'),
    ...decoder.push('llo"}\n\n'),
    ...decoder.push('data: line1\ndata: line2\n\n'),
  ]
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { event: 'output', data: '{"response":"hello"}' })
  assert.equal(events[1]!.data, 'line1\nline2')
})

test('decodeTraeEvent maps Trae named events', () => {
  assert.deepEqual(decodeTraeEvent({ data: '[DONE]' }), { type: 'done', finishReason: 'stop' })
  const delta = decodeTraeEvent({ event: 'output', data: '{"response":"hi","reasoning_content":"why"}' })
  assert.equal(delta.type, 'delta')
  assert.equal(delta.type === 'delta' ? delta.text : '', 'hi')
  assert.equal(delta.type === 'delta' ? delta.reasoning : '', 'why')
  const usage = decodeTraeEvent({ event: 'token_usage', data: '{"prompt_tokens":10,"completion_tokens":5}' })
  assert.deepEqual(usage, { type: 'usage', inputTokens: 10, outputTokens: 5 })
  // A 4001 in-body error is a real failure, not a silent success.
  const error = decodeTraeEvent({ event: 'error', data: '{"code":4001,"message":"the param is invalid"}' })
  assert.equal(error.type, 'error')
  assert.equal(error.type === 'error' ? error.code : undefined, 4001)
  // Bookkeeping events carry no model output.
  assert.deepEqual(decodeTraeEvent({ event: 'progress_notice', data: '{}' }), { type: 'ignore' })
  assert.deepEqual(decodeTraeEvent({ event: 'timing_cost', data: '{}' }), { type: 'ignore' })
})

test('normalizeTraeToolCalls reads function_call and tolerates function', () => {
  const calls = normalizeTraeToolCalls([
    { index: 0, id: 'c1', function_call: { name: 'pwsh', arguments: '{"a"' } },
    { index: 1, id: 'c2', function: { name: 'read', arguments: '{}' } },
    { index: 2, id: '', function_call: { name: '', arguments: '{"b"' } },
  ])
  assert.deepEqual(calls, [
    { index: 0, id: 'c1', name: 'pwsh', arguments: '{"a"' },
    { index: 1, id: 'c2', name: 'read', arguments: '{}' },
    { index: 2, arguments: '{"b"' },
  ])
  assert.deepEqual(normalizeTraeToolCalls(undefined), [])
})

test('toTraeMessages filters empty and unpaired tool calls', () => {
  const messages = [
    {
      id: 'm1',
      role: 'assistant' as const,
      source: { kind: 'model' as const },
      content: [
        { type: 'tool-call' as const, id: '', name: '', arguments: '{}' },
        { type: 'tool-call' as const, id: 'c1', name: 'read', arguments: '{}' },
      ],
    },
    {
      id: 'm2',
      role: 'user' as const,
      source: { kind: 'tool' as const, callId: 'c1' },
      content: [
        { type: 'tool-result' as const, toolCallId: '', content: [{ type: 'text' as const, text: 'err' }] },
        { type: 'tool-result' as const, toolCallId: 'c1', content: [{ type: 'text' as const, text: 'ok' }] },
      ],
    },
  ]
  const out = toTraeMessages(messages as any)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
  })
  assert.deepEqual(out[1], {
    role: 'tool',
    text: 'ok',
    toolCallId: 'c1',
  })
})

test('traeEndpoint joins a base and path without doubling the slash', () => {
  assert.equal(traeEndpoint('https://x.test/', '/api/v3'), 'https://x.test/api/v3')
  assert.equal(traeEndpoint('https://x.test', 'api/v3'), 'https://x.test/api/v3')
})

// ---------------------------------------------------------------------------
// Catalog + usage
// ---------------------------------------------------------------------------

/** A fetcher that answers every request with a 500, so nothing is discoverable. */
function failingFetch(): FetchFn {
  return (() => Promise.resolve(new Response('{}', { status: 500 }))) as unknown as FetchFn
}

test('a route with no discovery yields no fabricated rows, and says why', async () => {
  // The catalogue read is the ONLY source of roster rows. This test exists
  // because the opposite was once true: an empty discovery served eight
  // hardcoded models, so a broken directory fetch produced a full-looking picker
  // and the user could not tell a dead route from a healthy one.
  const read = await fetchTraeModels('token', 'user', 'solo', undefined, failingFetch())
  assert.deepEqual(read.models, [], 'no discovery must produce no rows')
  assert.notEqual(read.notFetched, undefined, 'and must report that the roster was not fetched')
  assert.match(read.notFetched!.what, /no model roster/)
})

test('fetchRemoteModels builds the unfiltered skeleton from every directory group', async () => {
  const payload = {
    data: {
      list: [
        {
          function: 'solo_work_remote',
          models: [
            { name: 'glm-5.3', display_name: 'GLM-5.3', max_mode: true, context_window_tokens: { dev: 200_000, max: 1_000_000 } },
            // IDE-only: the SOLO chat endpoint rejects it with 4001, so it must not be listed.
            { name: 'deepseek-v4.1-flash', display_name: 'DeepSeek-V4.1-Flash' },
            // The same config_name advertised narrower here than in the agent
            // directory below — the live directory does exactly this for
            // Doubao-Seed-Code (184000 under solo_coder, 256000 under solo_agent).
            { name: 'Doubao-Seed-Code', display_name: 'Seed-Code', context_window_tokens: { dev: 184_000, max: 0 } },
          ],
        },
        {
          function: 'solo_agent',
          models: [
            {
              name: 'glm-5.3',
              display_name: 'GLM-5.3',
              max_mode: true,
              context_window_tokens: { dev: 200_000, max: 1_000_000 },
              reasoning_effort_config: { support_thinking: true, options: ['light', 'high', 'extra_high'], default_level: 'high' },
            },
            {
              name: 'Doubao-Seed-Code',
              display_name: 'Seed-Code',
              context_window_tokens: { dev: 256_000, max: 0 },
              reasoning_effort_config: { support_thinking: true, options: ['light', 'high'], default_level: 'high' },
            },
          ],
        },
        {
          function: 'solo_coder',
          models: [{ name: 'glm-5', display_name: 'GLM-5', context_window_tokens: { dev: 200_000, max: 0 } }],
        },
      ],
    },
  }
  const fetchFn = (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as FetchFn

  const models = await fetchRemoteModels('token', undefined, fetchFn)
  assert.ok(models !== undefined)
  const byId = new Map(models.map(model => [model.id, model]))

  // The skeleton keeps EVERY advertised row, including the IDE-only one: this
  // is the merge skeleton, and callability is decided by the wire roster in
  // `mergeTraeModelSources`, not by the static table here. Filtering here is
  // what used to hide a brand-new model until the table was edited by hand.
  assert.equal(byId.has('deepseek-v4.1-flash'), true)
  // A model only the coder directory lists is present, with its own function.
  assert.equal(byId.get('glm-5')?.functionName, 'solo_coder')
  // A model only the agent directory lists is present.
  assert.equal(byId.get('Doubao-Seed-Code')?.functionName, 'solo_agent')

  // The richer agent row supplies the effort levels the work row omits, while
  // the first-seen function owner is kept.
  const glm53 = byId.get('glm-5.3')
  assert.equal(glm53?.functionName, 'solo_work_remote')
  assert.deepEqual(glm53?.efforts, ['none', 'low', 'high', 'xhigh'])
  assert.equal(glm53?.maxContextWindow, 1_000_000)
  // A row whose max window merely repeats dev exposes no budget switch.
  assert.equal(byId.get('glm-5')?.maxContextWindow, undefined)

  // Several directories advertise the same config_name with different windows.
  // The widest wins regardless of read order: the model's own window does not
  // shrink per entry point, and taking the first-seen 184000 would under-report
  // it (the live Doubao-Seed-Code case).
  const doubao = byId.get('Doubao-Seed-Code')
  assert.equal(doubao?.contextWindow, 256_000)
  assert.deepEqual(doubao?.efforts, ['none', 'low', 'high'])
})

// ---------------------------------------------------------------------------
// The two-source merge: skeleton × wire roster
// ---------------------------------------------------------------------------

/** A skeleton row, as the remote directory supplies it. */
function skeleton(id: string, extra: Partial<TraeModel> = {}): TraeModel {
  return { id, name: id, functionName: 'solo_work_remote', ...extra }
}

/** A wire row, as `get_detail_param` supplies it. */
function wire(id: string, extra: Partial<TraeModel> = {}): TraeModel {
  return { id, name: id, functionName: 'solo_work_remote', ...extra }
}

test('the merge keeps only skeleton rows the wire roster can actually call', () => {
  // The rule that stops the picker advertising models that always 4001: the
  // remote directory advertises `Doubao-Seed-Code` and `glm-5.3`, neither of
  // which is a current config_name, so both fail every request.
  const merged = mergeTraeModelSources(
    [skeleton('glm-5.2'), skeleton('Doubao-Seed-Code'), skeleton('kimi-k3')],
    [wire('glm-5.2'), wire('kimi-k3'), wire('search_agent_v2')],
  )
  assert.deepEqual(merged.map(m => m.id), ['glm-5.2', 'kimi-k3'])
  // An agent-internal config exists in the wire roster but never the skeleton,
  // which is exactly why iterating the skeleton is what filters it out.
  assert.equal(merged.some(m => m.id === 'search_agent_v2'), false)
})

test('the merge joins by config_name first, then by display name', () => {
  // Tier 1: the display id IS the wire id (the common case).
  const byId = mergeTraeModelSources(
    [skeleton('glm-5.2', { name: 'GLM-5.2' })],
    [wire('glm-5.2', { functionName: 'solo_work_lite' })],
  )
  assert.equal(byId[0]?.functionName, 'solo_work_lite')
  // No `wireConfigName`: the id already IS the wire id, so the chat call sends
  // it unchanged.
  assert.equal(byId[0]?.wireConfigName, undefined)

  // Tier 2: the display id differs from the wire id across Trae versions, so the
  // join falls back to the display name and records the real config_name.
  const byName = mergeTraeModelSources(
    [skeleton('Seed-Code-Display', { name: 'Seed-Code' })],
    [wire('Doubao-Seed-Code', { name: 'Seed-Code', functionName: 'solo_agent' })],
  )
  assert.equal(byName[0]?.id, 'Seed-Code-Display')
  assert.equal(byName[0]?.wireConfigName, 'Doubao-Seed-Code')
  assert.equal(byName[0]?.functionName, 'solo_agent')
})

test('the merge takes display facts from the skeleton and the function from the wire', () => {
  const merged = mergeTraeModelSources(
    [skeleton('glm-5.2', { name: 'GLM-5.2', contextWindow: 200_000, maxContextWindow: 1_000_000, efforts: ['none', 'high'] })],
    // The wire row carries its own (poorer) metadata and must NOT override the
    // skeleton's: the directory is authoritative for display facts.
    [wire('glm-5.2', { name: 'glm-5.2', contextWindow: 1, functionName: 'solo_work_lite' })],
  )
  assert.equal(merged[0]?.contextWindow, 200_000)
  assert.equal(merged[0]?.maxContextWindow, 1_000_000)
  assert.deepEqual(merged[0]?.efforts, ['none', 'high'])
  assert.equal(merged[0]?.functionName, 'solo_work_lite')
})

test('the merge is case- and whitespace-insensitive on both keys', () => {
  const merged = mergeTraeModelSources(
    [skeleton('GLM-5.2 ', { name: ' GLM-5.2' })],
    [wire(' glm-5.2', { name: 'glm-5.2' })],
  )
  assert.equal(merged.length, 1)
  // The skeleton's own spelling is what the picker shows.
  assert.equal(merged[0]?.id, 'GLM-5.2 ')
})

test('the merge preserves skeleton order and drops duplicates by first match', () => {
  const merged = mergeTraeModelSources(
    [skeleton('b'), skeleton('a'), skeleton('c')],
    [wire('a'), wire('b'), wire('c')],
  )
  // Skeleton order, not wire order: the directory decides how the picker reads.
  assert.deepEqual(merged.map(m => m.id), ['b', 'a', 'c'])
})

test('an empty wire roster yields an empty merge, never the skeleton', () => {
  // This is what makes the caller's degradation meaningful: an empty merge is
  // distinguishable from a populated one, so `fetchTraeModels` can keep the
  // skeleton instead of showing nothing.
  assert.deepEqual(mergeTraeModelSources([skeleton('a')], []), [])
  assert.deepEqual(mergeTraeModelSources([], [wire('a')]), [])
  assert.deepEqual(mergeTraeModelSources([], []), [])
})

test('parseTraeUsage derives available/consumed and per-pack remainders', () => {
  const snapshot = parseTraeUsage({
    usage_summary: { total_amount: 7500, consumed_amount: 5879.63, consumption_ratio: 0.78 },
    user_entitlement_pack_list: [
      {
        display_desc: '老用户福利',
        entitlement_base_info: {
          available_endpoint: 1,
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
        },
        usage: { credits_amount: 1820.37 },
      },
      {
        display_desc: '签到奖励',
        entitlement_base_info: {
          available_endpoint: 0,
          product_extra: { package_extra: { quota: { credits_limit: 200 } } },
        },
        usage: { credits_amount: 20.37 },
      },
    ],
  })
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.total, 7500)
  assert.equal(snapshot.consumed, 5879.63)
  assert.equal(snapshot.available, 1620.37)
  assert.equal(snapshot.packs.length, 2)
  // `available_endpoint: 1` marks the Work pool.
  assert.equal(snapshot.workAvailable, 2000 - 1820.37)
  assert.equal(snapshot.generalAvailable, 200 - 20.37)
})

test('parseTraeUsage returns undefined for an unusable payload', () => {
  assert.equal(parseTraeUsage(null), undefined)
  assert.equal(parseTraeUsage({}), undefined)
  assert.equal(parseTraeUsage({ usage_summary: { total_amount: 0 }, user_entitlement_pack_list: [] }), undefined)
})

test('traeUsageToProviderUsage renders a credit pool plus one window per pack', () => {
  const snapshot = parseTraeUsage({
    usage_summary: { total_amount: 100, consumed_amount: 25 },
    user_entitlement_pack_list: [
      {
        display_desc: '免费',
        entitlement_base_info: { available_endpoint: 0, product_extra: { package_extra: { quota: { credits_limit: 100 } } } },
        usage: { credits_amount: 25 },
      },
    ],
  })!
  const usage = traeUsageToProviderUsage(snapshot)
  assert.equal(usage.supported, true)
  assert.equal(usage.remaining, 75)
  assert.equal(usage.limit, 100)
  assert.equal(usage.windows?.[0]?.scope, 'credits')
  assert.equal(usage.windows?.[0]?.usedPercent, 25)
  assert.equal(usage.windows?.[1]?.scope, '免费')
})

test('the Trae check-in schedules a morning target on the same day', () => {
  const now = new Date(2026, 8, 20, 12, 0, 0)
  assert.equal(localDateString(now), '2026-09-20')
  const target = generateMorningTargetTime(now)
  const at = new Date(target)
  assert.equal(at.getFullYear(), 2026)
  assert.equal(at.getMonth(), 8)
  assert.equal(at.getDate(), 20)
  // The window is 06:00:00–07:54:59.
  assert.ok(at.getHours() >= 6 && at.getHours() < 8, `target hour was ${String(at.getHours())}`)
})

// ---------------------------------------------------------------------------
// Check-in claiming
// ---------------------------------------------------------------------------

/** A fetch stub that answers the status path and a scripted claim sequence. */
function checkinFetch(script: {
  status: unknown
  claims: readonly unknown[]
  statusAfter?: unknown
}): { fetchFn: FetchFn; claimCalls: () => number } {
  let claimCalls = 0
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/checkin_credits/claim')) {
      const payload = script.claims[Math.min(claimCalls, script.claims.length - 1)]
      claimCalls += 1
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/checkin_credits/status')) {
      const payload = claimCalls > 0 && script.statusAfter !== undefined ? script.statusAfter : script.status
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as FetchFn
  return { fetchFn, claimCalls: () => claimCalls }
}

test('claimTraeCheckin retries the saturated check-in queue and reports the success', async () => {
  const { fetchFn, claimCalls } = checkinFetch({
    status: { checked_in: false, credits: 0, enable: true },
    claims: [
      { code: 4001, message: '当前签到人数过多，请稍后再试' },
      { code: 4001, message: '当前签到人数过多，请稍后再试' },
      { code: 0, message: 'success', credits: 150 },
    ],
  })
  const delays: number[] = []
  const result = await claimTraeCheckin('token', 'user', undefined, fetchFn, async (ms) => { delays.push(ms) })

  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  assert.equal(result.credits, 150)
  assert.equal(claimCalls(), 3)
  // The backoff waits between attempts, and never waits after the last one.
  assert.deepEqual(delays, [2_000, 5_000])
})

test('claimTraeCheckin treats a landed claim as success even when the answer was saturated', async () => {
  const { fetchFn } = checkinFetch({
    status: { checked_in: false, credits: 0, enable: true },
    claims: [{ code: 4001, message: '当前签到人数过多' }],
    // The queue answered saturated, but the claim actually landed.
    statusAfter: { checked_in: true, credits: 150, enable: true },
  })
  const result = await claimTraeCheckin('token', 'user', undefined, fetchFn, async () => {})
  assert.equal(result.ok, true)
  assert.equal(result.message, '今日已签到')
  assert.equal(result.credits, 150)
})

test('claimTraeCheckin stops after the retry budget and explains the idempotence', async () => {
  const { fetchFn, claimCalls } = checkinFetch({
    status: { checked_in: false, credits: 0, enable: true },
    claims: [{ code: 4001, message: '当前签到人数过多，请稍后再试' }],
  })
  const result = await claimTraeCheckin('token', 'user', undefined, fetchFn, async () => {})
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 4)
  assert.equal(claimCalls(), 4)
  assert.match(result.message, /人数过多/)
  assert.match(result.message, /重试 4 次/)
})

test('claimTraeCheckin reports a non-transient business failure without retrying', async () => {
  const { fetchFn, claimCalls } = checkinFetch({
    status: { checked_in: false, credits: 0, enable: true },
    claims: [{ code: 4003, message: '该账号当前未开启签到活动' }],
  })
  const result = await claimTraeCheckin('token', 'user', undefined, fetchFn, async () => {})
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 1)
  assert.equal(claimCalls(), 1)
  assert.equal(result.message, '该账号当前未开启签到活动')
})

test('fetchTraeCheckinStatus reads today state off the status endpoint', async () => {
  const { fetchFn } = checkinFetch({
    status: { checked_in: true, credits: 150, enable: true },
    claims: [],
  })
  const status = await fetchTraeCheckinStatus('token', 'user', undefined, fetchFn)
  assert.equal(status.checkedIn, true)
  assert.equal(status.credits, 150)
  assert.equal(status.enabled, true)
})

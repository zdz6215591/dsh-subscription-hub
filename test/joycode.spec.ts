/**
 * The JoyCode route: protocol facts, credential handling, and the three wire
 * paths.
 *
 * Every assertion here traces to the reference implementations this channel was
 * ported from (`ref-joycode2api`, `ref-switch-dev`): the pinned capability table,
 * the gateway signature, the per-path `loginType`/`tenant` defaults, the `-hq`
 * Claude ids and the DOUBLE-WRAPPED Responses SSE are all things the references
 * document, so they are pinned here rather than re-derived.
 */

import './keep-alive.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { LlmError, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { JoyCodeSession, ProviderId } from '../src/auth/store.js'
import { JoyCodeAdapter } from '../src/providers/joycode.js'
import {
  JOYCODE_EFFORTS,
  JOYCODE_MODELS,
  isJoyCodeChatModel,
  joyCodeAnthropicId,
  joyCodeModel,
  joyCodePathFor,
} from '../src/providers/joycode/catalog.js'
import {
  JOYCODE_API_BASE,
  joyCodeBusinessError,
  joyCodeEnvelope,
  joyCodeGatewaySign,
  joyCodeHeaders,
  joyCodeHttpError,
  joyCodeUrl,
  isJoyCodeGrayRefusal,
} from '../src/providers/joycode/client.js'
import { joyCodeStateDbCandidates, parseJoyCodeStateValue, readJoyCodeStateDb } from '../src/providers/joycode/credentials.js'
import { fetchJoyCodeModels } from '../src/providers/joycode/models.js'
import { joyCodeSseLine, unwrapDoubleWrappedSse } from '../src/providers/joycode/translate.js'
import {
  importJoyCodeIde,
  joyCodeSessionFromPaste,
  parseJoyCodePaste,
  refreshJoyCodeSession,
  validateJoyCodeCredential,
} from '../src/providers/joycode-session.js'
import { streamResponses } from '../src/translate/responses.js'

const CREDENTIAL = {
  ptKey: 'pt-test',
  userId: '100001',
} as const

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function request(model: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'joycode',
    model,
    messages: [message('hello')],
    ...extra,
  }
}

/** A token manager over an in-memory account map. */
function tokensOf(sessions: Map<string, JoyCodeSession>, refresh?: (session: JoyCodeSession) => Promise<JoyCodeSession>) {
  const defaultKey = [...sessions.keys()][0] ?? ''
  return new AccountTokenManager<JoyCodeSession>({
    provider: 'joycode' as ProviderId,
    displayName: 'JoyCode',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: refresh ?? (current => Promise.resolve(current)),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve([...sessions.entries()].map(([key, session]) => ({ key, session }))),
      get: account => Promise.resolve(sessions.get(account ?? defaultKey)),
      save: (account, session) => {
        sessions.set(account, session)
        return Promise.resolve()
      },
      remove: account => {
        sessions.delete(account)
        return Promise.resolve()
      },
    },
  })
}

function sessionOf(extra: Partial<JoyCodeSession> = {}): JoyCodeSession {
  return {
    accessToken: 'pt-test',
    refreshToken: 'pt-test',
    expiresAt: Date.now() + 3_600_000,
    userId: '100001',
    account: 'tester',
    ...extra,
  }
}

// ---------------------------------------------------------------- catalogue

test('joycode sends each family to the endpoint that serves it', () => {
  // The GPT family: the chat path answers 1032 for these.
  assert.equal(joyCodePathFor('GPT-6 Astra'), 'responses')
  assert.equal(joyCodePathFor('gpt-7-something-new'), 'responses')
  // The Claude family: the OpenAI paths answer EMPTY for these.
  assert.equal(joyCodePathFor('Claude-Opus-5'), 'anthropic')
  assert.equal(joyCodePathFor('claude-opus-9'), 'anthropic')
  // Everything else.
  assert.equal(joyCodePathFor('GLM-5.3'), 'chat')
  assert.equal(joyCodePathFor('brand-new-model'), 'chat')
})

test('joycode maps Claude labels to their -hq internal id, and never invents one', () => {
  assert.equal(joyCodeAnthropicId('Claude-Opus-5'), 'Claude-Opus-5-hq')
  assert.equal(joyCodeAnthropicId('Claude-Sonnet-4.6'), 'Claude-Sonnet-4.6-hq')
  // An id that already spells its suffix resolves through the alias table.
  assert.equal(joyCodeAnthropicId('claude-opus-4.8-hq'), 'Claude-Opus-4.8-hq')
  // An unknown Claude id is passed through: the reference's silent fallback to
  // Claude-Opus-5-hq would answer with a model nobody asked for.
  assert.equal(joyCodeAnthropicId('Claude-Opus-9'), 'Claude-Opus-9')
})

test('joycode drops the completion-only model from the roster', () => {
  assert.equal(isJoyCodeChatModel('JoyCode-Base-V3'), false)
  assert.equal(isJoyCodeChatModel('joycode-base-v3'), false)
  assert.equal(isJoyCodeChatModel('GLM-5.3'), true)
})

test('joycode advertises thinking levels only where the reference published them', () => {
  assert.deepEqual(joyCodeModel('GPT-6 Astra')?.efforts, JOYCODE_EFFORTS)
  // Doubao is not in the reference's reasoning map, but its ChatThinking turns the
  // switch ON whenever an effort arrives, so the picker is the only way to reach it.
  assert.deepEqual(joyCodeModel('Doubao-Seed-2.0-pro')?.efforts, JOYCODE_EFFORTS)
  assert.deepEqual(joyCodeModel('Kimi-K3')?.efforts, JOYCODE_EFFORTS)
  // The Claude family carries no published level axis.
  assert.equal(joyCodeModel('Claude-Opus-5')?.efforts, undefined)
  // Neither does the platform's own default model.
  assert.equal(joyCodeModel('JoyAI-Code-1.5')?.efforts, undefined)
  // Every pinned row carries the published budgets.
  for (const model of JOYCODE_MODELS) {
    assert.ok(model.contextWindow >= 200_000, `${model.id} lost its context window`)
    assert.ok(model.maxOutputTokens > 0, `${model.id} lost its output cap`)
  }
})

// ------------------------------------------------------------------- client

test('joycode gateway signature matches the reference canonical string', () => {
  const { query, sign } = joyCodeGatewaySign('chat_completions', 1_700_000_000_000)
  assert.equal(query, 'appid=joycode_ide&functionId=chat_completions&t=1700000000000')
  // HMAC-SHA256 over `joycode_ide&<functionId>&<t>` with the IDE's published key.
  const expected = createHmac('sha256', '0691a3f0b37b4a85aeb63ad0fc7db3ed')
    .update('joycode_ide&chat_completions&1700000000000')
    .digest('hex')
  assert.equal(sign, expected)
  assert.equal(sign, 'e3cb11e84cd47a763ffc55f08168cb8c1fc5e32cc8e17378f74585ac9cf88ebb')
})

test('joycode uses the signed gateway when the credential names one, direct v2 otherwise', () => {
  const direct = joyCodeUrl(CREDENTIAL, 'chat')
  assert.equal(direct, `${JOYCODE_API_BASE}/api/saas/openai/v2/chat/completions`)

  const gateway = joyCodeUrl({ ...CREDENTIAL, colorBaseUrl: 'https://api-ai.jd.com' }, 'responses', 1_700_000_000_000)
  // Routing is by functionId: the v2 path does NOT appear in a gateway URL.
  assert.match(gateway, /^https:\/\/api-ai\.jd\.com\/api\?appid=joycode_ide&functionId=responses_completions&t=1700000000000&sign=[0-9a-f]{64}$/)

  // A credential that carries a master origin routes there instead.
  const overridden = joyCodeUrl({ ...CREDENTIAL, masterBaseUrl: 'https://staging.example/' }, 'models')
  assert.equal(overridden, 'https://staging.example/api/saas/models/v2/modelList')
})

test('joycode headers follow the path: loginType, ptKey source, stream encoding', () => {
  const chat = joyCodeHeaders(CREDENTIAL, { stream: true })
  assert.equal(chat.ptkey, 'pt-test')
  assert.equal(chat.logintype, 'N_PIN_PC')
  assert.equal(chat['source-type'], 'joycoder-ide')
  // gzip must be off on a stream: a buffered block turns live SSE into one dump.
  assert.equal(chat['accept-encoding'], 'identity')
  assert.match(chat['user-agent'] ?? '', /JoyCode\/2\.7\.5/)

  const anthropic = joyCodeHeaders({ ...CREDENTIAL, anthropicPtKey: 'pt-claude' }, { anthropic: true })
  assert.equal(anthropic.logintype, 'PIN_JD_CLOUD')
  assert.equal(anthropic.ptkey, 'pt-claude')

  // An imported credential claims the INSTALLED extension's version instead.
  const versioned = joyCodeHeaders({ ...CREDENTIAL, clientVersion: '3.8.67' })
  assert.match(versioned['user-agent'] ?? '', /JoyCode\/3\.8\.67/)
  assert.equal(versioned['accept-encoding'], 'gzip, deflate')
})

test('joycode envelope uses each path\'s tenant and the credential\'s fields', () => {
  const chat = joyCodeEnvelope({ ...CREDENTIAL, orgFullName: 'JD Cloud' })
  assert.deepEqual(chat, {
    tenant: 'JOYCODE', orgFullName: 'JD Cloud', userId: '100001', client: 'JoyCode', clientVersion: '2.7.5', language: 'UNKNOWN',
  })
  assert.equal(joyCodeEnvelope(CREDENTIAL, { anthropic: true }).tenant, 'JD')
  assert.equal(joyCodeEnvelope({ ...CREDENTIAL, tenant: 'CUSTOM' }, { anthropic: true }).tenant, 'CUSTOM')
  assert.equal(joyCodeEnvelope({ ...CREDENTIAL, clientVersion: '3.8.67' }).clientVersion, '3.8.67')
})

test('joycode names the two business codes that mean "wrong path for this model"', () => {
  const wrongPath = joyCodeHttpError(400, JSON.stringify({ code: 1032, msg: 'not supported' }), 'JoyCode chat')
  assert.equal(wrongPath.code, 'HTTP_400')
  assert.match(wrongPath.message, /Responses path/)

  const bareLabel = joyCodeHttpError(400, JSON.stringify({ code: 6002, msg: 'model not found' }), 'JoyCode anthropic')
  assert.match(bareLabel.message, /-hq/)

  assert.equal(joyCodeHttpError(401, 'nope', 'JoyCode chat').code, 'AUTH')
  assert.equal(joyCodeHttpError(429, 'slow down', 'JoyCode chat').code, 'RATE_LIMIT')
  assert.equal(joyCodeHttpError(500, 'boom', 'JoyCode chat').code, 'SERVER')
  assert.equal(joyCodeHttpError(400, 'plain body', 'JoyCode chat').code, 'HTTP_400')
  assert.match(joyCodeHttpError(400, 'plain body', 'JoyCode chat').message, /plain body/)
})

test('joycode treats a business code in a 200 as a failure, and an expired credential as AUTH', () => {
  assert.equal(joyCodeBusinessError({ code: 0, data: {} }, 'JoyCode'), undefined)
  const refused = joyCodeBusinessError({ code: 401, msg: '登录已过期，请重新登录' }, 'JoyCode')
  assert.equal(refused?.code, 'AUTH')
  const other = joyCodeBusinessError({ code: 5001, msg: 'internal' }, 'JoyCode')
  assert.equal(other?.code, 'SERVER')
})

test('joycode names the gray-release refusal instead of reporting a server fault', () => {
  // The gate answers with a policy string, not a status: both references treat
  // these two as "this account is not in the wave yet".
  const business = joyCodeBusinessError({ code: 5000, msg: 'AI_GRAY_ACCESS_DENIED' }, 'JoyCode')
  assert.match(business?.message ?? '', /gray-release/)
  const http = joyCodeHttpError(200, 'COLOR_FORWARD_EXCEPTION: not in wave', 'JoyCode chat')
  assert.match(http.message, /gray-release/)
  assert.equal(isJoyCodeGrayRefusal('all good'), false)
})

// -------------------------------------------------------------- credentials

test('joycode probes the platform state database, env override and container mount first', () => {
  const windows = joyCodeStateDbCandidates('win32', 'C:\\Users\\me', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })
  assert.deepEqual(windows, [win32.join('C:\\Users\\me\\AppData\\Roaming', 'JoyCode', 'User', 'globalStorage', 'state.vscdb')])

  // The container mount is probed before $HOME, and these are POSIX paths even
  // when the suite runs on Windows.
  const linux = joyCodeStateDbCandidates('linux', '/home/me', {})
  assert.deepEqual(linux, ['/root/.joycode-ide/state.vscdb', '/home/me/.config/JoyCode/User/globalStorage/state.vscdb'])
  assert.equal(joyCodeStateDbCandidates('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })[1], '/cfg/JoyCode/User/globalStorage/state.vscdb')

  const mac = joyCodeStateDbCandidates('darwin', '/Users/me', {})
  assert.deepEqual(mac, [posix.join('/Users/me', 'Library', 'Application Support', 'JoyCode', 'User', 'globalStorage', 'state.vscdb')])

  // The override wins outright and is the only candidate.
  const override = joyCodeStateDbCandidates('linux', '/home/me', { JOYCODE_STATE_DB: '/mnt/ide/state.vscdb' })
  assert.equal(override[0], '/mnt/ide/state.vscdb')
})

test('joycode parses the IDE document, nested or flat, and refuses a non-login', () => {
  const nested = parseJoyCodeStateValue(JSON.stringify({
    joyCoderUser: { ptKey: 'pt-1', userId: '42', userName: 'someone', colorBaseUrl: 'https://api-ai.jd.com', tenant: 'JOYCODE', loginType: 'N_PIN_PC', orgFullName: 'JD' },
  }))
  assert.deepEqual(nested, {
    ptKey: 'pt-1', userId: '42', account: 'someone', colorBaseUrl: 'https://api-ai.jd.com', tenant: 'JOYCODE', loginType: 'N_PIN_PC', orgFullName: 'JD',
  })
  assert.deepEqual(parseJoyCodeStateValue('{"ptKey":"pt-2","userId":"7"}'), { ptKey: 'pt-2', userId: '7' })
  assert.equal(parseJoyCodeStateValue('{"joyCoderUser":{"ptKey":"pt-3"}}'), undefined)
  assert.equal(parseJoyCodeStateValue('not json'), undefined)
})

test('joycode reads a live state database read-only', async t => {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    t.skip('this Node has no node:sqlite')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'joycode-db-'))
  try {
    const path = join(dir, 'state.vscdb')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'JoyCoder.IDE',
      JSON.stringify({ joyCoderUser: { ptKey: 'pt-live', userId: '100001', userName: 'IDE user' } }),
    )
    db.close()

    assert.deepEqual(await readJoyCodeStateDb(path), { ptKey: 'pt-live', userId: '100001', account: 'IDE user' })

    // A database without the key is "not signed in", not an error.
    const emptyPath = join(dir, 'empty.vscdb')
    const empty = new DatabaseSync(emptyPath)
    empty.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    empty.close()
    assert.equal(await readJoyCodeStateDb(emptyPath), undefined)
    // A path that does not exist is the same answer.
    assert.equal(await readJoyCodeStateDb(join(dir, 'absent.vscdb')), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- transport

test('joycode unwraps the double-wrapped Responses SSE down to real events', () => {
  assert.equal(joyCodeSseLine('data: event: response.output_text.done'), undefined)
  assert.equal(
    joyCodeSseLine('data: data: {"type":"response.output_text.done"}'),
    'data: {"type":"response.output_text.done"}',
  )
  assert.equal(joyCodeSseLine('data: [DONE]'), 'data: [DONE]')
  assert.equal(joyCodeSseLine(': keepalive'), undefined)
  assert.equal(joyCodeSseLine(''), undefined)
})

test('joycode\'s GPT path streams through the Responses translator end to end', async () => {
  const wrapped = [
    'data: event: response.output_text.delta',
    'data: data: {"type":"response.output_text.delta","delta":"Hi "}',
    'data: event: response.output_item.added',
    'data: data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash"}}',
    'data: event: response.output_item.done',
    'data: data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}',
    'data: event: response.completed',
    'data: data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4}}}',
    '',
  ].join('\n')

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wrapped))
      controller.close()
    },
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of streamResponses(unwrapDoubleWrappedSse(body))) chunks.push(chunk)

  const blocks = chunks.filter(chunk => chunk.type === 'block-end') as { block?: { type: string, text?: string, name?: string, arguments?: string } }[]
  // The tool item is closed by its own `output_item.done`, so it ends BEFORE the
  // text block, which closes when the response completes.
  const text = blocks.find(block => block.block?.type === 'text')
  const call = blocks.find(block => block.block?.type === 'tool-call')
  assert.deepEqual(text?.block, { type: 'text', text: 'Hi ' })
  assert.equal(call?.block?.name, 'bash')
  assert.equal(call?.block?.arguments, '{"cmd":"ls"}')
  const usage = chunks.find(chunk => chunk.type === 'usage') as { usage?: { inputTokens: number, outputTokens: number } } | undefined
  assert.deepEqual(usage?.usage, { inputTokens: 11, outputTokens: 4 })
  assert.ok(chunks.some(chunk => chunk.type === 'finish'))
})

test('joycode parses a live model list, merging pinned capabilities and live features', async () => {
  const roster = await fetchJoyCodeModels(CREDENTIAL, (async (_input: URL | Request, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).userId, '100001')
    return new Response(JSON.stringify({
      code: 0,
      data: [
        { label: 'JoyAI-Code-1.5', chatApiModel: 'JoyAI-Code-1.5', maxTotalTokens: 200_000, respMaxTokens: 64_000, features: ['chat'] },
        { label: 'GLM-5.3', chatApiModel: 'glm-5', maxTotalTokens: 200_000, respMaxTokens: 16_384, features: ['agent'] },
        { label: 'Kimi-K2.5', chatApiModel: 'Kimi-K2.5', maxTotalTokens: 200_000, respMaxTokens: 16_384, features: ['vision'] },
        // Completion-only: never a chat model.
        { label: 'JoyCode-Base-V3', chatApiModel: 'JoyCode-Base-V3', maxTotalTokens: 8_000 },
        // No id field at all: the label stands in for it, as the reference does.
        { label: 'Ghost' },
        // Neither field: nothing to call.
        { respMaxTokens: 100 },
      ],
    }))
  }) as typeof fetch)

  assert.deepEqual(roster.map(entry => entry.id), ['JoyAI-Code-1.5', 'glm-5', 'Kimi-K2.5', 'Ghost'])
  // The label is the display name even when the wire id differs.
  assert.equal(roster[1]?.name, 'GLM-5.3')
  // Pinned capabilities resolve through either spelling.
  assert.equal(roster[1]?.pinned?.id, 'GLM-5.3')
  assert.equal(roster[1]?.pinned?.efforts?.length, JOYCODE_EFFORTS.length)
  // Live features decide vision when the endpoint states them.
  assert.equal(roster[0]?.vision, false)
  assert.equal(roster[2]?.vision, true)
})

// ------------------------------------------------------------- credentials

test('joycode pastes a ptKey and user id in any of the shapes the IDE shows them', () => {
  assert.deepEqual(parseJoyCodePaste('ptkey: pt-1 userid: 42'), { ptKey: 'pt-1', userId: '42' })
  assert.deepEqual(parseJoyCodePaste('pt-1 42'), { ptKey: 'pt-1', userId: '42' })
  assert.deepEqual(parseJoyCodePaste('pt-1:42'), { ptKey: 'pt-1', userId: '42' })
  const document = parseJoyCodePaste(JSON.stringify({ joyCoderUser: { ptKey: 'pt-9', userId: '9', colorBaseUrl: 'https://api-ai.jd.com' } }))
  assert.deepEqual(document, { ptKey: 'pt-9', userId: '9', colorBaseUrl: 'https://api-ai.jd.com' })
  // A bare key cannot be used: every request carries the user id.
  assert.throws(() => parseJoyCodePaste('pt-1'), (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL')
  assert.throws(() => parseJoyCodePaste('   '), (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL')
})

test('joycode validation keeps the ROTATED ptKey and names the account', async () => {
  const identity = await validateJoyCodeCredential(CREDENTIAL, (async () => new Response(JSON.stringify({
    code: 0,
    data: { userId: '100001', realName: 'tester', ptKey: 'pt-rotated' },
  }))) as typeof fetch)
  assert.deepEqual(identity, { ptKey: 'pt-rotated', userId: '100001', account: 'tester' })
})

test('joycode validation reports a refusal as AUTH and a dead connection as TRANSPORT', async () => {
  await assert.rejects(
    validateJoyCodeCredential(CREDENTIAL, (async () => new Response(JSON.stringify({ code: 401, msg: 'expired' }))) as typeof fetch),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
  await assert.rejects(
    validateJoyCodeCredential(CREDENTIAL, (async () => new Response('nope', { status: 403 })) as typeof fetch),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
  await assert.rejects(
    validateJoyCodeCredential(CREDENTIAL, (async () => { throw new TypeError('fetch failed') }) as typeof fetch),
    (error: unknown) => error instanceof LlmError && error.code === 'TRANSPORT',
  )
  await assert.rejects(
    validateJoyCodeCredential(CREDENTIAL, (async () => new Response('<html>', { status: 502 })) as typeof fetch),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
})

test('joycode session from a paste stores one key twice and an hourly re-validation', async () => {
  const before = Date.now()
  const session = await joyCodeSessionFromPaste('ptkey: pt-1 userid: 42', (async () => new Response(JSON.stringify({
    code: 0, data: { userId: '42', realName: 'someone', ptKey: 'pt-rotated' },
  }))) as typeof fetch)
  assert.equal(session.accessToken, 'pt-rotated')
  assert.equal(session.refreshToken, 'pt-rotated')
  assert.equal(session.userId, '42')
  assert.equal(session.account, 'someone')
  assert.ok(session.expiresAt >= before + 60 * 60_000)
  // No local IDE was involved, so no extension version is claimed.
  assert.equal(session.clientVersion, undefined)
})

test('joycode refresh re-validates, rotates the key and extends the window', async () => {
  const session = sessionOf({ expiresAt: 1 })
  const next = await refreshJoyCodeSession(session, (async () => new Response(JSON.stringify({
    code: 0, data: { userId: '100001', realName: 'renamed', ptKey: 'pt-next' },
  }))) as typeof fetch)
  assert.equal(next.accessToken, 'pt-next')
  assert.equal(next.account, 'renamed')
  assert.ok(next.expiresAt > session.expiresAt)
  // A transport failure must NOT be treated as a dead credential.
  await assert.rejects(
    refreshJoyCodeSession(session, (async () => { throw new TypeError('offline') }) as typeof fetch),
    (error: unknown) => error instanceof LlmError && error.code === 'TRANSPORT',
  )
})

test('joycode import reads the local IDE credential and reports every path it probed', async t => {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    t.skip('this Node has no node:sqlite')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'joycode-import-'))
  try {
    const path = join(dir, 'state.vscdb')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'JoyCoder.IDE',
      JSON.stringify({ joyCoderUser: { ptKey: 'pt-ide', userId: '7', userName: 'ide-user', colorBaseUrl: 'https://api-ai.jd.com' } }),
    )
    db.close()

    const imported = await importJoyCodeIde({
      path,
      fetchFn: (async () => new Response(JSON.stringify({ code: 0, data: { userId: '7', ptKey: 'pt-ide-2' } }))) as typeof fetch,
    })
    assert.equal(imported.session?.accessToken, 'pt-ide-2')
    assert.equal(imported.session?.colorBaseUrl, 'https://api-ai.jd.com')
    assert.equal(imported.session?.account, 'ide-user')
    assert.deepEqual(imported.probed, [path])

    const empty = await importJoyCodeIde({ path: join(dir, 'absent.vscdb'), fetchFn: (async () => new Response('{}')) as typeof fetch })
    assert.equal(empty.session, undefined)
    assert.deepEqual(empty.probed, [join(dir, 'absent.vscdb')])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ adapter

test('joycode capabilities come from the pinned table, never from a guess', async () => {
  const adapter = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf()]])),
    discovery: true,
  })
  const gpt = await adapter.resolveOwnModel('joycode', 'GPT-6 Astra')
  assert.deepEqual(gpt.reasoning?.efforts.map(effort => String(effort.id)), JOYCODE_EFFORTS)
  assert.equal(gpt.context?.contextWindow, 200_000)
  assert.deepEqual(gpt.inputModalities, ['text', 'image'])

  const claude = await adapter.resolveOwnModel('joycode', 'Claude-Opus-5')
  assert.equal(claude.reasoning, undefined)

  const unknown = await adapter.resolveOwnModel('joycode', 'Mystery-1')
  assert.equal(unknown.reasoning, undefined)
  assert.equal(unknown.context, undefined)
  // An id the table cannot attribute is still routed by its family.
  assert.equal(joyCodePathFor('Mystery-1'), 'chat')
})

test('joycode honours the configured default thinking level', async () => {
  const adapter = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf()]])),
    discovery: true,
    defaultEffortOf: model => model === 'GPT-6 Astra' ? 'xhigh' : undefined,
  })
  const resolved = await adapter.resolveOwnModel('joycode', 'GPT-6 Astra')
  assert.equal(String(resolved.reasoning?.defaultEffort), 'xhigh')
})

test('joycode streams the chat path with its envelope, thinking switch off/on', async () => {
  const captured: { url: string, headers: Record<string, string>, body: Record<string, unknown> }[] = []
  const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n'
    + 'data: [DONE]\n\n'
  const adapter = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf({ colorBaseUrl: 'https://api-ai.jd.com' })]])),
    discovery: true,
    fetchFn: (async (input: URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: Object.fromEntries(Object.entries(init?.headers ?? {}) as [string, string][]),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(sse, { status: 200 })
    }) as typeof fetch,
  })

  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request('GLM-5.3', { reasoningEffort: ReasoningEffortId('high') }))) chunks.push(chunk)
  assert.equal(captured.length, 1)
  const call = captured[0]!
  assert.match(call.url, /\?appid=joycode_ide&functionId=chat_completions&t=\d+&sign=[0-9a-f]{64}$/)
  assert.equal(call.headers.ptkey, 'pt-test')
  assert.equal(call.headers.logintype, 'N_PIN_PC')
  assert.equal(call.body.tenant, 'JOYCODE')
  assert.equal(call.body.userId, '100001')
  assert.equal(call.body.model, 'GLM-5.3')
  assert.equal(call.body.reasoning_effort, 'high')
  assert.equal(call.body.thinking, undefined)
  assert.equal(call.body.stream, true)
  assert.ok(chunks.some(chunk => chunk.type === 'finish'))

  // Doubao gates thinking on a switch, so an effort turns it on (the reference's
  // own ChatThinking mapping).
  captured.length = 0
  for await (const chunk of adapter.stream(request('Doubao-Seed-2.0-pro', { reasoningEffort: ReasoningEffortId('high') }))) void chunk
  assert.deepEqual(captured[0]?.body.thinking, { type: 'enabled' })

  // `off` is this route's "no reasoning": the switch goes off instead.
  captured.length = 0
  for await (const chunk of adapter.stream(request('GLM-5.3', { reasoningEffort: ReasoningEffortId('off') }))) void chunk
  assert.deepEqual(captured[0]?.body.thinking, { type: 'disabled' })
  assert.equal(captured[0]?.body.reasoning_effort, undefined)
})

test('joycode streams the GPT path as Responses, with none for off', async () => {
  const captured: Record<string, unknown>[] = []
  const wrapped = 'data: data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
    + 'data: data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
  const adapter = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf()]])),
    discovery: true,
    fetchFn: (async (_input: URL | Request, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(wrapped, { status: 200 })
    }) as typeof fetch,
  })

  for await (const chunk of adapter.stream(request('GPT-6 Astra', { reasoningEffort: ReasoningEffortId('xhigh'), maxTokens: 1_024 }))) {
    void chunk
  }
  assert.deepEqual(captured[0]?.reasoning, { effort: 'xhigh' })
  assert.equal(captured[0]?.max_output_tokens, 1_024)
  assert.equal(captured[0]?.stream, true)
  assert.ok(Array.isArray(captured[0]?.input))

  captured.length = 0
  for await (const chunk of adapter.stream(request('GPT-6 Astra', { reasoningEffort: ReasoningEffortId('off') }))) void chunk
  assert.deepEqual(captured[0]?.reasoning, { effort: 'none' })
})

test('joycode streams Claude models through the native Anthropic path', async () => {
  const captured: { url: string, headers: Record<string, string>, body: Record<string, unknown> }[] = []
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n'
    + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
    + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const adapter = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf()]])),
    discovery: true,
    fetchFn: (async (input: URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: Object.fromEntries(Object.entries(init?.headers ?? {}) as [string, string][]),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(sse, { status: 200 })
    }) as typeof fetch,
  })

  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request('Claude-Opus-5', { maxTokens: 99_999 }))) chunks.push(chunk)
  const call = captured[0]!
  assert.equal(call.url, `${JOYCODE_API_BASE}/api/saas/anthropic/v1/messages`)
  assert.equal(call.headers.logintype, 'PIN_JD_CLOUD')
  assert.equal(call.body.tenant, 'JD')
  // The bare label answers 6002 upstream, so the `-hq` id goes on the wire.
  assert.equal(call.body.model, 'Claude-Opus-5-hq')
  // The path's own ceiling, whatever the caller asked for.
  assert.equal(call.body.max_tokens, 32_768)
  assert.equal(call.body.stream, true)
  assert.ok(chunks.some(chunk => chunk.type === 'block-end'))
  assert.ok(chunks.some(chunk => chunk.type === 'finish'))
})

test('joycode surfaces a failed model read instead of inventing a roster', async () => {
  const adapter = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf()]])),
    discovery: true,
    fetchFn: (async () => new Response('upstream exploded', { status: 500 })) as typeof fetch,
  })
  assert.deepEqual(await adapter.listOwnModels('joycode', '100001'), [])
  const reason = adapter.notFetchedReason('joycode')
  assert.equal(reason?.what, 'The JoyCode model list could not be fetched')
  assert.match(reason?.detail ?? '', /SERVER/)

  // A refused credential IS reported: unlike "not logged in", this is a route
  // that should have worked, and the reason is what makes it diagnosable.
  const unauthorized = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map([['100001', sessionOf()]])),
    discovery: true,
    fetchFn: (async () => new Response('nope', { status: 401 })) as typeof fetch,
  })
  assert.deepEqual(await unauthorized.listOwnModels('joycode', '100001'), [])
  assert.match(unauthorized.notFetchedReason('joycode')?.detail ?? '', /AUTH/)

  // No account at all is the SILENT case: there is simply nothing to list.
  const loggedOut = new JoyCodeAdapter({
    models: [],
    streamIdleTimeoutMs: 5_000,
    tokens: tokensOf(new Map()),
    discovery: true,
    fetchFn: (async () => new Response('{}')) as typeof fetch,
  })
  assert.deepEqual(await loggedOut.listOwnModels('joycode'), [])
  assert.equal(loggedOut.notFetchedReason('joycode'), undefined)
})

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountKeyOf } from '../src/auth/store.js'
import type { AgySession, CodeBuddySession, CommandCodeSession, ZedSession } from '../src/auth/store.js'
import { filterVisible, setModelVisible, hiddenIds } from '../src/model-visibility.js'
import { sessionFromZedPaste, parseZedModels, ndjsonToSse, parseZedUsage, buildZedProviderRequest } from '../src/providers/zed.js'
import { parseMeterUsage } from '../src/providers/codebuddy-lib/usage.js'
import { parseCommandCodeAuthFile, parseCommandCodeCredits, parseCommandCodeStream, sessionFromCommandCodePaste } from '../src/providers/commandcode.js'
import { extractAgyProjectId } from '../src/providers/agy.js'
import { parseAgyQuotaUsage } from '../src/providers/agy/models.js'
import { isAgyUnusableEndpoint } from '../src/providers/agy/constants.js'
import { providerForHostname } from '../src/http.js'
import { toAgyRequestBody } from '../src/providers/agy/translate.js'
import { parseSseDataLine } from '../src/providers/agy/parse.js'
import { checkinCodeBuddy } from '../src/providers/codebuddy.js'

const TEMP_DIRS: string[] = []
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

describe('new provider account keys', () => {
  it('keys agy by email', () => {
    const session: AgySession = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      account: 'user@gmail.com',
    }
    assert.equal(accountKeyOf('agy', session), 'user@gmail.com')
  })

  it('keys codebuddy by uid', () => {
    const session: CodeBuddySession = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      domain: 'tencent.com',
      uid: 'u-1',
      account: 'nick',
    }
    assert.equal(accountKeyOf('codebuddy', session), 'u-1')
  })

  it('keys commandcode by account then userId', () => {
    const session: CommandCodeSession = {
      accessToken: 'k',
      refreshToken: 'k',
      expiresAt: 1,
      account: 'go-1',
      userId: 'uid',
    }
    assert.equal(accountKeyOf('commandcode', session), 'go-1')
  })

  it('keys zed by userId', () => {
    const session: ZedSession = {
      accessToken: 't',
      refreshToken: 't',
      expiresAt: 1,
      userId: 'zed-user',
    }
    assert.equal(accountKeyOf('zed', session), 'zed-user')
  })
})

describe('model visibility deny-list', () => {
  it('hides opted-out ids and leaves new ones visible', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vis-'))
    TEMP_DIRS.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await setModelVisible('codex', 'gpt-hidden', false)
      const hidden = await hiddenIds('codex')
      assert.equal(hidden.has('gpt-hidden'), true)
      const listed = await filterVisible('codex', [
        { id: 'gpt-hidden' },
        { id: 'gpt-shown' },
      ])
      assert.deepEqual(listed.map(model => model.id), ['gpt-shown'])
      await setModelVisible('codex', 'gpt-hidden', true)
      const restored = await filterVisible('codex', [{ id: 'gpt-hidden' }])
      assert.deepEqual(restored.map(model => model.id), ['gpt-hidden'])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('zed paste and catalog', () => {
  it('parses userId + token and JSON', async () => {
    const spaced = await sessionFromZedPaste('abc token-value')
    assert.equal(spaced.userId, 'abc')
    assert.equal(spaced.accessToken, 'token-value')
    const json = await sessionFromZedPaste('{"userId":"u1","token":"t1","email":"a@b.c"}')
    assert.equal(json.userId, 'u1')
    assert.equal(json.accessToken, 't1')
    assert.equal(json.account, 'a@b.c')
    const lines = await sessionFromZedPaste('user-a\ntoken-b')
    assert.equal(lines.userId, 'user-a')
    assert.equal(lines.accessToken, 'token-b')
    const labeled = await sessionFromZedPaste('userId: aaa\ntoken: bbb')
    assert.equal(labeled.userId, 'aaa')
    assert.equal(labeled.accessToken, 'bbb')
  })

  it('parses the live /models payload', () => {
    const models = parseZedModels({
      models: [
        { id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', provider: 'anthropic', supports_images: true, max_token_count: 200000 },
        { id: 'gpt-5-nano', name: 'GPT-5 nano', provider: 'open_ai' },
      ],
    })
    assert.equal(models.length, 2)
    assert.equal(models[0].provider, 'anthropic')
    assert.equal(models[0].supportsImages, true)
    assert.equal(models[1].name, 'GPT-5 nano')
  })

  it('reads alternate context-window fields', () => {
    const models = parseZedModels({
      models: [
        { id: 'gpt-wide', provider: 'open_ai', max_tokens: 400_000, max_output_tokens: 32_000 },
      ],
    })
    assert.equal(models[0].contextWindow, 400_000)
    assert.equal(models[0].maxTokens, 32_000)
  })

  it('builds OpenAI Responses provider_request with top-level tool name', () => {
    const { provider, body } = buildZedProviderRequest(
      {
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'search', description: 's', parameters: { type: 'object' } }],
      } as unknown as Parameters<typeof buildZedProviderRequest>[0],
      {
        id: 'gpt-5.6-luna',
        name: 'GPT',
        provider: 'open_ai',
        supportsImages: false,
        supportsThinking: true,
        contextWindow: 272_000,
        maxTokens: 16_384,
      },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as Parameters<typeof buildZedProviderRequest>[2],
    )
    assert.equal(provider, 'open_ai')
    assert.equal(Array.isArray(body.input), true)
    assert.equal((body.tools as { name?: string }[])[0]?.name, 'search')
    assert.equal('function' in ((body.tools as object[])[0] as object), false)
  })

  it('maps /client/users/me plan + edit-prediction usage', () => {
    const usage = parseZedUsage({
      plan: {
        plan_v3: 'zed_pro',
        subscription_period: { started_at: '2026-08-04T00:00:00Z', ended_at: '2026-09-04T00:00:00Z' },
        usage: { edit_predictions: { used: 120, limit: 2000 } },
      },
      default_organization_id: 'org_01m1jhg6vxysd7sbeyf7z8zmyv',
      organizations: [{ id: 'org_01m1jhg6vxysd7sbeyf7z8zmyv', name: 'Me' }],
    }, { spent_cents: 250, included_cents: 500, spend_limit_cents: 1000 })
    assert.equal(usage.supported, true)
    assert.equal(usage.plan, 'Zed Pro')
    assert.equal(usage.windows?.[0]?.scope, 'Edit Predictions')
    assert.equal(Math.round(usage.windows?.[0]?.usedPercent ?? -1), 6)
    assert.equal(usage.windows?.[1]?.scope, 'Hosted models')
    assert.equal(Math.round(usage.windows?.[1]?.usedPercent ?? -1), 17)
  })

  it('unwraps NDJSON {event} lines into SSE data frames', async () => {
    const bytes = new TextEncoder().encode('{"event":{"choices":[{"delta":{"content":"hi"}}]}}\n{"status":"ok"}\n')
    const stream = ndjsonToSse(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }))
    const reader = stream.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value))
    }
    const text = chunks.join('')
    assert.match(text, /data: \{"choices":/)
    assert.doesNotMatch(text, /"status":"ok"/)
  })
})

describe('codebuddy meter + check-in', () => {
  it('parses personal Accounts windows', () => {
    const usage = parseMeterUsage({
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageCode: 'pro', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 40, CycleEndTime: '2026-09-10 23:59:59' },
              { PackageCode: 'TCACA_code_007_nzdH5h4Nl0', CycleCapacitySizePrecise: 50, CycleCapacityRemainPrecise: 0 },
            ],
          },
        },
      },
    })
    assert.equal(usage?.supported, true)
    assert.equal(usage?.windows?.[0]?.usedPercent, 60)
    assert.equal(usage?.windows?.[0]?.scope, 'pro')
    assert.equal(usage?.windows?.[0]?.remaining, 40)
    assert.equal(usage?.windows?.[0]?.limit, 100)
    assert.equal(usage?.windows?.[1]?.scope, 'credits-2')
    assert.equal(usage?.remaining, 40)
    assert.equal(usage?.limit, 150)
  })

  it('treats already-checked-in as success', async () => {
    const session: CodeBuddySession = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      domain: 'codebuddy.cn',
      uid: 'u1',
    }
    const result = await checkinCodeBuddy(session, async () => new Response(JSON.stringify({
      code: 0,
      data: { today_checked_in: true, streak_days: 3 },
    }), { status: 200 }))
    assert.equal(result.ok, true)
    assert.match(result.message, /Already checked in/)
  })

  it('treats check-in config 500 as already signed', async () => {
    const session: CodeBuddySession = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      domain: 'codebuddy.cn',
      uid: 'u1',
    }
    let n = 0
    const result = await checkinCodeBuddy(session, async () => {
      n += 1
      if (n === 1) return new Response(JSON.stringify({ code: 0, data: { active: true } }), { status: 200 })
      return new Response(JSON.stringify({ code: 1, msg: '签到配置加载失败，请稍后重试' }), { status: 500 })
    })
    assert.equal(result.ok, true)
    assert.match(result.message, /Already checked in/i)
  })

  it('skips global workbuddy accounts', async () => {
    const session: CodeBuddySession = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      domain: 'workbuddy.ai',
      uid: 'g1',
    }
    const result = await checkinCodeBuddy(session, async () => {
      throw new Error('must not fetch')
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /Global/)
  })
})

describe('commandcode credits', () => {
  it('maps monthly remaining plus window limits', () => {
    const usage = parseCommandCodeCredits({
      credits: { monthlyCredits: 8.5, purchasedCredits: 2, freeCredits: 0, planId: 'individual-go' },
      windowLimits: {
        fiveHour: { used: 1, cap: 10, resetAt: 1_800_000_000_000 },
        weekly: { used: 3, cap: 20, resetAt: 1_800_100_000_000 },
      },
    }, undefined, undefined, 1_800_200_000_000)
    assert.equal(usage.supported, true)
    assert.equal(usage.remaining, 8.5)
    assert.equal(usage.limit, 10)
    assert.equal(usage.plan, 'Go')
    assert.equal(usage.windows?.[0]?.scope, 'monthly')
    assert.equal(usage.windows?.[0]?.remaining, 8.5)
    assert.equal(usage.windows?.[0]?.resetsAt, 1_800_200_000_000)
    assert.equal(usage.windows?.[1]?.kind, 'session')
    assert.equal(usage.windows?.some(window => window.scope === 'on-demand'), true)
  })
})

describe('commandcode credentials', () => {
  it('parses the official CLI auth.json shapes', () => {
    assert.equal(parseCommandCodeAuthFile({ apiKey: 'user_abc' }), 'user_abc')
    assert.equal(parseCommandCodeAuthFile({ commandcode: { type: 'api', key: 'user_nested' } }), 'user_nested')
    assert.equal(parseCommandCodeAuthFile({ 'command-code': { type: 'oauth', access: 'user_oauth' } }), 'user_oauth')
    assert.equal(parseCommandCodeAuthFile({}), undefined)
  })

  it('stores a pasted key without requiring Studio', async () => {
    const session = await sessionFromCommandCodePaste('user_pasted', async () => {
      throw new Error('whoami optional')
    })
    assert.equal(session.accessToken, 'user_pasted')
  })
})

describe('commandcode stream', () => {
  it('emits text and finish from JSONL events', async () => {
    const payload = [
      JSON.stringify({ type: 'text-delta', text: 'Hello' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 2, outputTokens: 1 } }),
      '',
    ].join('\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const chunks = []
    for await (const chunk of parseCommandCodeStream(stream)) chunks.push(chunk)
    assert.equal(chunks[0]?.type, 'block-start')
    assert.equal(chunks[1]?.type, 'text-delta')
    assert.equal(chunks.some(chunk => chunk.type === 'usage'), true)
    assert.equal(chunks.at(-1)?.type, 'finish')
  })
})

describe('agy request body EOTP', () => {
  it('extracts a Cloud Code project id', () => {
    assert.equal(extractAgyProjectId({ cloudaicompanionProject: { id: 'proj-1' } }), 'proj-1')
    assert.equal(extractAgyProjectId({ cloudaicompanionProject: 'proj-str' }), 'proj-str')
    assert.equal(extractAgyProjectId({}), '')
  })

  it('skips 400 API key is invalid as an unusable host', async () => {
    const bad = new Response(JSON.stringify({ error: { message: 'API key is invalid' } }), { status: 400 })
    const other = new Response('nope', { status: 401 })
    assert.equal(await isAgyUnusableEndpoint(bad), true)
    assert.equal(await isAgyUnusableEndpoint(other), false)
  })

  it('maps hostnames to subscription providers for per-provider proxy', () => {
    assert.equal(providerForHostname('daily-cloudcode-pa.googleapis.com'), 'agy')
    assert.equal(providerForHostname('copilot.tencent.com'), 'codebuddy')
    assert.equal(providerForHostname('cloud.zed.dev'), 'zed')
    assert.equal(providerForHostname('example.com'), undefined)
  })

  it('aggregates catalog quotaInfo by family', () => {
    const usage = parseAgyQuotaUsage({
      models: {
        'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.4, resetTime: '2099-01-01T00:00:00Z' } },
        'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.6 } },
      },
    })
    assert.equal(usage.supported, true)
    assert.equal(usage.windows?.some(window => window.scope === 'Gemini'), true)
    assert.equal(usage.windows?.some(window => window.scope === 'Claude'), true)
  })

  it('omits project when projectId is absent', () => {
    const body = toAgyRequestBody(
      { model: 'gemini-3.7-flash-tiered', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as Parameters<typeof toAgyRequestBody>[0],
      {},
    )
    assert.equal('project' in body, false)
  })

  it('parses an SSE data line with the response envelope', () => {
    const payload = parseSseDataLine('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}')
    assert.equal(payload?.candidates?.[0]?.content?.parts?.[0]?.text, 'ok')
  })
})

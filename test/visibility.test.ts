import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountKeyOf } from '../src/auth/store.js'
import type { AgySession, CodeBuddySession, CommandCodeSession, ZedSession } from '../src/auth/store.js'
import { filterVisible, setModelVisible, hiddenIds } from '../src/model-visibility.js'
import { sessionFromZedPaste, parseZedModels, ndjsonToSse, parseZedUsage, buildZedProviderRequest, stripSandboxArguments, sandboxPolicyFacts, shouldStripSandboxArguments } from '../src/providers/zed.js'
import { parseMeterUsage } from '../src/providers/codebuddy-lib/usage.js'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { messagesToCommandCode, messagesToOpenAI, parseCommandCodeAuthFile, parseCommandCodeCredits, parseCommandCodeOpenAIStream, parseCommandCodeStream, sessionFromCommandCodePaste, commandCodePublishedEfforts, isUnpublishedModel } from '../src/providers/commandcode.js'
import { COMMANDCODE_MODELS_VERSION, COMMANDCODE_PUBLISHED_MODELS } from '../src/providers/commandcode-models.js'
import { extractAgyProjectId } from '../src/providers/agy.js'
import { catalogModelList, parseAgyQuotaUsage } from '../src/providers/agy/models.js'
import { AGY_PUBLIC_MODELS, isLevelThinkingModel } from '../src/providers/agy/catalog.js'
import { isAgyUnusableEndpoint } from '../src/providers/agy/constants.js'
import { countryCodeToEmoji, providerForHostname } from '../src/http.js'
import { toAgyRequestBody } from '../src/providers/agy/translate.js'
import { parseSseDataLine } from '../src/providers/agy/parse.js'
import { checkinCodeBuddy, codebuddyReasoning, generateMorningTargetTime, localDateString } from '../src/providers/codebuddy.js'

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

describe('model visibility management', () => {
  it('defaults new models to hidden and tracks unread status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vis-'))
    TEMP_DIRS.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      // First discovery initializes known list without tagging them all as new
      const initial = await filterVisible('codex', [
        { id: 'gpt-original' },
      ])
      assert.deepEqual(initial.map(m => m.id), ['gpt-original'])

      // Newly discovered model defaults to hidden and unread
      const withNew = await filterVisible('codex', [
        { id: 'gpt-original' },
        { id: 'gpt-brand-new' },
      ])
      // gpt-brand-new is hidden by default:
      assert.deepEqual(withNew.map(m => m.id), ['gpt-original'])

      const hidden = await hiddenIds('codex')
      assert.equal(hidden.has('gpt-brand-new'), true)

      // User explicitly enables the new model:
      await setModelVisible('codex', 'gpt-brand-new', true)
      const listedAfterEnable = await filterVisible('codex', [
        { id: 'gpt-original' },
        { id: 'gpt-brand-new' },
      ])
      assert.deepEqual(listedAfterEnable.map(m => m.id), ['gpt-original', 'gpt-brand-new'])

      // Trailing corruption in the file must self-heal and never throw
      const { visibilityFilePath } = await import('../src/model-visibility.js')
      const p = visibilityFilePath()
      const corrupt = (await readFile(p, 'utf8')) + '\n  "unread": {}\n}\n'
      await writeFile(p, corrupt, 'utf8')

      // Reading or filtering now must succeed without syntax error:
      const recovered = await filterVisible('codex', [{ id: 'gpt-original' }])
      assert.deepEqual(recovered.map(m => m.id), ['gpt-original'])
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

  it('parses the live /models payload with thinking effort levels and max-mode context', () => {
    const models = parseZedModels({
      models: [
        {
          id: 'claude-sonnet-5',
          display_name: 'Claude Sonnet 5',
          provider: 'anthropic',
          supports_images: true,
          supports_thinking: true,
          max_token_count: 1000000,
          max_token_count_in_max_mode: 2000000,
          max_output_tokens: 128000,
          supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high', is_default: true },
            { name: 'Extra High', value: 'xhigh' },
            { name: 'Max', value: 'max' },
          ],
        },
        { id: 'gpt-5-nano', name: 'GPT-5 nano', provider: 'open_ai' },
      ],
    })
    assert.equal(models.length, 2)
    assert.equal(models[0].provider, 'anthropic')
    assert.equal(models[0].supportsImages, true)
    assert.equal(models[0].supportsThinking, true)
    assert.equal(models[0].contextWindow, 1000000)
    assert.equal(models[0].contextWindowInMaxMode, 2000000)
    assert.equal(models[0].maxTokens, 128000)
    assert.equal(models[0].reasoning?.efforts.length, 5)
    assert.equal(models[0].reasoning?.defaultEffort, 'high')
    assert.equal(models[0].reasoning?.efforts[0]?.id, 'low')
    assert.equal(models[1].name, 'GPT-5 nano')
  })

  it('builds OpenAI Responses provider_request with top-level tool name and strips speculative sandbox_permissions in danger-full-access', () => {
    const { provider, body } = buildZedProviderRequest(
      {
        model: 'gpt-5.6-luna',
        system: 'You are an AI agent. Current DSH file policy: danger-full-access. Approval prompts are disabled in this session.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{
          name: 'pwsh',
          description: 'run powershell',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              sandbox_permissions: { type: 'string', enum: ['danger-full-access'] },
              justification: { type: 'string' },
            },
            required: ['command', 'sandbox_permissions'],
          },
        }],
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
    assert.equal((body.tools as { name?: string }[])[0]?.name, 'pwsh')
    const toolParams = (body.tools as { parameters?: { properties?: Record<string, unknown>; required?: string[] } }[])[0]?.parameters
    assert.equal('sandbox_permissions' in (toolParams?.properties ?? {}), false)
    assert.equal('justification' in (toolParams?.properties ?? {}), false)
    assert.equal(toolParams?.required?.includes('sandbox_permissions'), false)
  })

  it('reads the sandbox policy from the plugin snapshot message, not options.system', () => {
    // Real shape captured from a failing gpt-5.6-luna session: DSH injects the
    // runtime policy as a separate plugin-authored message and options.system
    // contains NO policy text at all. A guard that string-matched
    // options.system alone therefore never fired — the original bug.
    const options = {
      model: 'gpt-5.6-luna',
      system: 'You are an AI agent powered by DeepSeek Harness.',
      messages: [{
        role: 'user',
        id: 'm-1',
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
        content: [{
          type: 'text',
          text: 'Current runtime context.\n\nCurrent DSH file policy: danger-full-access. '
            + 'Any available operation enforced by the DSH file sandbox may modify files under the session workspace.\n\n'
            + 'Approval policy: never. Operations that require approval may ask through the configured answerers.',
        }],
      }],
    } as unknown as Parameters<typeof sandboxPolicyFacts>[0]

    const facts = sandboxPolicyFacts(options)
    assert.equal(facts.mode, 'danger-full-access')
    assert.equal(facts.approvalDisabled, true)
    assert.equal(shouldStripSandboxArguments(facts), true)
  })

  it('still strips when the session is only workspace-write but approval is disabled', () => {
    // The observed failing case: the model filled sandbox_permissions with
    // "workspace-write" while the call already ran in workspace-write, so
    // dsh-sandbox rejected it as non-widening 52 times in one session.
    const options = {
      model: 'gpt-5.6-luna',
      system: '',
      messages: [{
        role: 'user',
        id: 'm-2',
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
        content: [{
          type: 'text',
          text: 'Current DSH file policy: workspace-write. Approval prompts are disabled in this session.',
        }],
      }],
    } as unknown as Parameters<typeof sandboxPolicyFacts>[0]

    const facts = sandboxPolicyFacts(options)
    assert.equal(facts.mode, 'workspace-write')
    assert.equal(facts.approvalDisabled, true)
    assert.equal(shouldStripSandboxArguments(facts), true, 'approval disabled forbids escalation outright')
  })

  it('keeps escalation arguments when approval is available and access is confined', () => {
    // A legitimate upgrade path must survive: read-only + approvals on means
    // the model may still ask to escalate, so the argument stays.
    const options = {
      model: 'gpt-5.6-luna',
      system: 'plain system',
      messages: [{
        role: 'user',
        id: 'm-3',
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
        content: [{ type: 'text', text: 'Current DSH file policy: read-only. Approval policy: ask.' }],
      }],
    } as unknown as Parameters<typeof sandboxPolicyFacts>[0]

    const facts = sandboxPolicyFacts(options)
    assert.equal(facts.mode, 'read-only')
    assert.equal(facts.approvalDisabled, false)
    assert.equal(shouldStripSandboxArguments(facts), false)
  })

  it('stripSandboxArguments removes speculative escalation keys from tool-call JSON', () => {    // The exact shape an eager model (gpt-5.6-luna) emits under full access.
    const args = JSON.stringify({
      command: 'Get-ChildItem',
      sandbox_permissions: 'danger-full-access',
      justification: 'listing files needs full access',
    })
    const clean = stripSandboxArguments(args)
    assert.deepEqual(JSON.parse(clean), { command: 'Get-ChildItem' })

    // Nothing to strip → the very same string is returned (no needless rewrite).
    const plain = JSON.stringify({ command: 'Get-ChildItem' })
    assert.equal(stripSandboxArguments(plain), plain)
    // Unparseable fragments are left alone for the harness to report.
    assert.equal(stripSandboxArguments('{"command":'), '{"command":')
  })

  it('sanitizes the accumulated deltas the harness actually assembles', async () => {
    // Split the wire JSON mid-key so the fragments are individually
    // unparseable — exactly how a streaming tool call arrives.
    const full = JSON.stringify({
      command: 'ls',
      sandbox_permissions: 'danger-full-access',
      justification: 'why',
    })
    const cut = full.indexOf('sandbox_permissions') + 7
    const fragments = [full.slice(0, cut), full.slice(cut)]
    const accumulated = fragments.join('')
    // Precondition: the concatenated stream really carries the escalation key,
    // which is what dsh-tool-bash rejects under full access.
    assert.equal(accumulated.includes('sandbox_permissions'), true)
    assert.equal(fragments[0]?.length > 0 && fragments[1]?.length > 0, true, 'two non-empty fragments')
    const sanitized = stripSandboxArguments(accumulated)
    assert.equal(sanitized.includes('sandbox_permissions'), false)
    assert.equal(sanitized.includes('justification'), false)
    assert.deepEqual(JSON.parse(sanitized), { command: 'ls' })
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
    assert.equal(usage.windows?.length, 1)
    assert.equal(usage.windows?.[0]?.scope, 'Hosted models')
    assert.equal(Math.round(usage.windows?.[0]?.usedPercent ?? -1), 17)
  })

  it('maps /client/users/me zed_student bundled $10 credit when no spent_cents reported', () => {
    const usage = parseZedUsage({
      plan: {
        plan_v3: 'zed_student',
        subscription_period: { started_at: '2026-09-03T02:36:56Z', ended_at: '2026-10-03T00:00:00Z' },
        usage: {
          model_requests: { used: 0, limit: { limited: 0 } },
          edit_predictions: { used: 0, limit: 'unlimited' },
        },
      },
      default_organization_id: 'org_01m1jhg6vxysd7sbeyf7z8zmyv',
      organizations: [{ id: 'org_01m1jhg6vxysd7sbeyf7z8zmyv', name: 'Student Org' }],
      plans_by_organization: { org_01m1jhg6vxysd7sbeyf7z8zmyv: 'zed_student' },
    })
    assert.equal(usage.supported, true)
    assert.equal(usage.plan, 'Zed Student')
    assert.equal(usage.windows?.length, 1)
    assert.equal(usage.windows?.[0]?.scope, 'Hosted models')
    assert.equal(usage.windows?.[0]?.used, 0)
    assert.equal(usage.windows?.[0]?.limit, 10)
    assert.equal(usage.windows?.[0]?.remaining, 10)
    assert.equal(usage.windows?.[0]?.usedPercent, 0)
  })

  it('maps dashboard /frontend/billing/usage token_spend ($0.21 used of $10)', () => {
    const usage = parseZedUsage({
      plan: { plan_v3: 'zed_student' },
    }, {
      plan: 'token_based_zed_student',
      current_usage: {
        token_spend_in_cents: 21,
        token_spend: {
          spend_in_cents: 21,
          limit_in_cents: 1000,
        },
      },
    })
    assert.equal(usage.supported, true)
    assert.equal(usage.plan, 'Zed Student')
    assert.equal(usage.windows?.length, 1)
    assert.equal(usage.windows?.[0]?.scope, 'Hosted models')
    assert.equal(usage.windows?.[0]?.used, 0.21)
    assert.equal(usage.windows?.[0]?.limit, 10)
    assert.equal(usage.windows?.[0]?.remaining, 9.79)
    assert.equal(Math.round(usage.windows?.[0]?.usedPercent ?? -1), 2)
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

  it('generates a morning target time strictly before 8:00 AM', () => {
    const d = new Date(2026, 8, 20, 10, 0, 0)
    for (let i = 0; i < 50; i++) {
      const target = new Date(generateMorningTargetTime(d))
      assert.equal(target.getFullYear(), 2026)
      assert.equal(target.getMonth(), 8)
      assert.equal(target.getDate(), 20)
      assert.equal(target.getHours() >= 6 && target.getHours() < 8, true, 'target hour must be 6 or 7 (before 8am)')
      assert.equal(target.getHours() === 7 ? target.getMinutes() <= 55 : true, true)
    }
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

describe('commandcode messagesToCommandCode', () => {
  function msg(role: Message['role'], content: ContentBlock[], source: Message['source']): Message {
    return { id: MessageId('m-' + Math.random().toString(36).slice(2)), role, content, source }
  }

  it('round-trips paired tool-call and tool-result as structured wire parts', () => {
    const callId = ToolCallId('call_1')
    const history: Message[] = [
      msg('user', [{ type: 'text', text: 'list files' }], { kind: 'user' }),
      msg('assistant', [
        { type: 'text', text: 'checking' },
        { type: 'reasoning', text: 'private thought' },
        { type: 'tool-call', id: callId, name: 'pwsh', arguments: '{"command":"ls"}' },
      ], { kind: 'model', provider: 'commandcode', model: 'x' }),
      msg('user', [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'a.txt\nb.txt' }],
      }], { kind: 'tool', callId }),
    ]
    const wire = messagesToCommandCode(history)
    assert.equal(wire.length, 3)
    assert.deepEqual(wire[0], { role: 'user', content: [{ type: 'text', text: 'list files' }] })
    const assistant = wire[1] as { role: string; content: Array<Record<string, unknown>> }
    assert.equal(assistant.role, 'assistant')
    // Reasoning IS replayed on the CLI transport, in content order, as the
    // official CLI's own `toWireMessages` does. Dropping it is what made every
    // DeepSeek thinking-mode tool-loop turn fail with "The `reasoning_content`
    // in the thinking mode must be passed back to the API" (upstream issue #34).
    assert.equal(assistant.content.length, 3)
    assert.deepEqual(assistant.content[0], { type: 'text', text: 'checking' })
    assert.deepEqual(assistant.content[1], { type: 'reasoning', text: 'private thought' })
    assert.deepEqual(assistant.content[2], {
      type: 'tool-call',
      toolCallId: callId,
      toolName: 'pwsh',
      input: { command: 'ls' },
    })
    assert.deepEqual(wire[2], {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        toolName: 'pwsh',
        output: { type: 'text', value: 'a.txt\nb.txt' },
      }],
    })
  })

  it('drops unpaired tool calls so the wire conversation never dangles', () => {
    const history: Message[] = [
      msg('assistant', [
        { type: 'tool-call', id: ToolCallId('orphan'), name: 'pwsh', arguments: '{}' },
      ], { kind: 'model', provider: 'commandcode', model: 'x' }),
    ]
    assert.deepEqual(messagesToCommandCode(history), [])
  })
})

describe('commandcode OpenAI transport', () => {
  function msg(role: Message['role'], content: ContentBlock[], source: Message['source']): Message {
    return { id: MessageId('m-' + Math.random().toString(36).slice(2)), role, content, source }
  }

  it('replays reasoning_content on assistant turns (DeepSeek thinking contract)', () => {
    // Without this the turn fails with:
    //   The `reasoning_content` in the thinking mode must be passed back to the API.
    const callId = ToolCallId('call_think')
    const history: Message[] = [
      msg('user', [{ type: 'text', text: 'list files' }], { kind: 'user' }),
      msg('assistant', [
        { type: 'reasoning', text: 'I should call pwsh to list files.' },
        { type: 'tool-call', id: callId, name: 'pwsh', arguments: '{"command":"ls"}' },
      ], { kind: 'model', provider: 'commandcode', model: 'deepseek/deepseek-v4-pro' }),
      msg('user', [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'a.txt' }],
      }], { kind: 'tool', callId }),
    ]

    const wire = messagesToOpenAI(history) as Array<Record<string, unknown>>
    assert.equal(wire.length, 3)
    assert.deepEqual(wire[0], { role: 'user', content: 'list files' })
    const assistant = wire[1]!
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.reasoning_content, 'I should call pwsh to list files.')
    assert.deepEqual(assistant.tool_calls, [{
      id: callId,
      type: 'function',
      function: { name: 'pwsh', arguments: '{"command":"ls"}' },
    }])
    assert.deepEqual(wire[2], { role: 'tool', tool_call_id: callId, content: 'a.txt' })
  })

  it('parses reasoning + content deltas and fragmented tool calls', async () => {
    const payload = [
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"pwsh","arguments":"{\\"a\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
      '',
    ].join('\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const chunks: any[] = []
    for await (const chunk of parseCommandCodeOpenAIStream(stream)) chunks.push(chunk)

    const reasoning = chunks.find(c => c.type === 'reasoning-delta')
    assert.equal(reasoning?.text, 'think ')
    const text = chunks.find(c => c.type === 'text-delta')
    assert.equal(text?.text, 'hi')
    const callEnd = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')
    assert.equal(callEnd?.block?.name, 'pwsh')
    assert.equal(callEnd?.block?.arguments, '{"a":1}')
    assert.equal(chunks.some(c => c.type === 'usage'), true)
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.deepEqual(chunks.at(-1)?.reason, { kind: 'tool-calls' })
  })
})

describe('commandcode reasoning efforts', () => {
  it('covers the models the vendor publishes with selectable levels', () => {
    assert.deepEqual(commandCodePublishedEfforts('z-ai/glm-5.3-flash'), ['low', 'high', 'max'])
    assert.deepEqual(commandCodePublishedEfforts('deepseek/deepseek-v4.1-flash'), ['low', 'high', 'max'])
    assert.deepEqual(commandCodePublishedEfforts('google/gemini-3.8-flash'), ['low', 'medium', 'high'])
    assert.deepEqual(commandCodePublishedEfforts('claude-sonnet-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('gives a newly shipped model its levels without anyone editing a table', () => {
    // THE REGRESSION. `gpt-6-luna` shipped with five selectable levels, and the
    // hand-maintained map this replaced had no entry for it — so the model had no
    // thinking-level selector at all. Nothing here was hand-edited: the table is
    // generated from the vendor's own published model list.
    assert.deepEqual(commandCodePublishedEfforts('gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(commandCodePublishedEfforts('gpt-6-sol'), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(commandCodePublishedEfforts('gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max'])
    // And it is a published model, not an unpublished gap.
    assert.equal(isUnpublishedModel('gpt-6-luna'), false)
  })

  it('omits levels for a model the vendor publishes WITHOUT them', () => {
    // Tencent Hy3 / GLM-5 / GLM-5.1 / GLM-5.2-Fast / MiMo V2.5 think at a depth
    // the CLI drives and publish `—` for Efforts. That is a FACT recorded in the
    // table, which is what distinguishes it from an unpublished model below.
    //
    // Note `tencent/hy3-paid`, not `tencent/hy3`: the hand-maintained list this
    // replaced named two ids the vendor does not publish at all, so it was wrong
    // in both directions.
    for (const id of ['tencent/hy3-paid', 'zai-org/GLM-5', 'zai-org/GLM-5.1', 'zai-org/GLM-5.2-Fast', 'xiaomi/mimo-v2.5']) {
      assert.deepEqual(commandCodePublishedEfforts(id), [], id)
      // Published, so NOT a stale-snapshot gap.
      assert.equal(isUnpublishedModel(id), false, id)
    }
    // And the ids the old list invented are genuinely not in the roster.
    assert.equal(isUnpublishedModel('tencent/hy3'), true)
    assert.equal(isUnpublishedModel('meituan/LongCat-2.0:free'), true)
  })

  it('distinguishes an unpublished model from one published without levels', () => {
    // This is the distinction the old regex heuristic tried to guess at, and it
    // is now exact: absent from the table means nobody has re-run the sync.
    assert.equal(isUnpublishedModel('deepseek/deepseek-v4.2-flash'), true)
    assert.equal(isUnpublishedModel('claude-opus-6'), true)
    // A model whose id an old family pattern would NOT have matched is still
    // handled, because nothing matches on the id any more.
    assert.equal(isUnpublishedModel('some-new-vendor/brand-new-model'), true)
    assert.equal(isUnpublishedModel('gpt-6-luna'), false)
  })

  it('carries the full published roster, so a broken parse cannot pass silently', () => {
    const ids = Object.keys(COMMANDCODE_PUBLISHED_MODELS)
    // command-code@1.64.0 publishes 80 models, 51 of them with selectable
    // levels. The floor guard is here so a parse that silently drops rows fails
    // the suite instead of quietly shrinking the roster.
    assert.ok(ids.length >= 80, `only ${String(ids.length)} models in the table`)
    const withEfforts = ids.filter(id => commandCodePublishedEfforts(id).length > 0)
    assert.ok(withEfforts.length >= 51, `only ${String(withEfforts.length)} models with levels`)
    for (const id of ids) {
      const entry = COMMANDCODE_PUBLISHED_MODELS[id]!
      assert.ok(entry.name.length > 0, `${id} has no published name`)
      assert.ok(Array.isArray(entry.efforts), `${id} has no efforts array`)
      // Levels are the vendor's own spellings, deduplicated.
      assert.equal(new Set(entry.efforts).size, entry.efforts.length, `${id} repeats a level`)
    }
    // The version the table was generated from is recorded, so a stale snapshot
    // is diagnosable from the log line rather than needing a re-derivation.
    assert.match(COMMANDCODE_MODELS_VERSION, /^\d+\.\d+\.\d+$/)
  })
})

describe('agy level-thinking map', () => {
  it('only offers a thinking-level picker to models the catalog marks as level-thinking', () => {
    // The catalog is authoritative for every model it lists. A row without the
    // `thinking: 'level'` marker must not get a picker, even when its id looks
    // like a thinking model: sending `thinkingLevel` to a model that does not
    // accept it is a 400. `gemini-3.1-flash-lite` regressed exactly this way.
    assert.equal(isLevelThinkingModel('gemini-3.1-flash-lite'), false)
    // Gemini 2.x takes a fixed thinking budget, not the level axis.
    assert.equal(isLevelThinkingModel('gemini-2.5-pro'), false)
    assert.equal(isLevelThinkingModel('gemini-2.5-flash'), false)
    // The marked rows, and the aliases that resolve onto them, keep it.
    for (const id of [
      'gemini-3.8-flash-tiered',
      'gemini-3.7-flash-tiered',
      'gemini-3.6-flash-tiered',
      'gemini-3.5-flash-low',
      'gemini-pro-agent',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
      // Aliases: they must land on a marked row.
      'gemini-3.6-flash-high',
      'gemini-3.1-pro',
      'gemini-3.5-flash',
    ]) {
      assert.equal(isLevelThinkingModel(id), true, `${id} should expose a level picker`)
    }
    // A model the pin does not know yet still falls back to the id heuristic,
    // so a model shipped after the catalog was captured is not left behind.
    assert.equal(isLevelThinkingModel('gemini-3.9-flash-tiered'), true)
  })

  it('every catalog row declares a window and an output cap', () => {
    for (const model of AGY_PUBLIC_MODELS) {
      assert.ok(model.contextLength > 0, `${model.id} needs a positive context window`)
      assert.ok(model.maxOutputTokens > 0, `${model.id} needs a positive output cap`)
    }
    // The adapter serves the resolved shape, so its rows carry the window too.
    for (const model of catalogModelList()) {
      assert.equal(typeof model.id, 'string')
      assert.ok(model.inputModalities !== undefined && model.inputModalities.length > 0)
    }
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

  it('converts ISO 2-letter country codes to flag emoji', () => {
    assert.equal(countryCodeToEmoji('US'), '🇺🇸')
    assert.equal(countryCodeToEmoji('CN'), '🇨🇳')
    assert.equal(countryCodeToEmoji('TW'), '🇨🇳', 'Taiwan must use the Five-star Red Flag')
    assert.equal(countryCodeToEmoji('HK'), '🇭🇰')
    assert.equal(countryCodeToEmoji('JP'), '🇯🇵')
    assert.equal(countryCodeToEmoji(''), '')
    assert.equal(countryCodeToEmoji('USA'), '')
  })
})

describe('codebuddy thinking levels', () => {
  it('offers only the levels the catalog NAMED', () => {
    const reasoning = codebuddyReasoning({ supportedEfforts: ['low', 'medium', 'high'], effort: 'high' })
    assert.deepEqual(reasoning?.efforts.map(effort => String(effort.id)), ['low', 'medium', 'high'])
    // The declared default is honoured when it is one of the named levels.
    assert.equal(String(reasoning?.defaultEffort), 'high')
  })

  it('falls back to the first named level when the declared default is not one of them', () => {
    const reasoning = codebuddyReasoning({ supportedEfforts: ['medium', 'high'], effort: 'low' })
    assert.equal(String(reasoning?.defaultEffort), 'medium')
  })

  it('gives NO picker when the catalog never named the levels', () => {
    // THE FIX. This used to answer a hardcoded ['low','medium','high'] whenever a
    // model merely declared that it reasons — guessing at a vocabulary the
    // provider never disclosed, where a level the gateway does not accept is a
    // rejected turn. Sending no reasoning_effort is always valid and leaves the
    // provider's own default in force.
    assert.equal(codebuddyReasoning(undefined), undefined)
    assert.equal(codebuddyReasoning({}), undefined)
    assert.equal(codebuddyReasoning({ supportedEfforts: [] }), undefined)
  })
})
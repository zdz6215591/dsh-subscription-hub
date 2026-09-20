/**
 * Subscription OAuth login page, browser half. Registers the Subscriptions
 * settings section; every login state fact arrives through the node half's
 * `/subscriptions-auth` RPC channel — this plugin holds no credential state of its
 * own. Section copy rides the client locale service: one 'settings.subscriptions'
 * namespace with zh/en dictionaries, rebound per read so the nav label and
 * page text follow the active locale.
 */
// Type-only: pulls the `ctx.slots` Context merge (dsh-client-runtime owned it
// on rc.2; ui-renderer's augmentation carries it on the 0.1.2-alpha line).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ui-conversation's SlotMap merge (the 'conversation.input.right' entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slash-command registry contract (the /fast contribution).
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
// `.js` extension: this package's tsconfig lacks the reference repo's
// allowImportingTsExtensions/rewriteRelativeImportExtensions pair; under
// nodenext the .js specifier resolves to the .tsx source (see README note).
import { SubscriptionsSection } from './SubscriptionsSection.js'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { ImageGenerateToolview, createImageLoader } from './ImageGenerateToolview.js'
import type { ImageGenerateToolviewInjected } from './ImageGenerateToolview.js'
import { VideoGenerateToolview, createVideoLoader } from './VideoGenerateToolview.js'
import type { VideoGenerateToolviewInjected } from './VideoGenerateToolview.js'
import { SpeedSelect, createSpeedLoader, createSpeedSetter } from './SpeedSelect.js'
import type { ModelDirectoriesLike, SpeedSelectInjected } from './SpeedSelect.js'
import { SubscriptionUsageBadge, createCurrentModelReader } from './SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from './SubscriptionUsageBadge.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
export type { ImageGenerateToolviewInjected, ImageGenerateToolviewProps } from './ImageGenerateToolview.js'
export type { VideoGenerateToolviewInjected, VideoGenerateToolviewProps } from './VideoGenerateToolview.js'
export type { SpeedSelectInjected, SpeedSelectProps, SpeedState, SpeedTier } from './SpeedSelect.js'
export type { SubscriptionUsageBadgeInjected, SubscriptionUsageBadgeProps } from './SubscriptionUsageBadge.js'
export type { SubscriptionsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Subscriptions settings page copy. */
    'settings.subscriptions': SubscriptionsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.subscriptions'

/**
 * Required services (cordis fiber inject): `slots` carries the registration
 * seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
 * dictionaries.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the Subscriptions section once the `settings.section` declaration
 * is on the ledger (the shell's apply order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-subscriptions: copy dictionaries')
  // Settings-shell nudge: the panel (nav title + header row + section body)
  // sits flush against the panel's top edge; push it down a little to leave
  // breathing room. Scoped by the settings panel's own dialog role + nav child
  // so other aria-modal dialogs (e.g. the attachment lightbox) are untouched.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-plugin-subscriptions')
    style.textContent = 'div[role="dialog"][aria-modal="true"]:has(> nav) { padding-top: 14px; }'
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-plugin-subscriptions: settings panel breathing room')

  ctx.effect(() => {
    const update = () => {
      const dialog = document.querySelector('div[role="dialog"][aria-modal="true"]')
      if (!dialog) return
      const nav = dialog.querySelector('nav')
      if (!nav) return
      const buttons = Array.from(nav.querySelectorAll('button'))
      for (const btn of buttons) {
        const text = btn.textContent?.trim()
        if (!text) continue
        const svg = btn.querySelector('svg')
        if (!svg || svg.getAttribute('data-icon-fixed')) continue

        if (text === '订阅' || text === 'Subscriptions') {
          svg.setAttribute('data-icon-fixed', 'true')
          svg.setAttribute('viewBox', '0 0 16 16')
          svg.setAttribute('fill', 'none')
          svg.innerHTML = '<path d="M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z" stroke="currentColor" stroke-width="1.3"/><path d="M12.2 1.5Q12.5 3.7 14.7 4Q12.5 4.3 12.2 6.5Q11.9 4.3 9.7 4Q11.9 3.7 12.2 1.5Z" stroke="currentColor" stroke-width="1.1"/>'
        } else if (text === '插件市场' || text === 'Market' || text === 'Marketplace') {
          svg.setAttribute('data-icon-fixed', 'true')
          svg.setAttribute('viewBox', '0 0 24 24')
          svg.setAttribute('fill', 'none')
          svg.innerHTML = '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 7h20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
        }
      }
    }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    update()
    return () => observer.disconnect()
  }, 'dsh-plugin-subscriptions: nav icons')

  // The shell's Context merge types `connection` as the host handle; in the
  // browser shell the same key holds the full client ConnectionHandle.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as SubscriptionsSectionInjected['t']
  const injected = (): SubscriptionsSectionInjected => ({ rpc: connection.rpc, t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subscriptions',
    order: 11,
    // A thunk re-evaluated per read, so the nav label follows the active locale.
    label: () => t('nav'),
    inject: injected,
  }, SubscriptionsSection))

  // The image_generate keyed toolview owns how image calls render inline; its
  // gallery bytes ride the same channel through the injected loader. The
  // framework synthesizes the toolview's own `t` seat from `locale: NS`.
  const toolviewInjected = (): ImageGenerateToolviewInjected => ({ load: createImageLoader(connection.rpc) })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'image_generate',
    locale: NS,
    inject: toolviewInjected,
  }, ImageGenerateToolview))

  // The video_generate keyed toolview plays the saved MP4 inline; its bytes
  // ride the same channel's `video` endpoint through the injected loader.
  const videoToolviewInjected = (): VideoGenerateToolviewInjected => ({ loadVideo: createVideoLoader(connection.rpc) })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'video_generate',
    locale: NS,
    inject: videoToolviewInjected,
  }, VideoGenerateToolview))

  // The composer Speed toggle (codex fast tier) sits in the right tool row,
  // just left of the model selector; the framework synthesizes its `t` seat
  // from `locale: NS`, and the inject face binds each session's RPC calls.
  // The current-model read rides ui-model-selection's `modelDirectories`
  // service, resolved lazily so registration order never matters.
  const models = (): ModelDirectoriesLike | undefined =>
    ctx.get('modelDirectories') as ModelDirectoriesLike | undefined
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'codex-speed',
    order: 0,
    locale: NS,
    inject: (sessionId: string): SpeedSelectInjected => ({
      loadSpeed: createSpeedLoader(connection, models, sessionId),
      setSpeed: createSpeedSetter(connection, sessionId),
    }),
  }, SpeedSelect))

  // The subscription usage pill: a compact readout of the CURRENT model's
  // provider quota (CodeBuddy reports credits, everyone else a percentage).
  // The current-model read shares the Speed toggle's `modelDirectories` path.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'subscription-usage',
    order: 10,
    locale: NS,
    inject: (sessionId: string): SubscriptionUsageBadgeInjected => ({
      rpc: connection.rpc,
      currentModel: createCurrentModelReader(models, sessionId),
    }),
  }, SubscriptionUsageBadge))

  // The /fast slash command offers the same Standard/Fast choice as a popup.
  // `available` is synchronous and sees only the session id, so the command
  // stays listed everywhere; `options` throws the friendly gate when the
  // session's current model is not a fast-capable codex model (the same
  // in-popup error posture the /model contribution uses for its guards).
  ctx.inject(['commandUi'], (scope: ClientContext) => {
    const command = scope.get('commandUi') as CommandUiContract
    scope.effect(() => command.register({
      name: 'fast',
      // dsh 0.1.5-alpha made `description` a locale resolver evaluated per
      // candidate pass (commit 5d9603b76, "feat(web): localize slash command
      // descriptions"); earlier lines read the value as a plain string. The
      // bare string threw `contribution.description is not a function` inside
      // the registry's candidate pass on 0.1.5, aborting the whole `/` source
      // and hiding every host command — /plan, /model, /goal, ... — not just
      // /fast. Older lines render a function child as empty copy, no crash.
      description: (() => t('commandFast')) as unknown as string,
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async (session) => {
          const state = await createSpeedLoader(connection, models, session.sessionId)()
          if (!state.visible) throw new Error(t('commandFastUnavailable'))
          return ([
            { id: 'standard', label: t('speedStandard'), detail: t('speedStandardDescription') },
            { id: 'fast', label: t('speedFast'), detail: t('speedFastDescription') },
          ] as const).map(option => ({ ...option, active: option.id === state.tier }))
        },
        onSelect: async (option, session) => {
          await createSpeedSetter(connection, session.sessionId)(option.id as 'standard' | 'fast')
        },
      },
    }), 'dsh-plugin-subscriptions: /fast contribution')
  })
}

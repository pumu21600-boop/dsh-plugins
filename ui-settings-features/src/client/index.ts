/**
 * Feature configuration settings plugin, browser half. Registers the
 * 功能配置 (Features) settings page whose three modality cards configure the
 * `media-understanding` namespace: per-modality dedicated and backup model
 * routes, written through the settings scope and refreshed from pushed
 * invalidations.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { FeaturesSection } from './FeaturesSection.tsx'
import type { FeaturesSectionInjected } from './FeaturesSection.tsx'
import { FeaturesSettingsStore, decodeMediaUnderstanding } from './store.ts'
import { en, zh, type FeaturesKey } from './locales.ts'

export type { FeaturesSectionInjected, FeaturesSectionProps } from './FeaturesSection.tsx'
export type { FeaturesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Features page copy. */
    'settings.features': FeaturesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.features'

/** Settings namespace the page reads and writes. */
const MEDIA_UNDERSTANDING_NAMESPACE = 'media-understanding'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Refetch the page snapshot only after its first load: an unopened Features
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: FeaturesSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Register the Features dictionaries and the `settings.section` entry, once
 * the slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-features: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const scope = ctx.settingsScope.bind({
    namespace: MEDIA_UNDERSTANDING_NAMESPACE,
    decode: decodeMediaUnderstanding,
  })
  const controller = new FeaturesSettingsStore(connection.api, scope)
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-features: store scope')

  // The model catalog must converge like every other selector surface: a
  // provider's modality declarations live in settings, so an opened page keeps
  // offering the models its last catalog snapshot advertised until one of the
  // pushed invalidations makes it refetch. Without these subscriptions a
  // newly declared video-capable model never appears in the video card.
  ctx.effect(() => {
    const refresh = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-features: pushed invalidations')

  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as FeaturesSectionInjected['t']
  const injected = (): FeaturesSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'features',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, FeaturesSection))
}

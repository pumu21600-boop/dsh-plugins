/** Features section registration: slot declaration injection and the locale-following label thunk. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-features/client'
import { FeaturesSection } from '../src/client/FeaturesSection.tsx'

async function bench(isLoopback = true, settings?: object, services: object = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  new TestRemote(ctx)
  ctx.provide('connection', {
    api: settings === undefined ? services : { ...services, settings },
    isLoopback,
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-features apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('registers the features nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(FeaturesSection)
    expect(entry.options).toMatchObject({ id: 'features', order: 20 })
    expect(resolveSlotLabel(entry.options.label)).toBe('功能配置')
    const injected = (
      entry.inject as unknown as () => import('../src/client/FeaturesSection.tsx').FeaturesSectionInjected
    )()
    expect(injected.t('image.title')).toBe('图片理解')
    expect(typeof injected.controller.load).toBe('function')
    expect(injected.hooks.snapshot).toBe(injected.controller.store)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(FeaturesSection)
    expect(after.slots.entries('settings.section')).toHaveLength(1)
  })

  it('the label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Features')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('功能配置')
  })

  it('registers the zh/en dictionaries and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.features')('nav')).toBe('功能配置')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(() => b.locale.register('settings.features', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.features', 'en', {})).not.toThrow()
  })

  it('writes feature routes through the settings scope for a loopback browser', async () => {
    let stored: Record<string, unknown> = {}
    const settings = {
      describe: vi.fn(() => Promise.resolve({
        rpcId: 'apply-features' as never,
        result: {
          ok: true as const,
          value: {
            writable: true,
            hasDocument: false,
            namespaces: [{
              ns: 'media-understanding',
              schema: {},
              value: stored,
              applies: 'live' as const,
              secrets: [],
              revision: 0,
            }],
          },
        },
      })),
      mutate: vi.fn(() => Promise.resolve({
        rpcId: 'apply-features-mutate' as never,
        result: {
          ok: true as const,
          value: {
            ns: 'media-understanding',
            schema: {},
            value: stored,
            applies: 'live' as const,
            secrets: [],
            revision: 1,
          },
        },
      })),
    }
    const b = await bench(true, settings, { llm: { models: vi.fn() } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    const injected = (
      entry.inject as unknown as () => import('../src/client/FeaturesSection.tsx').FeaturesSectionInjected
    )()
    await injected.controller.load()
    stored = { image: { provider: 'deepseek-official', model: 'deepseek-vl2', backupProvider: '', backupModel: '' } }
    await injected.controller.setFeature('image', { provider: 'deepseek-official', model: 'deepseek-vl2' })
    expect(settings.mutate).toHaveBeenCalled()
  })

  it('refetches the model catalog on settings and adapter invalidations after first load', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'apply-features-models' as never,
      result: {
        ok: true as const,
        value: { groups: [], failures: [] },
      },
    }))
    const b = await bench(true, undefined, { llm: { models } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    const injected = (
      entry.inject as unknown as () => import('../src/client/FeaturesSection.tsx').FeaturesSectionInjected
    )()
    await injected.controller.load()
    expect(models).toHaveBeenCalledTimes(1)
    await b.ctx.remote.$dispatch('settings/document-updated', ['llm-pi-ai', 1])
    await b.ctx.remote.$dispatch('llm/adapters-updated', [])
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(3))
    expect(injected.controller.store.getSnapshot().status).toBe('ready')
  })
})

/** Feature configuration store: catalog load, scope derivation, and route writes. */
import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  FeaturesSettingsStore, decodeMediaUnderstanding,
  type FeaturesSettingsState, type MediaUnderstandingSettings,
} from '../src/client/store.ts'

/** A test scope whose snapshot is pushed by the test. */
function scope(
  snapshot: Partial<ReturnType<SettingsScope<MediaUnderstandingSettings>['getSnapshot']>> = {},
  set: (field: string, value: unknown) => Promise<void> = () => Promise.resolve(),
): SettingsScope<MediaUnderstandingSettings> {
  const current = {
    status: 'ready',
    value: {
      image: { provider: '', model: '', backupProvider: '', backupModel: '' },
      audio: { provider: '', model: '', backupProvider: '', backupModel: '' },
      video: { provider: '', model: '', backupProvider: '', backupModel: '' },
    },
    base: {},
    user: {},
    revision: 0,
    writable: true,
    mode: 'host',
    ...snapshot,
  } as ReturnType<SettingsScope<MediaUnderstandingSettings>['getSnapshot']>
  return {
    getSnapshot: () => current,
    subscribe: () => () => {},
    set: (field, value) => {
      ;(current as { value: MediaUnderstandingSettings }).value = {
        ...current.value as MediaUnderstandingSettings,
        [field]: value,
      } as MediaUnderstandingSettings
      return set(field, value)
    },
    unset: () => Promise.resolve(),
  } as SettingsScope<MediaUnderstandingSettings>
}

function catalog(groups: unknown[] = []) {
  return vi.fn(() => Promise.resolve({
    rpcId: 'llm-models' as never,
    result: { ok: true as const, value: { groups, failures: [] } },
  }))
}

/** Cast one llm face mock to the narrow page dependency. */
function api(models: unknown): Pick<import('@deepseek-ai/dsh-api-remotes/client').IApiClient, 'llm'> {
  return { llm: { models } } as unknown as Pick<import('@deepseek-ai/dsh-api-remotes/client').IApiClient, 'llm'>
}

describe('decodeMediaUnderstanding', () => {
  it('reads a full section and falls back to all-unset for malformed values', () => {
    expect(decodeMediaUnderstanding({
      image: { provider: 'p', model: 'm', backupProvider: 'bp', backupModel: 'bm' },
      audio: {},
      video: { provider: 'x' },
    })).toEqual({
      image: { provider: 'p', model: 'm', backupProvider: 'bp', backupModel: 'bm' },
      audio: { provider: '', model: '', backupProvider: '', backupModel: '' },
      video: { provider: 'x', model: '', backupProvider: '', backupModel: '' },
    })
    expect(decodeMediaUnderstanding(null)).toEqual({
      image: { provider: '', model: '', backupProvider: '', backupModel: '' },
      audio: { provider: '', model: '', backupProvider: '', backupModel: '' },
      video: { provider: '', model: '', backupProvider: '', backupModel: '' },
    })
    expect(decodeMediaUnderstanding(['not', 'an', 'object'])).toMatchObject({ image: { provider: '' } })
  })
})

describe('FeaturesSettingsStore', () => {
  it('joins the catalog and the scope into one snapshot', async () => {
    const models = catalog([{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-vl2', name: 'deepseek-vl2' }] }])
    const store = new FeaturesSettingsStore(api(models), scope())
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.groups).toHaveLength(1)
    expect(state.failures).toHaveLength(0)
    expect(state.writable).toBe(true)
    expect(state.features.image.provider).toBe('')
    store.dispose()
  })

  it('surfaces a catalog failure without losing the scope value', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'llm-models' as never,
      result: { ok: false as const, error: { code: 'internal', message: 'down', details: {} } },
    }))
    const store = new FeaturesSettingsStore(api(models), scope())
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toContain('down')
    store.dispose()
  })

  it('merges a feature write over the current section', async () => {
    const set = vi.fn((_field: string, _value: unknown) => Promise.resolve())
    const store = new FeaturesSettingsStore(
      api(catalog()),
      scope({}, set),
    )
    await store.load()
    await store.setFeature('image', { provider: 'p', model: 'm' })
    expect(set).toHaveBeenCalledWith('image', {
      provider: 'p', model: 'm', backupProvider: '', backupModel: '',
    })
    await store.setFeature('image', { backupModel: 'bm' })
    expect(set).toHaveBeenLastCalledWith('image', {
      provider: 'p', model: 'm', backupProvider: '', backupModel: 'bm',
    })
    store.dispose()
  })

  it('treats an unavailable scope as read-only with an all-unset section', async () => {
    const store = new FeaturesSettingsStore(
      api(catalog()),
      scope({ status: 'unavailable', writable: false }),
    )
    await store.load()
    const state: FeaturesSettingsState = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(false)
    expect(state.features.audio.model).toBe('')
    store.dispose()
  })
})

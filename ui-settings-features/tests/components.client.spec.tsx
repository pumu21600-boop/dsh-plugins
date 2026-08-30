// @vitest-environment jsdom

/** Feature configuration cards: titles, route rows, and select behavior. */
import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { IApiClient, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { FeaturesSettingsStore, type MediaUnderstandingSettings } from '../src/client/store.ts'
import { FeaturesSection } from '../src/client/FeaturesSection.tsx'
import type { FeaturesSectionProps } from '../src/client/FeaturesSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const GROUPS: ModelProviderGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-vl2', name: 'deepseek-vl2' },
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
    ],
  },
  {
    id: 'other',
    name: 'Other',
    models: [{ id: 'other-model', name: 'Other Model' }],
  },
]

const ALL_UNSET: MediaUnderstandingSettings = {
  image: { provider: '', model: '', backupProvider: '', backupModel: '' },
  audio: { provider: '', model: '', backupProvider: '', backupModel: '' },
  video: { provider: '', model: '', backupProvider: '', backupModel: '' },
}

interface ScopeLike {
  getSnapshot: () => {
    status: 'ready'
    value: MediaUnderstandingSettings
    base: unknown
    user: unknown
    revision: number
    writable: boolean
    mode: 'host'
  }
  subscribe: () => () => void
  set: (field: string, value: unknown) => Promise<void>
  unset: () => Promise<void>
}

/** Driven test store with a ready snapshot and a recording write path. */
function store(writes: Array<[string, unknown]> = [], writable = true): FeaturesSettingsStore {
  const models = vi.fn((_payload: object) => Promise.resolve({
    rpcId: 'llm-models' as never,
    result: { ok: true as const, value: { groups: GROUPS, failures: [] } },
  }))
  const api = { llm: { models } } as unknown as Pick<IApiClient, 'llm'>
  const current = {
    status: 'ready' as const,
    value: {
      image: { ...ALL_UNSET.image }, audio: { ...ALL_UNSET.audio }, video: { ...ALL_UNSET.video },
    },
    base: {},
    user: {},
    revision: 0,
    writable,
    mode: 'host' as const,
  }
  const scope: ScopeLike = {
    getSnapshot: () => current,
    subscribe: () => () => {},
    set: (field, value) => {
      writes.push([field, value])
      current.value = { ...current.value, [field]: value as MediaUnderstandingSettings['image'] } as MediaUnderstandingSettings
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
  }
  return new FeaturesSettingsStore(api, scope as never)
}

function t(key: keyof typeof zh): string {
  return zh[key]
}

/**
 * Reactive test harness: the real renderer binds `hooks.snapshot` to a
 * `useSyncExternalStore` hook; this wrapper reproduces that binding so the
 * section re-renders when the page store moves.
 */
function Harness({ controller }: { controller: FeaturesSettingsStore }): ReactElement {
  const snapshot = useSyncExternalStore(
    controller.store.subscribe,
    () => controller.store.getSnapshot(),
  )
  const props: FeaturesSectionProps = {
    controller,
    useSnapshot: selector => selector(snapshot),
    t,
  }
  return <FeaturesSection {...props} />
}

describe('FeaturesSection', () => {
  it('renders the three modality cards with dedicated and backup rows', async () => {
    const controller = store()
    const view = render(<Harness controller={controller} />)
    await waitFor(() => { expect(view.getByRole('heading', { name: '图片理解' })).toBeTruthy() })
    expect(view.getByRole('heading', { name: '功能配置' })).toBeTruthy()
    expect(view.getByRole('heading', { name: '音频理解' })).toBeTruthy()
    expect(view.getByRole('heading', { name: '视频理解' })).toBeTruthy()
    expect(view.getAllByLabelText('服务商')).toHaveLength(6)
    expect(view.getAllByLabelText('模型')).toHaveLength(6)
    controller.dispose()
  })

  it('offers every catalog provider and its models', async () => {
    const controller = store()
    const view = render(<Harness controller={controller} />)
    await waitFor(() => { expect(view.getAllByRole('option', { name: 'DeepSeek' })).toHaveLength(6) })
    expect(view.getAllByRole('option', { name: 'Other' })).toHaveLength(6)
    controller.dispose()
  })

  it('enables the model select only once a provider is chosen', async () => {
    const controller = store()
    const view = render(<Harness controller={controller} />)
    await waitFor(() => { expect(view.getAllByRole('option', { name: 'DeepSeek' })).toHaveLength(6) })
    const modelSelects = view.getAllByLabelText('模型') as HTMLSelectElement[]
    expect(modelSelects[0]?.disabled).toBe(true)
    const providerSelects = view.getAllByLabelText('服务商') as HTMLSelectElement[]
    fireEvent.change(providerSelects[0]!, { target: { value: 'deepseek-official' } })
    await waitFor(() => { expect(modelSelects[0]?.disabled).toBe(false) })
    controller.dispose()
  })

  it('writes the merged feature route through the scope', async () => {
    const writes: Array<[string, unknown]> = []
    const controller = store(writes)
    const view = render(<Harness controller={controller} />)
    await waitFor(() => { expect(view.getAllByRole('option', { name: 'DeepSeek' })).toHaveLength(6) })
    const providerSelects = view.getAllByLabelText('服务商') as HTMLSelectElement[]
    const modelSelects = view.getAllByLabelText('模型') as HTMLSelectElement[]
    fireEvent.change(providerSelects[0]!, { target: { value: 'deepseek-official' } })
    await waitFor(() => { expect(modelSelects[0]?.disabled).toBe(false) })
    fireEvent.change(modelSelects[0]!, { target: { value: 'deepseek-vl2' } })
    await waitFor(() => { expect(writes).toHaveLength(2) })
    expect(writes[0]).toEqual(['image', {
      provider: 'deepseek-official', model: '', backupProvider: '', backupModel: '',
    }])
    expect(writes[1]).toEqual(['image', {
      provider: 'deepseek-official', model: 'deepseek-vl2', backupProvider: '', backupModel: '',
    }])
    controller.dispose()
  })

  it('keeps the selected model when the new provider still advertises it', async () => {
    const writes: Array<[string, unknown]> = []
    const controller = store(writes)
    const view = render(<Harness controller={controller} />)
    await waitFor(() => { expect(view.getAllByRole('option', { name: 'DeepSeek' })).toHaveLength(6) })
    const providerSelects = view.getAllByLabelText('服务商') as HTMLSelectElement[]
    const modelSelects = view.getAllByLabelText('模型') as HTMLSelectElement[]
    fireEvent.change(providerSelects[0]!, { target: { value: 'deepseek-official' } })
    await waitFor(() => { expect(modelSelects[0]?.disabled).toBe(false) })
    fireEvent.change(modelSelects[0]!, { target: { value: 'deepseek-v4-flash' } })
    await waitFor(() => { expect(writes).toHaveLength(2) })
    fireEvent.change(providerSelects[0]!, { target: { value: 'deepseek-official' } })
    await waitFor(() => { expect(writes).toHaveLength(3) })
    expect(writes[2]).toEqual(['image', {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', backupProvider: '', backupModel: '',
    }])
    controller.dispose()
  })

  it('clears both fields when the provider is unset', async () => {
    const writes: Array<[string, unknown]> = []
    const controller = store(writes)
    const view = render(<Harness controller={controller} />)
    await waitFor(() => { expect(view.getAllByRole('option', { name: 'DeepSeek' })).toHaveLength(6) })
    const providerSelects = view.getAllByLabelText('服务商') as HTMLSelectElement[]
    fireEvent.change(providerSelects[0]!, { target: { value: 'deepseek-official' } })
    await waitFor(() => { expect(writes).toHaveLength(1) })
    fireEvent.change(providerSelects[0]!, { target: { value: '' } })
    await waitFor(() => { expect(writes).toHaveLength(2) })
    expect(writes[1]).toEqual(['image', {
      provider: '', model: '', backupProvider: '', backupModel: '',
    }])
    controller.dispose()
  })

  it('disables every select while read-only', async () => {
    const readOnly = store([], false)
    const view = render(<Harness controller={readOnly} />)
    await waitFor(() => { expect(view.getAllByLabelText('服务商')).toHaveLength(6) })
    expect(view.getByText('当前部署的设置文档为只读，无法修改')).toBeTruthy()
    for (const select of view.getAllByLabelText('服务商') as HTMLSelectElement[]) {
      expect(select.disabled).toBe(true)
    }
    readOnly.dispose()
  })

  it('renders the retry control when the catalog load failed', async () => {
    const failingModels = vi.fn((_payload: object) => Promise.resolve({
      rpcId: 'llm-models' as never,
      result: { ok: false as const, error: { code: 'internal', message: 'down', details: {} } },
    }))
    const failed = new FeaturesSettingsStore(
      { llm: { models: failingModels } } as unknown as Pick<IApiClient, 'llm'>,
      {
        getSnapshot: () => ({
          status: 'ready', value: ALL_UNSET, base: {}, user: {}, revision: 0, writable: true, mode: 'host',
        }),
        subscribe: () => () => {},
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
      } as never,
    )
    await failed.load()
    const view = render(<Harness controller={failed} />)
    expect(view.getByText(/配置加载失败/)).toBeTruthy()
    expect(view.getByRole('button', { name: '重试' })).toBeTruthy()
    failed.dispose()
  })
})

/**
 * Feature configuration (功能配置) settings section: three modality cards,
 * each with a dedicated and a backup model route. Providers come from the
 * host model catalog; every mutation writes through the settings scope and
 * the page re-renders from the next snapshot.
 */

import type { ReactNode } from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeaturesKey } from './locales.ts'
import {
  FeaturesSettingsStore,
  type FeatureKind,
  type FeatureModelConfig,
  type MediaUnderstandingSettings,
} from './store.ts'
import styles from './FeaturesSection.module.css'

/** Injected dependencies of {@link FeaturesSection} (slot `inject`). */
export interface FeaturesSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: FeaturesSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: FeaturesSettingsStore['store']
  }
  /** Section copy. */
  t: (key: FeaturesKey, params?: Readonly<Record<string, unknown>>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type FeaturesSectionProps = Partial<InjectFace<FeaturesSectionInjected>>

type FeaturesSectionFace = InjectFace<FeaturesSectionInjected>

const UNSET = ''

/**
 * Whether one catalog model can receive a media kind. Undeclared modalities
 * mean unknown, so the model stays offered and the runtime's capability
 * pre-flight is the judge.
 */
function modelAccepts(model: { id: string; inputModalities?: readonly string[] }, kind: FeatureKind): boolean {
  return model.inputModalities === undefined || model.inputModalities.includes(kind)
}

/** Provider groups narrowed to models that can receive one media kind. */
function groupsForKind(groups: readonly ModelProviderGroup[], kind: FeatureKind): ModelProviderGroup[] {
  return groups
    .map(group => ({ ...group, models: group.models.filter(model => modelAccepts(model, kind)) }))
    .filter(group => group.models.length > 0)
}

/** One route row (provider + model selects) inside a modality card. */
function RouteRow({ groups, value, disabled, labels, onChange }: {
  groups: readonly ModelProviderGroup[]
  value: { provider: string; model: string }
  disabled: boolean
  labels: { provider: string; model: string; unset: string }
  onChange: (next: { provider: string; model: string }) => void
}): ReactNode {
  const selected = groups.find(group => group.id === value.provider)
  return (
    <div className={styles['routeRow']}>
      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{labels.provider}</span>
        <select
          className={styles['select']}
          value={value.provider}
          disabled={disabled}
          aria-label={labels.provider}
          onChange={(event) => {
            const provider = event.target.value
            if (provider === UNSET) {
              onChange({ provider: '', model: '' })
              return
            }
            // Keep the current model only when the new provider still advertises it.
            const models = groups.find(group => group.id === provider)?.models ?? []
            onChange({ provider, model: models.some(model => model.id === value.model) ? value.model : '' })
          }}
        >
          <option value={UNSET}>{labels.unset}</option>
          {groups.map(group => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
      </label>
      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{labels.model}</span>
        <select
          className={styles['select']}
          value={value.model}
          disabled={disabled || value.provider === UNSET}
          aria-label={labels.model}
          onChange={(event) => { onChange({ ...value, model: event.target.value }) }}
        >
          <option value="">{labels.unset}</option>
          {selected?.models.map(model => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** One modality card: dedicated route, backup route, and their hint. */
function FeatureCard({ kind, title, features, groups, writable, t, onWrite }: {
  kind: FeatureKind
  title: string
  features: MediaUnderstandingSettings
  groups: readonly ModelProviderGroup[]
  writable: boolean
  t: FeaturesSectionFace['t']
  onWrite: (kind: FeatureKind, patch: Partial<FeatureModelConfig>) => void
}): ReactNode {
  const feature = features[kind]
  const capable = groupsForKind(groups, kind)
  const labels = { provider: t('provider'), model: t('model'), unset: t('unset') }
  /** Whether the stored dedicated route names a model that cannot receive this media kind. */
  const dedicatedIncapable = (() => {
    if (feature.provider === '' || feature.model === '') return false
    const group = groups.find(item => item.id === feature.provider)
    const model = group?.models.find(item => item.id === feature.model)
    return model !== undefined && modelAccepts(model, kind) === false
  })()
  const backupIncapable = (() => {
    if (feature.backupProvider === '' || feature.backupModel === '') return false
    const group = groups.find(item => item.id === feature.backupProvider)
    const model = group?.models.find(item => item.id === feature.backupModel)
    return model !== undefined && modelAccepts(model, kind) === false
  })()
  return (
    <section className={styles['card']}>
      <h3 className={styles['cardTitle']}>{title}</h3>
      {capable.length === 0 ? <p className={styles['routeHint']}>{t('noCapableModels', { media: t(`${kind}.title`) })}</p> : null}
      {dedicatedIncapable ? <p className={styles['routeHintWarn']}>{t('incapableRoute', { media: t(`${kind}.title`) })}</p> : null}
      <div className={styles['routeGroup']}>
        <span className={styles['routeLabel']}>{t('primary')}</span>
        <RouteRow
          groups={capable}
          value={{ provider: feature.provider, model: feature.model }}
          disabled={!writable}
          labels={labels}
          onChange={next => onWrite(kind, { provider: next.provider, model: next.model })}
        />
      </div>
      <div className={styles['routeGroup']}>
        <span className={styles['routeLabel']}>
          {t('backup')}
          <span className={styles['routeHint']}>{t('backupHint')}</span>
        </span>
        <RouteRow
          groups={capable}
          value={{ provider: feature.backupProvider, model: feature.backupModel }}
          disabled={!writable}
          labels={labels}
          onChange={next => onWrite(kind, { backupProvider: next.provider, backupModel: next.model })}
        />
      </div>
      {backupIncapable ? <p className={styles['routeHintWarn']}>{t('incapableRoute', { media: t(`${kind}.title`) })}</p> : null}
    </section>
  )
}

/**
 * Render the Features section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function FeaturesSection(props: FeaturesSectionProps): ReactNode {
  const { controller, useSnapshot, t } = props
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, t }} />
}

function Loaded({ injected }: { injected: FeaturesSectionFace }): ReactNode {
  const { controller, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)

  if (state.status === 'idle') void controller.load()
  if (state.status === 'loading' && state.groups.length === 0) {
    return <p className={styles['pending']}>{t('loadFailed')}…</p>
  }
  if (state.status === 'error') {
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <button type="button" className={styles['retry']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }
  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable ? <p className={styles['notice']}>{t('readonly')}</p> : null}
      <FeatureCard
        kind="image"
        title={t('image.title')}
        features={state.features}
        groups={state.groups}
        writable={state.writable}
        t={t}
        onWrite={(kind, patch) => { void controller.setFeature(kind, patch) }}
      />
      <FeatureCard
        kind="audio"
        title={t('audio.title')}
        features={state.features}
        groups={state.groups}
        writable={state.writable}
        t={t}
        onWrite={(kind, patch) => { void controller.setFeature(kind, patch) }}
      />
      <FeatureCard
        kind="video"
        title={t('video.title')}
        features={state.features}
        groups={state.groups}
        writable={state.writable}
        t={t}
        onWrite={(kind, patch) => { void controller.setFeature(kind, patch) }}
      />
    </div>
  )
}

/**
 * Feature configuration page store: one snapshot joining the host model
 * catalog (`llm.models`) with the `media-understanding` settings scope. The
 * scope is the transport — a loopback browser follows the durable host
 * section, while a remote browser's memory-mode scope keeps edits process-local.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, ModelCatalogFailure, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

/** The three modalities of the media-understanding section. */
export type FeatureKind = 'image' | 'audio' | 'video'

/** One modality's dedicated and backup routes; empty strings mean unset. */
export interface FeatureModelConfig {
  provider: string
  model: string
  backupProvider: string
  backupModel: string
}

/** The media-understanding settings section. */
export interface MediaUnderstandingSettings {
  image: FeatureModelConfig
  audio: FeatureModelConfig
  video: FeatureModelConfig
}

/** The unset route configuration. */
export const UNSET_FEATURE: FeatureModelConfig = {
  provider: '',
  model: '',
  backupProvider: '',
  backupModel: '',
}

/** Page snapshot. */
export interface FeaturesSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay on the page. */
  error: string | null
  /** Host model catalog groups. */
  groups: readonly ModelProviderGroup[]
  /** Providers whose catalog lookup failed. */
  failures: readonly ModelCatalogFailure[]
  /** Current section value, or all-unset before the scope answers. */
  features: MediaUnderstandingSettings
  /** Whether the settings provider accepts writes. */
  writable: boolean
}

/** Human text for a rejected wire call. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Accept any object section verbatim; a malformed durable value reads as the
 * all-unset section, so the page edits a fresh section instead of staying
 * stuck on a stale one.
 * @param section - the wire section value.
 * @returns the decoded section, or all-unset for non-object values.
 */
export function decodeMediaUnderstanding(section: unknown): MediaUnderstandingSettings {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return { image: { ...UNSET_FEATURE }, audio: { ...UNSET_FEATURE }, video: { ...UNSET_FEATURE } }
  }
  const raw = section as Record<string, unknown>
  const feature = (value: unknown): FeatureModelConfig => {
    const entry = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const text = (field: string): string => typeof entry[field] === 'string' ? entry[field] : ''
    return { provider: text('provider'), model: text('model'), backupProvider: text('backupProvider'), backupModel: text('backupModel') }
  }
  return { image: feature(raw.image), audio: feature(raw.audio), video: feature(raw.video) }
}

/** Feature settings page controller (one per settings surface). */
export class FeaturesSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<FeaturesSettingsState> = createSnapshotStore<FeaturesSettingsState>({
    status: 'idle',
    error: null,
    groups: [],
    failures: [],
    features: { image: { ...UNSET_FEATURE }, audio: { ...UNSET_FEATURE }, video: { ...UNSET_FEATURE } },
    writable: false,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0
  private following: (() => void) | undefined
  private writing = false

  /**
   * @param api - the wire face (model catalog only; writes ride the scope).
   * @param scope - the bound media-understanding settings scope.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'llm'>,
    private readonly scope: SettingsScope<MediaUnderstandingSettings>,
  ) {}

  /**
   * Begin following the bound scope (idempotent), fetch the model catalog,
   * and publish both answers.
   * @returns settlement after the current answers are published.
   */
  async load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    this.derive()
    try {
      const response = await this.api.llm.models({})
      if (generation !== this.generation) return
      const result = response.result
      if (!result.ok) throw new Error(result.error.message)
      const { groups, failures } = result.value
      this.store.update((state) => {
        state.groups = groups
        state.failures = failures
        if (state.status !== 'ready') state.status = 'ready'
        state.error = null
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Write one modality's merged configuration through the scope and republish
   * the post-write section. Failures surface through the snapshot after the
   * scope's recovery read.
   * @param kind - the modality to write.
   * @param patch - the fields to change; the rest keeps the current value.
   * @returns settlement after the write (the outcome is judged by the snapshot).
   */
  async setFeature(kind: FeatureKind, patch: Partial<FeatureModelConfig>): Promise<void> {
    if (this.scope.getSnapshot().mode === 'memory') {
      // A remote browser keeps its edits process-local through the scope's
      // memory mode, which rejects writes; mirror them locally instead.
      this.store.update((state) => {
        state.features = { ...state.features, [kind]: { ...state.features[kind], ...patch } }
      })
      return
    }
    this.writing = true
    try {
      await this.scope.set(kind, { ...this.store.getSnapshot().features[kind], ...patch })
    } finally {
      this.writing = false
    }
    this.derive()
  }

  /** Stop following the scope. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.writing) return
    const scope = this.scope.getSnapshot()
    switch (scope.status) {
      case 'loading':
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        return
      case 'unavailable':
        this.store.update((state) => {
          state.status = 'ready'
          state.features = { image: { ...UNSET_FEATURE }, audio: { ...UNSET_FEATURE }, video: { ...UNSET_FEATURE } }
          state.writable = false
        })
        return
      case 'ready':
        this.store.update((state) => {
          state.status = 'ready'
          state.writable = scope.writable
          if (scope.value !== undefined) state.features = scope.value
        })
        return
      default:
        break
    }
  }
}

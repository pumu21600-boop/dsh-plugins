/**
 * Settings vocabulary and durable event of the media-understanding capability.
 * Types only — no runtime code. @module @deepseek-ai/dsh-media-understanding/types
 */

/** A media kind the capability can route to a dedicated understanding model. */
export type MediaKind = 'image' | 'audio' | 'video'

/** One modality's dedicated and backup routes; empty strings mean unset. */
export interface MediaUnderstandingFeature {
  /** Provider route of the dedicated understanding model. */
  provider: string
  /** Model id of the dedicated understanding model. */
  model: string
  /** Provider route of the backup understanding model. */
  backupProvider: string
  /** Model id of the backup understanding model. */
  backupModel: string
}

/** User-settings section of the media-understanding capability. */
export interface MediaUnderstandingSettings {
  image: MediaUnderstandingFeature
  audio: MediaUnderstandingFeature
  video: MediaUnderstandingFeature
}

/**
 * Durable account of one media-understanding call, keyed by the attachment and
 * the exact route that produced it. Logged so the projected request history
 * (media blocks replaced by this text) stays reconstructable from the session
 * log on replay and resume without re-calling a model.
 */
export interface MediaUnderstandingEventData {
  /** Content-addressed attachment id understood, as a plain string. */
  attachmentId: string
  /** The understood media kind. */
  media: MediaKind
  /** Provider route that produced `text`. */
  provider: string
  /** Model that produced `text`. */
  model: string
  /** Whether `text` is a successful understanding (false: failure account). */
  ok: boolean
  /** Understanding text, or the failure account when {@link ok} is false. */
  text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One media-understanding outcome for one attachment and exact route. The
     * media-understanding plugin appends this before it substitutes the text
     * into a request, so every model-visible projection is reconstructable.
     */
    'media/understanding': MediaUnderstandingEventData
  }
}

/**
 * Media-understanding capability: when a configured conversation model
 * receives image, audio, or video input, this plugin projects the media out
 * of the request and substitutes the text a dedicated understanding model
 * produced. Each modality has its own dedicated route plus a backup route
 * used when the dedicated one fails; the projection is logged as a
 * `media/understanding` session event, so request history stays
 * reconstructable from the log on replay and resume.
 *
 * @module @deepseek-ai/dsh-media-understanding
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  audioOmittedText,
  BlockAssembler,
  createUserMessage,
  errorChain,
  videoOmittedText,
} from '@deepseek-ai/dsh-llm'
import type { AudioBlock, ContentBlock, ImageBlock, LlmRuntime, Message, VideoBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  MediaKind,
  MediaUnderstandingEventData,
  MediaUnderstandingFeature,
  MediaUnderstandingSettings,
} from './types.ts'

export type {
  MediaKind,
  MediaUnderstandingEventData,
  MediaUnderstandingFeature,
  MediaUnderstandingSettings,
} from './types.ts'

/** Settings namespace carrying the per-modality understanding routes a user owns. */
export const MEDIA_UNDERSTANDING_SETTINGS_NAMESPACE = settingsNamespace('media-understanding')

/** Default understanding call budget; the fused step signal still wins. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Default cap on one understanding answer, keeping the injected text from inflating conversation TPM. */
export const DEFAULT_MAX_TOKENS = 1500

/** Deployment-tunable understanding prompts; the media block is sent beside this text. */
export interface UnderstandingPrompts {
  /** Prompt sent with an image attachment. */
  image: string
  /** Prompt sent with an audio attachment. */
  audio: string
  /** Prompt sent with a video attachment. */
  video: string
}

const DEFAULT_PROMPTS: UnderstandingPrompts = {
  image: 'Describe this image in detail. Cover every element that would matter to someone who cannot see it, in the order a reader would need.',
  audio: 'Transcribe and describe this audio in detail. Cover spoken content and notable non-speech sounds in order.',
  video: 'Describe this video in detail: what happens across it, including visual content and any speech or captions, in chronological order.',
}

/** Media-understanding plugin configuration (composition layer). */
export interface Config {
  /** Per-call understanding timeout in milliseconds. Default: 120000. */
  timeoutMs?: number
  /** Cap on one understanding answer in tokens. Default: 1500. */
  maxTokens?: number
  /** Understanding prompts; a missing key keeps its default. */
  prompts?: Partial<UnderstandingPrompts>
  /** Composition defaults for the image feature; user settings override. */
  image?: Partial<MediaUnderstandingFeature>
  /** Composition defaults for the audio feature; user settings override. */
  audio?: Partial<MediaUnderstandingFeature>
  /** Composition defaults for the video feature; user settings override. */
  video?: Partial<MediaUnderstandingFeature>
}

const featureSchema: z<MediaUnderstandingFeature> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  backupProvider: z.string().default(''),
  backupModel: z.string().default(''),
})

const partialFeatureSchema: z<Partial<MediaUnderstandingFeature>> = z.object({
  provider: z.string(),
  model: z.string(),
  backupProvider: z.string(),
  backupModel: z.string(),
})

/** Cordis plugin name. */
export const name = 'media-understanding'

/** Services required to run the capability. */
export const inject = ['llm']

/** Runtime schema of the composition config. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  prompts: z.object({
    image: z.string(),
    audio: z.string(),
    video: z.string(),
  }),
  image: partialFeatureSchema,
  audio: partialFeatureSchema,
  video: partialFeatureSchema,
}) as z<Config>

/** Schema of the media-understanding settings section. */
export const MEDIA_UNDERSTANDING_SETTINGS_SCHEMA: z<MediaUnderstandingSettings> = z.object({
  image: featureSchema,
  audio: featureSchema,
  video: featureSchema,
})

/** A route pair (provider + model) with both fields set. */
export interface UnderstandingRoute {
  provider: string
  model: string
}

/** Resolve one feature's dedicated route, or undefined when unset. */
export function dedicatedRoute(feature: MediaUnderstandingFeature): UnderstandingRoute | undefined {
  if (feature.provider === '' || feature.model === '') return undefined
  return { provider: feature.provider, model: feature.model }
}

/** Resolve one feature's backup route, or undefined when unset. */
export function backupRoute(feature: MediaUnderstandingFeature): UnderstandingRoute | undefined {
  if (feature.backupProvider === '' || feature.backupModel === '') return undefined
  return { provider: feature.backupProvider, model: feature.backupModel }
}

/** Resolve the composition entry config for the settings base layer. */
function entrySettings(config: Config): MediaUnderstandingSettings {
  return {
    image: { provider: '', model: '', backupProvider: '', backupModel: '', ...config.image },
    audio: { provider: '', model: '', backupProvider: '', backupModel: '', ...config.audio },
    video: { provider: '', model: '', backupProvider: '', backupModel: '', ...config.video },
  }
}

/**
 * Reject a route whose model half names no provider. A provider-only entry is
 * a legitimate editing intermediate — the Web 功能配置 page persists the
 * provider first and the model second — so it must be storable; the route
 * stays inert until both halves exist (`dedicatedRoute` / `backupRoute`
 * already treat such half-set entries as unset).
 */
function validateFeature(feature: MediaUnderstandingFeature, label: string): void {
  if (feature.provider === '' && feature.model !== '') {
    throw new Error(`media-understanding: ${label} model requires a provider`)
  }
  if (feature.backupProvider === '' && feature.backupModel !== '') {
    throw new Error(`media-understanding: ${label} backup model requires a provider`)
  }
}

/** One media block found in the derived history, with its kind. */
interface MediaOccurrence {
  kind: MediaKind
  block: ImageBlock | AudioBlock | VideoBlock
}

/** Collect media occurrences in request order, walking nested tool results. */
function collectMedia(messages: readonly Message[]): MediaOccurrence[] {
  const occurrences: MediaOccurrence[] = []
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') occurrences.push({ kind: 'image', block })
      else if (block.type === 'audio') occurrences.push({ kind: 'audio', block })
      else if (block.type === 'video') occurrences.push({ kind: 'video', block })
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  for (const message of messages) walk(message.content)
  return occurrences
}

/** Replace the mapped blocks with their text, preserving message identity elsewhere. */
function projectBlocks(
  blocks: readonly ContentBlock[],
  replacements: ReadonlyMap<ContentBlock, string>,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    const text = replacements.get(block)
    if (text !== undefined) {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text })
      continue
    }
    if (block.type === 'tool-result') {
      const content = projectBlocks(block.content, replacements)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/** Project the full derived history through one replacement map. */
function projectMessages(
  messages: readonly Message[],
  replacements: ReadonlyMap<ContentBlock, string>,
): Message[] {
  return messages.map((message) => {
    const content = projectBlocks(message.content, replacements)
    return content === message.content ? message : { ...message, content }
  })
}

/** Model-facing label for one media kind. */
function successLabel(kind: MediaKind): string {
  return kind === 'image' ? 'Image understanding' : kind === 'audio' ? 'Audio understanding' : 'Video understanding'
}

/** Wrap one understanding text into the model-facing substitution. */
function formatUnderstanding(
  kind: MediaKind,
  route: UnderstandingRoute,
  text: string,
): string {
  return `[${successLabel(kind)} (${route.provider}/${route.model}):\n${text}]`
}

/** Wrap one understanding failure into the model-facing substitution. */
function formatFailure(
  kind: MediaKind,
  route: UnderstandingRoute,
  message: string,
): string {
  return `[${successLabel(kind)} failed (${route.provider}/${route.model}): ${message}]`
}

/** Media-kind name used by capability diagnostics. */
function mediaKindName(kind: MediaKind): string {
  return kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'video'
}

/**
 * Deterministic substitution when a configured route names a model that
 * cannot receive the media kind: the understanding never runs, the
 * conversation model is told the media was not shown to it, and the user is
 * pointed at the right fix.
 */
function unsupportedRouteText(kind: MediaKind, route: UnderstandingRoute): string {
  return `[${successLabel(kind)} not run: model ${route.provider}/${route.model} does not accept ${mediaKindName(kind)} input. The ${mediaKindName(kind)} was NOT shown to you. Tell the user to pick a ${mediaKindName(kind)}-capable model in Settings → Features (功能配置), or to paste a text description.]`
}

/**
 * Resolve the route model's declared input modalities and report whether it
 * can receive one media kind. Undeclared modalities mean unknown — assume
 * capable and let the adapter be the judge, so capability metadata that has
 * not caught up with a provider never blocks a working route.
 */
async function acceptsMedia(
  llm: LlmRuntime,
  route: UnderstandingRoute,
  kind: MediaKind,
): Promise<boolean> {
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    if (info.inputModalities === undefined) return true
    return info.inputModalities.includes(mediaKindName(kind) as typeof info.inputModalities[number])
  } catch {
    return true
  }
}

/** Find the latest logged understanding for this attachment and exact route. */
function lastLoggedUnderstanding(
  agent: Agent,
  kind: MediaKind,
  block: ImageBlock | AudioBlock | VideoBlock,
  route: UnderstandingRoute,
): MediaUnderstandingEventData | undefined {
  const attachmentId = String(block.attachment.attachmentId)
  for (let index = agent.session.events.length - 1; index >= 0; index--) {
    const event = agent.session.events[index]
    if (event === undefined || event.type !== 'media/understanding') continue
    const data = event.data as MediaUnderstandingEventData
    if (data.attachmentId === attachmentId && data.media === kind
      && data.provider === route.provider && data.model === route.model) {
      return data
    }
  }
  return undefined
}

/** Run one understanding call and return its model-facing text. */
async function understandOnce(
  llm: LlmRuntime,
  prompts: UnderstandingPrompts,
  timeoutMs: number,
  maxTokens: number,
  kind: MediaKind,
  block: ImageBlock | AudioBlock | VideoBlock,
  route: UnderstandingRoute,
  signal: AbortSignal,
): Promise<string> {
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const message = createUserMessage({
    source: { kind: 'user' },
    content: [block, { type: 'text', text: prompts[kind] }],
  })
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [message],
    purpose: 'media-understanding',
    signal: callSignal,
    maxTokens,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of stream) {
    callSignal.throwIfAborted()
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`${successLabel(kind)} failed (${route.provider}/${route.model}): ${finish.failure.message}`)
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return formatUnderstanding(kind, route, text)
}

/**
 * Register the settings namespace and the request projection. The
 * `agent/request-messages` listener runs before the loop freezes and
 * dispatches each request; it returns a projected message list without
 * calling `next()` when it substituted anything.
 * @param ctx - Cordis context providing `llm` and the settings seam.
 * @param config - validated composition config.
 */
export function apply(ctx: Context, config: Config): void {
  const prompts: UnderstandingPrompts = { ...DEFAULT_PROMPTS, ...config.prompts }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const entry = entrySettings(config)
  let source: () => MediaUnderstandingSettings = () => entry
  installSettingsSection(ctx, MEDIA_UNDERSTANDING_SETTINGS_NAMESPACE, MEDIA_UNDERSTANDING_SETTINGS_SCHEMA, entry, {
    validate: (settings) => {
      validateFeature(settings.image, 'image')
      validateFeature(settings.audio, 'audio')
      validateFeature(settings.video, 'video')
    },
    setSource: (current) => {
      source = current
    },
    onChange: () => {},
  })
  ctx.on('agent/request-messages', async (
    { agent, messages, signal },
    next,
  ): Promise<Message[]> => {
    const occurrences = collectMedia(messages)
    if (occurrences.length === 0) return next()
    const settings = source()
    const replacements = new Map<ContentBlock, string>()
    for (const { kind, block } of occurrences) {
      const feature = settings[kind]
      const route = dedicatedRoute(feature)
      if (route === undefined) {
        // Images keep their native path (the adapter projects or accepts them);
        // audio/video have no native path, so they become deterministic placeholders.
        if (block.type === 'audio') replacements.set(block, audioOmittedText(block.attachment))
        else if (block.type === 'video') replacements.set(block, videoOmittedText(block.attachment))
        continue
      }
      const logged = lastLoggedUnderstanding(agent, kind, block, route)
      if (logged !== undefined) {
        replacements.set(block, logged.text)
        continue
      }
      const backup = backupRoute(feature)
      const attempts = backup === undefined ? [route] : [route, backup]
      let lastError: unknown
      let lastRoute = route
      for (const attempt of attempts) {
        lastRoute = attempt
        try {
          // Capability pre-flight: a model that cannot receive this media
          // kind is substituted with an actionable note instead of a doomed
          // call (see unsupportedRouteText below).
          if (!await acceptsMedia(ctx.llm, attempt, kind)) {
            const text = unsupportedRouteText(kind, attempt)
            agent.session.append('media/understanding', {
              attachmentId: String(block.attachment.attachmentId),
              media: kind,
              provider: attempt.provider,
              model: attempt.model,
              ok: false,
              text,
            })
            replacements.set(block, text)
            break
          }
          const text = await understandOnce(ctx.llm, prompts, timeoutMs, maxTokens, kind, block, attempt, signal)
          agent.session.append('media/understanding', {
            attachmentId: String(block.attachment.attachmentId),
            media: kind,
            provider: attempt.provider,
            model: attempt.model,
            ok: true,
            text,
          })
          replacements.set(block, text)
          break
        } catch (error: unknown) {
          lastError = error
          // Cancellation is the caller's verdict, not a route failure to fail over.
          if (signal.aborted) throw error
        }
      }
      if (!replacements.has(block)) {
        // Both attempts failed (or none existed beyond the dedicated route).
        const text = formatFailure(kind, lastRoute, errorChain(lastError))
        agent.session.append('media/understanding', {
          attachmentId: String(block.attachment.attachmentId),
          media: kind,
          provider: lastRoute.provider,
          model: lastRoute.model,
          ok: false,
          text,
        })
        replacements.set(block, text)
      }
    }
    if (replacements.size === 0) return next()
    return projectMessages(messages, replacements)
  })
}

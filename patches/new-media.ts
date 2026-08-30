/**
 * Direct OpenAI-compatible media streaming for modalities pi-ai cannot carry.
 *
 * pi-ai's wire vocabulary stops at text and image, so video and audio blocks
 * never reach `streamSimple`. When a route declares `video`/`audio` on a
 * model, the adapter serves those blocks itself: one SSE `chat/completions`
 * call against the route's endpoint with `video_url` / `input_audio` content
 * parts, translated into the same StreamChunk protocol the pi-ai path yields.
 *
 * @module dsh-llm-pi-ai/media
 */

import { attributionHeaders, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentStore,
  AudioAttachmentRef,
  ImageAttachmentRef,
  VideoAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { IdleWatchdog } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/** Media kinds this module can put on the wire. */
export type RequestMediaKind = 'video' | 'audio'

/** One media attachment occurrence, in request order. */
export interface RequestMedia {
  kind: RequestMediaKind
  ref: AudioAttachmentRef | VideoAttachmentRef
}

/** Collect video/audio attachment references from one request, in order. */
export function collectRequestMedia(messages: readonly Message[]): RequestMedia[] {
  const media: RequestMedia[] = []
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'video') media.push({ kind: 'video', ref: block.attachment })
      else if (block.type === 'audio') media.push({ kind: 'audio', ref: block.attachment })
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  for (const message of messages) walk(message.content)
  return media
}

/** OpenAI chat content part this path emits. */
type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAiContentPart[]
}

/** Base64 data URI for one stored attachment. */
function dataUri(mediaType: string, data: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

/** Audio container media type → the `input_audio` format token OpenAI expects. */
function audioFormat(mediaType: string): string {
  const subtype = mediaType.split('/')[1] ?? mediaType
  // OpenAI names the MP3 container "mp3" whatever the exact MPEG subtype was.
  return subtype === 'mpeg' ? 'mp3' : subtype
}

/**
 * Convert one user/tool message's blocks into OpenAI content parts. Media
 * bytes are resolved here because only the occurrence list knows which refs
 * this request carries; unknown block types degrade to nothing, matching the
 * pi-ai path's treatment of blocks outside its vocabulary.
 */
async function userParts(
  blocks: readonly ContentBlock[],
  resolvedMedia: ReadonlyMap<string, { mediaType: string; data: Uint8Array }>,
  requestImages: ReadonlyMap<string, { mediaType: string; data: Uint8Array }>,
): Promise<OpenAiContentPart[]> {
  const parts: OpenAiContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const image = requestImages.get(String(block.attachment.attachmentId))
        if (image !== undefined) {
          parts.push({ type: 'image_url', image_url: { url: dataUri(image.mediaType, image.data) } })
        }
        break
      }
      case 'video': {
        const video = resolvedMedia.get(String(block.attachment.attachmentId))
        if (video !== undefined) {
          parts.push({ type: 'video_url', video_url: { url: dataUri(video.mediaType, video.data) } })
        }
        break
      }
      case 'audio': {
        const audio = resolvedMedia.get(String(block.attachment.attachmentId))
        if (audio !== undefined) {
          parts.push({
            type: 'input_audio',
            input_audio: { data: Buffer.from(audio.data).toString('base64'), format: audioFormat(audio.mediaType) },
          })
        }
        break
      }
      case 'tool-result': {
        const nested = await userParts(block.content, resolvedMedia, requestImages)
        parts.push(...nested)
        break
      }
      default:
        break
    }
  }
  return parts
}

/** Flatten an assistant message to plain text; tool calls are out of scope for media requests. */
function assistantText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text' || block.type === 'reasoning')
    .map(block => (block as { text: string }).text)
    .join('')
}

/** Collect every image reference in the request so mixed media requests keep their images. */
function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(String(block.attachment.attachmentId), block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/** Arguments for one direct media stream. */
export interface MediaStreamRequest {
  /** Resolved route profile: endpoint, headers, timeouts. */
  profile: ResolvedPiAiProviderProfile
  /** Resolved model descriptor: id, endpoint, wire protocol. */
  model: Model<Api>
  /** The originating harness request. */
  options: GenerateOptions
  /** Video/audio occurrences found in the request, in order. */
  media: readonly RequestMedia[]
  /** Durable attachment service for media and image bytes. */
  attachments: AttachmentStore
  /** Validated reasoning level for this request, if any. */
  reasoning: ModelThinkingLevel | undefined
  /** Route credential resolved for this call, if one is configured. */
  apiKey: string | undefined
  /** Idle watchdog owning the stable fused signal and per-read arming. */
  watchdog: IdleWatchdog
}

/** One parsed SSE data payload from an OpenAI-compatible stream. */
interface OpenAiChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cached_tokens?: number
  } | null
  error?: { message?: string }
}

/** Map wire usage into harness counts. */
function mapUsage(usage: NonNullable<OpenAiChunk['usage']>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    ...usage.cached_tokens !== undefined && usage.cached_tokens > 0
      ? { cacheReadTokens: usage.cached_tokens }
      : {},
  }
}

/** Classify a provider-side failure into the harness error vocabulary. */
function classifyWireError(status: number, message: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 413 || status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  if (status === 408) return 'TIMEOUT'
  return message.length > 0 && status === 0 ? 'TRANSPORT' : 'INVALID_REQUEST'
}

/**
 * Stream one media request directly against the route's OpenAI-compatible
 * endpoint. Only `openai-completions`-style routes reach this path: the media
 * content parts are that protocol's vocabulary, and the declared-modality gate
 * in the adapter is what keeps a non-OpenAI route from being asked for video.
 * @returns harness chunks: one text block, then usage, then finish.
 */
export async function* streamMediaRequest(request: MediaStreamRequest): AsyncGenerator<StreamChunk> {
  const { profile, model, options, media, attachments, apiKey, watchdog } = request
  if (model.api !== 'openai-completions') {
    throw new LlmError(
      `pi-ai media input requires an openai-completions route; model "${model.id}" speaks "${model.api}"`,
      'UNSUPPORTED_CONTENT',
    )
  }
  const signal = watchdog.signal

  // Resolve every media and image attachment before the request is built, so
  // a storage failure refuses the call before anything reaches the wire.
  const resolvedMedia = new Map<string, { mediaType: string; data: Uint8Array }>()
  for (const occurrence of media) {
    const id = String(occurrence.ref.attachmentId)
    if (resolvedMedia.has(id)) continue
    const stored = occurrence.kind === 'video'
      ? await attachments.readVideo(occurrence.ref as VideoAttachmentRef, signal)
      : await attachments.readAudio(occurrence.ref as AudioAttachmentRef, signal)
    resolvedMedia.set(id, { mediaType: stored.ref.mediaType, data: stored.data })
  }
  const imageRefs = new Map<string, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, imageRefs)
  const resolvedImages = new Map<string, { mediaType: string; data: Uint8Array }>()
  for (const [id, ref] of imageRefs) {
    const stored = await attachments.readImage(ref, signal)
    resolvedImages.set(id, { mediaType: stored.ref.mediaType, data: stored.data })
  }

  const messages: OpenAiMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: assistantText(message) })
      continue
    }
    if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: assistantText(message) })
      continue
    }
    const parts = await userParts(message.content, resolvedMedia, resolvedImages)
    if (parts.every(part => part.type === 'text')) {
      messages.push({ role: 'user', content: parts.map(part => part.text).join('') })
    } else {
      messages.push({ role: 'user', content: parts })
    }
  }

  const baseUrl = (model.baseUrl ?? '').replace(/\/+$/, '')
  if (baseUrl.length === 0) {
    throw new LlmError(`pi-ai model "${model.id}" has no endpoint for media input`, 'INVALID_REQUEST')
  }
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
    ...Object.fromEntries(Object.entries(profile.headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
    }),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const message = `pi-ai media request failed with HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 500)}` : ''}`
    throw new LlmError(message, classifyWireError(response.status, detail))
  }
  if (response.body === null) {
    throw new LlmError('pi-ai media response carried no body', 'TRANSPORT')
  }

  const reader = response.body.getReader()
  const reads: AsyncIterator<Uint8Array> = {
    next: async (): Promise<IteratorResult<Uint8Array>> => {
      const result = await reader.read()
      return result.done
        ? { done: true, value: undefined }
        : { done: false, value: result.value }
    },
  }
  const decoder = new TextDecoder()
  let buffered = ''
  let blockOpen = false
  const blockIndex = 0
  let text = ''
  let usage: OpenAiChunk['usage']
  let finishReason: string | null | undefined

  try {
    for (;;) {
      const item = await watchdog.next(reads)
      if (item.done) break
      const value = item.value
      if (value === undefined) continue
      buffered += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') continue
        let chunk: OpenAiChunk
        try {
          chunk = JSON.parse(payload) as OpenAiChunk
        } catch {
          continue
        }
        if (chunk.error !== undefined) {
          throw new LlmError(
            `pi-ai media stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`,
            'SERVER',
          )
        }
        if (chunk.usage != null) usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (choice === undefined) continue
        const delta = choice.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          if (!blockOpen) {
            yield { type: 'block-start', index: blockIndex, blockType: 'text' }
            blockOpen = true
          }
          text += delta
          yield { type: 'text-delta', index: blockIndex, text: delta }
        }
        if (choice.finish_reason != null) finishReason = choice.finish_reason
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  if (blockOpen) {
    yield { type: 'block-end', index: blockIndex, block: { type: 'text', text } }
  }
  if (usage != null) yield { type: 'usage', usage: mapUsage(usage) }
  if (finishReason === 'length') {
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
    return
  }
  if (!blockOpen) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `model "${model.id}" returned a completed response with no content`, code: EMPTY_RESPONSE_CODE },
      },
    }
    return
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

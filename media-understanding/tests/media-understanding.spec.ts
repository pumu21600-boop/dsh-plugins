/** Media-understanding request projection: routes, substitution, failover, and logged-outcome reuse. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  apply, backupRoute, dedicatedRoute, MEDIA_UNDERSTANDING_SETTINGS_NAMESPACE,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { MediaUnderstandingEventData } from '../src/types.ts'

/** A stream of one text block carrying `text`, closed with a stop finish. */
function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** A stream that reports the given failure at the terminal finish. */
function errorStream(message: string, code: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
  })()
}

const IMAGE_REF = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 10,
  width: 1,
  height: 1,
} as const

const AUDIO_REF = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  mediaType: 'audio/mpeg',
  bytes: 10,
} as const

const VIDEO_REF = {
  attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
  mediaType: 'video/mp4',
  bytes: 10,
} as const

function imageMessage(): Message {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: IMAGE_REF }] })
}

interface Bench {
  ctx: Context
  stream: ReturnType<typeof vi.fn>
  session: { events: Array<{ type: string; data: unknown }>; append: ReturnType<typeof vi.fn> }
  agent: { session: Bench['session'] }
  project: (messages: readonly Message[]) => Promise<Message[]>
}

async function bench(config: Config, streams: Array<AsyncIterable<StreamChunk>>): Promise<Bench> {
  const ctx = new Context()
  const stream = vi.fn()
  for (const value of streams) stream.mockReturnValueOnce(value)
  ctx.provide('llm', { stream })
  const session = {
    events: [] as Array<{ type: string; data: unknown }>,
    append: vi.fn((_type: string, data: unknown) => {
      session.events.push({ type: 'media/understanding', data })
      return { seq: session.events.length - 1, time: 0, type: 'media/understanding', data }
    }),
  }
  const agent = { session }
  apply(ctx, config)
  return {
    ctx,
    stream,
    session,
    agent,
    project: async (messages) => {
      const next = (): Promise<Message[]> => Promise.resolve([...messages])
      return ctx.waterfall(
        ctx as never, 'agent/request-messages',
        { agent, turn: 1, step: 1, messages: [...messages], signal: new AbortController().signal } as never,
        next as never,
      )
    },
  }
}

function textOf(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('route resolution', () => {
  it('resolves dedicated and backup routes only when both fields are set', () => {
    const feature = { provider: 'p', model: 'm', backupProvider: 'bp', backupModel: 'bm' }
    expect(dedicatedRoute(feature)).toEqual({ provider: 'p', model: 'm' })
    expect(backupRoute(feature)).toEqual({ provider: 'bp', model: 'bm' })
    expect(dedicatedRoute({ ...feature, model: '' })).toBeUndefined()
    expect(backupRoute({ ...feature, backupModel: '' })).toBeUndefined()
  })
})

describe('request projection', () => {
  it('leaves media-free history untouched', async () => {
    const b = await bench({}, [])
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })
    expect(await b.project([message])).toEqual([message])
    expect(b.stream).not.toHaveBeenCalled()
  })

  it('keeps images native when no image route is configured', async () => {
    const b = await bench({}, [])
    const message = imageMessage()
    expect(await b.project([message])).toEqual([message])
    expect(b.stream).not.toHaveBeenCalled()
  })

  it('substitutes configured images with the understanding text and logs the outcome', async () => {
    const b = await bench(
      { image: { provider: 'vision', model: 'vl' } },
      [textStream('a red ball on grass')],
    )
    const projected = await b.project([imageMessage()])
    expect(textOf(projected[0]!)).toContain('[Image understanding (vision/vl):')
    expect(textOf(projected[0]!)).toContain('a red ball on grass')
    expect(b.stream).toHaveBeenCalledTimes(1)
    const request = b.stream.mock.calls[0]![0] as { provider: string; model: string; purpose: string }
    expect(request.provider).toBe('vision')
    expect(request.model).toBe('vl')
    expect(request.purpose).toBe('media-understanding')
    const event = b.session.events[0]!.data as MediaUnderstandingEventData
    expect(event).toMatchObject({ media: 'image', provider: 'vision', model: 'vl', ok: true })
  })

  it('reuses the logged outcome on the next step without another model call', async () => {
    const b = await bench(
      { image: { provider: 'vision', model: 'vl' } },
      [textStream('a red ball on grass')],
    )
    await b.project([imageMessage()])
    const projected = await b.project([imageMessage()])
    expect(textOf(projected[0]!)).toContain('a red ball on grass')
    expect(b.stream).toHaveBeenCalledTimes(1)
    expect(b.session.events).toHaveLength(1)
  })

  it('fails over to the backup route when the dedicated one fails', async () => {
    const b = await bench(
      { image: { provider: 'vision', model: 'vl', backupProvider: 'backup', backupModel: 'bl' } },
      [errorStream('dedicated down', 'DOWN'), textStream('backup description')],
    )
    const projected = await b.project([imageMessage()])
    expect(textOf(projected[0]!)).toContain('[Image understanding (backup/bl):')
    expect(textOf(projected[0]!)).toContain('backup description')
    const event = b.session.events[0]!.data as MediaUnderstandingEventData
    expect(event).toMatchObject({ provider: 'backup', model: 'bl', ok: true })
  })

  it('records a failure account when every route fails, reused without retrying', async () => {
    const b = await bench(
      { image: { provider: 'vision', model: 'vl' } },
      [errorStream('vision down', 'DOWN')],
    )
    const projected = await b.project([imageMessage()])
    expect(textOf(projected[0]!)).toContain('[Image understanding failed (vision/vl):')
    const event = b.session.events[0]!.data as MediaUnderstandingEventData
    expect(event.ok).toBe(false)
    await b.project([imageMessage()])
    expect(b.stream).toHaveBeenCalledTimes(1)
    expect(b.session.events).toHaveLength(1)
  })

  it('replaces unconfigured audio and video with deterministic placeholders', async () => {
    const b = await bench({}, [])
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'audio', attachment: AUDIO_REF }, { type: 'video', attachment: VIDEO_REF }],
    })
    const projected = await b.project([message])
    expect(textOf(projected[0]!)).toContain('[audio omitted because no audio-understanding model is configured')
    expect(textOf(projected[0]!)).toContain('[video omitted because no video-understanding model is configured')
    expect(b.stream).not.toHaveBeenCalled()
  })

  it('projects nested tool-result media too', async () => {
    const b = await bench({ image: { provider: 'vision', model: 'vl' } }, [textStream('nested image text')])
    const message = createUserMessage({
      source: { kind: 'tool', callId: 'c1' as never },
      content: [{
        type: 'tool-result',
        toolCallId: 'c1' as never,
        content: [{ type: 'image', attachment: IMAGE_REF }],
        isError: false,
      }],
    })
    const projected = await b.project([message])
    const toolResult = projected[0]!.content[0]!
    expect(toolResult.type).toBe('tool-result')
    if (toolResult.type === 'tool-result') {
      expect(toolResult.content[0]).toMatchObject({ type: 'text' })
    }
  })

  it('exposes the settings namespace identity', () => {
    expect(String(MEDIA_UNDERSTANDING_SETTINGS_NAMESPACE)).toBe('media-understanding')
  })
})

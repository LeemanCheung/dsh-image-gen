import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, inject, type Config } from '../src/index.ts'
import { IMAGE_GEN_RPC_ENDPOINT } from '../src/rpc.ts'
import { PRESENTATION_SCHEMA, REFERENCE_MARKER, RESULT_SCHEMA } from '../src/types.ts'

const config: Config = {
  authMode: 'api-key',
  apiKeyEnv: 'OPENAI_API_KEY',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-image-2',
  defaultSize: 'auto',
  defaultQuality: 'auto',
  defaultOutputFormat: 'png',
  defaultOutputCompression: 90,
  defaultBackground: 'auto',
  moderation: 'auto',
  partialImages: 3,
  requestTimeoutMs: 120_000,
  maxRetries: 0,
  retryBaseMs: 1,
  maxConcurrent: 2,
}

function sseFinal(data = 'png-data'): Response {
  const b64 = Buffer.from(data).toString('base64')
  return new Response(`data: ${JSON.stringify({
    type: 'image_generation.completed',
    b64_json: b64,
    output_format: 'png',
    size: '1024x1024',
    quality: 'medium',
    background: 'opaque',
  })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}

function harness(options: {
  credential?: string | null
  resolveCredential?: () => Promise<unknown>
  config?: Partial<Config>
} = {}) {
  let definition: ToolDefinition | undefined
  let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
  let events: unknown[] = []
  const cleanups: Array<() => void | Promise<void>> = []
  const saveImage = vi.fn(async () => ({
    attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mediaType: 'image/png' as const,
    bytes: 8,
    width: 1024,
    height: 1024,
    name: 'blue-whale.png',
  }))
  const readImage = vi.fn(async (ref: unknown) => ({ ref, data: new Uint8Array(Buffer.from('png-data')) }))
  const fs = {
    resolve: vi.fn(async (path: string) => ({ displayPath: path })),
    stat: vi.fn(async () => ({ type: 'file' })),
    readBytes: vi.fn(async () => new Uint8Array(Buffer.from('png-data'))),
  }
  const logger = { warn: vi.fn() }
  const ctx = {
    tools: { register: vi.fn((next: ToolDefinition) => { definition = next; return () => {} }) },
    attachments: { imageLimits: { maxImageBytes: 1024 }, saveImage, readImage },
    fs,
    credentials: { resolve: vi.fn(async () => options.resolveCredential === undefined
      ? options.credential === null ? undefined : ({ ref: 'OPENAI_API_KEY', value: options.credential ?? 'secret-key', source: 'test' })
      : options.resolveCredential()) },
    connection: { rpc: { handle: vi.fn((_channel, handler) => { rpcHandler = handler; return async () => {} }) } },
    sessionPersistence: { inspect: vi.fn(async (sessionId: unknown) => ({ events: String(sessionId) === 'session-1' ? events : [] })) },
    get: (name: string) => name === 'fs' ? fs : undefined,
    logger,
    effect: vi.fn((install: () => (() => void | Promise<void>)) => {
      cleanups.push(install())
      return () => {}
    }),
  } as unknown as Context
  apply(ctx, { ...config, ...options.config })
  if (definition === undefined || rpcHandler === undefined) throw new Error('plugin did not register')
  return {
    definition,
    rpcHandler,
    saveImage,
    readImage,
    fs,
    logger,
    setEvents(next: unknown[]) { events = next },
    async dispose() {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

function execution(callId = 'call-1'): ToolRunContext {
  const token = Symbol('token')
  return {
    callId,
    rootCallId: callId,
    name: 'image_gen',
    arguments: {},
    agent: { session: { header: { id: 'session-1', cwd: 'C:\\workspace' } } },
    signal: new AbortController().signal,
    token,
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

describe('Host image generation plugin', () => {
  it('declares every hard service dependency', () => {
    expect(inject).toEqual(['tools', 'attachments', 'credentials', 'connection', 'sessionPersistence'])
  })

  it('stores the final image before returning a text-only result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseFinal()))
    const { definition, saveImage, logger } = harness()
    if (definition.execute === undefined || definition.output === undefined) throw new Error('missing tool body')

    const value = await definition.execute({ prompt: 'A blue glass whale', size: '1024x1024' }, execution())
    expect(saveImage).toHaveBeenCalledOnce()
    expect(value).toMatchObject({ schema: RESULT_SCHEMA, callId: 'call-1', image: { mediaType: 'image/png' } })

    const content = definition.output.render?.({}, value)
    expect(content).toHaveLength(1)
    expect(content?.every(block => block.type === 'text')).toBe(true)
    expect(content?.some(block => block.type === 'image')).toBe(false)
    expect(content?.[0]).toMatchObject({ type: 'text' })
    expect((content?.[0] as { text: string }).text).toContain(REFERENCE_MARKER)

    const topLevel = definition.finalizeContent?.(execution(), {
      isError: false,
      value,
      content: content ?? [],
    })
    expect(topLevel).toEqual([expect.objectContaining({ type: 'text', text: expect.not.stringContaining(REFERENCE_MARKER) })])
    const nestedExec = { ...execution(), parent: Symbol('parent') }
    expect(definition.finalizeContent?.(nestedExec as ToolRunContext, { isError: false, value, content: content ?? [] })).toBeUndefined()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('reads and persists a reference image before calling the API-key edit endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/images/edits')
      expect(init?.body).toBeInstanceOf(FormData)
      const image = (init?.body as FormData).get('image')
      expect(Buffer.from(await (image as Blob).arrayBuffer())).toEqual(Buffer.from('png-data'))
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('edited-png').toString('base64') }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    const { definition, fs, saveImage } = harness()
    if (definition.execute === undefined) throw new Error('missing tool body')
    const value = await definition.execute({ prompt: 'Animate this whale', reference_image_path: 'assets/minke.png' }, execution())
    expect(fs.resolve).toHaveBeenCalledWith('assets/minke.png', { cwd: 'C:\\workspace', signal: expect.any(AbortSignal) })
    expect(fs.readBytes).toHaveBeenCalledOnce()
    expect(saveImage).toHaveBeenCalledTimes(2)
    expect(value).toMatchObject({ referenceImage: { mediaType: 'image/png' } })
  })

  it('authorizes durable bytes from native metadata and Code Mode markers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseFinal()))
    const { definition, rpcHandler, readImage, setEvents } = harness()
    if (definition.execute === undefined || definition.output === undefined) throw new Error('missing tool body')
    const value = await definition.execute({ prompt: 'A blue glass whale' }, execution())
    const meta = definition.output.presentationMeta?.({}, value)
    expect(meta).toMatchObject({ schema: PRESENTATION_SCHEMA })

    setEvents([{ type: 'tool/result', data: { meta } }])
    const native = await rpcHandler(IMAGE_GEN_RPC_ENDPOINT.image, { sessionId: 'session-1', callId: 'call-1' }, new AbortController().signal)
    expect(native).toMatchObject({ ok: true, value: { attachment: { attachmentId: value.image.attachmentId } } })
    expect(readImage).toHaveBeenCalledOnce()

    const markerContent = definition.output.render?.({}, value)
    setEvents([{ type: 'tool/code-dispatch', data: { name: 'image_gen', subCallId: 'call-1', content: markerContent } }])
    const nested = await rpcHandler(IMAGE_GEN_RPC_ENDPOINT.image, { sessionId: 'session-1', callId: 'call-1' }, new AbortController().signal)
    expect(nested).toMatchObject({ ok: true })

    const wrongSession = await rpcHandler(IMAGE_GEN_RPC_ENDPOINT.image, { sessionId: 'session-2', callId: 'call-1' }, new AbortController().signal)
    expect(wrongSession).toMatchObject({ ok: false, error: { code: 'attachment-error' } })

    setEvents([{ type: 'tool/code-dispatch', data: { name: 'image_gen', subCallId: 'different', content: markerContent } }])
    const denied = await rpcHandler(IMAGE_GEN_RPC_ENDPOINT.image, { sessionId: 'session-1', callId: 'call-1' }, new AbortController().signal)
    expect(denied).toMatchObject({ ok: false, error: { code: 'attachment-error' } })
  })

  it('reserves the configured concurrency slot before credential resolution', async () => {
    let release: ((value: unknown) => void) | undefined
    const credential = new Promise<unknown>(resolve => { release = resolve })
    const { definition } = harness({ resolveCredential: () => credential, config: { maxConcurrent: 1 } })
    if (definition.execute === undefined) throw new Error('missing tool body')
    const first = definition.execute({ prompt: 'first image' }, execution('call-1'))
    await Promise.resolve()
    await expect(definition.execute({ prompt: 'second image' }, execution('call-2'))).rejects.toThrow('Too many image generations')
    release?.(undefined)
    await expect(first).rejects.toThrow('No credential is configured')
  })

  it('aborts and drains provider work when the plugin is disposed', async () => {
    let providerSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      providerSignal = init?.signal ?? undefined
      providerSignal?.addEventListener('abort', () => { reject(providerSignal?.reason) }, { once: true })
    })))
    const { definition, dispose } = harness()
    if (definition.execute === undefined) throw new Error('missing tool body')
    const pending = definition.execute({ prompt: 'an image held during teardown' }, execution())
    await vi.waitFor(() => { expect(providerSignal).toBeDefined() })
    const draining = dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await draining
    expect(providerSignal?.aborted).toBe(true)
  })

  it('rejects missing credentials without putting secrets in logs', async () => {
    const { definition, logger } = harness({ credential: null })
    if (definition.execute === undefined) throw new Error('missing tool body')
    const error = await definition.execute({ prompt: 'a credential test image' }, execution()).catch(value => value as Error)
    expect(error.message).toContain('No credential is configured')
    expect(error.message).not.toContain('secret-key')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

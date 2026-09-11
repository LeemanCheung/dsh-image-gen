import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, inject, type Config } from '../src/index.ts'
import { CODEX_SUBSCRIPTION_MODEL } from '../src/index.ts'
import { IMAGE_GEN_RPC_ENDPOINT } from '../src/rpc.ts'
import { PRESENTATION_SCHEMA, REFERENCE_MARKER, RESULT_SCHEMA } from '../src/types.ts'

// The optional `dsh-codex-connect` peer is absent from the keyless test
// environment, and the codex module's module-not-found fallback cannot tell
// Vite's resolver error apart from a genuinely incompatible connector. Substitute
// a fixed in-memory subscription credential so the subscription paths stay
// deterministic and never read the real OAuth store.
vi.mock('../src/codex.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/codex.ts')>(),
  resolveCodexSubscriptionAuth: vi.fn(async () => ({ accessToken: 'oauth-secret', accountId: 'account-1' })),
}))

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
  let preExecute: ((execution: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
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
  const validateImage = vi.fn(async () => {})
  const saveImages = vi.fn(async (inputs: readonly unknown[]) => {
    const refs = []
    for (const input of inputs) await validateImage(input)
    for (const input of inputs) refs.push(await saveImage(input))
    return refs
  })
  const fs = {
    resolve: vi.fn(async (path: string) => ({ displayPath: path })),
    stat: vi.fn(async () => ({ type: 'file' })),
    readBytes: vi.fn(async () => new Uint8Array(Buffer.from('png-data'))),
  }
  const logger = { warn: vi.fn() }
  const ctx = {
    tools: { register: vi.fn((next: ToolDefinition) => { definition = next; return () => {} }) },
    attachments: { imageLimits: { maxImageBytes: 1024 }, validateImage, saveImages, saveImage, readImage },
    fs,
    credentials: { resolve: vi.fn(async () => options.resolveCredential === undefined
      ? options.credential === null ? undefined : ({ ref: 'OPENAI_API_KEY', value: options.credential ?? 'secret-key', source: 'test' })
      : options.resolveCredential()) },
    connection: { rpc: { handle: vi.fn((_channel, handler) => { rpcHandler = handler; return async () => {} }) } },
    sessionPersistence: { inspect: vi.fn(async (sessionId: unknown) => ({ events: String(sessionId) === 'session-1' ? events : [] })) },
    get: (name: string) => name === 'fs' ? fs : undefined,
    logger,
    on: vi.fn((event: string, listener: unknown) => {
      if (event === 'tools/pre-execute') {
        preExecute = listener as typeof preExecute
      }
      return () => {}
    }),
    effect: vi.fn((install: () => (() => void | Promise<void>)) => {
      cleanups.push(install())
      return () => {}
    }),
  } as unknown as Context
  apply(ctx, { ...config, ...options.config })
  if (definition === undefined || rpcHandler === undefined || preExecute === undefined) throw new Error('plugin did not register')
  return {
    definition,
    preExecute,
    rpcHandler,
    saveImage,
    saveImages,
    readImage,
    validateImage,
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
    expect(inject).toEqual(['tools', 'attachments', 'credentials', 'connection', 'webServer', 'sessionPersistence'])
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

  it('requires one-time approval before reading or uploading a reference path', async () => {
    const { preExecute, fs, saveImage, validateImage } = harness()
    const next = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
    const decision = await preExecute({
      ...execution(),
      arguments: { prompt: 'Edit this whale', reference_image_path: `  private/minke.png${' '.repeat(4_096)}` },
    } as ToolExecution, next)

    expect(decision).toEqual({
      kind: 'ask',
      reason: 'Upload reference image "minke.png" to https://api.openai.com for this image edit.',
    })
    expect(next).not.toHaveBeenCalled()
    expect(fs.resolve).not.toHaveBeenCalled()
    expect(validateImage).not.toHaveBeenCalled()
    expect(saveImage).not.toHaveBeenCalled()

    expect(await preExecute({
      ...execution('call-invalid'),
      arguments: { prompt: 'Edit this whale', reference_image_path: 'x'.repeat(4_097) },
    } as ToolExecution, next)).toEqual({
      kind: 'deny',
      reason: 'reference_image_path must contain 1–4096 characters',
    })
    expect(next).not.toHaveBeenCalled()

    expect(await preExecute({
      ...execution('call-plain'),
      arguments: { prompt: 'Generate a new whale' },
    } as ToolExecution, next)).toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('reads a reference for the API-key edit endpoint and batch-persists it only after success', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/images/edits')
      expect(init?.body).toBeInstanceOf(FormData)
      const image = (init?.body as FormData).get('image')
      expect(Buffer.from(await (image as Blob).arrayBuffer())).toEqual(Buffer.from('png-data'))
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('edited-png').toString('base64') }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    const { definition, fs, saveImage, saveImages, validateImage } = harness({ config: { authMode: 'auto' } })
    if (definition.execute === undefined) throw new Error('missing tool body')
    const value = await definition.execute({ prompt: 'Animate this whale', reference_image_path: 'assets/minke.png' }, execution())
    expect(fs.resolve).toHaveBeenCalledWith('assets/minke.png', { cwd: 'C:\\workspace', signal: expect.any(AbortSignal) })
    expect(fs.readBytes).toHaveBeenCalledOnce()
    expect(validateImage).toHaveBeenCalledTimes(3)
    expect(saveImages).toHaveBeenCalledOnce()
    expect(saveImage).toHaveBeenCalledTimes(2)
    expect(value).toMatchObject({ referenceImage: { mediaType: 'image/png' } })
  })

  it('keeps public-API-only transparent output off the private subscription endpoint', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { definition } = harness({ config: { authMode: 'codex-subscription' } })
    if (definition.execute === undefined) throw new Error('missing tool body')

    await expect(definition.execute({
      prompt: 'A transparent whale icon',
      background: 'transparent',
      output_format: 'png',
    }, execution())).rejects.toThrow('transparent background output requires authMode auto')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not persist a validated reference when the provider rejects the edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'edit rejected', code: 'image_generation_user_error' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })))
    const { definition, validateImage, saveImage } = harness()
    if (definition.execute === undefined) throw new Error('missing tool body')

    await expect(definition.execute({
      prompt: 'Edit this whale',
      reference_image_path: 'assets/minke.png',
    }, execution())).rejects.toThrow('edit rejected')
    expect(validateImage).toHaveBeenCalledOnce()
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('does not start batch writes when final-image validation fails after a successful edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from('invalid-final-image').toString('base64') }],
    }), { headers: { 'content-type': 'application/json' } })))
    const { definition, validateImage, saveImages, saveImage } = harness()
    validateImage.mockImplementation(async (input: unknown) => {
      if ((input as { name?: string }).name !== 'minke.png') throw new Error('invalid final image')
    })
    if (definition.execute === undefined) throw new Error('missing tool body')

    await expect(definition.execute({
      prompt: 'Edit this whale',
      reference_image_path: 'assets/minke.png',
    }, execution())).rejects.toThrow('invalid final image')
    expect(saveImages).toHaveBeenCalledOnce()
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('separates requested settings from validated output facts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseFinal()))
    const { definition } = harness()
    if (definition.execute === undefined) throw new Error('missing tool body')
    const value = await definition.execute({
      prompt: 'A glass whale',
      size: '1536x864',
      quality: 'high',
    }, execution())

    expect(value).toMatchObject({
      size: '1024x1024',
      quality: 'medium',
      requestedSize: '1536x864',
      requestedQuality: 'high',
      providerSize: '1024x1024',
      qualitySource: 'provider',
    })
  })

  it('exposes the full GPT Image 2.5 quality ladder in the tool and output schemas', () => {
    const { definition } = harness()
    if (definition.parameters === undefined || definition.output === undefined) throw new Error('missing tool schema')

    const parameterProperties = (definition.parameters as { properties?: Record<string, { enum?: unknown }> }).properties
    expect(parameterProperties?.quality?.enum).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])

    const properties = (definition.output.schema as { properties?: Record<string, { enum?: unknown }> }).properties
    expect(properties?.quality?.enum).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(properties?.requestedQuality?.enum).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('applies a per-call GPT Image 2.5 model and extended quality in API-key mode', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseFinal()
    }))
    const { definition } = harness()
    if (definition.execute === undefined) throw new Error('missing tool body')

    const value = await definition.execute({
      prompt: 'A cobalt glass lighthouse',
      model: '  gpt-image-2.5-sunburst  ',
      quality: 'max',
    }, execution())

    expect(bodies[0]).toMatchObject({ model: 'gpt-image-2.5-sunburst', quality: 'max' })
    expect(value).toMatchObject({ model: 'gpt-image-2.5-sunburst', requestedQuality: 'max' })
  })

  it('falls back to the configured model and normalizes an invalid per-call model', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseFinal()
    }))
    const { definition } = harness({ config: { model: 'gpt-image-2' } })
    if (definition.execute === undefined) throw new Error('missing tool body')

    await expect(definition.execute({ prompt: 'A model name with spaces', model: 'gpt image 2.5' }, execution()))
      .rejects.toThrow('only letters, digits')
    expect(bodies).toHaveLength(0)

    const value = await definition.execute({ prompt: 'A configured model image' }, execution())
    expect(bodies[0]).toMatchObject({ model: 'gpt-image-2' })
    expect(value).toMatchObject({ model: 'gpt-image-2' })
  })

  it('routes a per-call GPT Image 2.5 model through the Codex subscription endpoint', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('subscription-image').toString('base64') }],
        output_format: 'png',
        size: '1774x887',
        quality: 'medium',
      }), { headers: { 'content-type': 'application/json' } })
    }))
    const { definition } = harness({ config: { authMode: 'codex-subscription' } })
    if (definition.execute === undefined) throw new Error('missing tool body')

    const value = await definition.execute({
      prompt: 'A subscription whale',
      model: 'gpt-image-2.5-sunburst',
      quality: 'max',
    }, execution())

    expect(bodies[0]).toMatchObject({ model: 'gpt-image-2.5-sunburst', quality: 'max' })
    expect(value).toMatchObject({ model: 'gpt-image-2.5-sunburst', requestedQuality: 'max' })

    const fallback = await definition.execute({ prompt: 'A default subscription whale' }, execution('call-2'))
    expect(bodies[1]).toMatchObject({ model: CODEX_SUBSCRIPTION_MODEL })
    expect(fallback).toMatchObject({ model: CODEX_SUBSCRIPTION_MODEL })
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

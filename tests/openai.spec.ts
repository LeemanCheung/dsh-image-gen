import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  ImageApiError,
  OpenAIImageClient,
  imageApiBaseUrl,
  imageSize,
  type GenerateImageProgress,
} from '../src/openai.ts'

const request = {
  prompt: 'a blue glass whale',
  size: '1024x1024',
  quality: 'medium' as const,
  outputFormat: 'png' as const,
  background: 'auto' as const,
}

const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof OpenAIImageClient>[0]> = {}) {
  return new OpenAIImageClient({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-secret',
    model: 'gpt-image-2',
    moderation: 'auto',
    partialImages: 3,
    maxRetries: 0,
    retryBaseMs: 1,
    maxImageBytes: 1024,
    fetchImpl,
    ...overrides,
  })
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

describe('OpenAI image transport', () => {
  it('validates credential destinations and arbitrary GPT Image sizes', () => {
    expect(imageApiBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(imageApiBaseUrl('http://127.0.0.1:4000/v1')).toBe('http://127.0.0.1:4000/v1')
    expect(() => imageApiBaseUrl('http://example.com/v1')).toThrow('https')
    expect(() => imageApiBaseUrl('https://user:pass@example.com/v1')).toThrow('credentials')
    expect(() => imageApiBaseUrl('https://example.com/v1?key=x')).toThrow('query')
    expect(imageSize('auto')).toBe('auto')
    expect(imageSize('1024x1024')).toBe('1024x1024')
    expect(() => imageSize('1000x1000')).toThrow('divisible by 16')
    expect(() => imageSize('4096x1024')).toThrow('3840')
    expect(() => imageSize('512x512')).toThrow('pixels')
  })

  it('parses split CRLF streams and replaces partial progress before completion', async () => {
    const partial = Buffer.from('partial-image').toString('base64')
    const final = Buffer.from('final-image').toString('base64')
    const seen: GenerateImageProgress[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toMatchObject({
        accept: 'text/event-stream',
        authorization: 'Bearer test-secret',
      })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({ model: 'gpt-image-2', stream: true, partial_images: 3, n: 1 })
      return sseResponse([
        `data: {"type":"image_generation.partial_image","partial_image_index":0,"output_format":"png","b64_json":"${partial}"}\r`,
        '\n\r\n',
        `data: {"type":"image_generation.completed","output_format":"png","size":"1024x1024","quality":"medium","background":"opaque","b64_json":"${final}","usage":{"input_tokens":4,"output_tokens":9,"total_tokens":13}}\r\n\r\n`,
      ])
    })

    const generated = await client(fetchImpl).generate(request, new AbortController().signal, progress => { seen.push(progress) })

    expect(Buffer.from(generated.data).toString()).toBe('final-image')
    expect(generated).toMatchObject({ size: '1024x1024', quality: 'medium', background: 'opaque', usage: { totalTokens: 13 } })
    expect(seen.map(item => item.kind)).toEqual(['requesting', 'generating', 'partial'])
  })

  it('accepts bounded non-streaming JSON images larger than an error body', async () => {
    const image = Buffer.alloc(10_000, 7)
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ b64_json: image.toString('base64') }],
      output_format: 'png',
      size: '1024x1024',
      quality: 'medium',
    }), { headers: { 'content-type': 'application/json' } }))
    const generated = await client(fetchImpl, { maxImageBytes: 16_384 }).generate(request, new AbortController().signal, () => {})
    expect(Buffer.from(generated.data)).toEqual(image)
  })

  it('cancels an unfinished SSE body after the completed event', async () => {
    const encoder = new TextEncoder()
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"image_generation.completed","b64_json":"${Buffer.from('done').toString('base64')}"}\n\n`))
      },
      cancel: cancelled,
    })
    const generated = await client(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
      .generate(request, new AbortController().signal, () => {})
    expect(Buffer.from(generated.data).toString()).toBe('done')
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('bounds and cancels oversized provider error bodies', async () => {
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(20_000).fill(65)) },
      cancel: cancelled,
    })
    await expect(client(async () => new Response(stream, { status: 500 })).generate(request, new AbortController().signal, () => {})).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('retries 429 responses but not moderation failures', async () => {
    const final = Buffer.from('done').toString('base64')
    const retrying = vi.fn()
    const transient = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(sseResponse([`data: {"type":"image_generation.completed","b64_json":"${final}"}\n\n`]))
    const generated = await client(transient, { maxRetries: 1 }).generate(request, new AbortController().signal, retrying)
    expect(Buffer.from(generated.data).toString()).toBe('done')
    expect(transient).toHaveBeenCalledTimes(2)
    expect(retrying).toHaveBeenCalledWith({ kind: 'retrying', attempt: 1 })

    const blocked = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'private detail' } }), { status: 400 }))
    await expect(client(blocked, { maxRetries: 3 }).generate(request, new AbortController().signal, () => {}))
      .rejects.toThrow('blocked by the provider safety policy')
    expect(blocked).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed, oversized, and prematurely closed streams', async () => {
    await expect(client(async () => sseResponse(['data: {bad json}\n\n'])).generate(request, new AbortController().signal, () => {}))
      .rejects.toBeInstanceOf(ImageApiError)
    await expect(client(async () => sseResponse(['data: {"type":"image_generation.completed","b64_json":"%%%"}\n\n'])).generate(request, new AbortController().signal, () => {}))
      .rejects.toThrow('invalid or oversized')
    await expect(client(async () => sseResponse(['data: {"type":"image_generation.partial_image","b64_json":"ZA=="}\n\n'])).generate(request, new AbortController().signal, () => {}))
      .rejects.toThrow('before completion')
  })

  it('propagates cancellation into the upstream fetch', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
    }))
    const pending = client(fetchImpl).generate(request, controller.signal, () => {})
    controller.abort(new DOMException('cancelled by test', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('never follows a redirect carrying the credential', async () => {
    let targetRequests = 0
    const server = createServer((req, res) => {
      if (req.url === '/sink') {
        targetRequests += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(302, { location: '/sink' })
      res.end()
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server address')
    const localClient = client(fetch, { baseUrl: `http://127.0.0.1:${address.port}/v1` })

    await expect(localClient.generate(request, new AbortController().signal, () => {})).rejects.toThrow()
    expect(targetRequests).toBe(0)
  })
})

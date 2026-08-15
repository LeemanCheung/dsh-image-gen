/** Small dependency-free GPT Image 2 streaming client. */

import { CODEX_IMAGE_BASE_URL } from './codex.ts'
import type {
  ImageBackground,
  ImageOutputFormat,
  ImageQuality,
  ImageUsageValue,
} from './types.ts'

const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400
const MAX_EDGE = 3_840
const MAX_ERROR_BYTES = 8_192

/** One validated Image API request. */
export interface GenerateImageRequest {
  prompt: string
  size: string
  quality: ImageQuality
  outputFormat: ImageOutputFormat
  outputCompression?: number
  background: ImageBackground
}

/** Final bytes and provider facts from a completed stream. */
export interface GeneratedImage {
  data: Uint8Array
  size: string
  quality: ImageQuality
  outputFormat: ImageOutputFormat
  background: ImageBackground
  usage?: ImageUsageValue
}

/** Progress emitted before the final image is durable. */
export type GenerateImageProgress =
  | { kind: 'requesting'; attempt: number }
  | { kind: 'generating'; attempt: number }
  | { kind: 'partial'; attempt: number; index: number; outputFormat: ImageOutputFormat; data: string }
  | { kind: 'retrying'; attempt: number }

/** Client deployment and retry policy. */
export interface OpenAIImageClientOptions {
  baseUrl: string
  apiKey: string
  model: string
  moderation: 'auto' | 'low'
  partialImages: number
  maxRetries: number
  retryBaseMs: number
  maxImageBytes: number
  protocol?: 'openai-api' | 'codex-subscription'
  accountId?: string
  turnId?: string
  fetchImpl?: typeof fetch
}

interface ProviderEvent {
  type?: unknown
  b64_json?: unknown
  output_format?: unknown
  partial_image_index?: unknown
  size?: unknown
  quality?: unknown
  background?: unknown
  usage?: unknown
  error?: unknown
}

/** HTTP/protocol failure with a stable retry decision. */
export class ImageApiError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly retryable: boolean

  constructor(message: string, options: { status?: number; code?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ImageApiError'
    this.status = options.status
    this.code = options.code
    this.retryable = options.retryable ?? false
  }
}

/** Validate an OpenAI base URL before a credential can be sent to it. */
export function imageApiBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('baseUrl must use https, or http for a loopback host')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('baseUrl must not contain credentials, a query, or a fragment')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !loopback) throw new TypeError('baseUrl must use https outside loopback')
  return url.href.replace(/\/+$/u, '')
}

/** Validate GPT Image 2's automatic or arbitrary-resolution size. */
export function imageSize(value: string): string {
  if (value === 'auto') return value
  const match = /^(\d{2,4})x(\d{2,4})$/u.exec(value)
  if (match === null) throw new TypeError('size must be auto or WIDTHxHEIGHT')
  const width = Number(match[1])
  const height = Number(match[2])
  const pixels = width * height
  if (width % 16 !== 0 || height % 16 !== 0) throw new TypeError('size edges must be divisible by 16')
  if (width > MAX_EDGE || height > MAX_EDGE) throw new TypeError(`size edges must not exceed ${MAX_EDGE}px`)
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
    throw new TypeError(`size must contain ${MIN_PIXELS}–${MAX_PIXELS} pixels`)
  }
  const ratio = width / height
  if (ratio < 1 / 3 || ratio > 3) throw new TypeError('size aspect ratio must be between 1:3 and 3:1')
  return `${width}x${height}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function outputFormat(value: unknown, fallback: ImageOutputFormat): ImageOutputFormat {
  return value === 'png' || value === 'jpeg' || value === 'webp' ? value : fallback
}

function quality(value: unknown, fallback: ImageQuality): ImageQuality {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' ? value : fallback
}

function background(value: unknown, fallback: ImageBackground): ImageBackground {
  return value === 'auto' || value === 'opaque' ? value : fallback
}

function usage(value: unknown): ImageUsageValue | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = value.input_tokens
  const outputTokens = value.output_tokens
  const totalTokens = value.total_tokens
  if (![inputTokens, outputTokens, totalTokens].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)) {
    return undefined
  }
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number }
}

function providerError(value: unknown): { code?: string; message: string } {
  const error = isRecord(value) && isRecord(value.error) ? value.error : isRecord(value) ? value : undefined
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = typeof error?.message === 'string' && error.message.trim() !== '' ? error.message : 'OpenAI Image API request failed.'
  return { ...(code === undefined ? {} : { code }), message }
}

function safeProviderMessage(status: number, value: unknown): ImageApiError {
  const detail = providerError(value)
  if (detail.code === 'moderation_blocked' || detail.code === 'image_generation_user_error') {
    return new ImageApiError(
      detail.code === 'moderation_blocked'
        ? 'Image generation was blocked by the provider safety policy. Revise the prompt and try again.'
        : detail.message,
      { status, ...(detail.code === undefined ? {} : { code: detail.code }) },
    )
  }
  return new ImageApiError(detail.message, {
    status,
    ...(detail.code === undefined ? {} : { code: detail.code }),
    retryable: status === 429 || status >= 500,
  })
}

function base64Bytes(value: string, maximum: number): Uint8Array {
  const maximumChars = Math.ceil(maximum / 3) * 4 + 8
  if (value.length === 0 || value.length > maximumChars || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new ImageApiError('OpenAI returned invalid or oversized image data.')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new ImageApiError('OpenAI returned invalid or oversized image data.')
  }
  return bytes
}

function ssePayload(chunk: string): unknown | undefined {
  const data = chunk
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (data === '' || data === '[DONE]') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch (error) {
    throw new ImageApiError('OpenAI returned malformed streaming JSON.', { cause: error, retryable: true })
  }
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maximumEventChars: number,
  maximumTotalBytes: number,
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let totalBytes = 0
  let reachedEnd = false
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => {
      // Cancellation is best-effort; the read path preserves the operation error.
    })
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) {
        reachedEnd = true
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > maximumTotalBytes) throw new ImageApiError('OpenAI image stream exceeded its byte limit.')
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r', '')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        if (boundary > maximumEventChars) throw new ImageApiError('OpenAI image stream event exceeded its byte limit.')
        const payload = ssePayload(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (payload !== undefined) yield payload
        boundary = buffer.indexOf('\n\n')
      }
      if (buffer.length > maximumEventChars) throw new ImageApiError('OpenAI image stream event exceeded its byte limit.')
    }
    buffer += decoder.decode().replaceAll('\r', '')
    const payload = ssePayload(buffer.trim())
    if (payload !== undefined) yield payload
  } finally {
    signal.removeEventListener('abort', abort)
    if (!reachedEnd) {
      try {
        await reader.cancel(signal.reason)
      } catch {
        // Cancellation is best-effort; parsing and provider errors remain authoritative.
      }
    }
    reader.releaseLock()
  }
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  truncate: boolean,
): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let reachedEnd = false
  let cancelled = false
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => {
      // Cancellation is best-effort; the read path preserves the operation error.
    })
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) {
        reachedEnd = true
        break
      }
      const remaining = maximumBytes - totalBytes
      if (value.byteLength > remaining) {
        if (truncate && remaining > 0) chunks.push(value.subarray(0, remaining))
        cancelled = true
        await reader.cancel('response byte limit reached')
        if (!truncate) throw new ImageApiError('OpenAI JSON response exceeded its byte limit.')
        break
      }
      chunks.push(value)
      totalBytes += value.byteLength
    }
  } finally {
    signal.removeEventListener('abort', abort)
    if (!reachedEnd && !cancelled) {
      try {
        await reader.cancel(signal.reason)
      } catch {
        // Cancellation is best-effort; the read error remains authoritative.
      }
    }
    reader.releaseLock()
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parsedResponse(text: string): unknown {
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text }
  }
}

async function responseErrorBody(response: Response, signal: AbortSignal): Promise<unknown> {
  return parsedResponse(await boundedResponseText(response, MAX_ERROR_BYTES, signal, true))
}

async function responseImageBody(response: Response, signal: AbortSignal, maximumImageBytes: number): Promise<unknown> {
  const maximumJsonBytes = Math.ceil(maximumImageBytes / 3) * 4 + 65_536
  const text = await boundedResponseText(response, maximumJsonBytes, signal, false)
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ImageApiError('OpenAI returned malformed image JSON.', { cause: error, retryable: true })
  }
}

function completedFromEvent(event: ProviderEvent, request: GenerateImageRequest, maximum: number): GeneratedImage | undefined {
  if (event.type !== 'image_generation.completed' || typeof event.b64_json !== 'string') return undefined
  const parsedUsage = usage(event.usage)
  return {
    data: base64Bytes(event.b64_json, maximum),
    size: typeof event.size === 'string' ? event.size : request.size,
    quality: quality(event.quality, request.quality),
    outputFormat: outputFormat(event.output_format, request.outputFormat),
    background: background(event.background, request.background),
    ...(parsedUsage === undefined ? {} : { usage: parsedUsage }),
  }
}

function retryDelay(response: Response | undefined, base: number, attempt: number): number {
  const raw = response?.headers.get('retry-after')
  if (raw !== null && raw !== undefined) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000)
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()))
  }
  return Math.min(10_000, base * (2 ** Math.max(0, attempt - 1)))
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** Direct Image API client with redirect rejection and bounded retries. */
export class OpenAIImageClient {
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly protocol: 'openai-api' | 'codex-subscription'

  constructor(private readonly options: OpenAIImageClientOptions) {
    const baseUrl = imageApiBaseUrl(options.baseUrl)
    this.protocol = options.protocol ?? 'openai-api'
    if (this.protocol === 'codex-subscription') {
      if (baseUrl !== CODEX_IMAGE_BASE_URL) throw new TypeError('Codex subscription credentials may be sent only to the first-party Codex endpoint')
      if (options.accountId === undefined || options.accountId.length === 0 || options.accountId.length > 256) {
        throw new TypeError('Codex subscription mode requires a valid ChatGPT account id')
      }
      if (options.turnId === undefined || options.turnId.length === 0 || options.turnId.length > 512) {
        throw new TypeError('Codex subscription mode requires a valid image turn id')
      }
    }
    this.endpoint = `${baseUrl}/images/generations`
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Generate one image and surface progressive partial frames. */
  async generate(
    request: GenerateImageRequest,
    signal: AbortSignal,
    onProgress: (progress: GenerateImageProgress) => void,
  ): Promise<GeneratedImage> {
    const body = JSON.stringify({
      model: this.options.model,
      prompt: request.prompt,
      size: request.size,
      quality: request.quality,
      background: request.background,
      n: 1,
      ...this.protocol === 'codex-subscription'
        ? {}
        : {
            output_format: request.outputFormat,
            ...request.outputFormat === 'png' || request.outputCompression === undefined
              ? {}
              : { output_compression: request.outputCompression },
            moderation: this.options.moderation,
            stream: true,
            partial_images: this.options.partialImages,
          },
    })

    let lastError: unknown
    for (let attempt = 1; attempt <= this.options.maxRetries + 1; attempt += 1) {
      signal.throwIfAborted()
      onProgress({ kind: 'requesting', attempt })
      let response: Response | undefined
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            accept: this.protocol === 'codex-subscription' ? 'application/json' : 'text/event-stream',
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
            ...this.protocol === 'codex-subscription'
              ? {
                  'chatgpt-account-id': this.options.accountId!,
                  'x-codex-image-turn-id': this.options.turnId!,
                  originator: 'deepseek-harness',
                }
              : {},
          },
          body,
          signal,
        })
        if (!response.ok) throw safeProviderMessage(response.status, await responseErrorBody(response, signal))
        onProgress({ kind: 'generating', attempt })

        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('text/event-stream')) {
          const value = await responseImageBody(response, signal, this.options.maxImageBytes)
          if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0]) || typeof value.data[0].b64_json !== 'string') {
            throw new ImageApiError('OpenAI returned no image.', { retryable: true })
          }
          const parsedUsage = usage(value.usage)
          return {
            data: base64Bytes(value.data[0].b64_json, this.options.maxImageBytes),
            size: typeof value.size === 'string' ? value.size : request.size,
            quality: quality(value.quality, request.quality),
            outputFormat: outputFormat(value.output_format, request.outputFormat),
            background: background(value.background, request.background),
            ...(parsedUsage === undefined ? {} : { usage: parsedUsage }),
          }
        }
        if (response.body === null) throw new ImageApiError('OpenAI returned an empty image stream.', { retryable: true })

        const maximumEventChars = Math.ceil(this.options.maxImageBytes / 3) * 4 + 16_384
        const maximumTotalBytes = (this.options.partialImages + 1) * maximumEventChars + 65_536
        for await (const raw of readSse(response.body, signal, maximumEventChars, maximumTotalBytes)) {
          if (!isRecord(raw)) continue
          const event = raw as ProviderEvent
          if (event.type === 'error') throw safeProviderMessage(502, event)
          if (event.type === 'image_generation.partial_image' && typeof event.b64_json === 'string') {
            base64Bytes(event.b64_json, this.options.maxImageBytes)
            onProgress({
              kind: 'partial',
              attempt,
              index: typeof event.partial_image_index === 'number' ? event.partial_image_index : 0,
              outputFormat: outputFormat(event.output_format, request.outputFormat),
              data: event.b64_json,
            })
          }
          const completed = completedFromEvent(event, request, this.options.maxImageBytes)
          if (completed !== undefined) return completed
        }
        throw new ImageApiError('OpenAI ended the image stream before completion.', { retryable: true })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        lastError = error
        const retryable = error instanceof ImageApiError ? error.retryable : true
        if (!retryable || attempt > this.options.maxRetries) throw error
        onProgress({ kind: 'retrying', attempt })
        await wait(retryDelay(response, this.options.retryBaseMs, attempt), signal)
      }
    }
    throw lastError
  }
}

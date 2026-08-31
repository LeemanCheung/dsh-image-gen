/** Host plugin: GPT Image 2 tool, progressive state, and durable image reads. */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { CODEX_IMAGE_BASE_URL, resolveCodexSubscriptionAuth } from './codex.ts'
import {
  ImageApiError,
  type ImageGenerationInput,
  OpenAIImageClient,
  imageApiBaseUrl,
  imageSize,
} from './openai.ts'
import { IMAGE_GEN_RPC_CHANNEL, IMAGE_GEN_RPC_ENDPOINT } from './rpc.ts'
import {
  PRESENTATION_SCHEMA,
  REFERENCE_MARKER,
  REFERENCE_SCHEMA,
  RESULT_SCHEMA,
  type ImageBackground,
  type ImageGenerationValue,
  type ImageMediaType,
  type ImageOutputFormat,
  type ImagePartialValue,
  type ImagePresentationValue,
  type ImageProgressValue,
  type ImageReferenceValue,
  type ImageQuality,
  type ImageRefValue,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'image-gen'

/** Required Host services. */
export const inject = ['tools', 'attachments', 'credentials', 'connection', 'sessionPersistence']

/** Deployment configuration for provider access, defaults, and operation bounds. */
export interface Config {
  authMode: 'auto' | 'codex-subscription' | 'api-key'
  apiKeyEnv: string
  baseUrl: string
  model: string
  defaultSize: string
  defaultQuality: ImageQuality
  defaultOutputFormat: ImageOutputFormat
  defaultOutputCompression: number
  defaultBackground: ImageBackground
  moderation: 'auto' | 'low'
  partialImages: number
  requestTimeoutMs: number
  maxRetries: number
  retryBaseMs: number
  maxConcurrent: number
}

/** Cordis configuration schema. */
export const Config: Schema<Config> = Schema.object({
  authMode: Schema.union(['auto', 'codex-subscription', 'api-key']).default('auto'),
  apiKeyEnv: Schema.string().default('OPENAI_API_KEY'),
  baseUrl: Schema.string().default('https://api.openai.com/v1'),
  model: Schema.string().default('gpt-image-2'),
  defaultSize: Schema.string().default('auto'),
  defaultQuality: Schema.union(['auto', 'low', 'medium', 'high']).default('auto'),
  defaultOutputFormat: Schema.union(['png', 'jpeg', 'webp']).default('png'),
  defaultOutputCompression: Schema.number().min(0).max(100).step(1).default(90),
  defaultBackground: Schema.union(['auto', 'opaque', 'transparent']).default('auto'),
  moderation: Schema.union(['auto', 'low']).default('auto'),
  partialImages: Schema.number().min(0).max(3).step(1).default(3),
  requestTimeoutMs: Schema.number().min(10_000).max(300_000).step(1).default(120_000),
  maxRetries: Schema.number().min(0).max(5).step(1).default(2),
  retryBaseMs: Schema.number().min(100).max(30_000).step(1).default(1_000),
  maxConcurrent: Schema.number().min(1).max(8).step(1).default(2),
})

interface ActiveGeneration {
  sessionId: string
  callId: string
  revision: number
  attempt: number
  startedAt: number
  state: Exclude<ImageProgressValue['state'], 'missing'>
  partial?: ImagePartialValue
}

interface ImageArguments {
  prompt: string
  size?: string
  quality?: ImageQuality
  output_format?: ImageOutputFormat
  output_compression?: number
  background?: ImageBackground
  reference_image_path?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
}

function normalizedReferenceImagePath(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('reference_image_path must be a string')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 4_096) {
    throw new Error('reference_image_path must contain 1–4096 characters')
  }
  return normalized
}

function imageRefValue(ref: ImageAttachmentRef): ImageRefValue {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType as ImageRefValue['mediaType'],
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

function attachmentRef(value: ImageRefValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(value.name === undefined ? {} : { name: value.name }),
  }
}

function mediaType(format: ImageOutputFormat): ImageRefValue['mediaType'] {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}

function extension(format: ImageOutputFormat): string {
  return format === 'jpeg' ? 'jpg' : format
}

function referenceMediaType(filePath: string): ImageMediaType | undefined {
  switch (extname(filePath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    default: return undefined
  }
}

interface PreparedReferenceImage {
  input: ImageGenerationInput
  save: { data: Uint8Array, mediaType: ImageMediaType, name: string }
}

async function referenceImageFromPath(ctx: Context, exec: ToolExecution, filePath: string): Promise<PreparedReferenceImage> {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('reference_image_path requires a DSH filesystem provider')
  const mediaType = referenceMediaType(filePath)
  if (mediaType === undefined) throw new Error('reference_image_path must name a PNG, JPEG, or WebP image')
  const cwd = exec.agent?.session.header.cwd
  const target = await fs.resolve(filePath, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal })
  const info = await fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') throw new Error(`reference_image_path cannot read "${filePath}" as a regular file`)
  const data = await fs.readBytes(target, exec.signal, ctx.attachments.imageLimits.maxImageBytes)
  const name = basename(filePath)
  await ctx.attachments.validateImage({ data, mediaType, name })
  return {
    input: { data, mediaType, name },
    save: { data, mediaType, name },
  }
}

function promptName(prompt: string, format: ImageOutputFormat): string {
  const stem = prompt
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48)
    .toLowerCase() || 'generated-image'
  return `${stem}.${extension(format)}`
}

function imageRef(value: unknown): ImageRefValue | undefined {
  if (!isRecord(value)
    || typeof value.attachmentId !== 'string'
    || (value.mediaType !== 'image/png' && value.mediaType !== 'image/jpeg' && value.mediaType !== 'image/webp')
    || typeof value.bytes !== 'number'
    || typeof value.width !== 'number'
    || typeof value.height !== 'number') return undefined
  return value as unknown as ImageRefValue
}

function presentation(value: unknown): ImagePresentationValue | undefined {
  if (!isRecord(value) || value.schema !== PRESENTATION_SCHEMA || !isRecord(value.result)) return undefined
  const result = value.result
  if (result.schema !== RESULT_SCHEMA || typeof result.callId !== 'string' || imageRef(result.image) === undefined) return undefined
  return value as unknown as ImagePresentationValue
}

function referenceValue(value: ImageGenerationValue): ImageReferenceValue {
  return {
    schema: REFERENCE_SCHEMA,
    callId: value.callId,
    model: value.model,
    image: value.image,
    ...(value.referenceImage === undefined ? {} : { referenceImage: value.referenceImage }),
    size: value.size,
    quality: value.quality,
    ...(value.requestedSize === undefined ? {} : { requestedSize: value.requestedSize }),
    ...(value.requestedQuality === undefined ? {} : { requestedQuality: value.requestedQuality }),
    ...(value.providerSize === undefined ? {} : { providerSize: value.providerSize }),
    ...(value.qualitySource === undefined ? {} : { qualitySource: value.qualitySource }),
    outputFormat: value.outputFormat,
    background: value.background,
    elapsedMs: value.elapsedMs,
    ...(value.usage === undefined ? {} : { usage: value.usage }),
  }
}

function referenceFromText(value: unknown): ImageReferenceValue | undefined {
  if (typeof value !== 'string') return undefined
  const start = value.indexOf(REFERENCE_MARKER)
  if (start < 0) return undefined
  const line = value.slice(start + REFERENCE_MARKER.length).split('\n', 1)[0]
  if (line === undefined || line.length > 2_048) return undefined
  try {
    const parsed = JSON.parse(line) as unknown
    if (!isRecord(parsed) || parsed.schema !== REFERENCE_SCHEMA || typeof parsed.callId !== 'string' || imageRef(parsed.image) === undefined) return undefined
    return parsed as unknown as ImageReferenceValue
  } catch {
    return undefined
  }
}

function referenceFromContent(content: unknown): ImageReferenceValue | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') continue
    const parsed = referenceFromText(block.text)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function authorizedImage(events: readonly unknown[], callId: string): ImageRefValue | undefined {
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.data)) continue
    if (event.type === 'tool/result') {
      const meta = presentation(event.data.meta)
      if (meta !== undefined && meta.result.callId === callId) return meta.result.image
    }
    if (event.type === 'tool/code-dispatch' && event.data.name === 'image_gen' && event.data.subCallId === callId) {
      const marker = referenceFromContent(event.data.content)
      if (marker !== undefined && marker.callId === callId) return marker.image
    }
  }
  return undefined
}

function rpcError(reason: string, message: string) {
  return { ok: false as const, error: { code: 'attachment-error' as const, message, details: { reason } } }
}

function progressOf(entry: ActiveGeneration | undefined): ImageProgressValue {
  if (entry === undefined) return { state: 'missing', revision: 0, attempt: 0, startedAt: 0 }
  return {
    state: entry.state,
    revision: entry.revision,
    attempt: entry.attempt,
    startedAt: entry.startedAt,
    ...(entry.partial === undefined ? {} : { partial: entry.partial }),
  }
}

function validateConfig(config: Config): void {
  imageApiBaseUrl(config.baseUrl)
  imageSize(config.defaultSize)
  credentialRef(config.apiKeyEnv)
  if (config.model.trim() === '') throw new TypeError('model must not be blank')
}

/** Register the image tool and its loopback progress/image channel. */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  const active = new Map<string, ActiveGeneration>()
  const inFlight = new Set<Promise<void>>()
  const lifetime = new AbortController()
  let stopping = false
  const keyOf = (sessionId: string, callId: string): string => `${sessionId}\u0000${callId}`
  const trackBackgroundWork = (work: Promise<unknown>): void => {
    const settled = work.then(() => {}, () => {})
    inFlight.add(settled)
    void settled.finally(() => { inFlight.delete(settled) })
  }
  const resolveImageAuth = async (signal: AbortSignal, apiKeyReason?: string): Promise<
    | { kind: 'codex-subscription'; apiKey: string; accountId: string }
    | { kind: 'api-key'; apiKey: string }
  > => {
    if (apiKeyReason !== undefined && config.authMode === 'codex-subscription') {
      throw new Error(`${apiKeyReason} requires authMode auto with an API key fallback, or authMode api-key`)
    }
    let codexError: unknown
    if (apiKeyReason === undefined && config.authMode !== 'api-key') {
      try {
        const auth = await resolveCodexSubscriptionAuth(signal, undefined, undefined, undefined, trackBackgroundWork)
        return { kind: 'codex-subscription', apiKey: auth.accessToken, accountId: auth.accountId }
      } catch (error) {
        signal.throwIfAborted()
        codexError = error
        if (config.authMode === 'codex-subscription') throw error
      }
    }
    const resolved = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv))
    signal.throwIfAborted()
    if (resolved !== undefined) return { kind: 'api-key', apiKey: resolved.value }
    if (codexError instanceof Error) throw new Error(`${codexError.message} No ${config.apiKeyEnv} fallback is configured.`, { cause: codexError })
    throw new Error(`No credential is configured for ${config.apiKeyEnv}. Store it in DSH credentials or export it before starting DSH.`)
  }

  ctx.effect(() => async () => {
    stopping = true
    lifetime.abort(new DOMException('dsh-image-gen was unloaded', 'AbortError'))
    await Promise.allSettled([...inFlight])
  }, 'image-gen: abort and drain active generations')

  const uploadOrigin = new URL(imageApiBaseUrl(config.baseUrl)).origin
  ctx.on('tools/pre-execute', async (execution, next): Promise<PreToolDecision> => {
    if (execution.name !== 'image_gen' || !isRecord(execution.arguments)) return next()
    let referencePath: string | undefined
    try {
      referencePath = normalizedReferenceImagePath(execution.arguments.reference_image_path)
    } catch (error) {
      return { kind: 'deny', reason: error instanceof Error ? error.message : 'reference_image_path is invalid' }
    }
    if (referencePath === undefined) return next()
    return {
      kind: 'ask',
      reason: `Upload reference image "${basename(referencePath)}" to ${uploadOrigin} for this image edit.`,
    }
  })

  ctx.effect(() => ctx.connection.rpc.handle(
    IMAGE_GEN_RPC_CHANNEL,
    async (endpoint, payload, signal) => {
      if (!isRecord(payload)) return rpcError('invalid-request', 'A JSON object is required.')
      const sessionId = safeString(payload.sessionId, 256)
      const callId = safeString(payload.callId, 512)
      if (sessionId === undefined || callId === undefined) {
        return rpcError('invalid-request', 'Valid sessionId and callId values are required.')
      }
      if (endpoint === IMAGE_GEN_RPC_ENDPOINT.progress) {
        return { ok: true, value: progressOf(active.get(keyOf(sessionId, callId))) }
      }
      if (endpoint !== IMAGE_GEN_RPC_ENDPOINT.image) {
        return rpcError('unknown-endpoint', `Unknown image generation endpoint: ${endpoint}`)
      }
      let inspection
      try {
        inspection = await ctx.sessionPersistence.inspect(SessionId(sessionId), signal)
      } catch {
        return rpcError('image-unavailable', 'The image session could not be inspected.')
      }
      const ref = authorizedImage(inspection.events, callId)
      if (ref === undefined) return rpcError('image-unavailable', 'The image is not authorized by this session.')
      try {
        const stored = await ctx.attachments.readImage(attachmentRef(ref), signal)
        return {
          ok: true,
          value: {
            attachment: imageRefValue(stored.ref),
            data: Buffer.from(stored.data).toString('base64'),
          },
        }
      } catch {
        return rpcError('image-unavailable', 'The generated image could not be read.')
      }
    },
    { authority: 'loopback' },
  ), 'image-gen: loopback progress and image RPC')

  ctx.tools.register(defineTool({
    name: 'image_gen',
    description: 'Generate one new image with OpenAI GPT Image 2 using the signed-in Codex subscription by default, with API-key fallback when configured. Set reference_image_path to make an API-key image edit from a PNG, JPEG, or WebP reference; every reference upload requires one-time user approval. Use this when the user asks to create, draw, render, illustrate, or design an image. The result appears in an animated DSH image card with preview and download.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Detailed image prompt. Preserve user constraints and describe subject, composition, style, lighting, palette, text, and exclusions as relevant.',
      },
      reference_image_path: {
        type: 'string',
        description: 'Optional PNG, JPEG, or WebP reference path. Requires one-time user approval, uses the API-key image-edit endpoint, and cannot run through a Codex subscription.',
      },
      size: {
        type: 'string',
        description: 'auto or WIDTHxHEIGHT. Edges must be divisible by 16, at most 3840px, 1:3–3:1, and 655360–8294400 total pixels.',
      },
      quality: {
        type: 'string',
        enum: ['auto', 'low', 'medium', 'high'],
        description: 'Image quality. Omit for deployment default.',
      },
      output_format: {
        type: 'string',
        enum: ['png', 'jpeg', 'webp'],
        description: 'Output format. Codex subscription mode accepts PNG only; JPEG/WebP require API-key mode. Omit for deployment default.',
      },
      output_compression: {
        type: 'integer',
        description: 'API-key mode only: JPEG/WebP compression quality from 0 to 100. Do not set for PNG.',
      },
      background: {
        type: 'string',
        enum: ['auto', 'opaque', 'transparent'],
        description: 'Background behavior. Transparent is an API-key Image API preview feature and requires PNG or WebP.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schema: { type: 'string', const: RESULT_SCHEMA, required: true },
          callId: { type: 'string', required: true },
          model: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          referenceImage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          size: { type: 'string', required: true },
          quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], required: true },
          requestedSize: { type: 'string' },
          requestedQuality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
          providerSize: { type: 'string' },
          qualitySource: { type: 'string', enum: ['provider', 'request'] },
          outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'], required: true },
          background: { type: 'string', enum: ['auto', 'opaque', 'transparent'], required: true },
          elapsedMs: { type: 'integer', required: true },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer', required: true },
              outputTokens: { type: 'integer', required: true },
              totalTokens: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Generated an image with ${value.model} (${value.image.width}×${value.image.height}, ${value.outputFormat.toUpperCase()}, ${(value.elapsedMs / 1000).toFixed(1)}s). The image is available in the DSH card for preview and download.\n${REFERENCE_MARKER}${JSON.stringify(referenceValue(value as ImageGenerationValue))}`,
      }],
      presentationMeta: (_args, value) => ({ schema: PRESENTATION_SCHEMA, result: value }),
    },
    finalizeContent(exec, result) {
      if (exec.parent !== undefined || result.isError) return undefined
      let changed = false
      const content = result.content.map((block) => {
        if (block.type !== 'text') return block
        const marker = block.text.indexOf(`\n${REFERENCE_MARKER}`)
        if (marker < 0) return block
        changed = true
        return { type: 'text' as const, text: block.text.slice(0, marker) }
      })
      return changed ? content : undefined
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: 'Generate image', kind: 'other', rawInput: { prompt: args.prompt, size: args.size ?? config.defaultSize } }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Image generation failed' : 'Generated image' }),
    async execute(args: ImageArguments, exec): Promise<ImageGenerationValue> {
      const sessionId = exec.agent?.session.header.id
      if (sessionId === undefined) throw new Error('image_gen requires a calling DSH agent session')
      if (stopping) throw new DOMException('dsh-image-gen is stopping', 'AbortError')
      const prompt = args.prompt.trim()
      if (prompt.length === 0 || prompt.length > 32_000) throw new Error('prompt must contain 1–32000 characters')
      const referenceImagePath = normalizedReferenceImagePath(args.reference_image_path)
      const size = imageSize(args.size ?? config.defaultSize)
      const quality = args.quality ?? config.defaultQuality
      const outputFormat = args.output_format ?? config.defaultOutputFormat
      const requestBackground = args.background ?? config.defaultBackground
      const outputCompression = args.output_compression ?? config.defaultOutputCompression
      if (!Number.isSafeInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
        throw new Error('output_compression must be a whole number from 0 to 100')
      }
      if (outputFormat === 'png' && args.output_compression !== undefined) {
        throw new Error('output_compression is supported only for JPEG and WebP')
      }
      if (requestBackground === 'transparent' && outputFormat === 'jpeg') {
        throw new Error('transparent backgrounds require PNG or WebP output')
      }
      if (Buffer.byteLength(prompt, 'utf8') > 64_000) throw new Error('prompt must not exceed 64000 UTF-8 bytes')
      if (active.size >= config.maxConcurrent) throw new Error('Too many image generations are already running. Try again after one finishes.')

      const callId = String(exec.callId)
      const operationKey = keyOf(String(sessionId), callId)
      const entry: ActiveGeneration = {
        sessionId: String(sessionId),
        callId,
        revision: 1,
        attempt: 1,
        startedAt: Date.now(),
        state: 'requesting',
      }
      active.set(operationKey, entry)
      let finishOperation: (() => void) | undefined
      const operationDone = new Promise<void>(resolve => { finishOperation = resolve })
      inFlight.add(operationDone)
      const requestSignal = AbortSignal.any([lifetime.signal, exec.signal, AbortSignal.timeout(config.requestTimeoutMs)])

      try {
        const apiKeyReason = referenceImagePath !== undefined
          ? 'reference_image_path'
          : outputFormat !== 'png'
            ? `${outputFormat.toUpperCase()} output`
            : requestBackground === 'transparent'
              ? 'transparent background output'
              : args.output_compression !== undefined
                ? 'output_compression'
                : undefined
        const auth = await resolveImageAuth(requestSignal, apiKeyReason)
        requestSignal.throwIfAborted()
        const reference = referenceImagePath === undefined ? undefined : await referenceImageFromPath(ctx, exec, referenceImagePath)
        requestSignal.throwIfAborted()
        const requestOutputFormat = auth.kind === 'codex-subscription' ? 'png' : outputFormat
        if (auth.kind === 'codex-subscription' && requestOutputFormat !== 'png') {
          throw new Error('Codex subscription image generation currently returns PNG. Set output_format to png or omit it.')
        }
        if (auth.kind === 'codex-subscription' && args.output_compression !== undefined) {
          throw new Error('output_compression is available only in API-key mode')
        }
        const requestModel = auth.kind === 'codex-subscription' ? 'gpt-image-2' : config.model
        const client = new OpenAIImageClient({
          baseUrl: auth.kind === 'codex-subscription' ? CODEX_IMAGE_BASE_URL : config.baseUrl,
          apiKey: auth.apiKey,
          model: requestModel,
          moderation: config.moderation,
          partialImages: auth.kind === 'codex-subscription' ? 0 : config.partialImages,
          maxRetries: config.maxRetries,
          retryBaseMs: config.retryBaseMs,
          maxImageBytes: ctx.attachments.imageLimits.maxImageBytes,
          protocol: auth.kind === 'codex-subscription' ? 'codex-subscription' : 'openai-api',
          ...(auth.kind === 'codex-subscription' ? { accountId: auth.accountId, turnId: callId } : {}),
        })
        const generated = await client.generate({
          prompt,
          size,
          quality,
          outputFormat: requestOutputFormat,
          ...(requestOutputFormat === 'png' ? {} : { outputCompression }),
          background: requestBackground,
          ...(reference === undefined ? {} : { referenceImage: reference.input }),
        }, requestSignal, (progress) => {
          entry.revision += 1
          entry.attempt = progress.attempt
          if (progress.kind === 'requesting' || progress.kind === 'retrying') {
            entry.state = 'requesting'
            delete entry.partial
          } else entry.state = 'generating'
          if (progress.kind === 'partial') {
            entry.partial = { index: progress.index, format: progress.outputFormat, data: progress.data }
          }
        })
        entry.state = 'saving'
        entry.revision += 1
        requestSignal.throwIfAborted()
        const finalInput = {
          data: generated.data,
          mediaType: mediaType(generated.outputFormat),
          name: promptName(prompt, generated.outputFormat),
        }
        const saved = await ctx.attachments.saveImages([
          finalInput,
          ...(reference === undefined ? [] : [reference.save]),
        ])
        const ref = saved[0]
        const referenceRef = saved[1]
        if (ref === undefined || (reference !== undefined && referenceRef === undefined)) {
          throw new Error('The attachment service did not return every saved image reference.')
        }
        requestSignal.throwIfAborted()
        return {
          schema: RESULT_SCHEMA,
          callId,
          model: requestModel,
          prompt,
          image: imageRefValue(ref),
          ...(referenceRef === undefined ? {} : { referenceImage: imageRefValue(referenceRef) }),
          size: `${ref.width}x${ref.height}`,
          quality: generated.quality,
          requestedSize: size,
          requestedQuality: quality,
          ...(generated.sizeSource === 'provider' ? { providerSize: generated.size } : {}),
          qualitySource: generated.qualitySource,
          outputFormat: generated.outputFormat,
          background: generated.background,
          elapsedMs: Math.max(0, Date.now() - entry.startedAt),
          ...(generated.usage === undefined ? {} : { usage: generated.usage }),
        }
      } catch (error) {
        if (error instanceof ImageApiError) {
          ctx.logger.warn(`image_gen provider failure${error.code === undefined ? '' : ` (${error.code})`}: ${error.message}`)
        }
        throw error
      } finally {
        active.delete(operationKey)
        finishOperation?.()
        inFlight.delete(operationDone)
      }
    },
  }))
}

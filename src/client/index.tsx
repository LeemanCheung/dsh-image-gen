/** Browser plugin: animated progressive image-generation tool card. */

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { IMAGE_GEN_RPC_CHANNEL, IMAGE_GEN_RPC_ENDPOINT } from '../rpc.ts'
import {
  PRESENTATION_SCHEMA,
  REFERENCE_MARKER,
  REFERENCE_SCHEMA,
  RESULT_SCHEMA,
  type ImageGenerationValue,
  type ImagePresentationValue,
  type ImageProgressValue,
  type ImageReferenceValue,
  type ImageRefValue,
} from '../types.ts'
import { IMAGE_GEN_STYLES } from './styles.ts'

const NS = 'dsh.imageGen' as const
const POLL_MS = 650

const en = {
  generating: 'Generating image',
  generated: 'Generated image',
  edited: 'Edited image',
  failed: 'Image generation failed',
  requesting: 'Contacting GPT Image 2',
  rendering: 'Rendering pixels',
  saving: 'Saving final image',
  waiting: 'Preparing the canvas',
  ready: 'Final image saved',
  draft: 'Live draft',
  preview: 'Preview',
  download: 'Download',
  close: 'Close',
  details: 'Prompt & details',
  requested: 'Requested',
  unverified: 'unverified',
  loading: 'Loading final image',
  unavailable: 'The generated image is unavailable. Reload the page or check Host logs.',
  noOutput: 'The provider did not return a usable image.',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  generating: '正在生成图片',
  generated: '图片已生成',
  edited: '图片编辑已完成',
  failed: '图片生成失败',
  requesting: '正在连接 GPT Image 2',
  rendering: '正在渲染像素',
  saving: '正在保存最终图片',
  waiting: '正在准备画布',
  ready: '最终图片已保存',
  draft: '实时草图',
  preview: '预览',
  download: '下载',
  close: '关闭',
  details: '提示词与详情',
  requested: '请求参数',
  unverified: '未核验',
  loading: '正在加载最终图片',
  unavailable: '无法读取已生成图片。请刷新页面或查看 Host 日志。',
  noOutput: '服务未返回可用图片。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image generation tool-card copy. */
    'dsh.imageGen': LocaleKey
  }
}

type Translate = (key: LocaleKey) => string

interface ImageGenCardInjectedProps {
  sessionId: SessionId
  t: Translate
  requestProgress: (sessionId: SessionId, callId: string, signal: AbortSignal) => Promise<ImageProgressValue>
  requestImage: (sessionId: SessionId, callId: string, signal: AbortSignal) => Promise<{ attachment: ImageRefValue; data: string }>
}

type ImageGenCardProps = ToolCallViewProps & ImageGenCardInjectedProps

interface ParsedArgs {
  prompt: string
  size: string
  quality: string
  outputFormat: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function argsOf(block: ToolCallBlock): ParsedArgs {
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (raw === null || raw === undefined) return { prompt: '', size: 'auto', quality: 'auto', outputFormat: 'png' }
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) throw new Error('not an object')
    return {
      prompt: typeof value.prompt === 'string' ? value.prompt : '',
      size: typeof value.size === 'string' ? value.size : 'auto',
      quality: typeof value.quality === 'string' ? value.quality : 'auto',
      outputFormat: typeof value.output_format === 'string' ? value.output_format : 'png',
    }
  } catch {
    return { prompt: '', size: 'auto', quality: 'auto', outputFormat: 'png' }
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
    if (!isRecord(parsed) || parsed.schema !== REFERENCE_SCHEMA || typeof parsed.callId !== 'string' || !isRecord(parsed.image)) return undefined
    return parsed as unknown as ImageReferenceValue
  } catch {
    return undefined
  }
}

function presentationOf(block: ToolCallBlock): ImagePresentationValue | undefined {
  if (!('kind' in block)) return undefined
  if (isRecord(block.meta) && block.meta.schema === PRESENTATION_SCHEMA && isRecord(block.meta.result)) {
    const result = block.meta.result
    if (result.schema === RESULT_SCHEMA && isRecord(result.image) && result.callId === block.callId) {
      return block.meta as unknown as ImagePresentationValue
    }
  }
  const marker = block.content
    .filter(item => item.type === 'text')
    .map(item => item.type === 'text' ? referenceFromText(item.text) : undefined)
    .find((item): item is ImageReferenceValue => item !== undefined && item.callId === block.callId)
  if (marker === undefined) return undefined
  const args = argsOf(block)
  return {
    schema: PRESENTATION_SCHEMA,
    result: {
      schema: RESULT_SCHEMA,
      callId: marker.callId,
      model: marker.model,
      prompt: args.prompt,
      image: marker.image,
      ...(marker.referenceImage === undefined ? {} : { referenceImage: marker.referenceImage }),
      size: marker.size,
      quality: marker.quality,
      ...(marker.requestedSize === undefined ? {} : { requestedSize: marker.requestedSize }),
      ...(marker.requestedQuality === undefined ? {} : { requestedQuality: marker.requestedQuality }),
      ...(marker.providerSize === undefined ? {} : { providerSize: marker.providerSize }),
      ...(marker.qualitySource === undefined ? {} : { qualitySource: marker.qualitySource }),
      outputFormat: marker.outputFormat,
      background: marker.background,
      elapsedMs: marker.elapsedMs,
      ...(marker.usage === undefined ? {} : { usage: marker.usage }),
    },
  }
}

function resultError(block: ToolCallBlock, fallback: string): string {
  if (!('kind' in block) || !block.isError) return ''
  const text = block.content
    .filter(item => item.type === 'text')
    .map(item => item.type === 'text' ? item.text : '')
    .join('\n')
    .trim()
  return text || fallback
}

function dataUrl(format: string, data: string): string {
  const mime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`
  return `data:${mime};base64,${data}`
}

function finalImageUrl(mediaType: string, data: string): string {
  if (typeof URL.createObjectURL !== 'function') return `data:${mediaType};base64,${data}`
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes], { type: mediaType }))
}

function aspectRatio(args: ParsedArgs, result: ImageGenerationValue | undefined): number {
  if (result !== undefined && result.image.width > 0 && result.image.height > 0) return result.image.width / result.image.height
  const match = /^(\d+)x(\d+)$/u.exec(args.size)
  if (match === null) return 1
  return Math.min(3, Math.max(1 / 3, Number(match[1]) / Number(match[2])))
}

function elapsedLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function ImageMark() {
  return (
    <span className="dshImageGen__mark" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.8l1.6 5.1L19 9.5l-5.4 1.7L12 16.3l-1.6-5.1L5 9.5l5.4-1.6L12 2.8Z" fill="currentColor"/><path d="M18.2 14.3l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7Z" fill="currentColor" opacity=".72"/></svg>
    </span>
  )
}

/** The session-scoped progressive card for one image_gen call. */
function ImageGenCard({ sessionId, callId, block, t, requestProgress, requestImage }: ImageGenCardProps) {
  const args = useMemo(() => argsOf(block), [block])
  const presentation = useMemo(() => presentationOf(block), [block])
  const settled = 'kind' in block
  const failed = settled && (block.isError || presentation === undefined)
  const [progress, setProgress] = useState<ImageProgressValue | undefined>()
  const [finalImage, setFinalImage] = useState<string | undefined>()
  const [loadError, setLoadError] = useState(false)
  const [lightbox, setLightbox] = useState(false)

  useEffect(() => {
    if (settled) return
    const controller = new AbortController()
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await requestProgress(sessionId, callId, controller.signal)
        if (!live) return
        setProgress(next)
      } catch {
        if (!controller.signal.aborted && live) setProgress(undefined)
      }
      if (live) timer = setTimeout(() => { void poll() }, POLL_MS)
    }
    void poll()
    return () => {
      live = false
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [callId, requestProgress, sessionId, settled])

  useEffect(() => {
    if (presentation === undefined) return
    const controller = new AbortController()
    let live = true
    let objectUrl: string | undefined
    setLoadError(false)
    setFinalImage(undefined)
    void requestImage(sessionId, callId, controller.signal).then(({ attachment, data }) => {
      if (!live) return
      objectUrl = finalImageUrl(attachment.mediaType, data)
      setFinalImage(objectUrl)
    }).catch(() => { if (live) setLoadError(true) })
    return () => {
      live = false
      controller.abort()
      if (objectUrl?.startsWith('blob:') === true) URL.revokeObjectURL(objectUrl)
    }
  }, [callId, presentation, requestImage, sessionId])

  useEffect(() => {
    if (!lightbox) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setLightbox(false) }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close) }
  }, [lightbox])

  const result = presentation?.result
  const prompt = result?.prompt || args.prompt
  const partial = !settled && progress?.partial !== undefined
    ? dataUrl(progress.partial.format, progress.partial.data)
    : undefined
  const src = finalImage ?? partial
  const ratio = aspectRatio(args, result)
  const state = failed ? 'error' : settled ? 'done' : 'running'
  const phase = progress?.state === 'requesting'
    ? t('requesting')
    : progress?.state === 'generating'
      ? t('rendering')
      : progress?.state === 'saving'
        ? t('saving')
        : settled && finalImage !== undefined
          ? t('ready')
          : settled && presentation !== undefined && !loadError
            ? t('loading')
            : t('waiting')
  const title = failed
    ? t('failed')
    : settled
      ? result?.referenceImage === undefined ? t('generated') : t('edited')
      : t('generating')
  const startedAt = progress?.startedAt || ('time' in block ? block.time : Date.now())
  const elapsed = result?.elapsedMs ?? Math.max(0, Date.now() - startedAt)
  const error = failed
    ? settled && block.isError ? resultError(block, t('noOutput')) : t('noOutput')
    : loadError ? t('unavailable') : ''
  const filename = result?.image.name ?? `gpt-image-2.${result?.outputFormat === 'jpeg' ? 'jpg' : result?.outputFormat ?? args.outputFormat}`
  const sizeLabel = result === undefined ? args.size : `${result.image.width}x${result.image.height}`
  const qualityLabel = result === undefined
    ? args.quality
    : result.qualitySource === 'provider'
      ? result.quality
      : `${result.quality} (${result.qualitySource === 'request' ? t('requested').toLowerCase() : t('unverified')})`

  const download = (): void => {
    if (finalImage === undefined) return
    const anchor = document.createElement('a')
    anchor.href = finalImage
    anchor.download = filename
    anchor.click()
  }

  return (
    <article className="dshImageGen" data-state={state} aria-busy={!settled}>
      <header className="dshImageGen__header">
        <ImageMark />
        <div className="dshImageGen__heading">
          <div className="dshImageGen__title">{title}</div>
          <div className="dshImageGen__subtitle">{failed ? 'GPT Image 2' : phase}</div>
        </div>
        <span className="dshImageGen__state"><span className="dshImageGen__dot" />{elapsedLabel(elapsed)}</span>
      </header>

      <div className="dshImageGen__stage" style={{ '--ig-ratio': String(ratio) } as CSSProperties}>
        {!settled && <><span className="dshImageGen__scan" /><span className="dshImageGen__orb" /></>}
        {src !== undefined && <img key={src.slice(-32)} className="dshImageGen__image" src={src} alt={prompt || title} />}
        {partial !== undefined && finalImage === undefined && <span className="dshImageGen__draft">{t('draft')}</span>}
        {error !== '' && <div className="dshImageGen__error" role="alert">{error}</div>}
      </div>

      <footer className="dshImageGen__footer">
        <div className="dshImageGen__prompt">{prompt || title}</div>
        <div className="dshImageGen__meta">
          <span className="dshImageGen__chip">{sizeLabel}</span>
          <span className="dshImageGen__chip">{qualityLabel}</span>
          <span className="dshImageGen__chip">{(result?.outputFormat ?? args.outputFormat).toUpperCase()}</span>
          {progress !== undefined && progress.attempt > 1 && <span className="dshImageGen__chip">attempt {progress.attempt}</span>}
          {finalImage !== undefined && (
            <span className="dshImageGen__actions">
              <button type="button" className="dshImageGen__button" onClick={() => { setLightbox(true) }}>{t('preview')}</button>
              <button type="button" className="dshImageGen__button" onClick={download}>{t('download')}</button>
            </span>
          )}
        </div>
        <details className="dshImageGen__details">
          <summary>{t('details')}</summary>
          <p>{prompt}</p>
          {result?.requestedSize !== undefined && result.requestedQuality !== undefined && (
            <p>{`${t('requested')}: ${result.requestedSize} · ${result.requestedQuality}`}</p>
          )}
          {result?.usage !== undefined && <p>{`${result.model} · ${result.usage.totalTokens} tokens · ${elapsedLabel(result.elapsedMs)}`}</p>}
        </details>
      </footer>

      {lightbox && finalImage !== undefined && (
        <div className="dshImageGen__lightbox" role="dialog" aria-modal="true" aria-label={t('preview')} onClick={() => { setLightbox(false) }}>
          <img src={finalImage} alt={prompt || title} onClick={event => { event.stopPropagation() }} />
          <button type="button" className="dshImageGen__button" onClick={() => { setLightbox(false) }}>{t('close')}</button>
        </div>
      )}
    </article>
  )
}

function decodeProgress(value: unknown): ImageProgressValue {
  if (!isRecord(value)
    || (value.state !== 'missing' && value.state !== 'requesting' && value.state !== 'generating' && value.state !== 'saving')
    || typeof value.revision !== 'number'
    || typeof value.attempt !== 'number'
    || typeof value.startedAt !== 'number') throw new Error('Host returned invalid image progress')
  return value as unknown as ImageProgressValue
}

function decodeImage(value: unknown): { attachment: ImageRefValue; data: string } {
  if (!isRecord(value) || !isRecord(value.attachment) || typeof value.data !== 'string') {
    throw new Error('Host returned invalid image data')
  }
  return value as unknown as { attachment: ImageRefValue; data: string }
}

/** Register the localized keyed tool card and its lifecycle-owned CSS. */
export const inject = ['slots', 'locale', 'connection']

/** Browser Cordis plugin entry. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('dsh-image-gen requires the Client connection service')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-image-gen: locale dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-image-gen'
    style.textContent = IMAGE_GEN_STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-image-gen: card styles')
  const t = ctx.locale.bind(NS) as Translate
  const call = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    if (!connection.isLoopback) throw new Error('Image previews are available only from the local DSH page')
    const result = await connection.rpc.call(IMAGE_GEN_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'image_gen',
    locale: NS,
    inject: (sessionId) => ({
      sessionId,
      t,
      requestProgress: async (sessionId: SessionId, callId: string, signal: AbortSignal) => decodeProgress(
        await call(IMAGE_GEN_RPC_ENDPOINT.progress, { sessionId: String(sessionId), callId }, signal),
      ),
      requestImage: async (sessionId: SessionId, callId: string, signal: AbortSignal) => decodeImage(
        await call(IMAGE_GEN_RPC_ENDPOINT.image, { sessionId: String(sessionId), callId }, signal),
      ),
    }),
  }, ImageGenCard))
}

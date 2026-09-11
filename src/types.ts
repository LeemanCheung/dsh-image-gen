/** Shared JSON vocabulary for generation, presentation, and loopback RPC. */

export const RESULT_SCHEMA = 'dsh-image-gen/result-v1' as const
export const PRESENTATION_SCHEMA = 'dsh-image-gen/presentation-v1' as const
export const REFERENCE_SCHEMA = 'dsh-image-gen/ref-v1' as const
export const REFERENCE_MARKER = 'DSH_IMAGE_REF_V1 ' as const
export const ERROR_SCHEMA = 'dsh-image-gen/error-v1' as const

/**
 * Reason one image read was refused.
 *
 * `pending` means the session store has not committed the completed tool result
 * yet, which is transient; the others are terminal for that call.
 */
export type ImageUnavailableReason = 'pending' | 'inspection-failed' | 'attachment-failed'

/** Safe Host diagnostics attached to a failed image read. */
export interface ImageErrorDetails {
  reason: ImageUnavailableReason
}

/** Narrows an untrusted RPC error payload to the plugin's own failure shape. */
export function imageErrorDetails(value: unknown): ImageErrorDetails | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const details = value as Record<string, unknown>
  if (details.reason !== 'pending'
    && details.reason !== 'inspection-failed'
    && details.reason !== 'attachment-failed') return undefined
  return { reason: details.reason }
}

export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Canonical quality ladder in provider order.
 *
 * GPT Image 2 and GPT Image 2.5 both accept `auto`, `low`, `medium`, and `high`.
 * The `xhigh` and `max` tiers are GPT Image 2.5 additions; the provider rejects
 * them for older image models, so callers select quality together with a model.
 */
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ImageQuality[]

/** Narrow an untrusted value to a provider-supported image quality. */
export function isImageQuality(value: unknown): value is ImageQuality {
  return typeof value === 'string' && (IMAGE_QUALITIES as readonly string[]).includes(value)
}

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp'
export type ImageBackground = 'auto' | 'opaque' | 'transparent'
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'
export type ImageMetadataSource = 'provider' | 'request'

/** JSON-safe copy of a DSH durable image reference. */
export interface ImageRefValue {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

/** Provider token accounting returned with a completed GPT Image stream. */
export interface ImageUsageValue {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** Canonical successful value returned by the model tool. */
export interface ImageGenerationValue {
  schema: typeof RESULT_SCHEMA
  callId: string
  model: string
  prompt: string
  image: ImageRefValue
  referenceImage?: ImageRefValue
  size: string
  quality: ImageQuality
  requestedSize?: string
  requestedQuality?: ImageQuality
  providerSize?: string
  qualitySource?: ImageMetadataSource
  outputFormat: ImageOutputFormat
  background: ImageBackground
  elapsedMs: number
  usage?: ImageUsageValue
}

/** Replay-stable payload kept outside top-level model-facing Tool result text. */
export interface ImagePresentationValue {
  schema: typeof PRESENTATION_SCHEMA
  result: ImageGenerationValue
}

/** Bounded text marker used when Code Mode omits presentation metadata. */
export interface ImageReferenceValue {
  schema: typeof REFERENCE_SCHEMA
  callId: string
  model: string
  image: ImageRefValue
  referenceImage?: ImageRefValue
  size: string
  quality: ImageQuality
  requestedSize?: string
  requestedQuality?: ImageQuality
  providerSize?: string
  qualitySource?: ImageMetadataSource
  outputFormat: ImageOutputFormat
  background: ImageBackground
  elapsedMs: number
  usage?: ImageUsageValue
}

/** One partial frame retained only while a generation call is live. */
export interface ImagePartialValue {
  index: number
  format: ImageOutputFormat
  data: string
}

/** Browser-visible snapshot of an active operation. */
export interface ImageProgressValue {
  state: 'missing' | 'requesting' | 'generating' | 'saving'
  revision: number
  attempt: number
  startedAt: number
  partial?: ImagePartialValue
}

/** Shared JSON vocabulary for generation, presentation, and loopback RPC. */

export const RESULT_SCHEMA = 'dsh-image-gen/result-v1' as const
export const PRESENTATION_SCHEMA = 'dsh-image-gen/presentation-v1' as const
export const REFERENCE_SCHEMA = 'dsh-image-gen/ref-v1' as const
export const REFERENCE_MARKER = 'DSH_IMAGE_REF_V1 ' as const

export type ImageQuality = 'auto' | 'low' | 'medium' | 'high'
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp'
export type ImageBackground = 'auto' | 'opaque'
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

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

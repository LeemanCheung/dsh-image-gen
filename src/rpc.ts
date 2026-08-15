/** Private loopback RPC names shared by the Host and browser halves. */
export const IMAGE_GEN_RPC_CHANNEL = '/dsh-image-gen'

/** Versioned endpoints for live progress and durable image reads. */
export const IMAGE_GEN_RPC_ENDPOINT = {
  progress: 'generation/progress',
  image: 'generation/image',
} as const

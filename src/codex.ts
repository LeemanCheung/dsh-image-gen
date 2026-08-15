/** Codex subscription OAuth resolution from the DSH-owned Codex Connect store. */

import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONNECTOR_PACKAGE = 'dsh-codex-connect'
const CODEX_PROVIDER_ID = 'openai-codex'
const CODEX_AUTH_FILENAME = '.openai-codex-auth.json'
const AUTH_FORMAT_VERSION = 1
const MAX_AUTH_DOCUMENT_BYTES = 16 * 1024
const REFRESH_WINDOW_MS = 5 * 60 * 1000

/** Fixed first-party Codex endpoint. Subscription credentials never cross to configured origins. */
export const CODEX_IMAGE_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** The small credential projection consumed by the image transport. */
export interface CodexSubscriptionAuth {
  accessToken: string
  accountId: string
}

interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

interface ConnectorStore {
  read: (providerId: string) => Promise<unknown>
}

interface ConnectorModule {
  OpenAICodexCredentialStore: new () => ConnectorStore
  readOpenAICodexRateLimits: (store: ConnectorStore) => Promise<unknown>
}

export type LoadCodexConnector = () => Promise<unknown>
export type ReadCodexAuthDocument = (signal: AbortSignal) => Promise<unknown>
export type TrackCodexAuthWork = (work: Promise<unknown>) => void

function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured === undefined || configured.length === 0 ? join(homedir(), '.dsh') : configured
}

async function defaultLoadConnector(): Promise<unknown> {
  return import(CONNECTOR_PACKAGE)
}

async function defaultReadCodexAuthDocument(signal: AbortSignal): Promise<unknown> {
  const filename = join(dshHome(), CODEX_AUTH_FILENAME)
  let info
  try {
    info = await lstat(filename)
  } catch (error) {
    throw new Error('OpenAI Codex is signed out. Install dsh-codex-connect and sign in from DSH settings.', { cause: error })
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The Codex OAuth store must be a regular file.')
  if (info.size < 2 || info.size > MAX_AUTH_DOCUMENT_BYTES) throw new Error('The Codex OAuth store has an invalid size.')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('The Codex OAuth store is readable beyond its owner; run chmod 600 before retrying.')
  }
  let text: string
  try {
    text = await readFile(filename, { encoding: 'utf8', signal })
  } catch (error) {
    signal.throwIfAborted()
    throw new Error('The Codex OAuth store could not be read.', { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error('The Codex OAuth store is not valid JSON.', { cause: error })
  }
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every(key => allowed.includes(key))
}

function parseCredential(value: unknown): OAuthCredential | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const credential = value as Record<string, unknown>
  if (!exactKeys(credential, ['type', 'access', 'refresh', 'expires', 'accountId'])) return undefined
  if (credential.type !== 'oauth'
    || typeof credential.access !== 'string' || credential.access.trim().length === 0 || credential.access.length > 16_384
    || typeof credential.refresh !== 'string' || credential.refresh.trim().length === 0 || credential.refresh.length > 16_384
    || typeof credential.expires !== 'number' || !Number.isFinite(credential.expires) || credential.expires <= 0
    || typeof credential.accountId !== 'string' || credential.accountId.trim().length === 0 || credential.accountId.length > 256) return undefined
  return credential as unknown as OAuthCredential
}

function parseDocument(value: unknown): OAuthCredential | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const document = value as Record<string, unknown>
  if (document.version !== AUTH_FORMAT_VERSION || !exactKeys(document, ['version', 'credential'])) return undefined
  return parseCredential(document.credential)
}

function parseConnector(value: unknown): ConnectorModule | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const module = value as Record<string, unknown>
  if (typeof module.OpenAICodexCredentialStore !== 'function' || typeof module.readOpenAICodexRateLimits !== 'function') return undefined
  return module as unknown as ConnectorModule
}

function connectorUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  return record.code === 'ERR_MODULE_NOT_FOUND'
    && typeof record.message === 'string'
    && record.message.startsWith(`Cannot find package '${CONNECTOR_PACKAGE}'`)
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function project(credential: OAuthCredential, now: number): CodexSubscriptionAuth {
  if (credential.expires <= now) {
    throw new Error('OpenAI Codex sign-in expired. Sign in again from Codex Connect settings or run "dsh openai-codex login".')
  }
  return { accessToken: credential.access, accountId: credential.accountId }
}

/** Resolve the current DSH-owned Codex subscription credential without retaining it. */
export async function resolveCodexSubscriptionAuth(
  signal: AbortSignal,
  loadConnector: LoadCodexConnector = defaultLoadConnector,
  readDocument: ReadCodexAuthDocument = defaultReadCodexAuthDocument,
  now: () => number = Date.now,
  trackWork?: TrackCodexAuthWork,
): Promise<CodexSubscriptionAuth> {
  signal.throwIfAborted()
  let loaded: unknown
  try {
    loaded = await loadConnector()
  } catch (error) {
    signal.throwIfAborted()
    if (!connectorUnavailable(error)) throw new Error('Codex Connect could not be loaded safely.', { cause: error })
    const credential = parseDocument(await readDocument(signal))
    signal.throwIfAborted()
    if (credential === undefined) {
      throw new Error('OpenAI Codex is signed out or its credential store is incompatible. Sign in again from Codex Connect settings.')
    }
    return project(credential, now())
  }

  signal.throwIfAborted()
  const connector = parseConnector(loaded)
  if (connector === undefined) throw new Error('The installed dsh-codex-connect package is incompatible. Update it before using subscription image generation.')
  const store = new connector.OpenAICodexCredentialStore()
  let credential = parseCredential(await store.read(CODEX_PROVIDER_ID))
  signal.throwIfAborted()
  if (credential === undefined) throw new Error('OpenAI Codex is signed out. Sign in from Codex Connect settings.')
  if (credential.expires <= now() + REFRESH_WINDOW_MS) {
    let refreshError: unknown
    const refreshWork = connector.readOpenAICodexRateLimits(store)
    trackWork?.(refreshWork)
    try {
      await raceAbort(refreshWork, signal)
    } catch (error) {
      signal.throwIfAborted()
      refreshError = error
    }
    credential = parseCredential(await store.read(CODEX_PROVIDER_ID))
    signal.throwIfAborted()
    if (credential === undefined) throw new Error('OpenAI Codex refresh returned no usable credential. Sign in again from Codex Connect settings.')
    if (credential.expires <= now() && refreshError !== undefined) {
      throw new Error('OpenAI Codex sign-in could not be refreshed. Sign in again from Codex Connect settings.', { cause: refreshError })
    }
  }
  return project(credential, now())
}

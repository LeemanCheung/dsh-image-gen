import { describe, expect, it, vi } from 'vitest'
import { activeProfileName, loadInstalledCodexConnector, resolveCodexSubscriptionAuth } from '../src/codex.ts'

const now = 1_800_000_000_000

function credential(overrides: Partial<{ access: string; refresh: string; expires: number; accountId: string }> = {}) {
  return {
    type: 'oauth',
    access: 'access-secret',
    refresh: 'refresh-secret',
    expires: now + 3_600_000,
    accountId: 'account-123',
    ...overrides,
  }
}

function document(overrides: Parameters<typeof credential>[0] = {}) {
  return { version: 1, credential: credential(overrides) }
}

function unavailableConnector(): Promise<unknown> {
  return Promise.reject(Object.assign(new Error("Cannot find package 'dsh-codex-connect'"), { code: 'ERR_MODULE_NOT_FOUND' }))
}

describe('Codex subscription authentication', () => {
  it('resolves a linked plugin integration from its active Profile before reading legacy JSON', async () => {
    const module = { OpenAICodexCredentialStore: class {}, readOpenAICodexRateLimits: vi.fn() }
    const fromProfile = vi.fn(() => '/isolated/profile/node_modules/dsh-codex-connect/lib/index.js')
    const load = vi.fn(async (_url: string) => module)
    await expect(loadInstalledCodexConnector(unavailableConnector, fromProfile, load)).resolves.toBe(module)
    expect(fromProfile).toHaveBeenCalledOnce()
    expect(load.mock.calls[0]?.[0]).toMatch(/^file:\/\//)
  })

  it('does not disguise a broken direct connector by loading another copy', async () => {
    const failure = Object.assign(new Error("Cannot find package 'undici'"), { code: 'ERR_MODULE_NOT_FOUND' })
    const fromProfile = vi.fn()
    await expect(loadInstalledCodexConnector(async () => { throw failure }, fromProfile)).rejects.toBe(failure)
    expect(fromProfile).not.toHaveBeenCalled()
  })

  it('uses the actual profile and rejects profile path traversal', () => {
    expect(activeProfileName(['web'])).toBe('web')
    expect(activeProfileName(['--profile', 'image-gen-smoke'])).toBe('image-gen-smoke')
    expect(activeProfileName(['--profile', '../../another-home'])).toBe('web')
  })

  it('uses the public Codex Connect store and returns only the transport projection', async () => {
    class Store {
      async read(providerId: string) {
        expect(providerId).toBe('openai-codex')
        return credential()
      }
    }
    const auth = await resolveCodexSubscriptionAuth(new AbortController().signal, async () => ({
      OpenAICodexCredentialStore: Store,
      readOpenAICodexRateLimits: vi.fn(),
    }), async () => { throw new Error('fallback must not run') }, () => now)
    expect(auth).toEqual({ accessToken: 'access-secret', accountId: 'account-123' })
    expect(auth).not.toHaveProperty('refresh')
    expect(auth).not.toHaveProperty('expires')
  })

  it('accepts a refreshed credential even when the connector quota request fails afterward', async () => {
    let current = credential({ access: 'old', expires: now + 1_000 })
    class Store {
      async read() { return current }
    }
    const refresh = vi.fn(async () => {
      current = credential({ access: 'fresh', expires: now + 3_600_000 })
      throw new Error('quota endpoint changed after refresh')
    })
    const auth = await resolveCodexSubscriptionAuth(new AbortController().signal, async () => ({
      OpenAICodexCredentialStore: Store,
      readOpenAICodexRateLimits: refresh,
    }), async () => { throw new Error('fallback must not run') }, () => now)
    expect(refresh).toHaveBeenCalledOnce()
    expect(auth.accessToken).toBe('fresh')
  })

  it('falls back to the bounded DSH-owned document for linked development installs', async () => {
    const auth = await resolveCodexSubscriptionAuth(
      new AbortController().signal,
      unavailableConnector,
      async () => document(),
      () => now,
    )
    expect(auth).toEqual({ accessToken: 'access-secret', accountId: 'account-123' })
  })

  it('does not hide a broken connector behind the linked-install fallback', async () => {
    const readDocument = vi.fn(async () => document())
    const transitive = Object.assign(
      new Error("Cannot find package 'missing-transitive' imported from /node_modules/dsh-codex-connect/lib/index.js"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    await expect(resolveCodexSubscriptionAuth(
      new AbortController().signal,
      async () => { throw transitive },
      readDocument,
      () => now,
    )).rejects.toThrow('could not be loaded safely')
    expect(readDocument).not.toHaveBeenCalled()
  })

  it('fails closed for unknown fields, malformed values, and expired credentials', async () => {
    await expect(resolveCodexSubscriptionAuth(
      new AbortController().signal,
      unavailableConnector,
      async () => ({ ...document(), extra: true }),
      () => now,
    )).rejects.toThrow('incompatible')

    await expect(resolveCodexSubscriptionAuth(
      new AbortController().signal,
      unavailableConnector,
      async () => document({ accountId: ' ' }),
      () => now,
    )).rejects.toThrow('incompatible')

    await expect(resolveCodexSubscriptionAuth(
      new AbortController().signal,
      unavailableConnector,
      async () => document({ expires: now - 1 }),
      () => now,
    )).rejects.toThrow('expired')
  })

  it('honors cancellation before loading and after reading the fallback document', async () => {
    const before = new AbortController()
    before.abort(new DOMException('cancelled', 'AbortError'))
    await expect(resolveCodexSubscriptionAuth(before.signal, unavailableConnector, async () => document(), () => now))
      .rejects.toMatchObject({ name: 'AbortError' })

    const during = new AbortController()
    await expect(resolveCodexSubscriptionAuth(during.signal, unavailableConnector, async () => {
      during.abort(new DOMException('cancelled', 'AbortError'))
      return document()
    }, () => now)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not wait for the connector quota timeout after cancellation', async () => {
    class Store {
      async read() { return credential({ expires: now + 1_000 }) }
    }
    let notifyStarted: (() => void) | undefined
    let finishRefresh: (() => void) | undefined
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const refreshWork = new Promise<void>(resolve => { finishRefresh = resolve })
    const tracked: Promise<unknown>[] = []
    const controller = new AbortController()
    const pending = resolveCodexSubscriptionAuth(controller.signal, async () => ({
      OpenAICodexCredentialStore: Store,
      readOpenAICodexRateLimits: () => {
        notifyStarted?.()
        return refreshWork
      },
    }), async () => { throw new Error('fallback must not run') }, () => now, work => { tracked.push(work) })
    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(tracked).toEqual([refreshWork])
    finishRefresh?.()
    await refreshWork
  })
})

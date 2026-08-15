// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index.tsx'
import { IMAGE_GEN_RPC_ENDPOINT } from '../src/rpc.ts'
import { IMAGE_GEN_STYLES } from '../src/client/styles.ts'
import { PRESENTATION_SCHEMA, RESULT_SCHEMA } from '../src/types.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.head.querySelectorAll('style[data-plugin="dsh-image-gen"]').forEach(node => { node.remove() })
})

const running: ToolCallBlock = {
  callId: 'call-1',
  name: 'image_gen',
  argsRaw: JSON.stringify({ prompt: 'A luminous blue whale', size: '1024x1024', quality: 'medium', output_format: 'png' }),
  turn: 1,
  step: 1,
  time: Date.now() - 2_000,
  callView: null,
  subCalls: [],
}

const finalResult = {
  schema: RESULT_SCHEMA,
  callId: 'call-1',
  model: 'gpt-image-2',
  prompt: 'A luminous blue whale',
  image: {
    attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mediaType: 'image/png' as const,
    bytes: 8,
    width: 1024,
    height: 1024,
    name: 'blue-whale.png',
  },
  size: '1024x1024',
  quality: 'medium' as const,
  outputFormat: 'png' as const,
  background: 'opaque' as const,
  elapsedMs: 4_200,
}

function settled(options: { error?: boolean } = {}): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 2,
    time: Date.now(),
    callId: 'call-1',
    call: { name: 'image_gen', argsRaw: running.argsRaw },
    callTime: running.time,
    content: options.error ? [{ type: 'text', text: 'Provider refused the request.' }] : [{ type: 'text', text: 'Generated.' }],
    isError: options.error ?? false,
    ...(options.error ? {} : { meta: { schema: PRESENTATION_SCHEMA, result: finalResult } }),
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

function card(rpc: (endpoint: string) => Promise<unknown>) {
  let Component: ComponentType<Record<string, unknown>> | undefined
  let injected: Record<string, unknown> = {}
  const cleanups: Array<() => void | Promise<void>> = []
  const connection = {
    isLoopback: true,
    rpc: {
      call: vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: await rpc(endpoint) })),
    },
  }
  const locale = {
    register: vi.fn(() => () => {}),
    bind: vi.fn(() => (key: string) => ({
      generating: 'Generating image', generated: 'Generated image', failed: 'Image generation failed',
      requesting: 'Contacting GPT Image 2', rendering: 'Rendering pixels', saving: 'Saving final image', waiting: 'Preparing the canvas', ready: 'Final image saved',
      draft: 'Live draft', preview: 'Preview', download: 'Download', close: 'Close', details: 'Prompt & details',
      loading: 'Loading final image', unavailable: 'Unavailable', noOutput: 'No output',
    } as Record<string, string>)[key] ?? key),
  }
  const slots = {
    inject: vi.fn((_name: string, install: () => unknown) => install()),
    register: vi.fn((registration: { inject?: () => Record<string, unknown> }, next: ComponentType<Record<string, unknown>>) => {
      Component = next
      injected = registration.inject?.() ?? {}
      return () => {}
    }),
  }
  const ctx = {
    locale,
    slots,
    get: vi.fn((name: string) => name === 'connection' ? connection : undefined),
    effect: vi.fn((install: () => (() => void | Promise<void>)) => {
      const dispose = install()
      cleanups.push(dispose)
      return () => {}
    }),
  } as unknown as ClientContext
  apply(ctx)
  if (Component === undefined) throw new Error('card not registered')
  return { Component, injected, connection, async dispose() { await Promise.all(cleanups.map(item => item())) } }
}

describe('animated image card', () => {
  it('shows and replaces a real partial preview while the call runs', async () => {
    const partial = Buffer.from('partial').toString('base64')
    const registered = card(async endpoint => {
      expect(endpoint).toBe(IMAGE_GEN_RPC_ENDPOINT.progress)
      return {
        state: 'generating', revision: 2, attempt: 1, startedAt: Date.now() - 1_000,
        partial: { index: 0, format: 'png', data: partial },
      }
    })
    const { unmount } = render(<registered.Component {...registered.injected} sessionId={'session-1'} callId="call-1" toolName="image_gen" block={running} openFile={() => {}} />)

    await waitFor(() => { expect(screen.getByText('Live draft')).toBeTruthy() })
    expect(screen.getByRole('img').getAttribute('src')).toBe(`data:image/png;base64,${partial}`)
    expect(screen.getByText('Rendering pixels')).toBeTruthy()
    unmount()
    await registered.dispose()
  })

  it('loads the authorized final image, opens a lightbox, and revokes its URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:final-image')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const registered = card(async endpoint => {
      expect(endpoint).toBe(IMAGE_GEN_RPC_ENDPOINT.image)
      return { attachment: finalResult.image, data: Buffer.from('png-data').toString('base64') }
    })
    const { unmount } = render(<registered.Component {...registered.injected} sessionId={'session-1'} callId="call-1" toolName="image_gen" block={settled()} openFile={() => {}} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy() })
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:final-image')
    expect(screen.getByText('Final image saved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:final-image')
    await registered.dispose()
  })

  it('renders a settled provider error without requesting image bytes', async () => {
    const rpc = vi.fn(async () => { throw new Error('must not be called') })
    const registered = card(rpc)
    render(<registered.Component {...registered.injected} sessionId={'session-1'} callId="call-1" toolName="image_gen" block={settled({ error: true })} openFile={() => {}} />)

    expect(screen.getByText('Image generation failed')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Provider refused')
    await act(async () => { await registered.dispose() })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails closed when settled metadata is missing or belongs to another call', async () => {
    const rpc = vi.fn(async () => { throw new Error('must not be called') })
    const registered = card(rpc)
    const missing = { ...settled(), meta: undefined } as ToolCallBlock
    const first = render(<registered.Component {...registered.injected} sessionId={'session-1'} callId="call-1" toolName="image_gen" block={missing} openFile={() => {}} />)
    expect(screen.getByText('Image generation failed')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('No output')
    first.unmount()

    const mismatch = {
      ...settled(),
      meta: { schema: PRESENTATION_SCHEMA, result: { ...finalResult, callId: 'call-other' } },
    } as ToolCallBlock
    render(<registered.Component {...registered.injected} sessionId={'session-1'} callId="call-1" toolName="image_gen" block={mismatch} openFile={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('No output')
    expect(rpc).not.toHaveBeenCalled()
    await registered.dispose()
  })

  it('owns its stylesheet and honors reduced-motion preferences', async () => {
    const registered = card(async () => ({ state: 'missing', revision: 0, attempt: 0, startedAt: 0 }))
    const style = document.head.querySelector('style[data-plugin="dsh-image-gen"]')
    expect(style?.textContent).toContain('@media (prefers-reduced-motion: reduce)')
    expect(IMAGE_GEN_STYLES).toContain('animation-duration: .001ms')
    await registered.dispose()
    expect(document.head.querySelector('style[data-plugin="dsh-image-gen"]')).toBeNull()
  })
})

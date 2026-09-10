import { describe, expect, it } from 'vitest'
import { pickAsset, runUpdate, type UpdateIO } from './update.js'

const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

const RELEASE = {
  assets: [
    { name: 'hodor.mjs', url: 'api://bundle', browser_download_url: 'pub://bundle' },
    { name: 'version.json', url: 'api://version', browser_download_url: 'pub://version' },
    { name: 'install.sh', url: 'api://sh', browser_download_url: 'pub://sh' },
  ],
}

interface Call {
  url: string
  headers: Record<string, string>
}

function fakeIo(over: {
  currentVersion?: string
  selfPath?: string
  token?: string
  responses: Record<string, { status: number; bytes: Uint8Array }>
}): { io: UpdateIO; calls: Call[]; replaced: Uint8Array[]; output: string[] } {
  const calls: Call[] = []
  const replaced: Uint8Array[] = []
  const output: string[] = []
  const io: UpdateIO = {
    currentVersion: over.currentVersion ?? '1.0.0',
    ...(over.selfPath !== undefined ? { selfPath: over.selfPath } : {}),
    ...(over.token !== undefined ? { token: over.token } : {}),
    http: async (url, headers) => {
      calls.push({ url, headers })
      return over.responses[url] ?? { status: 404, bytes: new Uint8Array(0) }
    },
    replaceSelf: async (bytes) => {
      replaced.push(bytes)
    },
    write: (text) => output.push(text),
  }
  return { io, calls, replaced, output }
}

const RELEASE_URL = 'https://api.github.com/repos/dylnhdsn/hodor/releases/tags/latest'

describe('pickAsset', () => {
  it('finds assets by name and ignores malformed entries', () => {
    expect(pickAsset(RELEASE, 'hodor.mjs')).toMatchObject({ url: 'api://bundle' })
    expect(pickAsset(RELEASE, 'nope.zip')).toBeUndefined()
    expect(pickAsset({ assets: [null, { name: 'hodor.mjs' }] }, 'hodor.mjs')).toBeUndefined()
    expect(pickAsset({}, 'hodor.mjs')).toBeUndefined()
    expect(pickAsset(null, 'hodor.mjs')).toBeUndefined()
  })
})

describe('runUpdate', () => {
  it('refuses to update a dev checkout', async () => {
    const { io, output, calls } = fakeIo({ responses: {} })
    expect(await runUpdate(io)).toBe(1)
    expect(output.join('')).toContain('dev checkout')
    expect(calls).toHaveLength(0)
  })

  it('reports a failed release fetch', async () => {
    const { io, output } = fakeIo({ selfPath: '/x/hodor.mjs', responses: {} })
    expect(await runUpdate(io)).toBe(1)
    expect(output.join('')).toContain('HTTP 404')
  })

  it('reports missing release assets', async () => {
    const { io, output } = fakeIo({
      selfPath: '/x/hodor.mjs',
      responses: { [RELEASE_URL]: { status: 200, bytes: enc({ assets: [] }) } },
    })
    expect(await runUpdate(io)).toBe(1)
    expect(output.join('')).toContain('missing')
  })

  it('is a no-op when already on the released version', async () => {
    const { io, output, replaced } = fakeIo({
      currentVersion: '1.2.3',
      selfPath: '/x/hodor.mjs',
      responses: {
        [RELEASE_URL]: { status: 200, bytes: enc(RELEASE) },
        'pub://version': { status: 200, bytes: enc({ version: '1.2.3' }) },
      },
    })
    expect(await runUpdate(io)).toBe(0)
    expect(output.join('')).toContain('already up to date')
    expect(replaced).toHaveLength(0)
  })

  it('downloads and replaces the bundle when versions differ', async () => {
    const bundle = new TextEncoder().encode('#!/usr/bin/env node\n// new build')
    const { io, output, replaced, calls } = fakeIo({
      currentVersion: '1.2.3',
      selfPath: '/x/hodor.mjs',
      responses: {
        [RELEASE_URL]: { status: 200, bytes: enc(RELEASE) },
        'pub://version': { status: 200, bytes: enc({ version: '1.2.4' }) },
        'pub://bundle': { status: 200, bytes: bundle },
      },
    })
    expect(await runUpdate(io)).toBe(0)
    expect(replaced).toEqual([bundle])
    expect(output.join('')).toContain('1.2.3 → 1.2.4')
    // unauthenticated: downloads use the public browser URLs
    expect(calls.map((c) => c.url)).toEqual([RELEASE_URL, 'pub://version', 'pub://bundle'])
    expect(calls[0]!.headers).not.toHaveProperty('authorization')
  })

  it('uses API asset URLs and a bearer token when authenticated', async () => {
    const { io, calls } = fakeIo({
      currentVersion: '1.2.3',
      selfPath: '/x/hodor.mjs',
      token: 'tok123',
      responses: {
        [RELEASE_URL]: { status: 200, bytes: enc(RELEASE) },
        'api://version': { status: 200, bytes: enc({ version: '1.2.4' }) },
        'api://bundle': { status: 200, bytes: new Uint8Array([1]) },
      },
    })
    expect(await runUpdate(io)).toBe(0)
    expect(calls.map((c) => c.url)).toEqual([RELEASE_URL, 'api://version', 'api://bundle'])
    for (const call of calls) {
      expect(call.headers['authorization']).toBe('Bearer tok123')
    }
    expect(calls[1]!.headers['accept']).toBe('application/octet-stream')
  })

  it('reports a failed bundle download without replacing anything', async () => {
    const { io, output, replaced } = fakeIo({
      currentVersion: '1.2.3',
      selfPath: '/x/hodor.mjs',
      responses: {
        [RELEASE_URL]: { status: 200, bytes: enc(RELEASE) },
        'pub://version': { status: 200, bytes: enc({ version: '1.2.4' }) },
      },
    })
    expect(await runUpdate(io)).toBe(1)
    expect(output.join('')).toContain('failed to download hodor.mjs')
    expect(replaced).toHaveLength(0)
  })
})

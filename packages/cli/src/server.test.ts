import { MemFs, type Snapshot } from '@hodor/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { CliDeps } from './main.js'
import { startServer, type RunningServer } from './server.js'

function serverDeps(fs = new MemFs()): { deps: CliDeps; fs: MemFs; errors: string[] } {
  const errors: string[] = []
  const deps: CliDeps = {
    fs,
    homedir: () => '/home/u',
    platformFlavor: 'posix',
    now: () => new Date('2026-06-01T12:00:00Z'),
    write: () => {},
    writeErr: (t) => errors.push(t),
    sleep: async () => {},
    columns: () => 100,
    listWslDistros: async () => [],
    wslDistro: () => undefined,
    env: () => undefined,
    openUrl: async () => {},
    selfUpdate: async () => 0,
  }
  return { deps, fs, errors }
}

const line = (uuid: string, ts: string, cwd: string, prompt?: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: ts,
    cwd,
    ...(prompt !== undefined ? { message: { role: 'user', content: prompt } } : {}),
  }) + '\n'

let running: RunningServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start(fs: MemFs, deps: CliDeps): Promise<RunningServer> {
  running = await startServer(deps, { port: 0, intervalMs: 0 })
  return running
}

describe('startServer', () => {
  it('serves the snapshot over the API', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r', 'hello'))
    const server = await start(fs, deps)

    const snapshot = (await (await fetch(`${server.url}/api/snapshot`)).json()) as Snapshot
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['aaaa'])
    expect(snapshot.sessions[0]!.promptPreview).toBe('hello')
  })

  it('applies mutations and reflects them immediately', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r'))
    const server = await start(fs, deps)

    const created = await fetch(`${server.url}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create-project', name: 'My Lane' }),
    })
    expect(created.status).toBe(200)
    expect((await created.json()) as { id: string }).toMatchObject({ id: 'my-lane' })

    await fetch(`${server.url}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'include', id: 'my-lane', sessionIds: ['aaaa'] }),
    })
    await fetch(`${server.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'rename-session', sessionId: 'aaaa', name: 'Star session' }),
    })

    const snapshot = (await (await fetch(`${server.url}/api/snapshot`)).json()) as Snapshot
    expect(snapshot.customProjects).toEqual([{ id: 'my-lane', name: 'My Lane' }])
    expect(snapshot.placements).toEqual([
      { sessionId: 'aaaa', customProjectId: 'my-lane', via: 'include' },
    ])
    expect(snapshot.sessions[0]!.rename).toBe('Star session')
    // persisted, not just in memory
    expect(await fs.readFile('/home/u/.hodor/projects.json')).toContain('my-lane')
  })

  it('rejects bad mutations with structured errors', async () => {
    const { deps, fs } = serverDeps()
    const server = await start(fs, deps)
    const bad = await fetch(`${server.url}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'rename-project', id: 'ghost', name: 'X' }),
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()) as { error: string }).toMatchObject({ error: 'no project "ghost"' })

    const notJson = await fetch(`${server.url}/api/project`, { method: 'POST', body: '{nope' })
    expect(notJson.status).toBe(400)
  })

  it('streams snapshots over SSE, pushing on change', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r'))
    const server = await start(fs, deps)

    const res = await fetch(`${server.url}/api/events`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('"sessions"')
    expect(first).toContain('aaaa')

    // a new transcript appears; the next tick pushes an update
    fs.writeFile('/home/u/.claude/projects/-r/bbbb.jsonl', line('u2', '2026-06-01T11:30:00Z', '/r'))
    await server.tick()
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('bbbb')
    await reader.cancel()
  })

  it('serves a fallback page when no UI is embedded', async () => {
    const { deps, fs } = serverDeps()
    const server = await start(fs, deps)
    const page = await (await fetch(server.url + '/')).text()
    expect(page).toContain('hodor')
    expect(page).toContain('/api/snapshot')
    expect((await fetch(server.url + '/nope')).status).toBe(404)
  })
})

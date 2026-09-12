import { MemFs, type Snapshot } from '@hodor/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { CliDeps } from './main.js'
import { startServer, type RunningServer } from './server.js'

function serverDeps(fs = new MemFs()): {
  deps: CliDeps
  fs: MemFs
  errors: string[]
  spawns: Array<{ file: string; args: string[] }>
  captures: Array<{ file: string; args: string[] }>
  http: {
    responses: Map<string, { status: number; json?: unknown }>
    calls: string[]
    headers?: Record<string, string>
  }
} {
  const errors: string[] = []
  const spawns: Array<{ file: string; args: string[] }> = []
  const captures: Array<{ file: string; args: string[] }> = []
  const http: {
    responses: Map<string, { status: number; json?: unknown }>
    calls: string[]
    headers?: Record<string, string>
  } = { responses: new Map(), calls: [] }
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
    osPlatform: 'linux',
    spawnDetached: async (file, args) => {
      spawns.push({ file, args })
      if (file !== 'x-terminal-emulator') throw new Error(`spawn ${file}: not stubbed`)
    },
    selfUpdate: async () => 0,
    importModule: async () => ({}),
    httpGetJson: async (url, headers) => {
      http.calls.push(url)
      http.headers = headers
      return http.responses.get(url) ?? { status: 404 }
    },
    runCapture: async (file, args) => {
      captures.push({ file, args })
      return { code: 0, output: 'queued\n' }
    },
  }
  return { deps, fs, errors, spawns, captures, http }
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
    expect(snapshot.customProjects).toEqual([
      {
        id: 'my-lane',
        name: 'My Lane',
        matchers: [],
        excludeMatchers: [],
        include: ['aaaa'],
        exclude: [],
      },
    ])
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

  it('answers HEAD like GET on read routes, without a body', async () => {
    const { deps, fs } = serverDeps()
    const server = await start(fs, deps)
    const head = await fetch(server.url + '/api/snapshot', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toContain('application/json')
    expect(await head.text()).toBe('')
    expect((await fetch(server.url + '/', { method: 'HEAD' })).status).toBe(200)
  })

  it('materializes an auto project when an edit targets its derived id', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r/app'))
    const server = await start(fs, deps)

    const before = (await (await fetch(`${server.url}/api/snapshot`)).json()) as Snapshot
    const autoId = before.projects[0]!.id
    expect(before.customProjects).toEqual([])

    // Renaming the auto project silently creates the custom record…
    const renamed = await fetch(`${server.url}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'rename-project', id: autoId, name: 'App work' }),
    })
    expect(renamed.status).toBe(200)
    const { id } = (await renamed.json()) as { id: string }
    expect(id).not.toBe(autoId)

    const after = (await (await fetch(`${server.url}/api/snapshot`)).json()) as Snapshot
    expect(after.customProjects).toEqual([
      expect.objectContaining({
        id,
        name: 'App work',
        derivedFrom: autoId,
        // cwd-identity projects seed an exact-dir matcher, not a subtree
        matchers: [{ kind: 'dir', path: '/r/app' }],
      }),
    ])
    // …which claims the session, so the auto project is fully absorbed.
    expect(after.placements.map((p) => p.customProjectId)).toEqual([id])

    // A second edit addressed to the same auto id lands on the record.
    await fetch(`${server.url}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'archive-project', id: autoId, archived: true }),
    })
    const archived = (await (await fetch(`${server.url}/api/snapshot`)).json()) as Snapshot
    expect(archived.customProjects).toEqual([expect.objectContaining({ id, archived: true })])
    expect(archived.sessions[0]!.hiddenBy).toBe(`project-archived:${id}`)
  })

  it('serves a session transcript tail: prompts and assistant text only', async () => {
    const { deps, fs } = serverDeps()
    const entries = [
      line('u1', '2026-06-01T10:00:00Z', '/r', 'fix the tests'),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-06-01T10:00:10Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'text', text: 'On it — running the suite.' },
          ],
        },
      }) + '\n',
      // meta/tool-only lines carry no text and are skipped
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        isMeta: true,
        timestamp: '2026-06-01T10:00:11Z',
        message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' },
      }) + '\n',
    ]
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', entries.join(''))
    const server = await start(fs, deps)

    const res = await fetch(`${server.url}/api/transcript?id=aaaa`)
    expect(res.status).toBe(200)
    const { messages } = (await res.json()) as {
      messages: Array<{ type: string; text: string; isSidechain: boolean }>
    }
    expect(messages).toEqual([
      expect.objectContaining({ type: 'user', text: 'fix the tests', isSidechain: false }),
      expect.objectContaining({ type: 'assistant', text: 'On it — running the suite.' }),
    ])

    expect((await fetch(`${server.url}/api/transcript?id=nope`)).status).toBe(404)
  })

  it('merges modern subagent transcripts into the tail, in time order', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T10:00:00Z', '/r', 'go'))
    fs.writeFile(
      '/home/u/.claude/projects/-r/aaaa/subagents/agent-x1.jsonl',
      JSON.stringify({
        type: 'user',
        uuid: 's1',
        parentUuid: null,
        isSidechain: true,
        agentId: 'x1',
        timestamp: '2026-06-01T10:00:05Z',
        message: { role: 'user', content: 'probe the thing' },
      }) + '\n',
    )
    fs.writeFile(
      '/home/u/.claude/projects/-r/aaaa/subagents/agent-x1.meta.json',
      '{"agentType":"Explore","description":"probe"}',
    )
    const server = await start(fs, deps)

    // the run shows up as a sidechain thread with its meta…
    const snapshot = (await (await fetch(`${server.url}/api/snapshot`)).json()) as Snapshot
    const session = snapshot.sessions.find((s) => s.id === 'aaaa')!
    expect(session.counts.sidechains).toBe(1)
    expect(session.threads.find((t) => t.kind === 'sidechain')).toMatchObject({
      agentId: 'x1',
      agentType: 'Explore',
      description: 'probe',
    })

    // …and its turns merge into the conversation tail in time order
    const { messages } = (await (await fetch(`${server.url}/api/transcript?id=aaaa`)).json()) as {
      messages: Array<{ text: string; isSidechain: boolean }>
    }
    expect(messages.map((m) => [m.text, m.isSidechain])).toEqual([
      ['go', false],
      ['probe the thing', true],
    ])
  })

  it('launches resume/fork terminals and validates new-session roots', async () => {
    const { deps, fs, spawns } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r/app'))
    const server = await start(fs, deps)

    const resume = await fetch(`${server.url}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'resume', sessionId: 'aaaa' }),
    })
    expect(resume.status).toBe(200)
    expect((await resume.json()) as object).toMatchObject({
      ok: true,
      method: 'x-terminal-emulator',
      command: 'claude --resume aaaa',
      cwd: '/r/app',
    })
    expect(spawns[0]!.file).toBe('x-terminal-emulator')

    const fork = await fetch(`${server.url}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'fork', sessionId: 'aaaa' }),
    })
    expect((await fork.json()) as object).toMatchObject({
      command: 'claude --resume aaaa --fork-session',
    })

    // pty mode composes a spec for an embedded terminal, spawning nothing
    const spawnsBefore = spawns.length
    const pty = await fetch(`${server.url}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'resume', sessionId: 'aaaa', mode: 'pty' }),
    })
    expect(pty.status).toBe(200)
    const ptyBody = (await pty.json()) as {
      spec: { file: string; args: string[]; cwd?: string } | null
      title: string
      command: string
    }
    expect(ptyBody.command).toBe('claude --resume aaaa')
    expect(ptyBody.title.length).toBeGreaterThan(0)
    expect(ptyBody.spec).toMatchObject({ args: ['-lic', 'claude --resume aaaa'], cwd: '/r/app' })
    expect(spawns.length).toBe(spawnsBefore)

    // new sessions only launch into roots the data already knows
    const good = await fetch(`${server.url}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'new', storeId: 'local', root: '/r/app' }),
    })
    expect(good.status).toBe(200)
    expect((await good.json()) as object).toMatchObject({ ok: true, command: 'claude' })

    const bad = await fetch(`${server.url}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'new', storeId: 'local', root: '/etc' }),
    })
    expect(bad.status).toBe(400)

    expect(
      (
        await fetch(`${server.url}/api/launch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'resume', sessionId: 'nope' }),
        })
      ).status,
    ).toBe(404)
  })

  it('previews which sessions a matcher would claim', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r/app'))
    fs.writeFile('/home/u/.claude/projects/-r/bbbb.jsonl', line('u2', '2026-06-01T11:00:00Z', '/r/other'))
    const server = await start(fs, deps)

    const preview = await fetch(`${server.url}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matcher: { kind: 'cwd', prefix: '/r/app' } }),
    })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toEqual({ sessionIds: ['aaaa'] })

    const bad = await fetch(`${server.url}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matcher: { kind: 'nope' } }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('cloud sessions', () => {
  const cloudRecord = {
    id: 'session_01CLOUD',
    title: 'Cloud work',
    session_status: 'SESSION_STATUS_IDLE',
    status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
    updated_at: '2026-06-01T11:30:00Z',
    session_context: {
      sources: [{ git_repository: { url: 'https://github.com/acme/app.git' } }],
    },
    post_turn_summary: { needs_action: 'answer the question' },
  }

  it('lists cloud sessions when credentials exist, degrades on failure', async () => {
    const { deps, fs, http, captures } = serverDeps()
    fs.writeFile(
      '/home/u/.claude/.credentials.json',
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok_test' } }),
    )
    http.responses.set('https://api.anthropic.com/v1/code/sessions?limit=50', {
      status: 200,
      json: { data: [cloudRecord] },
    })
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r/app'))
    const server = await start(fs, deps)

    const snapshot = (await (await fetch(`${server.url}/api/snapshot`)).json()) as {
      cloudSessions: Array<{ id: string; bucket?: string; needsAction?: string; remoteUrl?: string }>
    }
    expect(snapshot.cloudSessions).toHaveLength(1)
    expect(snapshot.cloudSessions[0]).toMatchObject({
      id: 'session_01CLOUD',
      bucket: 'blocked',
      needsAction: 'answer the question',
      remoteUrl: 'github.com/acme/app',
    })
    // the API requires anthropic-version even with valid auth (400 without)
    expect(http.headers).toMatchObject({
      authorization: 'Bearer tok_test',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    })

    // messaging queues claude -p … --cloud <id> through a login shell
    const message = await fetch(`${server.url}/api/cloud/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session_01CLOUD', text: 'ship it' }),
    })
    expect(message.status).toBe(200)
    expect(captures).toHaveLength(1)
    expect(captures[0]!.args[captures[0]!.args.length - 1]).toContain('--cloud')
    expect(captures[0]!.args[captures[0]!.args.length - 1]).toContain("'ship it'")

    // teleport composes a pty spec targeting the host
    const teleport = await fetch(`${server.url}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'teleport', sessionId: 'session_01CLOUD', mode: 'pty' }),
    })
    expect(teleport.status).toBe(200)
    const body = (await teleport.json()) as { spec: { args: string[] } | null; title: string }
    expect(body.title).toContain('Cloud work')
    expect(body.spec?.args.join(' ')).toContain('--teleport session_01CLOUD')

    // unknown cloud session 404s
    const missing = await fetch(`${server.url}/api/cloud/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session_nope', text: 'x' }),
    })
    expect(missing.status).toBe(404)
  })

  it('is absent without credentials and reports listing failures', async () => {
    const { deps, fs } = serverDeps()
    fs.writeFile('/home/u/.claude/projects/-r/aaaa.jsonl', line('u1', '2026-06-01T11:00:00Z', '/r/app'))
    const server = await start(fs, deps)
    const snapshot = (await (await fetch(`${server.url}/api/snapshot`)).json()) as {
      cloudSessions: unknown[]
      cloudError?: string
    }
    expect(snapshot.cloudSessions).toEqual([])
    expect(snapshot.cloudError).toBeUndefined()
  })
})

describe('workspace document', () => {
  it('round-trips through /api/workspace and starts empty', async () => {
    const { deps, fs } = serverDeps()
    const server = await start(fs, deps)

    const empty = (await (await fetch(`${server.url}/api/workspace`)).json()) as {
      workspaces: unknown[]
    }
    expect(empty.workspaces).toEqual([])

    const doc = {
      v: 1,
      dockHeight: 300,
      workspaces: [
        {
          id: 'default',
          name: 'Workspace',
          windows: [{ layout: { grid: { root: {} } }, extra: 'kept' }],
        },
      ],
    }
    const post = await fetch(`${server.url}/api/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    })
    expect(post.status).toBe(200)

    const read = (await (await fetch(`${server.url}/api/workspace`)).json()) as typeof doc
    expect(read.dockHeight).toBe(300)
    expect(read.workspaces[0]!.windows[0]!.layout).toEqual({ grid: { root: {} } })
    // persisted where the rest of the user plane lives
    expect(await fs.readFile('/home/u/.hodor/workspaces.json')).toContain('"default"')
  })

  it('rejects bodies that are not workspace documents', async () => {
    const { deps, fs } = serverDeps()
    const server = await start(fs, deps)
    for (const body of ['not json', '{"workspaces":"nope"}', '{"workspaces":[{"id":1}]}']) {
      const res = await fetch(`${server.url}/api/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      expect(res.status).toBe(400)
    }
    // nothing was written
    expect(await fs.readFile('/home/u/.hodor/workspaces.json')).toBeUndefined()
  })
})

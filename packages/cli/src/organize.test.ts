import { MemFs, buildSnapshot, emptyState, foldAll, type SourceEvent } from '@hodor/core'
import { describe, expect, it } from 'vitest'
import type { CliDeps } from './main.js'
import { buildOrganizeFacts, createOrganizer, type OrganizeFact } from './organize.js'

function organizeDeps(fs = new MemFs()): {
  deps: CliDeps
  fs: MemFs
  calls: { imports: number; captures: Array<{ file: string; args: string[]; stdin?: string }> }
  setModule(fn: unknown): void
} {
  const calls = { imports: 0, captures: [] as Array<{ file: string; args: string[]; stdin?: string }> }
  let moduleFn: unknown
  const deps = {
    fs,
    homedir: () => '/home/u',
    platformFlavor: 'posix',
    now: () => new Date('2026-09-12T12:00:00Z'),
    write: () => {},
    writeErr: () => {},
    sleep: async () => {},
    columns: () => 100,
    listWslDistros: async () => [],
    wslDistro: () => undefined,
    env: () => undefined,
    openUrl: async () => {},
    osPlatform: 'linux',
    spawnDetached: async () => {},
    selfUpdate: async () => 0,
    httpGetJson: async () => ({ status: 404 }),
    importModule: async () => {
      calls.imports += 1
      return { default: moduleFn }
    },
    runCapture: async (file: string, args: string[], options?: { stdin?: string }) => {
      calls.captures.push({ file, args, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) })
      return { code: 0, output: JSON.stringify({ labels: { aaa: ['from-exec'] } }) }
    },
  } as CliDeps
  return { deps, fs, calls, setModule: (fn) => (moduleFn = fn) }
}

const localSession = (id: string, prompt: string): SourceEvent => ({
  type: 'transcript-lines',
  storeId: 's1',
  transcriptPath: `/home/u/.claude/projects/-x/${id}.jsonl`,
  sessionId: id,
  lines: [
    {
      kind: 'message',
      type: 'user',
      uuid: `${id}-u1`,
      parentUuid: null,
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-12T10:00:00Z',
      cwd: '/w',
      promptText: prompt,
    },
  ],
})

const store = {
  id: 's1',
  rootPath: '/home/u/.claude',
  pathFlavor: 'posix' as const,
  origin: { kind: 'native' as const },
  watchStrategy: 'poll' as const,
}

function stateWith(...events: SourceEvent[]) {
  return foldAll(emptyState, [{ type: 'store-discovered', store }, ...events])
}

describe('createOrganizer', () => {
  it('runs organize.js per fact, memoizes, and isolates throws', async () => {
    const { deps, fs, calls, setModule } = organizeDeps()
    fs.writeFile('/home/u/.hodor/organize.js', '// real content lives on disk')
    let ran = 0
    setModule((fact: OrganizeFact) => {
      ran += 1
      if (fact.id === 'bad') throw new Error('kaboom')
      return fact.type === 'local' && fact.title?.includes('game') ? ['games'] : undefined
    })

    const state = stateWith(localSession('aaa', 'game session'), localSession('bad', 'x'))
    const snapshot = buildSnapshot(state, { now: deps.now() })
    const organizer = createOrganizer(deps, '/home/u/.hodor')

    const event = await organizer.evaluate({}, state, snapshot)
    expect(event).toMatchObject({
      type: 'organize-results',
      labels: { aaa: ['games'] },
    })
    if (event?.type !== 'organize-results') throw new Error('unreachable')
    expect(event.errors[0]).toContain('kaboom')
    expect(ran).toBe(2)

    // unchanged sessions + unchanged script → memoized, fn not re-run
    await organizer.evaluate({}, state, snapshot)
    expect(ran).toBe(2)
    expect(calls.imports).toBe(2) // import is re-resolved (cheap; cache-busted by mtime)
  })

  it('runs the exec hook with facts on stdin and merges labels', async () => {
    const { deps, calls, fs, setModule } = organizeDeps()
    fs.writeFile('/home/u/.hodor/organize.js', '//')
    setModule(() => ['from-script'])
    const state = stateWith(localSession('aaa', 'x'))
    const snapshot = buildSnapshot(state, { now: deps.now() })
    const organizer = createOrganizer(deps, '/home/u/.hodor')

    const event = await organizer.evaluate(
      { organize: { command: 'python3 my-organizer.py' } },
      state,
      snapshot,
    )
    if (event?.type !== 'organize-results') throw new Error('no event')
    expect(event.labels['aaa']).toEqual(['from-script', 'from-exec'])
    expect(calls.captures[0]!.args).toEqual(['-lc', 'python3 my-organizer.py'])
    const stdin = JSON.parse(calls.captures[0]!.stdin!) as { apiVersion: number; sessions: unknown[] }
    expect(stdin.apiVersion).toBe(1)
    expect(stdin.sessions).toHaveLength(1)
  })

  it('is absent with no hooks, and clears once after hooks are removed', async () => {
    const { deps, fs, setModule } = organizeDeps()
    const state = stateWith(localSession('aaa', 'x'))
    const snapshot = buildSnapshot(state, { now: deps.now() })
    const organizer = createOrganizer(deps, '/home/u/.hodor')
    expect(await organizer.evaluate({}, state, snapshot)).toBeUndefined()

    fs.writeFile('/home/u/.hodor/organize.js', '//')
    setModule(() => ['x'])
    expect(await organizer.evaluate({}, state, snapshot)).toBeDefined()

    fs.removeFile('/home/u/.hodor/organize.js')
    const clearing = await organizer.evaluate({}, state, snapshot)
    expect(clearing).toMatchObject({ type: 'organize-results', labels: {} })
    expect(await organizer.evaluate({}, state, snapshot)).toBeUndefined()
  })

  it('builds facts for local (with remotes and title) and cloud sessions', () => {
    const state = foldAll(stateWith(localSession('aaa', 'hello world')), [
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/w',
        context: { repoRoot: '/w', isWorktree: false, remoteUrl: 'git@github.com:a/b.git' },
      },
      {
        type: 'cloud-sessions-scanned',
        sessions: [{ id: 'cse_x', status: 'idle', branches: [], url: 'https://claude.ai/code/cse_x' }],
        scannedAt: '2026-09-12T11:00:00Z',
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T12:00:00Z') })
    const facts = buildOrganizeFacts(state, snapshot)
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ type: 'local', id: 'aaa', title: 'hello world', remotes: ['github.com/a/b'] })
    expect(facts[1]).toMatchObject({ type: 'cloud', id: 'cse_x' })
  })
})

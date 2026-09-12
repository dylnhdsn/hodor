import { MemFs, emptyState, foldAll, type SourceEvent } from '@hodor/core'
import { describe, expect, it } from 'vitest'
import { createBranchChecker } from './cloudbranch.js'
import type { CliDeps } from './main.js'

const store = {
  id: 's1',
  rootPath: '/home/u/.claude',
  pathFlavor: 'posix' as const,
  origin: { kind: 'native' as const },
  watchStrategy: 'poll' as const,
}

const localSession: SourceEvent = {
  type: 'transcript-lines',
  storeId: 's1',
  transcriptPath: '/home/u/.claude/projects/-w/aaa.jsonl',
  sessionId: 'aaa',
  lines: [
    {
      kind: 'message',
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-12T10:00:00Z',
      cwd: '/w',
      promptText: 'x',
    },
  ],
}

const gitContext: SourceEvent = {
  type: 'git-context-resolved',
  storeId: 's1',
  cwd: '/w',
  context: { repoRoot: '/w', isWorktree: false, remoteUrl: 'git@github.com:a/b.git' },
}

const cloudScan = (sessions: Array<{ id: string; branch?: string }>): SourceEvent => ({
  type: 'cloud-sessions-scanned',
  sessions: sessions.map(({ id, branch }) => ({
    id,
    status: 'idle' as const,
    branches: branch !== undefined ? [branch] : [],
    remoteUrl: 'github.com/a/b',
    remoteUrls: ['github.com/a/b'],
    url: `https://claude.ai/code/${id}`,
  })),
  scannedAt: '2026-09-12T10:00:00Z',
})

function checkerDeps(fs = new MemFs()): {
  deps: CliDeps
  fs: MemFs
  captures: Array<{ file: string; args: string[] }>
  lsRemote: { code: number; output: string }
} {
  const captures: Array<{ file: string; args: string[] }> = []
  const lsRemote = { code: 0, output: '' }
  const deps = {
    fs,
    homedir: () => '/home/u',
    platformFlavor: 'posix',
    osPlatform: 'linux',
    now: () => new Date('2026-09-12T12:00:00Z'),
    write: () => {},
    writeErr: () => {},
    env: () => undefined,
    runCapture: async (file: string, args: string[]) => {
      captures.push({ file, args })
      return lsRemote
    },
  } as unknown as CliDeps
  return { deps, fs, captures, lsRemote }
}

describe('createBranchChecker', () => {
  it('trusts local refs without touching the network', async () => {
    const { deps, fs, captures } = checkerDeps()
    fs.writeFile('/w/.git/config', '')
    fs.writeFile('/w/.git/refs/remotes/origin/claude/known', 'aaaa\n')
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession,
      gitContext,
      cloudScan([{ id: 'cse_1', branch: 'claude/known' }]),
    ])
    const event = await createBranchChecker(deps).check(state, [store], () => fs)
    expect(event).toMatchObject({
      type: 'cloud-branches-checked',
      presence: { cse_1: true },
    })
    expect(captures).toHaveLength(0)
  })

  it('asks origin once per repo and marks confirmed-gone branches', async () => {
    const { deps, fs, captures, lsRemote } = checkerDeps()
    fs.writeFile('/w/.git/config', '')
    lsRemote.output = 'aaaa\trefs/heads/claude/still-there\n'
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession,
      gitContext,
      cloudScan([
        { id: 'cse_alive', branch: 'claude/still-there' },
        { id: 'cse_gone', branch: 'claude/merged-away' },
        { id: 'cse_nobranch' },
      ]),
    ])
    const event = await createBranchChecker(deps).check(state, [store], () => fs)
    if (event?.type !== 'cloud-branches-checked') throw new Error('no event')
    expect(event.presence).toEqual({ cse_alive: true, cse_gone: false })
    expect(captures).toHaveLength(1)
    expect(captures[0]!.file).toBe('git')
    expect(captures[0]!.args).toContain('refs/heads/claude/merged-away')
    expect(captures[0]!.args).toContain('refs/heads/claude/still-there')
  })

  it('yields no verdict when ls-remote fails, and skips repos it cannot exec', async () => {
    const { deps, fs, lsRemote } = checkerDeps()
    fs.writeFile('/w/.git/config', '')
    lsRemote.code = 128
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession,
      gitContext,
      cloudScan([{ id: 'cse_x', branch: 'claude/who-knows' }]),
    ])
    const event = await createBranchChecker(deps).check(state, [store], () => fs)
    if (event?.type !== 'cloud-branches-checked') throw new Error('no event')
    expect(event.presence).toEqual({})

    // a windows store viewed from linux has no exec route at all
    const winStore = {
      ...store,
      id: 'sw',
      pathFlavor: 'win32' as const,
      origin: { kind: 'windows' as const, mountRoot: '/mnt/c' },
    }
    const winState = foldAll(emptyState, [
      { type: 'store-discovered', store: winStore },
      { ...localSession, storeId: 'sw', transcriptPath: 'C:\\u\\.claude\\projects\\-w\\aaa.jsonl' },
      { ...gitContext, storeId: 'sw', cwd: '/w' },
      cloudScan([{ id: 'cse_w', branch: 'claude/elsewhere' }]),
    ])
    const { deps: deps2, fs: fs2, captures: captures2 } = checkerDeps()
    fs2.writeFile('/w/.git/config', '')
    const event2 = await createBranchChecker(deps2).check(winState, [winStore], () => fs2)
    if (event2?.type !== 'cloud-branches-checked') throw new Error('no event')
    expect(event2.presence).toEqual({})
    expect(captures2).toHaveLength(0)
  })

  it('paces itself and stays silent when nothing changed', async () => {
    const { deps, fs } = checkerDeps()
    fs.writeFile('/w/.git/config', '')
    fs.writeFile('/w/.git/refs/heads/claude/known', 'aaaa\n')
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession,
      gitContext,
      cloudScan([{ id: 'cse_1', branch: 'claude/known' }]),
    ])
    const checker = createBranchChecker(deps)
    expect(await checker.check(state, [store], () => fs)).toBeDefined()
    // within the pass interval: no re-scan, no event
    expect(await checker.check(state, [store], () => fs)).toBeUndefined()
  })
})

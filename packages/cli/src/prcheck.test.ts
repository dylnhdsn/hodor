import { describe, expect, it } from 'vitest'
import { emptyState, foldAll, type SessionStore } from '@hodor/core'
import type { CliDeps } from './main.js'
import { createPrChecker, ghListSpec, prTargets } from './prcheck.js'

const NOW = new Date('2026-09-18T20:00:00.000Z')
const native: SessionStore = { id: 'local', rootPath: '/home/d/.claude', pathFlavor: 'posix', origin: { kind: 'native' }, watchStrategy: 'poll' }
const wsl: SessionStore = { id: 'ubuntu', rootPath: '/home/d/.claude', pathFlavor: 'posix', origin: { kind: 'wsl', distro: 'Ubuntu' }, watchStrategy: 'poll' }

const line = (uuid: string, ts: string, cwd: string, gitBranch: string) =>
  ({ type: 'user', uuid, parentUuid: null, isSidechain: false, timestamp: ts, cwd, gitBranch, message: { role: 'user', content: 'hi' } })

function stateWith(sessions: Array<{ id: string; branch: string; ts: string; store?: string }>) {
  let state = emptyState
  for (const s of sessions) {
    state = foldAll(state, [
      {
        type: 'transcript-lines',
        storeId: s.store ?? 'local',
        transcriptPath: `/t/${s.id}.jsonl`,
        sessionId: s.id,
        lines: [{ kind: 'message', ...line(`u-${s.id}`, s.ts, '/repo/app', s.branch) } as never],
      },
      { type: 'git-context-resolved', storeId: s.store ?? 'local', cwd: '/repo/app', context: { repoRoot: '/repo/app', isWorktree: false, remoteUrl: 'git@github.com:o/app.git' } },
    ])
  }
  return state
}

describe('ghListSpec', () => {
  it('runs gh inside the repo natively, through wsl.exe from Windows, and not at all where it cannot', () => {
    expect(ghListSpec('linux', native, '/repo/app', 'feat')).toMatchObject({ file: 'gh', cwd: '/repo/app' })
    expect(ghListSpec('linux', native, '/repo/app', 'feat')?.args.slice(0, 4)).toEqual(['pr', 'list', '--head', 'feat'])
    expect(ghListSpec('win32', wsl, '/repo/app', 'feat')).toMatchObject({ file: 'wsl.exe' })
    expect(ghListSpec('win32', wsl, '/repo/app', 'feat')?.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--cd', '/repo/app', '-e'])
    expect(ghListSpec('linux', wsl, '/repo/app', 'feat')).toBeUndefined()
  })
})

describe('prTargets', () => {
  it('asks about recent sessions with a branch and a remote, one ask per repo+branch', () => {
    const state = stateWith([
      { id: 'a', branch: 'feat', ts: '2026-09-18T19:00:00Z' },
      { id: 'b', branch: 'feat', ts: '2026-09-18T18:00:00Z' },
      { id: 'c', branch: 'other', ts: '2026-09-18T17:00:00Z' },
      { id: 'old', branch: 'feat', ts: '2026-08-01T00:00:00Z' },
    ])
    const targets = prTargets(state, NOW.getTime())
    expect(targets.map((t) => [t.branch, t.sessionIds.sort()])).toEqual([
      ['feat', ['a', 'b']],
      ['other', ['c']],
    ])
  })
})

describe('createPrChecker', () => {
  const deps = (outputs: Record<string, string | Error>, calls: string[]): CliDeps =>
    ({
      osPlatform: 'linux',
      now: () => NOW,
      runCapture: (_file: string, args: string[]) => {
        const branch = args[args.indexOf('--head') + 1]!
        calls.push(branch)
        const out = outputs[branch]
        if (out instanceof Error) return Promise.reject(out)
        return Promise.resolve({ code: 0, output: out ?? '[]' })
      },
    }) as unknown as CliDeps

  const pr = (n: number, updatedAt: string) =>
    JSON.stringify([{ number: n, url: `https://github.com/o/app/pull/${n}`, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', updatedAt, headRefOid: 'aaa' }])

  it('emits PRs for checked sessions, null for a branch without one, then only changes', async () => {
    const calls: string[] = []
    const checker = createPrChecker(deps({ feat: pr(68, '2026-09-18T19:30:00Z'), other: '[]' }, calls))
    const state = stateWith([
      { id: 'a', branch: 'feat', ts: '2026-09-18T19:00:00Z' },
      { id: 'c', branch: 'other', ts: '2026-09-18T17:00:00Z' },
    ])
    const first = await checker.check(state, [native])
    expect(first).toMatchObject({ type: 'prs-checked', prs: { a: { number: 68, state: 'open', review: 'review required' }, c: null } })
    expect(calls).toEqual(['feat', 'other'])
    // a second pass inside the interval does nothing at all
    expect(await checker.check(state, [native])).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('leaves a failed lookup unknown rather than clearing a chip', async () => {
    const calls: string[] = []
    const checker = createPrChecker(deps({ feat: new Error('gh: not logged in') }, calls))
    const state = stateWith([{ id: 'a', branch: 'feat', ts: '2026-09-18T19:00:00Z' }])
    expect(await checker.check(state, [native])).toBeUndefined()
  })

  it('folds into the snapshot state and clears on null', () => {
    let state = stateWith([{ id: 'a', branch: 'feat', ts: '2026-09-18T19:00:00Z' }])
    state = foldAll(state, [{ type: 'prs-checked', checkedAt: NOW.toISOString(), prs: { a: { number: 1, url: 'u', state: 'open', fingerprint: 'f', checkedAt: NOW.toISOString() } } }])
    expect(state.prs['a']?.number).toBe(1)
    state = foldAll(state, [{ type: 'prs-checked', checkedAt: NOW.toISOString(), prs: { a: null } }])
    expect(state.prs['a']).toBeUndefined()
  })
})

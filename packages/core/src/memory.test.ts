import { describe, expect, it } from 'vitest'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import { MemFs } from './fs.js'
import { enrichMemoryFiles } from './memory.js'
import { buildSnapshot } from './snapshot.js'
import type { SessionStore } from './types.js'

const store: SessionStore = {
  id: 's1',
  rootPath: '/home/u/.claude',
  pathFlavor: 'posix',
  origin: { kind: 'native' },
  watchStrategy: 'poll',
}

const line = (uuid: string, cwd: string) => ({
  kind: 'message' as const,
  type: 'user' as const,
  uuid,
  parentUuid: null,
  isSidechain: false,
  isMeta: false,
  timestamp: '2026-06-01T10:00:00Z',
  cwd,
})

const baseEvents: SourceEvent[] = [
  { type: 'store-discovered', store },
  {
    type: 'transcript-lines',
    storeId: 's1',
    transcriptPath: '/home/u/.claude/projects/-x/aaa.jsonl',
    sessionId: 'aaa',
    lines: [line('u1', '/repo/a/src')],
  },
  {
    type: 'transcript-lines',
    storeId: 's1',
    transcriptPath: '/home/u/.claude/projects/-x/bbb.jsonl',
    sessionId: 'bbb',
    lines: [line('u2', '/plain')],
  },
  {
    type: 'git-context-resolved',
    storeId: 's1',
    cwd: '/repo/a/src',
    context: { repoRoot: '/repo/a', isWorktree: false },
  },
  { type: 'git-context-resolved', storeId: 's1', cwd: '/plain', context: null },
]

describe('enrichMemoryFiles', () => {
  it('probes repo roots, bare cwds, and store roots; caches results', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/a/CLAUDE.md', '# project memory\n'.repeat(10))
    fs.writeFile('/repo/a/AGENTS.md', 'agents!')
    fs.writeFile('/home/u/.claude/CLAUDE.md', 'user memory')
    // /plain has none

    let state = foldAll(emptyState, baseEvents)
    const events = await enrichMemoryFiles(state, () => fs)
    state = foldAll(state, events)

    const snapshot = buildSnapshot(state, { now: new Date('2026-06-01T12:00:00Z') })
    expect(
      snapshot.memoryFiles.map((f) => ({ root: f.root, name: f.name, userLevel: f.userLevel })),
    ).toEqual([
      { root: '/home/u/.claude', name: 'CLAUDE.md', userLevel: true },
      { root: '/repo/a', name: 'AGENTS.md', userLevel: false },
      { root: '/repo/a', name: 'CLAUDE.md', userLevel: false },
    ])
    const claudeMd = snapshot.memoryFiles.find((f) => f.root === '/repo/a' && f.name === 'CLAUDE.md')!
    expect(claudeMd.bytes).toBeGreaterThan(100)
    expect(claudeMd.path).toBe('/repo/a/CLAUDE.md')

    // "none found" is cached too: a second pass has nothing left to probe
    expect(await enrichMemoryFiles(state, () => fs)).toEqual([])
  })

  it('waits for git resolution before choosing roots', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/a/CLAUDE.md', 'memory')
    // no git-context events yet: only the store root gets probed
    let state = foldAll(emptyState, baseEvents.slice(0, 2))
    const events = await enrichMemoryFiles(state, () => fs)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'memory-scanned', userLevel: true })
  })
})

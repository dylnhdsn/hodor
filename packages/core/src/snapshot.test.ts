import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { MessageLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import { buildSnapshot } from './snapshot.js'
import type { SessionStore } from './types.js'

const store: SessionStore = {
  id: 's1',
  rootPath: '/home/.claude',
  pathFlavor: 'posix',
  origin: { kind: 'native' },
  watchStrategy: 'poll',
}

const msg = (uuid: string, ts: string, cwd: string): MessageLine => ({
  kind: 'message',
  type: 'user',
  uuid,
  parentUuid: null,
  isSidechain: false,
  isMeta: false,
  timestamp: ts,
  cwd,
})

const sessionEvents = (id: string, ts: string, cwd: string): SourceEvent[] => [
  {
    type: 'transcript-lines',
    storeId: 's1',
    transcriptPath: `/home/.claude/projects/-x/${id}.jsonl`,
    sessionId: id,
    lines: [msg(`${id}-u1`, ts, cwd)],
  },
]

const baseEvents: SourceEvent[] = [
  { type: 'store-discovered', store },
  ...sessionEvents('aaa', '2026-06-01T11:59:30Z', '/repo/a'),
  ...sessionEvents('bbb', '2026-06-01T08:00:00Z', '/repo/b'),
  {
    type: 'git-context-resolved',
    storeId: 's1',
    cwd: '/repo/a',
    context: { repoRoot: '/repo/a', isWorktree: false, remoteUrl: 'git@github.com:o/a.git' },
  },
  { type: 'git-context-resolved', storeId: 's1', cwd: '/repo/b', context: null },
]

const NOW = new Date('2026-06-01T12:00:00Z')

describe('buildSnapshot', () => {
  it('assembles sessions, projects, and assignments with provenance', () => {
    const snapshot = buildSnapshot(foldAll(emptyState, baseEvents), { now: NOW })

    expect(snapshot.sessions.map((s) => s.id)).toEqual(['aaa', 'bbb'])
    expect(snapshot.projects.map((p) => p.id)).toEqual(['git-remote:github.com/o/a', 'cwd:s1:/repo/b'])

    const forA = snapshot.assignments.find((a) => a.sessionId === 'aaa')!
    expect(forA.projectId).toBe('git-remote:github.com/o/a')
    expect(forA.confidence).toBe(0.9)
    expect(forA.reasons.map((r) => r.source)).toEqual(['cwd', 'git-root', 'git-remote'])

    const forB = snapshot.assignments.find((a) => a.sessionId === 'bbb')!
    expect(forB.projectId).toBe('cwd:s1:/repo/b')
    expect(forB.confidence).toBe(0.5)
  })

  it('marks recent sessions as inferred-active and old ones idle', () => {
    const snapshot = buildSnapshot(foldAll(emptyState, baseEvents), { now: NOW })
    expect(snapshot.sessions.find((s) => s.id === 'aaa')!.runtime.kind).toBe('inferred-active')
    expect(snapshot.sessions.find((s) => s.id === 'bbb')!.runtime.kind).toBe('idle')
  })

  it('lets an explicit runtime (hosted) override inference', () => {
    const events: SourceEvent[] = [
      ...baseEvents,
      {
        type: 'runtime-changed',
        sessionId: 'bbb',
        runtime: { kind: 'hosted', pid: 42, startedAt: '2026-06-01T07:59:00Z' },
      },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    expect(snapshot.sessions.find((s) => s.id === 'bbb')!.runtime).toEqual({
      kind: 'hosted',
      pid: 42,
      startedAt: '2026-06-01T07:59:00Z',
    })
  })

  it('honors pinned project assignments over heuristics', () => {
    const events: SourceEvent[] = [
      ...baseEvents,
      { type: 'meta-changed', meta: { sessionId: 'aaa', pinnedProject: 'my-project' } },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    const forA = snapshot.assignments.find((a) => a.sessionId === 'aaa')!
    expect(forA).toMatchObject({ projectId: 'my-project', pinned: true, confidence: 1 })
    expect(snapshot.projects.some((p) => p.id === 'my-project')).toBe(true)
  })

  it('unifies a worktree session with its primary repo project', () => {
    const events: SourceEvent[] = [
      { type: 'store-discovered', store },
      ...sessionEvents('main1', '2026-06-01T10:00:00Z', '/repo/a'),
      ...sessionEvents('wt1', '2026-06-01T10:00:01Z', '/wt/a-feature'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/repo/a',
        context: { repoRoot: '/repo/a', isWorktree: false, remoteUrl: 'git@github.com:o/a.git' },
      },
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/wt/a-feature',
        context: {
          repoRoot: '/wt/a-feature',
          isWorktree: true,
          mainRepoRoot: '/repo/a',
          remoteUrl: 'git@github.com:o/a.git',
        },
      },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    expect(snapshot.projects).toHaveLength(1)
    const project = snapshot.projects[0]!
    expect(project.id).toBe('git-remote:github.com/o/a')
    expect(project.roots).toEqual([
      { storeId: 's1', path: '/repo/a' },
      { storeId: 's1', path: '/wt/a-feature' },
    ])
    const wtReasons = snapshot.assignments.find((a) => a.sessionId === 'wt1')!.reasons
    expect(wtReasons.map((r) => r.source)).toContain('worktree-of')
  })

  it('produces complete session objects, threads included', () => {
    const events: SourceEvent[] = [
      { type: 'store-discovered', store },
      {
        type: 'transcript-lines',
        storeId: 's1',
        transcriptPath: '/home/.claude/projects/-x/full.jsonl',
        sessionId: 'full',
        lines: [
          { kind: 'summary', summary: 'the title' },
          {
            kind: 'message',
            type: 'user',
            uuid: 'm1',
            parentUuid: null,
            isSidechain: false,
            isMeta: false,
            timestamp: '2026-06-01T10:00:00Z',
            cwd: '/a',
            gitBranch: 'main',
            version: '2.1.0',
          },
          {
            kind: 'message',
            type: 'assistant',
            uuid: 'm2',
            parentUuid: 'm1',
            isSidechain: false,
            isMeta: false,
            timestamp: '2026-06-01T10:00:05Z',
            cwd: '/b',
          },
          {
            kind: 'message',
            type: 'user',
            uuid: 'sc1',
            parentUuid: null,
            isSidechain: true,
            isMeta: false,
            timestamp: '2026-06-01T10:00:02Z',
            spawnedBy: { toolUseId: 't1', assistantUuid: 'm1' },
          },
        ],
      },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    expect(snapshot.generatedAt).toBe('2026-06-01T12:00:00.000Z')
    expect(snapshot.stores).toEqual([store])
    expect(snapshot.sessions).toEqual([
      {
        id: 'full',
        storeId: 's1',
        transcriptPath: '/home/.claude/projects/-x/full.jsonl',
        cwd: '/b',
        cwds: ['/a', '/b'],
        entrypoints: [],
        gitBranch: 'main',
        summary: 'the title',
        createdAt: '2026-06-01T10:00:00Z',
        lastActivityAt: '2026-06-01T10:00:05Z',
        cliVersion: '2.1.0',
        counts: { user: 1, assistant: 1, sidechains: 1 },
        threads: [
          {
            id: 'full:main',
            kind: 'main',
            firstTs: '2026-06-01T10:00:00Z',
            lastTs: '2026-06-01T10:00:05Z',
            messageCount: 2,
          },
          {
            id: 'full:sc0',
            kind: 'sidechain',
            spawnedBy: { toolUseId: 't1', assistantUuid: 'm1' },
            firstTs: '2026-06-01T10:00:02Z',
            lastTs: '2026-06-01T10:00:02Z',
            messageCount: 1,
          },
        ],
        runtime: { kind: 'idle' },
      },
    ])
  })

  it('carries prompt previews and entrypoints, and applies hide rules', () => {
    const events: SourceEvent[] = [
      { type: 'store-discovered', store },
      {
        type: 'transcript-lines',
        storeId: 's1',
        transcriptPath: '/home/.claude/projects/-x/noisy.jsonl',
        sessionId: 'noisy',
        lines: [
          {
            kind: 'message',
            type: 'user',
            uuid: 'u1',
            parentUuid: null,
            isSidechain: false,
            isMeta: false,
            timestamp: '2026-06-01T10:00:00Z',
            cwd: '/home/d/.peri/runs/x/cache/blind',
            entrypoint: 'sdk',
            promptText: 'Evaluate the blind variant',
          },
        ],
      },
      ...sessionEvents('real', '2026-06-01T10:00:01Z', '/home/d/proj'),
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), {
      now: NOW,
      hide: {
        pathPrefixes: ['/tmp'],
        pathSegments: [],
        pathInfixes: [],
        hideDotSegments: true,
        dotSegmentAllowlist: ['.claude'],
        hideNonInteractive: true,
        interactiveEntrypoints: ['cli', 'remote'],
      },
    })
    const noisy = snapshot.sessions.find((s) => s.id === 'noisy')!
    expect(noisy.hiddenBy).toBe('dot-segment:.peri')
    expect(noisy.promptPreview).toBe('Evaluate the blind variant')
    expect(noisy.entrypoints).toEqual(['sdk'])
    expect(snapshot.sessions.find((s) => s.id === 'real')!.hiddenBy).toBeUndefined()
    // Hidden sessions still get grouped — visibility is presentation's call.
    expect(snapshot.assignments.map((a) => a.sessionId)).toContain('noisy')
  })

  it('respects a custom activeWindowMs', () => {
    const state = foldAll(emptyState, baseEvents)
    const wide = buildSnapshot(state, { now: NOW, activeWindowMs: 5 * 3600 * 1000 })
    expect(wide.sessions.map((s) => s.runtime.kind)).toEqual(['inferred-active', 'inferred-active'])
    const narrow = buildSnapshot(state, { now: NOW, activeWindowMs: 10_000 })
    expect(narrow.sessions.map((s) => s.runtime.kind)).toEqual(['idle', 'idle'])
    const exact = buildSnapshot(state, { now: NOW, activeWindowMs: 30_000 })
    expect(exact.sessions.find((s) => s.id === 'aaa')!.runtime).toEqual({
      kind: 'inferred-active',
      lastAppendAt: '2026-06-01T11:59:30Z',
    })
  })

  it('treats unparseable timestamps as idle', () => {
    const state = foldAll(emptyState, sessionEvents('weird', 'not-a-date', '/x'))
    const snapshot = buildSnapshot(state, { now: NOW })
    expect(snapshot.sessions[0]!.runtime).toEqual({ kind: 'idle' })
  })

  it('sorts sessions by recency descending, then id', () => {
    const state = foldAll(emptyState, [
      ...sessionEvents('bbb', '2026-06-01T09:00:00Z', '/x'),
      ...sessionEvents('ccc', '2026-06-01T09:00:00Z', '/x'),
      ...sessionEvents('aaa', '2026-06-01T10:00:00Z', '/x'),
    ])
    const snapshot = buildSnapshot(state, { now: NOW })
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('assigns a repo without a remote by its root at 0.7 confidence', () => {
    const events: SourceEvent[] = [
      { type: 'store-discovered', store },
      ...sessionEvents('one', '2026-06-01T10:00:00Z', '/local/repo/sub'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/local/repo/sub',
        context: { repoRoot: '/local/repo', isWorktree: false },
      },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    expect(snapshot.projects).toEqual([
      {
        id: 'git-root:s1:/local/repo',
        name: 'repo',
        identity: { kind: 'path', storeId: 's1', root: '/local/repo' },
        roots: [{ storeId: 's1', path: '/local/repo' }],
      },
    ])
    const assignment = snapshot.assignments[0]!
    expect(assignment.confidence).toBe(0.7)
    expect(assignment.reasons.map((r) => r.source)).toEqual(['cwd', 'git-root'])
  })

  it('unifies a remote-less worktree with its primary repo root', () => {
    const events: SourceEvent[] = [
      { type: 'store-discovered', store },
      ...sessionEvents('wt', '2026-06-01T10:00:00Z', '/wt/x'),
      ...sessionEvents('main', '2026-06-01T10:00:01Z', '/local/repo'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/wt/x',
        context: { repoRoot: '/wt/x', isWorktree: true, mainRepoRoot: '/local/repo' },
      },
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/local/repo',
        context: { repoRoot: '/local/repo', isWorktree: false },
      },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    expect(snapshot.projects.map((p) => p.id)).toEqual(['git-root:s1:/local/repo'])
    expect(snapshot.projects[0]!.roots).toEqual([
      { storeId: 's1', path: '/local/repo' },
      { storeId: 's1', path: '/wt/x' },
    ])
  })

  it('deduplicates roots when two sessions share a cwd', () => {
    const events: SourceEvent[] = [
      { type: 'store-discovered', store },
      ...sessionEvents('one', '2026-06-01T10:00:00Z', '/repo/a'),
      ...sessionEvents('two', '2026-06-01T10:00:01Z', '/repo/a'),
      { type: 'git-context-resolved', storeId: 's1', cwd: '/repo/a', context: null },
    ]
    const snapshot = buildSnapshot(foldAll(emptyState, events), { now: NOW })
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.projects[0]!.roots).toEqual([{ storeId: 's1', path: '/repo/a' }])
    expect(snapshot.assignments.map((a) => a.sessionId)).toEqual(['one', 'two'])
  })

  it('is order-independent across files: shuffled events give the same snapshot', () => {
    const eventPool: SourceEvent[][] = [
      [baseEvents[0]!],
      sessionEvents('aaa', '2026-06-01T11:59:30Z', '/repo/a'),
      sessionEvents('bbb', '2026-06-01T08:00:00Z', '/repo/b'),
      sessionEvents('ccc', '2026-06-01T09:00:00Z', '/repo/a'),
      [baseEvents[3]!],
      [baseEvents[4]!],
    ]
    const reference = buildSnapshot(foldAll(emptyState, eventPool.flat()), { now: NOW })
    fc.assert(
      fc.property(fc.shuffledSubarray(eventPool, { minLength: eventPool.length }), (shuffled) => {
        const snapshot = buildSnapshot(foldAll(emptyState, shuffled.flat()), { now: NOW })
        expect(snapshot).toEqual(reference)
      }),
      { numRuns: 30 },
    )
  })
})

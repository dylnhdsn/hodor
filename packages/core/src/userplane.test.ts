import { describe, expect, it } from 'vitest'
import type { MessageLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import {
  compileUserPlane,
  computePlacements,
  emptyUserPlane,
  parseUserPlane,
  type CustomProject,
  type Matcher,
} from './userplane.js'
import { buildSnapshot } from './snapshot.js'

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

const sessionEvents = (id: string, cwd: string): SourceEvent[] => [
  {
    type: 'transcript-lines',
    storeId: 's1',
    transcriptPath: `/home/.claude/projects/-x/${id}.jsonl`,
    sessionId: id,
    lines: [msg(`${id}-u1`, '2026-06-01T10:00:00Z', cwd)],
  },
]

const NOW = new Date('2026-06-01T12:00:00Z')

function stateWith(events: SourceEvent[]) {
  return foldAll(emptyState, events)
}

const project = (over: Partial<CustomProject> & { id: string }): CustomProject => ({
  name: over.id,
  matchers: [],
  include: [],
  exclude: [],
  ...over,
})

describe('parseUserPlane', () => {
  it('parses projects with matchers', () => {
    const { plane, error } = parseUserPlane(
      JSON.stringify({
        projects: {
          p1: {
            name: 'Extension v4',
            matchers: [
              { kind: 'remote', url: 'github.com/o/ext' },
              { kind: 'session', id: 'abc' },
            ],
            exclude: ['zzz'],
          },
        },
      }),
    )
    expect(error).toBeUndefined()
    expect(plane.projects).toEqual([
      {
        id: 'p1',
        name: 'Extension v4',
        matchers: [
          { kind: 'remote', url: 'github.com/o/ext' },
          { kind: 'session', id: 'abc' },
        ],
        include: [],
        exclude: ['zzz'],
      },
    ])
  })

  it('degrades gracefully on malformed input', () => {
    expect(parseUserPlane('{oops').plane).toEqual(emptyUserPlane)
    expect(parseUserPlane('{oops').error).toContain('not valid JSON')
    const wrong = parseUserPlane(JSON.stringify({ projects: { p1: { name: 5 } } }))
    expect(wrong.plane).toEqual(emptyUserPlane)
    expect(wrong.error).toContain('p1')
    expect(parseUserPlane('{}')).toEqual({ plane: { projects: [] } })
  })
})

describe('compileUserPlane', () => {
  it('compiles legacy splitRoots and projectNames into custom projects', () => {
    const compiled = compileUserPlane(emptyUserPlane, {
      splitRoots: ['/home/d/peri-stable'],
      projectNames: { 'split:local:/home/d/peri-stable': 'stable lane' },
    })
    expect(compiled).toEqual([
      {
        id: 'split:/home/d/peri-stable',
        name: 'stable lane',
        matchers: [{ kind: 'root', path: '/home/d/peri-stable' }],
        include: [],
        exclude: [],
      },
    ])
  })

  it('resolves compiled split names by exact or legacy store-qualified key only', () => {
    const config = {
      splitRoots: ['/a/b', '/c/d', '/e/f'],
      projectNames: {
        'split:/a/b': 'exact',
        'split:wsl:Ubuntu:/c/d': 'legacy',
        'not-split:/e/f': 'imposter',
      },
    }
    const names = compileUserPlane(emptyUserPlane, config).map((p) => p.name)
    expect(names).toEqual(['exact', 'legacy', 'f'])
  })

  it('skips compiling a split whose id the user plane already defines', () => {
    const plane = { projects: [project({ id: 'split:/a/b', name: 'mine' })] }
    const compiled = compileUserPlane(plane, { splitRoots: ['/a/b'] })
    expect(compiled).toHaveLength(1)
    expect(compiled[0]!.name).toBe('mine')
  })

  it('does not duplicate an include already present', () => {
    const plane = { projects: [project({ id: 'p1', include: ['abc'] })] }
    const compiled = compileUserPlane(plane, { sessions: { abc: { pinnedProject: 'p1' } } })
    expect(compiled[0]!.include).toEqual(['abc'])
  })

  it('turns pinnedProject entries naming a custom project into includes', () => {
    const compiled = compileUserPlane(
      { projects: [project({ id: 'p1', name: 'Mine' })] },
      { sessions: { abc: { pinnedProject: 'p1' }, def: { pinnedProject: 'unknown' } } },
    )
    expect(compiled[0]!.include).toEqual(['abc'])
  })

  it('never mutates its inputs', () => {
    const plane = { projects: [project({ id: 'p1' })] }
    compileUserPlane(plane, { sessions: { abc: { pinnedProject: 'p1' } } })
    expect(plane.projects[0]!.include).toEqual([])
  })
})

describe('computePlacements', () => {
  const gitEvents: SourceEvent[] = [
    {
      type: 'git-context-resolved',
      storeId: 's1',
      cwd: '/repo/a/src',
      context: { repoRoot: '/repo/a', isWorktree: false, remoteUrl: 'git@github.com:o/a.git' },
    },
    { type: 'git-context-resolved', storeId: 's1', cwd: '/plain/dir', context: null },
  ]

  function snapshotSessions(state = stateWith([...sessionEvents('one', '/repo/a/src'), ...sessionEvents('two', '/plain/dir'), ...gitEvents])) {
    return { state, sessions: buildSnapshot(state, { now: NOW }).sessions }
  }

  it('matches remotes with URL-form normalization', () => {
    const { state, sessions } = snapshotSessions()
    const placements = computePlacements(state, sessions, [
      project({ id: 'p1', matchers: [{ kind: 'remote', url: 'https://github.com/o/a' }] }),
    ])
    expect(placements).toEqual([
      { sessionId: 'one', customProjectId: 'p1', via: { kind: 'remote', url: 'https://github.com/o/a' } },
    ])
  })

  it('matches roots against repo roots and raw cwds', () => {
    const { state, sessions } = snapshotSessions()
    const viaRepoRoot = computePlacements(state, sessions, [
      project({ id: 'p1', matchers: [{ kind: 'root', path: '/repo/a' }] }),
    ])
    expect(viaRepoRoot.map((p) => p.sessionId)).toEqual(['one'])

    const viaCwd = computePlacements(state, sessions, [
      project({ id: 'p2', matchers: [{ kind: 'root', path: '/plain' }] }),
    ])
    expect(viaCwd.map((p) => p.sessionId)).toEqual(['two'])
  })

  it('supports cwd-prefix and session matchers', () => {
    const { state, sessions } = snapshotSessions()
    const placements = computePlacements(state, sessions, [
      project({ id: 'p1', matchers: [{ kind: 'cwd', prefix: '/repo/a/src' }] }),
      project({ id: 'p2', matchers: [{ kind: 'session', id: 'two' }] }),
    ])
    expect(placements).toEqual([
      { sessionId: 'one', customProjectId: 'p1', via: { kind: 'cwd', prefix: '/repo/a/src' } },
      { sessionId: 'two', customProjectId: 'p2', via: { kind: 'session', id: 'two' } },
    ])
  })

  it('labels: multiple projects claim the same session', () => {
    const { state, sessions } = snapshotSessions()
    const placements = computePlacements(state, sessions, [
      project({ id: 'a-work', matchers: [{ kind: 'remote', url: 'github.com/o/a' }] }),
      project({ id: 'everything', matchers: [{ kind: 'cwd', prefix: '/repo' }] }),
    ])
    expect(placements.filter((p) => p.sessionId === 'one').map((p) => p.customProjectId)).toEqual([
      'a-work',
      'everything',
    ])
  })

  it('include adds, exclude beats both matchers and include', () => {
    const { state, sessions } = snapshotSessions()
    const placements = computePlacements(state, sessions, [
      project({ id: 'p1', include: ['two'] }),
      project({
        id: 'p2',
        matchers: [{ kind: 'cwd', prefix: '/repo' }],
        include: ['one'],
        exclude: ['one'],
      }),
    ])
    expect(placements).toEqual([{ sessionId: 'two', customProjectId: 'p1', via: 'include' }])
  })

  it('matches roots through a worktree main repo root', () => {
    const state = stateWith([
      ...sessionEvents('wt', '/wt/feature'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/wt/feature',
        context: { repoRoot: '/wt/feature', isWorktree: true, mainRepoRoot: '/repo/main' },
      },
    ])
    const sessions = buildSnapshot(state, { now: NOW }).sessions
    const placements = computePlacements(state, sessions, [
      project({ id: 'p1', matchers: [{ kind: 'root', path: '/repo/main' }] }),
    ])
    expect(placements.map((p) => p.sessionId)).toEqual(['wt'])
  })

  it('sorts placements by session id then project id', () => {
    const { state, sessions } = snapshotSessions()
    const everything: Matcher[] = [
      { kind: 'cwd', prefix: '/repo' },
      { kind: 'cwd', prefix: '/plain' },
    ]
    const placements = computePlacements(state, sessions, [
      project({ id: 'zz', matchers: everything }),
      project({ id: 'aa', matchers: everything }),
    ])
    expect(placements.map((p) => `${p.sessionId}/${p.customProjectId}`)).toEqual([
      'one/aa',
      'one/zz',
      'two/aa',
      'two/zz',
    ])
  })

  it('survives base-plane changes: evidence matchers need no derived ids', () => {
    // Same user plane, applied before and after git enrichment exists —
    // the remote matcher only gains sessions, never errors or orphans.
    const bare = stateWith([...sessionEvents('one', '/repo/a/src')])
    const plane = [project({ id: 'p1', matchers: [{ kind: 'remote', url: 'github.com/o/a' }] })]
    const before = computePlacements(bare, buildSnapshot(bare, { now: NOW }).sessions, plane)
    expect(before).toEqual([])

    const { state, sessions } = snapshotSessions()
    const after = computePlacements(state, sessions, plane)
    expect(after.map((p) => p.sessionId)).toEqual(['one'])
  })
})

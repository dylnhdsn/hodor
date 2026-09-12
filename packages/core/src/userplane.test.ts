import { describe, expect, it } from 'vitest'
import type { MessageLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import {
  compileUserPlane,
  computePlacements,
  emptyUserPlane,
  parseUserPlane,
  previewMatcher,
  seedMatchersFor,
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
  excludeMatchers: [],
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
        excludeMatchers: [],
        include: [],
        exclude: ['zzz'],
      },
    ])
  })

  it('round-trips archived, derivedFrom and excludeMatchers', () => {
    const { plane, error } = parseUserPlane(
      JSON.stringify({
        projects: {
          p1: {
            name: 'peri',
            matchers: [{ kind: 'remote', url: 'github.com/o/peri' }],
            excludeMatchers: [{ kind: 'root', path: '/d/peri-stable' }],
            archived: true,
            derivedFrom: 'git-remote:github.com/o/peri',
          },
        },
      }),
    )
    expect(error).toBeUndefined()
    expect(plane.projects[0]).toMatchObject({
      excludeMatchers: [{ kind: 'root', path: '/d/peri-stable' }],
      archived: true,
      derivedFrom: 'git-remote:github.com/o/peri',
    })
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
        excludeMatchers: [],
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

  it('exclude matchers veto evidence matches, but includes still win', () => {
    const { state, sessions } = snapshotSessions()
    const placements = computePlacements(state, sessions, [
      // 'one' matches via cwd but is vetoed by the root exclude…
      project({
        id: 'p1',
        matchers: [{ kind: 'cwd', prefix: '/repo' }],
        excludeMatchers: [{ kind: 'root', path: '/repo/a' }],
      }),
      // …while an explicit include beats the same veto.
      project({
        id: 'p2',
        matchers: [{ kind: 'cwd', prefix: '/repo' }],
        excludeMatchers: [{ kind: 'root', path: '/repo/a' }],
        include: ['one'],
      }),
    ])
    expect(placements).toEqual([{ sessionId: 'one', customProjectId: 'p2', via: 'include' }])
  })
})

describe('seedMatchersFor', () => {
  it('captures a remote identity as a remote matcher', () => {
    expect(
      seedMatchersFor({
        id: 'git-remote:github.com/o/a',
        name: 'a',
        identity: { kind: 'git-remote', url: 'github.com/o/a' },
        roots: [],
      }),
    ).toEqual([{ kind: 'remote', url: 'github.com/o/a' }])
  })

  it('captures a git-root identity as a subtree root matcher', () => {
    expect(
      seedMatchersFor({
        id: 'git-root:s1:/repo/main',
        name: 'main',
        identity: { kind: 'path', storeId: 's1', root: '/repo/main' },
        roots: [],
      }),
    ).toEqual([{ kind: 'root', path: '/repo/main' }])
  })

  it('captures a cwd identity as an exact-dir matcher, never a subtree', () => {
    // Seeding a subtree claim for a bare folder (say, a home directory)
    // would swallow every project underneath it on archive.
    expect(
      seedMatchersFor({
        id: 'cwd:s1:/home/d',
        name: 'd',
        identity: { kind: 'path', storeId: 's1', root: '/home/d' },
        roots: [],
      }),
    ).toEqual([{ kind: 'dir', path: '/home/d' }])
  })
})

describe('dir matcher', () => {
  it('matches the exact folder only', () => {
    const state = stateWith([
      ...sessionEvents('home', '/home/d'),
      ...sessionEvents('nested', '/home/d/code/app'),
    ])
    const sessions = buildSnapshot(state, { now: NOW }).sessions
    const placements = computePlacements(state, sessions, [
      project({ id: 'p1', matchers: [{ kind: 'dir', path: '/home/d' }] }),
    ])
    expect(placements.map((p) => p.sessionId)).toEqual(['home'])
  })
})

describe('previewMatcher', () => {
  it('answers from the same evidence as placements', () => {
    const state = stateWith([
      ...sessionEvents('one', '/repo/a/src'),
      ...sessionEvents('two', '/plain/dir'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/repo/a/src',
        context: { repoRoot: '/repo/a', isWorktree: false, remoteUrl: 'git@github.com:o/a.git' },
      },
      { type: 'git-context-resolved', storeId: 's1', cwd: '/plain/dir', context: null },
    ])
    const sessions = buildSnapshot(state, { now: NOW }).sessions
    expect(previewMatcher(state, sessions, { kind: 'remote', url: 'https://github.com/o/a' })).toEqual(
      ['one'],
    )
    expect(previewMatcher(state, sessions, { kind: 'root', path: '/plain' })).toEqual(['two'])
    expect(previewMatcher(state, sessions, { kind: 'session', id: 'nope' })).toEqual([])
  })
})

describe('rule matchers: new leaves and combinators', () => {
  const session = (over: Record<string, unknown>) =>
    ({
      id: 'sess-1',
      storeId: 's1',
      transcriptPath: '/t',
      cwds: ['/repo/app'],
      entrypoints: ['cli'],
      counts: { user: 1, assistant: 1, sidechains: 0, toolCalls: 0 },
      threads: [],
      runtime: { kind: 'idle' },
      ...over,
    }) as never

  const state = { ...emptyState }

  it('branch globs, title text and regex, model, entrypoint', () => {
    const s = session({
      gitBranch: 'claude/deadlock-aim-42',
      promptPreview: 'Build a Yahtzee scorecard',
      usage: { 'claude-fable-5': {} },
    })
    expect(previewMatcher(state, [s], { kind: 'branch', glob: 'claude/deadlock-*' })).toEqual(['sess-1'])
    expect(previewMatcher(state, [s], { kind: 'branch', glob: 'claude/pour-*' })).toEqual([])
    expect(previewMatcher(state, [s], { kind: 'title', match: 'yahtzee' })).toEqual(['sess-1'])
    expect(previewMatcher(state, [s], { kind: 'title', match: '/score(card)?/i' })).toEqual(['sess-1'])
    expect(previewMatcher(state, [s], { kind: 'model', match: 'fable' })).toEqual(['sess-1'])
    expect(previewMatcher(state, [s], { kind: 'entrypoint', value: 'cli' })).toEqual(['sess-1'])
    expect(previewMatcher(state, [s], { kind: 'entrypoint', value: 'sdk' })).toEqual([])
  })

  it('all/any/not compose and nest', () => {
    const s = session({ gitBranch: 'claude/deadlock-aim-42', promptPreview: 'aim trainer' })
    const tree = {
      kind: 'all' as const,
      of: [
        { kind: 'any' as const, of: [{ kind: 'branch' as const, glob: 'claude/deadlock-*' }] },
        { kind: 'not' as const, of: { kind: 'title' as const, match: 'yahtzee' } },
      ],
    }
    expect(previewMatcher(state, [s], tree)).toEqual(['sess-1'])
    expect(
      previewMatcher(state, [s], { kind: 'not', of: { kind: 'branch', glob: 'claude/deadlock-*' } }),
    ).toEqual([])
  })

  it('nested combinators survive the projects.json parser', () => {
    const { plane, error } = parseUserPlane(
      JSON.stringify({
        projects: {
          games: {
            name: 'Games',
            matchers: [
              {
                kind: 'any',
                of: [
                  { kind: 'branch', glob: 'claude/deadlock-*' },
                  { kind: 'all', of: [{ kind: 'remote', url: 'github.com/x/y' }, { kind: 'title', match: 'aim' }] },
                ],
              },
            ],
          },
        },
      }),
    )
    expect(error).toBeUndefined()
    expect(plane.projects[0]!.matchers[0]).toMatchObject({ kind: 'any' })
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeCloudSession } from './cloud.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import { buildSnapshot } from './snapshot.js'

const store = {
  id: 's1',
  rootPath: '/home/u/.claude',
  pathFlavor: 'posix' as const,
  origin: { kind: 'native' as const },
  watchStrategy: 'poll' as const,
}

const localSession = (id: string): SourceEvent => ({
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
      promptText: 'work',
    },
  ],
})

const plane = (over: Partial<{ exclude: string[] }> = {}): SourceEvent => ({
  type: 'userplane-changed',
  plane: {
    projects: [
      {
        id: 'games',
        name: 'Games',
        matchers: [],
        excludeMatchers: [],
        include: [],
        exclude: over.exclude ?? [],
      },
    ],
  },
})

describe('organize labels in the snapshot', () => {
  it('places local sessions with organize provenance; exclude pins veto', () => {
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession('aaa'),
      localSession('bbb'),
      plane({ exclude: ['bbb'] }),
      {
        type: 'organize-results',
        labels: { aaa: ['Games'], bbb: ['games'], ccc: ['games'] },
        errors: [],
        evaluatedAt: '2026-09-12T12:00:00Z',
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T13:00:00Z') })
    expect(snapshot.placements).toEqual([
      { sessionId: 'aaa', customProjectId: 'games', via: 'organize' },
    ])
    expect(snapshot.organize).toEqual({ errors: [], unresolved: [] })
  })

  it('labels with no project surface as unresolved, with counts', () => {
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession('aaa'),
      localSession('bbb'),
      {
        type: 'organize-results',
        labels: { aaa: ['expensive'], bbb: ['expensive', 'family'] },
        errors: ['organize.js on xyz: boom'],
        evaluatedAt: '2026-09-12T12:00:00Z',
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T13:00:00Z') })
    expect(snapshot.placements).toEqual([])
    expect(snapshot.organize).toEqual({
      errors: ['organize.js on xyz: boom'],
      unresolved: [
        { label: 'expensive', sessions: 2 },
        { label: 'family', sessions: 1 },
      ],
    })
  })

  it('labels claim cloud sessions too (claimedBy, not placements)', () => {
    const cloud = normalizeCloudSession({ id: 'cse_norepo', title: 'gaming chat' })!
    const state = foldAll(emptyState, [
      plane(),
      { type: 'cloud-sessions-scanned', sessions: [cloud], scannedAt: '2026-09-12T12:00:00Z' },
      {
        type: 'organize-results',
        labels: { cse_norepo: ['games'] },
        errors: [],
        evaluatedAt: '2026-09-12T12:00:00Z',
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T13:00:00Z') })
    expect(snapshot.cloudSessions[0]!.claimedBy).toEqual(['games'])
  })
})

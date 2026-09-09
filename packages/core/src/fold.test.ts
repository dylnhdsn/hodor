import { describe, expect, it } from 'vitest'
import type { MessageLine, SummaryLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll, gitKey } from './fold.js'

const msg = (over: Partial<MessageLine> & { uuid: string }): MessageLine => ({
  kind: 'message',
  type: 'user',
  parentUuid: null,
  isSidechain: false,
  isMeta: false,
  ...over,
})

const lines = (sessionId: string, ls: (MessageLine | SummaryLine)[]): SourceEvent => ({
  type: 'transcript-lines',
  storeId: 's1',
  transcriptPath: `/store/projects/-x/${sessionId}.jsonl`,
  sessionId,
  lines: ls,
})

describe('fold', () => {
  it('accumulates counts, timestamps, cwds, and version', () => {
    const state = foldAll(emptyState, [
      lines('a', [
        msg({ uuid: 'u1', type: 'user', timestamp: '2026-01-01T10:00:00Z', cwd: '/x', version: '2.1.0' }),
        msg({ uuid: 'u2', type: 'assistant', timestamp: '2026-01-01T10:00:05Z', cwd: '/x' }),
        msg({ uuid: 'u3', type: 'user', timestamp: '2026-01-01T10:01:00Z', cwd: '/y', gitBranch: 'main' }),
      ]),
    ])
    const accum = state.sessions['a']!
    expect(accum.userCount).toBe(2)
    expect(accum.assistantCount).toBe(1)
    expect(accum.createdAt).toBe('2026-01-01T10:00:00Z')
    expect(accum.lastActivityAt).toBe('2026-01-01T10:01:00Z')
    expect(accum.cwds).toEqual(['/x', '/y'])
    expect(accum.gitBranch).toBe('main')
    expect(accum.cliVersion).toBe('2.1.0')
    expect(accum.main.messageCount).toBe(3)
  })

  it('is incremental: two appends equal one combined append', () => {
    const l1 = msg({ uuid: 'u1', timestamp: '2026-01-01T10:00:00Z', cwd: '/x' })
    const l2 = msg({ uuid: 'u2', timestamp: '2026-01-01T10:00:10Z' })
    const split = foldAll(emptyState, [lines('a', [l1]), lines('a', [l2])])
    const combined = foldAll(emptyState, [lines('a', [l1, l2])])
    expect(split).toEqual(combined)
  })

  it('groups sidechain messages into threads by parent chain', () => {
    const state = foldAll(emptyState, [
      lines('a', [
        msg({ uuid: 'm1', timestamp: '2026-01-01T10:00:00Z' }),
        msg({ uuid: 'sc1a', isSidechain: true, spawnedBy: { toolUseId: 't1', assistantUuid: 'm1' } }),
        msg({ uuid: 'sc2a', isSidechain: true, spawnedBy: { toolUseId: 't2', assistantUuid: 'm1' } }),
        msg({ uuid: 'sc1b', isSidechain: true, parentUuid: 'sc1a' }),
        msg({ uuid: 'sc1c', isSidechain: true, parentUuid: 'sc1b' }),
      ]),
    ])
    const accum = state.sessions['a']!
    expect(accum.sidechains).toHaveLength(2)
    expect(accum.sidechains[0]).toMatchObject({ messageCount: 3, spawnedBy: { toolUseId: 't1' } })
    expect(accum.sidechains[1]).toMatchObject({ messageCount: 1, spawnedBy: { toolUseId: 't2' } })
    expect(accum.main.messageCount).toBe(1)
  })

  it('takes the last summary', () => {
    const state = foldAll(emptyState, [
      lines('a', [
        { kind: 'summary', summary: 'first' },
        msg({ uuid: 'u1' }),
        { kind: 'summary', summary: 'second' },
      ]),
    ])
    expect(state.sessions['a']!.summary).toBe('second')
  })

  it('removes sessions when their transcript is removed', () => {
    const state = foldAll(emptyState, [
      lines('a', [msg({ uuid: 'u1' })]),
      lines('b', [msg({ uuid: 'u2' })]),
      { type: 'transcript-removed', storeId: 's1', transcriptPath: '/store/projects/-x/a.jsonl' },
    ])
    expect(Object.keys(state.sessions)).toEqual(['b'])
  })

  it('keeps the first real prompt as preview, skipping meta lines', () => {
    const state = foldAll(emptyState, [
      lines('a', [
        msg({ uuid: 'u0', isMeta: true, promptText: 'should not happen', entrypoint: 'cli' }),
        msg({ uuid: 'u1', promptText: 'first real ask', entrypoint: 'cli' }),
        msg({ uuid: 'u2', promptText: 'second ask', entrypoint: 'sdk' }),
      ]),
    ])
    const accum = state.sessions['a']!
    expect(accum.promptPreview).toBe('first real ask')
    expect(accum.entrypoints).toEqual(['cli', 'sdk'])
    // meta user lines do not count as user messages
    expect(accum.userCount).toBe(2)
    expect(accum.main.messageCount).toBe(3)
  })

  it('counts system messages in the main thread but not in user/assistant', () => {
    const state = foldAll(emptyState, [
      lines('a', [
        msg({ uuid: 'u1', type: 'user' }),
        msg({ uuid: 's1', type: 'system' }),
      ]),
    ])
    const accum = state.sessions['a']!
    expect(accum.main.messageCount).toBe(2)
    expect(accum.userCount).toBe(1)
    expect(accum.assistantCount).toBe(0)
  })

  it('handles identical timestamps without flapping', () => {
    const ts = '2026-01-01T10:00:00Z'
    const state = foldAll(emptyState, [
      lines('a', [msg({ uuid: 'u1', timestamp: ts }), msg({ uuid: 'u2', timestamp: ts })]),
    ])
    const accum = state.sessions['a']!
    expect(accum.createdAt).toBe(ts)
    expect(accum.lastActivityAt).toBe(ts)
    expect(accum.main).toMatchObject({ firstTs: ts, lastTs: ts, messageCount: 2 })
  })

  it('keeps distinct git contexts for cwds that would collide naively', () => {
    const context = { repoRoot: '/r', isWorktree: false }
    const state = foldAll(emptyState, [
      { type: 'git-context-resolved', storeId: 'a', cwd: 'b/c', context },
      { type: 'git-context-resolved', storeId: 'a/b', cwd: 'c', context: null },
    ])
    expect(state.gitContexts[gitKey('a', 'b/c')]).toEqual(context)
    expect(state.gitContexts[gitKey('a/b', 'c')]).toBeNull()
    expect(Object.keys(state.gitContexts)).toHaveLength(2)
  })

  it('does not mutate prior states', () => {
    const s1 = foldAll(emptyState, [lines('a', [msg({ uuid: 'u1', cwd: '/x' })])])
    const before = structuredClone(s1)
    foldAll(s1, [lines('a', [msg({ uuid: 'u2', cwd: '/y' })])])
    expect(s1).toEqual(before)
    expect(emptyState.sessions).toEqual({})
  })
})

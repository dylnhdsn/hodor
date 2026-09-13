import { describe, expect, it } from 'vitest'
import { parseTranscriptLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import { buildSnapshot, classifyTurn } from './snapshot.js'

const store = {
  id: 's1',
  rootPath: '/home/u/.claude',
  pathFlavor: 'posix' as const,
  origin: { kind: 'native' as const },
  watchStrategy: 'poll' as const,
}

const raw = (obj: Record<string, unknown>): string => JSON.stringify(obj)

const userLine = (uuid: string, ts: string, text: string) =>
  raw({
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: ts,
    cwd: '/w',
    message: { role: 'user', content: text },
  })

const assistantText = (uuid: string, ts: string, text: string) =>
  raw({
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

const assistantTool = (uuid: string, ts: string, id: string, name: string, input?: unknown) =>
  raw({
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: input ?? {} }] },
  })

const toolResult = (uuid: string, ts: string, forId: string) =>
  raw({
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: forId, content: 'ok' }],
    },
  })

function stateOf(...lines: string[]) {
  const events: SourceEvent[] = [
    { type: 'store-discovered', store },
    {
      type: 'transcript-lines',
      storeId: 's1',
      transcriptPath: '/home/u/.claude/projects/-w/aaa.jsonl',
      sessionId: 'aaa',
      lines: lines.map((l) => parseTranscriptLine(l)),
    },
  ]
  return foldAll(emptyState, events)
}

const turnAt = (state: ReturnType<typeof stateOf>, iso: string) =>
  buildSnapshot(state, { now: new Date(iso) }).sessions[0]!.turn

describe('turn-state parsing', () => {
  it('extracts tool_use ids and AskUserQuestion options', () => {
    const line = parseTranscriptLine(
      assistantTool('a1', '2026-09-13T10:00:00Z', 'tu1', 'AskUserQuestion', {
        questions: [
          {
            question: 'mock the worker scope, or move those specs to e2e?',
            options: [{ label: 'move them to e2e' }, { label: 'mock the scope' }],
          },
        ],
      }),
    )
    if (line.kind !== 'message') throw new Error('not a message')
    expect(line.toolUses).toEqual([
      {
        id: 'tu1',
        name: 'AskUserQuestion',
        question: 'mock the worker scope, or move those specs to e2e?',
        options: ['move them to e2e', 'mock the scope'],
      },
    ])
  })

  it('extracts tool_result ids from user lines', () => {
    const line = parseTranscriptLine(toolResult('u1', '2026-09-13T10:00:01Z', 'tu1'))
    if (line.kind !== 'message') throw new Error('not a message')
    expect(line.toolResultIds).toEqual(['tu1'])
  })
})

describe('classifyTurn via the fold', () => {
  it('waits when the agent had the last word and the file went quiet', () => {
    const state = stateOf(
      userLine('u1', '2026-09-13T10:00:00Z', 'do the thing'),
      assistantText('a1', '2026-09-13T10:01:00Z', 'done — want me to also X?'),
    )
    // fresh: still working (more blocks may stream)
    expect(turnAt(state, '2026-09-13T10:01:10Z')).toMatchObject({ state: 'working' })
    // quiet 31s: your turn, since the agent's last word — carried verbatim
    expect(turnAt(state, '2026-09-13T10:01:31Z')).toMatchObject({
      state: 'waiting',
      since: '2026-09-13T10:01:00Z',
      preview: 'done — want me to also X?',
    })
    // no idle downgrade: overnight is still a wait
    expect(turnAt(state, '2026-09-14T09:00:00Z')).toMatchObject({ state: 'waiting' })
  })

  it('treats an open AskUserQuestion as waiting immediately, with real options', () => {
    const state = stateOf(
      userLine('u1', '2026-09-13T10:00:00Z', 'x'),
      assistantTool('a1', '2026-09-13T10:00:30Z', 'tu1', 'AskUserQuestion', {
        questions: [{ question: 'which way?', options: [{ label: 'left' }, { label: 'right' }] }],
      }),
    )
    expect(turnAt(state, '2026-09-13T10:00:32Z')).toEqual({
      state: 'waiting',
      since: '2026-09-13T10:00:30Z',
      preview: 'which way?',
      pending: { tool: 'AskUserQuestion', question: 'which way?', options: ['left', 'right'] },
    })
  })

  it('keeps a pending ordinary tool as working (mid-run vs permission is unknowable)', () => {
    const state = stateOf(
      userLine('u1', '2026-09-13T10:00:00Z', 'x'),
      assistantTool('a1', '2026-09-13T10:00:30Z', 'tu1', 'Bash'),
    )
    expect(turnAt(state, '2026-09-13T10:10:00Z')).toEqual({
      state: 'working',
      pending: { tool: 'Bash' },
    })
    // hours-old pending tool = dead process
    expect(turnAt(state, '2026-09-13T13:00:00Z')).toEqual({ state: 'idle' })
  })

  it('resolves tools on results and returns to waiting after final text', () => {
    const state = stateOf(
      userLine('u1', '2026-09-13T10:00:00Z', 'x'),
      assistantTool('a1', '2026-09-13T10:00:30Z', 'tu1', 'Bash'),
      toolResult('u2', '2026-09-13T10:00:40Z', 'tu1'),
      assistantText('a2', '2026-09-13T10:00:50Z', 'all green'),
    )
    expect(turnAt(state, '2026-09-13T10:02:00Z')).toMatchObject({
      state: 'waiting',
      since: '2026-09-13T10:00:50Z',
    })
  })

  it('a human input abandons pending dialogs; trailing human input goes idle', () => {
    const state = stateOf(
      userLine('u1', '2026-09-13T10:00:00Z', 'x'),
      assistantTool('a1', '2026-09-13T10:00:30Z', 'tu1', 'AskUserQuestion', {
        questions: [{ question: 'pick', options: [{ label: 'a' }] }],
      }),
      userLine('u2', '2026-09-13T10:01:00Z', '[Request interrupted] actually do it differently'),
    )
    // shortly after: the model should be replying
    expect(turnAt(state, '2026-09-13T10:01:20Z')).toEqual({ state: 'working' })
    // long quiet after a human prompt: the process is dead
    expect(turnAt(state, '2026-09-13T10:30:00Z')).toEqual({ state: 'idle' })
  })

  it('classifyTurn is exported for direct use', () => {
    expect(
      classifyTurn(
        { lastMainAt: '2026-09-13T10:00:00Z', lastMainKind: 'assistant-text', openTools: {} },
        new Date('2026-09-13T10:05:00Z'),
      ),
    ).toMatchObject({ state: 'waiting' })
  })
})

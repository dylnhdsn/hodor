import { describe, expect, it } from 'vitest'
import { enrichCheckpointBackups } from './checkpoints.js'
import { parseTranscriptLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll } from './fold.js'
import { MemFs } from './fs.js'
import { buildSnapshot } from './snapshot.js'
import type { SessionStore } from './types.js'

// Shapes captured verbatim from CLI 2.1.269 (docs/brainstorm/017).
const snapshotLine = JSON.stringify({
  type: 'file-history-snapshot',
  messageId: 'cp-2',
  snapshot: {
    messageId: 'cp-2',
    trackedFileBackups: {
      'beta.txt': {
        backupFileName: 'a4ceddcf0644f5fa@v2',
        version: 2,
        backupTime: '2026-09-12T15:36:57.126Z',
        realParentDir: '/tmp/cptest',
      },
      'alpha.txt': {
        backupFileName: '3dcd1fa448e6d791@v2',
        version: 2,
        backupTime: '2026-09-12T15:36:57.127Z',
        realParentDir: '/tmp/cptest',
      },
    },
    timestamp: '2026-09-12T15:36:57.127Z',
  },
  isSnapshotUpdate: false,
})

const deltaLine = JSON.stringify({
  type: 'file-history-delta',
  messageId: 'm-1',
  snapshotMessageId: 'cp-1',
  trackingPath: 'alpha.txt',
  backup: {
    backupFileName: null,
    version: 1,
    backupTime: '2026-09-12T15:36:25.217Z',
    realParentDir: '/tmp/cptest',
  },
  timestamp: '2026-09-12T15:36:25.218Z',
})

describe('checkpoint line parsing', () => {
  it('reads a file-history-snapshot with tracked backups', () => {
    expect(parseTranscriptLine(snapshotLine)).toEqual({
      kind: 'other',
      type: 'file-history-snapshot',
      checkpoint: {
        id: 'cp-2',
        isUpdate: false,
        ts: '2026-09-12T15:36:57.127Z',
        files: ['/tmp/cptest/beta.txt', '/tmp/cptest/alpha.txt'],
      },
    })
  })

  it('reads a file-history-delta, resolving the tracked path', () => {
    expect(parseTranscriptLine(deltaLine)).toEqual({
      kind: 'other',
      type: 'file-history-delta',
      checkpointDelta: { file: '/tmp/cptest/alpha.txt', ts: '2026-09-12T15:36:25.218Z' },
    })
  })

  it('resolves Windows parent dirs with backslashes', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'file-history-delta',
        trackingPath: 'src\\app.ts',
        backup: { realParentDir: 'C:\\code\\proj' },
        timestamp: '2026-09-12T00:00:00Z',
      }),
    )
    expect(line).toMatchObject({
      checkpointDelta: { file: 'C:\\code\\proj\\src\\app.ts' },
    })
  })

  it('tolerates an empty first snapshot', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'file-history-snapshot',
        messageId: 'cp-1',
        snapshot: { messageId: 'cp-1', trackedFileBackups: {}, timestamp: '2026-09-12T15:36:22Z' },
        isSnapshotUpdate: false,
      }),
    )
    expect(line).toMatchObject({
      checkpoint: { id: 'cp-1', isUpdate: false, files: [] },
    })
  })
})

const store: SessionStore = {
  id: 's1',
  rootPath: '/home/u/.claude',
  pathFlavor: 'posix',
  origin: { kind: 'native' },
  watchStrategy: 'poll',
}

const checkpointEvents: SourceEvent[] = [
  { type: 'store-discovered', store },
  {
    type: 'transcript-lines',
    storeId: 's1',
    transcriptPath: '/home/u/.claude/projects/-x/aaa.jsonl',
    sessionId: 'aaa',
    lines: [
      {
        kind: 'message',
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        isMeta: false,
        timestamp: '2026-09-12T15:36:20Z',
        cwd: '/tmp/cptest',
        promptText: 'hi',
      },
      parseTranscriptLine(
        JSON.stringify({
          type: 'file-history-snapshot',
          messageId: 'cp-1',
          snapshot: { trackedFileBackups: {}, timestamp: '2026-09-12T15:36:22Z' },
          isSnapshotUpdate: false,
        }),
      ),
      // An update rewrites the same checkpoint id — never a second checkpoint.
      parseTranscriptLine(
        JSON.stringify({
          type: 'file-history-snapshot',
          messageId: 'cp-1',
          snapshot: { trackedFileBackups: {}, timestamp: '2026-09-12T15:36:23Z' },
          isSnapshotUpdate: true,
        }),
      ),
      parseTranscriptLine(deltaLine),
      parseTranscriptLine(snapshotLine),
    ],
  },
]

describe('checkpoint folding and snapshot', () => {
  it('dedupes checkpoints by id, unions files, tracks edits and last-at', () => {
    const state = foldAll(emptyState, checkpointEvents)
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T16:00:00Z') })
    const session = snapshot.sessions.find((s) => s.id === 'aaa')!
    expect(session.checkpoints).toEqual({
      count: 2, // cp-1 (update deduped) + cp-2
      edits: 1,
      files: ['/tmp/cptest/alpha.txt', '/tmp/cptest/beta.txt'],
      lastAt: '2026-09-12T15:36:57.127Z',
    })
  })

  it('omits checkpoints entirely for sessions without checkpoint lines', () => {
    const state = foldAll(emptyState, [
      checkpointEvents[0]!,
      {
        type: 'transcript-lines',
        storeId: 's1',
        transcriptPath: '/home/u/.claude/projects/-x/bbb.jsonl',
        sessionId: 'bbb',
        lines: [
          {
            kind: 'message',
            type: 'user',
            uuid: 'u9',
            parentUuid: null,
            isSidechain: false,
            isMeta: false,
            timestamp: '2026-09-12T15:00:00Z',
          },
        ],
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T16:00:00Z') })
    expect(snapshot.sessions.find((s) => s.id === 'bbb')!.checkpoints).toBeUndefined()
  })
})

describe('enrichCheckpointBackups', () => {
  it('counts backup files for checkpointed sessions and caches results', async () => {
    const fs = new MemFs()
    fs.writeFile('/home/u/.claude/file-history/aaa/3dcd1fa448e6d791@v2', 'old bytes')
    fs.writeFile('/home/u/.claude/file-history/aaa/a4ceddcf0644f5fa@v2', 'old bytes')

    let state = foldAll(emptyState, checkpointEvents)
    const events = await enrichCheckpointBackups(state, () => fs)
    expect(events).toEqual([
      { type: 'checkpoint-backups-scanned', storeId: 's1', sessionId: 'aaa', backupFiles: 2 },
    ])
    state = foldAll(state, events)

    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T16:00:00Z') })
    expect(snapshot.sessions.find((s) => s.id === 'aaa')!.checkpoints?.backupFiles).toBe(2)

    // cached: nothing left to probe
    expect(await enrichCheckpointBackups(state, () => fs)).toEqual([])
  })

  it('reports 0 when the backup dir is gone (expired), and skips sessions without checkpoints', async () => {
    const fs = new MemFs()
    let state = foldAll(emptyState, checkpointEvents)
    const events = await enrichCheckpointBackups(state, () => fs)
    expect(events).toEqual([
      { type: 'checkpoint-backups-scanned', storeId: 's1', sessionId: 'aaa', backupFiles: 0 },
    ])
    state = foldAll(state, events)
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T16:00:00Z') })
    expect(snapshot.sessions.find((s) => s.id === 'aaa')!.checkpoints?.backupFiles).toBe(0)
  })
})

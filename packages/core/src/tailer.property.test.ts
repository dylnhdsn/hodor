import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { emptyState, foldAll } from './fold.js'
import { MemFs } from './fs.js'
import { buildSnapshot } from './snapshot.js'
import { StoreTailer, scanStore } from './tailer.js'
import type { SessionStore } from './types.js'

/**
 * Flagship invariant: for any sequence of store mutations, folding the
 * tailer's incremental events produces the same snapshot as one full
 * rescan of the final tree. If this holds, live mode can never drift.
 */

const store: SessionStore = {
  id: 's1',
  rootPath: '/home/.claude',
  pathFlavor: 'posix',
  origin: { kind: 'native' },
  watchStrategy: 'poll',
}

const SESSION_FILES = [
  '/home/.claude/projects/-repo-a/aaaa.jsonl',
  '/home/.claude/projects/-repo-a/bbbb.jsonl',
  '/home/.claude/projects/-repo-b/cccc.jsonl',
]

const CWDS = ['/repo/a', '/repo/b']

type Op =
  | { kind: 'append'; file: number; messages: number; garbage: boolean; sidechain: boolean }
  | { kind: 'remove'; file: number }
  | { kind: 'truncate'; file: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
      kind: fc.constant('append' as const),
      file: fc.integer({ min: 0, max: SESSION_FILES.length - 1 }),
      messages: fc.integer({ min: 1, max: 3 }),
      garbage: fc.boolean(),
      sidechain: fc.boolean(),
    }) },
  { weight: 1, arbitrary: fc.record({
      kind: fc.constant('remove' as const),
      file: fc.integer({ min: 0, max: SESSION_FILES.length - 1 }),
    }) },
  { weight: 1, arbitrary: fc.record({
      kind: fc.constant('truncate' as const),
      file: fc.integer({ min: 0, max: SESSION_FILES.length - 1 }),
    }) },
)

const batchesArb = fc.array(fc.array(opArb, { minLength: 1, maxLength: 3 }), { maxLength: 6 })

function materialize(op: Op, fs: MemFs, counter: { n: number }): void {
  const path = SESSION_FILES[op.kind === 'append' ? op.file : op.file]!
  if (op.kind === 'remove') {
    fs.removeFile(path)
    return
  }
  if (op.kind === 'truncate') {
    fs.writeFile(path, '')
    return
  }
  let content = ''
  for (let i = 0; i < op.messages; i++) {
    const n = counter.n++
    const ts = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString()
    const type = n % 2 === 0 ? 'user' : 'assistant'
    content += JSON.stringify({
      type,
      uuid: `u${n}`,
      parentUuid: null,
      isSidechain: op.sidechain && i === op.messages - 1,
      timestamp: ts,
      cwd: CWDS[n % CWDS.length],
    })
    content += '\n'
  }
  if (op.garbage) content += 'this is not json\n'
  fs.appendFile(path, content)
}

describe('incremental tailing equals full rescan', () => {
  it('holds for arbitrary mutation sequences', async () => {
    await fc.assert(
      fc.asyncProperty(batchesArb, async (batches) => {
        const fs = new MemFs()
        const tailer = new StoreTailer(fs, store)
        const counter = { n: 0 }

        let incremental = foldAll(emptyState, await tailer.poll())
        for (const batch of batches) {
          // A file removed/truncated and then re-grown between two polls is
          // out of contract (append-only transcripts; documented in
          // tailer.ts), so skip appends to files already reset this batch.
          const reset = new Set<number>()
          for (const op of batch) {
            if (op.kind === 'append' && reset.has(op.file)) continue
            if (op.kind !== 'append') reset.add(op.file)
            materialize(op, fs, counter)
          }
          incremental = foldAll(incremental, await tailer.poll())
        }

        const fresh = foldAll(emptyState, await scanStore(fs, store))

        const now = new Date('2026-06-01T00:00:00Z')
        expect(buildSnapshot(incremental, { now })).toEqual(buildSnapshot(fresh, { now }))
      }),
      { numRuns: 50 },
    )
  })

  it('holds when appends split lines at arbitrary byte positions', async () => {
    const lineText = JSON.stringify({
      type: 'user',
      uuid: 'u-split',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/répo/ünïcode',
    })
    const bytes = new TextEncoder().encode(lineText + '\n')

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: bytes.length - 1 }), { maxLength: 4 }),
        async (rawCuts) => {
          const cuts = [...new Set(rawCuts)].sort((a, b) => a - b)
          const fs = new MemFs()
          const tailer = new StoreTailer(fs, store)
          fs.writeFile(SESSION_FILES[0]!, '')
          let incremental = foldAll(emptyState, await tailer.poll())

          let prev = 0
          for (const cut of [...cuts, bytes.length]) {
            fs.appendBytes(SESSION_FILES[0]!, bytes.slice(prev, cut))
            prev = cut
            incremental = foldAll(incremental, await tailer.poll())
          }

          const fresh = foldAll(emptyState, await scanStore(fs, store))
          const now = new Date('2026-06-01T00:00:00Z')
          expect(buildSnapshot(incremental, { now })).toEqual(buildSnapshot(fresh, { now }))
          expect(incremental.sessions['aaaa']?.cwds).toEqual(['/répo/ünïcode'])
        },
      ),
      { numRuns: 50 },
    )
  })
})

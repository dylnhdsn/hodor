import { parseTranscriptLine, type TranscriptLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import type { FileSystem } from './fs.js'
import { flavorOfPath, pathOps } from './paths.js'
import type { SessionStore } from './types.js'

/**
 * Incremental transcript tailer for one session store.
 *
 * Transcripts are append-only JSONL, so each file is tracked by byte offset
 * plus a pending buffer for a partial trailing line (appends can split a
 * line — or a multi-byte UTF-8 character — across polls; bytes are only
 * decoded once a newline completes them).
 *
 * A fresh tailer's first poll IS the initial scan: discovery and live
 * tailing share this one code path, which is what makes the
 * "incremental folding equals full rescan" invariant testable.
 */

const NEWLINE = 0x0a

interface TrackedFile {
  sessionId: string
  offset: number
  pending: Uint8Array
  mtimeMs: number
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.length + b.length)
  merged.set(a, 0)
  merged.set(b, a.length)
  return merged
}

/** Split buffered bytes into complete decoded lines and the leftover tail. */
export function splitCompleteLines(buffer: Uint8Array): { lines: string[]; rest: Uint8Array } {
  let lastNewline = -1
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i] === NEWLINE) {
      lastNewline = i
      break
    }
  }
  if (lastNewline === -1) return { lines: [], rest: buffer }
  const complete = new TextDecoder().decode(buffer.slice(0, lastNewline))
  const rest = buffer.slice(lastNewline + 1)
  return { lines: complete.split('\n').filter((l) => l.trim().length > 0), rest }
}

export class StoreTailer {
  private tracked = new Map<string, TrackedFile>()
  private announced = false

  constructor(
    private readonly fs: FileSystem,
    readonly store: SessionStore,
  ) {}

  async poll(): Promise<SourceEvent[]> {
    const events: SourceEvent[] = []
    if (!this.announced) {
      this.announced = true
      events.push({ type: 'store-discovered', store: this.store })
    }

    const p = pathOps(flavorOfPath(this.store.rootPath))
    const projectsDir = p.join(this.store.rootPath, 'projects')
    const current = new Map<string, string>() // path → sessionId

    for (const bucket of await this.fs.listDir(projectsDir)) {
      const bucketPath = p.join(projectsDir, bucket)
      if ((await this.fs.stat(bucketPath))?.kind !== 'dir') continue
      for (const entry of await this.fs.listDir(bucketPath)) {
        if (!entry.endsWith('.jsonl')) continue
        current.set(p.join(bucketPath, entry), entry.slice(0, -'.jsonl'.length))
      }
    }

    for (const [path, tracked] of this.tracked) {
      if (!current.has(path)) {
        this.tracked.delete(path)
        events.push({ type: 'transcript-removed', storeId: this.store.id, transcriptPath: path })
      }
    }

    for (const [path, sessionId] of current) {
      const stat = await this.fs.stat(path)
      if (stat?.kind !== 'file') continue

      let tracked = this.tracked.get(path)
      const rewritten =
        tracked !== undefined &&
        tracked.offset > 0 &&
        (stat.size < tracked.offset ||
          (stat.size === tracked.offset && stat.mtimeMs !== tracked.mtimeMs))
      if (rewritten) {
        // Truncated or rewritten in place: drop derived state, re-read from
        // zero. (A rewrite that also grows the file is indistinguishable
        // from an append by size/mtime alone — transcripts are append-only,
        // so that case is accepted as out of contract.)
        events.push({ type: 'transcript-removed', storeId: this.store.id, transcriptPath: path })
        tracked = undefined
      }
      if (tracked === undefined) {
        tracked = { sessionId, offset: 0, pending: new Uint8Array(0), mtimeMs: stat.mtimeMs }
        this.tracked.set(path, tracked)
      }
      if (stat.size <= tracked.offset) {
        tracked.mtimeMs = stat.mtimeMs
        continue
      }

      const bytes = await this.fs.readBytesFrom(path, tracked.offset)
      if (bytes === undefined || bytes.length === 0) continue
      tracked.offset += bytes.length
      tracked.mtimeMs = (await this.fs.stat(path))?.mtimeMs ?? stat.mtimeMs

      const { lines, rest } = splitCompleteLines(concat(tracked.pending, bytes))
      tracked.pending = rest
      if (lines.length === 0) continue

      const parsed: TranscriptLine[] = lines.map(parseTranscriptLine)
      events.push({
        type: 'transcript-lines',
        storeId: this.store.id,
        transcriptPath: path,
        sessionId,
        lines: parsed,
      })
    }

    return events
  }
}

/** Initial discovery of a store — a fresh tailer's first poll. */
export function scanStore(fs: FileSystem, store: SessionStore): Promise<SourceEvent[]> {
  return new StoreTailer(fs, store).poll()
}

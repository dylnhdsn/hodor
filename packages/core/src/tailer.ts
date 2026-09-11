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
  /** Path used in emitted events: for subagent files, the parent's main
   * transcript, so folding is independent of which file appears first. */
  eventPath: string
  isSubagent: boolean
  offset: number
  pending: Uint8Array
  mtimeMs: number
}

interface DiscoveredFile {
  sessionId: string
  eventPath: string
  isSubagent: boolean
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
    const current = new Map<string, DiscoveredFile>()

    for (const bucket of await this.fs.listDir(projectsDir)) {
      const bucketPath = p.join(projectsDir, bucket)
      if ((await this.fs.stat(bucketPath))?.kind !== 'dir') continue
      for (const entry of await this.fs.listDir(bucketPath)) {
        if (entry.endsWith('.jsonl')) {
          const path = p.join(bucketPath, entry)
          const sessionId = entry.slice(0, -'.jsonl'.length)
          current.set(path, { sessionId, eventPath: path, isSubagent: false })
          continue
        }
        // Modern CLIs write each subagent run to its own transcript under
        // <bucket>/<sessionId>/subagents/agent-<id>.jsonl. Those lines are
        // sidechains of the PARENT session; events carry the parent's main
        // transcript path so fold order never matters.
        const subagentsPath = p.join(bucketPath, entry, 'subagents')
        if ((await this.fs.stat(subagentsPath))?.kind !== 'dir') continue
        const mainPath = p.join(bucketPath, `${entry}.jsonl`)
        for (const agentFile of await this.fs.listDir(subagentsPath)) {
          if (!agentFile.startsWith('agent-') || !agentFile.endsWith('.jsonl')) continue
          current.set(p.join(subagentsPath, agentFile), {
            sessionId: entry,
            eventPath: mainPath,
            isSubagent: true,
          })
        }
      }
    }

    for (const [path, tracked] of this.tracked) {
      if (!current.has(path)) {
        this.tracked.delete(path)
        // A removed subagent file never removes the parent session: the
        // event's path is the agent file, which no session claims as its
        // transcript. The next full rescan is what truly forgets its lines.
        if (!tracked.isSubagent) {
          events.push({ type: 'transcript-removed', storeId: this.store.id, transcriptPath: path })
        }
      }
    }

    for (const [path, found] of current) {
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
        // so that case is accepted as out of contract.) For a subagent file
        // the removal event would name the parent's transcript and wipe the
        // whole session, so rewrites there are out of contract too: reset
        // silently and accept re-reading.
        if (!found.isSubagent) {
          events.push({ type: 'transcript-removed', storeId: this.store.id, transcriptPath: path })
        }
        tracked = undefined
      }
      if (tracked === undefined) {
        tracked = {
          sessionId: found.sessionId,
          eventPath: found.eventPath,
          isSubagent: found.isSubagent,
          offset: 0,
          pending: new Uint8Array(0),
          mtimeMs: stat.mtimeMs,
        }
        this.tracked.set(path, tracked)
        if (found.isSubagent) {
          const meta = await this.readAgentMeta(path)
          if (meta !== undefined) {
            events.push({
              type: 'subagent-meta',
              storeId: this.store.id,
              sessionId: found.sessionId,
              transcriptPath: found.eventPath,
              agentId: meta.agentId,
              ...(meta.agentType !== undefined ? { agentType: meta.agentType } : {}),
              ...(meta.description !== undefined ? { description: meta.description } : {}),
            })
          }
        }
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
        transcriptPath: tracked.eventPath,
        sessionId: tracked.sessionId,
        lines: parsed,
      })
    }

    return events
  }

  /** agent-<id>.meta.json beside a subagent transcript; tolerant like the
   * line parser — a missing or malformed sidecar just means no metadata. */
  private async readAgentMeta(
    agentPath: string,
  ): Promise<{ agentId: string; agentType?: string; description?: string } | undefined> {
    const file = agentPath.slice(agentPath.lastIndexOf('agent-'))
    const agentId = file.slice('agent-'.length, -'.jsonl'.length)
    if (agentId.length === 0) return undefined
    const metaPath = agentPath.slice(0, -'.jsonl'.length) + '.meta.json'
    const content = await this.fs.readFile(metaPath).catch(() => undefined)
    if (content === undefined) return { agentId }
    try {
      const json = JSON.parse(content) as { agentType?: unknown; description?: unknown }
      return {
        agentId,
        ...(typeof json.agentType === 'string' ? { agentType: json.agentType } : {}),
        ...(typeof json.description === 'string' ? { description: json.description } : {}),
      }
    } catch {
      return { agentId }
    }
  }
}

/** Initial discovery of a store — a fresh tailer's first poll. */
export function scanStore(fs: FileSystem, store: SessionStore): Promise<SourceEvent[]> {
  return new StoreTailer(fs, store).poll()
}

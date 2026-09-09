import type { MessageLine } from './claude/transcript.js'
import type { SourceEvent } from './events.js'
import type { GitContext } from './git.js'
import type { Runtime, SessionId, SessionMeta, SessionStore, StoreId } from './types.js'

/**
 * The pure core: state' = fold(state, event). No I/O, no clocks, no
 * randomness — everything time- or filesystem-shaped arrives as an event,
 * and presentation-ready output is derived by selectors (snapshot.ts).
 */

export interface ThreadAccum {
  firstTs?: string
  lastTs?: string
  messageCount: number
  spawnedBy?: { toolUseId: string; assistantUuid: string }
}

export interface SessionAccum {
  id: SessionId
  storeId: StoreId
  transcriptPath: string
  cwds: string[]
  gitBranch?: string
  summary?: string
  createdAt?: string
  lastActivityAt?: string
  cliVersion?: string
  userCount: number
  assistantCount: number
  main: ThreadAccum
  sidechains: ThreadAccum[]
  /** message uuid → index into sidechains, for incremental chain-following. */
  uuidToSidechain: Record<string, number>
}

export interface CoreState {
  stores: Record<StoreId, SessionStore>
  sessions: Record<SessionId, SessionAccum>
  /** gitKey(storeId, cwd) → context; null = resolved as "not in a repo". */
  gitContexts: Record<string, GitContext | null>
  metas: Record<SessionId, SessionMeta>
  /** Authoritative runtimes (e.g. hosted PTYs); absent = infer from activity. */
  runtimes: Record<SessionId, Runtime>
}

export const emptyState: CoreState = {
  stores: {},
  sessions: {},
  gitContexts: {},
  metas: {},
  runtimes: {},
}

export function gitKey(storeId: StoreId, cwd: string): string {
  // NUL appears in neither store ids nor paths, so keys never collide.
  return storeId + '\0' + cwd
}

function newAccum(id: SessionId, storeId: StoreId, transcriptPath: string): SessionAccum {
  return {
    id,
    storeId,
    transcriptPath,
    cwds: [],
    userCount: 0,
    assistantCount: 0,
    main: { messageCount: 0 },
    sidechains: [],
    uuidToSidechain: {},
  }
}

function touchThread(thread: ThreadAccum, ts: string | undefined): void {
  thread.messageCount += 1
  if (ts === undefined) return
  if (thread.firstTs === undefined || ts < thread.firstTs) thread.firstTs = ts
  if (thread.lastTs === undefined || ts > thread.lastTs) thread.lastTs = ts
}

function applyMessage(accum: SessionAccum, line: MessageLine): void {
  const ts = line.timestamp
  if (ts !== undefined) {
    if (accum.createdAt === undefined || ts < accum.createdAt) accum.createdAt = ts
    if (accum.lastActivityAt === undefined || ts > accum.lastActivityAt) accum.lastActivityAt = ts
  }

  if (line.isSidechain) {
    let index = line.parentUuid !== null ? accum.uuidToSidechain[line.parentUuid] : undefined
    if (index === undefined) {
      const thread: ThreadAccum = { messageCount: 0 }
      if (line.spawnedBy !== undefined) thread.spawnedBy = line.spawnedBy
      accum.sidechains.push(thread)
      index = accum.sidechains.length - 1
    }
    accum.uuidToSidechain[line.uuid] = index
    touchThread(accum.sidechains[index]!, ts)
    return
  }

  touchThread(accum.main, ts)
  if (line.type === 'user') accum.userCount += 1
  if (line.type === 'assistant') accum.assistantCount += 1
  if (line.cwd !== undefined && !accum.cwds.includes(line.cwd)) accum.cwds.push(line.cwd)
  if (line.gitBranch !== undefined) accum.gitBranch = line.gitBranch
  if (line.version !== undefined) accum.cliVersion = line.version
}

function cloneAccum(accum: SessionAccum): SessionAccum {
  return {
    ...accum,
    cwds: [...accum.cwds],
    main: { ...accum.main },
    sidechains: accum.sidechains.map((t) => ({ ...t })),
    uuidToSidechain: { ...accum.uuidToSidechain },
  }
}

export function fold(state: CoreState, event: SourceEvent): CoreState {
  switch (event.type) {
    case 'store-discovered':
      return { ...state, stores: { ...state.stores, [event.store.id]: event.store } }

    case 'transcript-lines': {
      const existing = state.sessions[event.sessionId]
      const accum = existing
        ? cloneAccum(existing)
        : newAccum(event.sessionId, event.storeId, event.transcriptPath)
      for (const line of event.lines) {
        if (line.kind === 'message') applyMessage(accum, line)
        else if (line.kind === 'summary') accum.summary = line.summary
      }
      return { ...state, sessions: { ...state.sessions, [event.sessionId]: accum } }
    }

    case 'transcript-removed': {
      const sessions: Record<SessionId, SessionAccum> = {}
      for (const [id, accum] of Object.entries(state.sessions)) {
        if (accum.transcriptPath !== event.transcriptPath) sessions[id] = accum
      }
      return { ...state, sessions }
    }

    case 'git-context-resolved':
      return {
        ...state,
        gitContexts: { ...state.gitContexts, [gitKey(event.storeId, event.cwd)]: event.context },
      }

    case 'runtime-changed':
      return { ...state, runtimes: { ...state.runtimes, [event.sessionId]: event.runtime } }

    case 'meta-changed':
      return { ...state, metas: { ...state.metas, [event.meta.sessionId]: event.meta } }
  }
}

export function foldAll(state: CoreState, events: Iterable<SourceEvent>): CoreState {
  let next = state
  for (const event of events) next = fold(next, event)
  return next
}

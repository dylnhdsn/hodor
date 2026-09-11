import type { MessageLine } from './claude/transcript.js'
import type { HodorConfig } from './config.js'
import type { SourceEvent } from './events.js'
import type { GitContext } from './git.js'
import { addUsage, emptyUsage, type UsageTotals } from './pricing.js'
import type { Runtime, SessionId, SessionMeta, SessionStore, StoreId } from './types.js'
import { emptyUserPlane, type UserPlane } from './userplane.js'

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
  /** Modern subagent runs: the agent id stamped on their lines. */
  agentId?: string
  /** Token usage by model, billed once per API message id. */
  usageByModel?: Record<string, UsageTotals>
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
  /** First real (non-meta, non-command) user prompt — the fallback title. */
  promptPreview?: string
  /** First slash command that started the session, e.g. "/gsd-resume-work". */
  firstCommand?: string
  /** Unique entrypoint values observed (cli, sdk, remote, …). */
  entrypoints: string[]
  /**
   * A forked/resumed-as-new session carries copied history whose lines
   * still hold the ORIGINAL session id — the first mismatch names the
   * ancestor.
   */
  forkedFrom?: SessionId
  userCount: number
  assistantCount: number
  /** tool_use blocks seen, main and sidechains alike. */
  toolCallCount: number
  /** API message ids already billed — usage repeats on every content-block
   * line of one response, so each id counts exactly once. */
  billedMessageIds: Record<string, true>
  main: ThreadAccum
  sidechains: ThreadAccum[]
  /** message uuid → index into sidechains, for incremental chain-following. */
  uuidToSidechain: Record<string, number>
  /** agent id → index into sidechains (modern per-file subagent runs). */
  agentToSidechain: Record<string, number>
  /** agent id → sidecar metadata from agent-<id>.meta.json. */
  agentMeta: Record<string, { agentType?: string; description?: string }>
}

export interface CoreState {
  stores: Record<StoreId, SessionStore>
  sessions: Record<SessionId, SessionAccum>
  /** gitKey(storeId, cwd) → context; null = resolved as "not in a repo". */
  gitContexts: Record<string, GitContext | null>
  metas: Record<SessionId, SessionMeta>
  /** Authoritative runtimes (e.g. hosted PTYs); absent = infer from activity. */
  runtimes: Record<SessionId, Runtime>
  /** Persisted user configuration (settings/policy). */
  config: HodorConfig
  /** Persisted user plane: custom projects and their mappings. */
  userPlane: UserPlane
}

export const emptyState: CoreState = {
  stores: {},
  sessions: {},
  gitContexts: {},
  metas: {},
  runtimes: {},
  config: {},
  userPlane: emptyUserPlane,
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
    entrypoints: [],
    userCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    billedMessageIds: {},
    main: { messageCount: 0 },
    sidechains: [],
    uuidToSidechain: {},
    agentToSidechain: {},
    agentMeta: {},
  }
}

function touchThread(thread: ThreadAccum, ts: string | undefined): void {
  thread.messageCount += 1
  if (ts === undefined) return
  if (thread.firstTs === undefined || ts < thread.firstTs) thread.firstTs = ts
  if (thread.lastTs === undefined || ts > thread.lastTs) thread.lastTs = ts
}

/** Bill a line's usage into its thread — once per API message id. */
function billUsage(accum: SessionAccum, thread: ThreadAccum, line: MessageLine): void {
  if (line.toolUses !== undefined) accum.toolCallCount += line.toolUses
  if (line.usage === undefined || line.model === undefined) return
  // Lines without a message id can't be deduped; bill them individually
  // (observed only on synthetic lines, which carry no usage anyway).
  if (line.messageId !== undefined) {
    if (accum.billedMessageIds[line.messageId] === true) return
    accum.billedMessageIds[line.messageId] = true
  }
  thread.usageByModel ??= {}
  const totals = (thread.usageByModel[line.model] ??= emptyUsage())
  addUsage(totals, line.usage)
}

function applyMessage(accum: SessionAccum, line: MessageLine): void {
  const ts = line.timestamp
  if (ts !== undefined) {
    if (accum.createdAt === undefined || ts < accum.createdAt) accum.createdAt = ts
    if (accum.lastActivityAt === undefined || ts > accum.lastActivityAt) accum.lastActivityAt = ts
  }

  if (line.entrypoint !== undefined && !accum.entrypoints.includes(line.entrypoint)) {
    accum.entrypoints.push(line.entrypoint)
  }

  if (
    accum.forkedFrom === undefined &&
    line.sessionId !== undefined &&
    line.sessionId !== accum.id
  ) {
    accum.forkedFrom = line.sessionId
  }

  if (line.isSidechain) {
    // Modern per-file subagent runs stamp every line with an agentId — one
    // run per id. Legacy in-file sidechains group by parent-uuid chains.
    let index =
      line.agentId !== undefined
        ? accum.agentToSidechain[line.agentId]
        : line.parentUuid !== null
          ? accum.uuidToSidechain[line.parentUuid]
          : undefined
    if (index === undefined) {
      const thread: ThreadAccum = { messageCount: 0 }
      if (line.spawnedBy !== undefined) thread.spawnedBy = line.spawnedBy
      if (line.agentId !== undefined) thread.agentId = line.agentId
      accum.sidechains.push(thread)
      index = accum.sidechains.length - 1
    }
    if (line.agentId !== undefined) accum.agentToSidechain[line.agentId] = index
    accum.uuidToSidechain[line.uuid] = index
    touchThread(accum.sidechains[index]!, ts)
    billUsage(accum, accum.sidechains[index]!, line)
    return
  }

  touchThread(accum.main, ts)
  billUsage(accum, accum.main, line)
  if (line.type === 'user' && !line.isMeta) {
    accum.userCount += 1
    if (accum.promptPreview === undefined && line.promptText !== undefined) {
      accum.promptPreview = line.promptText
    }
    if (accum.firstCommand === undefined && line.commandName !== undefined) {
      accum.firstCommand = line.commandName
    }
  }
  if (line.type === 'assistant') accum.assistantCount += 1
  if (line.cwd !== undefined && !accum.cwds.includes(line.cwd)) accum.cwds.push(line.cwd)
  if (line.gitBranch !== undefined) accum.gitBranch = line.gitBranch
  if (line.version !== undefined) accum.cliVersion = line.version
}

function cloneThread(thread: ThreadAccum): ThreadAccum {
  const clone: ThreadAccum = { ...thread }
  if (thread.usageByModel !== undefined) {
    clone.usageByModel = Object.fromEntries(
      Object.entries(thread.usageByModel).map(([model, totals]) => [model, { ...totals }]),
    )
  }
  return clone
}

function cloneAccum(accum: SessionAccum): SessionAccum {
  return {
    ...accum,
    cwds: [...accum.cwds],
    entrypoints: [...accum.entrypoints],
    main: cloneThread(accum.main),
    sidechains: accum.sidechains.map(cloneThread),
    uuidToSidechain: { ...accum.uuidToSidechain },
    agentToSidechain: { ...accum.agentToSidechain },
    agentMeta: { ...accum.agentMeta },
    billedMessageIds: { ...accum.billedMessageIds },
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

    case 'subagent-meta': {
      const existing = state.sessions[event.sessionId]
      const accum = existing
        ? cloneAccum(existing)
        : newAccum(event.sessionId, event.storeId, event.transcriptPath)
      accum.agentMeta[event.agentId] = {
        ...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
        ...(event.description !== undefined ? { description: event.description } : {}),
      }
      return { ...state, sessions: { ...state.sessions, [event.sessionId]: accum } }
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

    case 'config-changed':
      return { ...state, config: event.config }

    case 'userplane-changed':
      return { ...state, userPlane: event.plane }
  }
}

export function foldAll(state: CoreState, events: Iterable<SourceEvent>): CoreState {
  let next = state
  for (const event of events) next = fold(next, event)
  return next
}

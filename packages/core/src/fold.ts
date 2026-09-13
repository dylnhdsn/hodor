import type { MessageLine } from './claude/transcript.js'
import type { CloudSession } from './cloud.js'
import type { HodorConfig } from './config.js'
import type { SourceEvent } from './events.js'
import type { GitContext } from './git.js'
import type { MemoryFileInfo } from './memory.js'
import { addUsage, emptyUsage, type UsageTotals } from './pricing.js'
import type { Runtime, SessionId, SessionMeta, SessionStore, StoreId } from './types.js'
// Type-only on purpose: userplane value-imports gitKey from this module,
// and a value import back would make the ESM cycle initialization-order
// dependent (emptyState.userPlane showed up as undefined under vite).
import type { UserPlane } from './userplane.js'

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
  /** Turn-state tracking (docs/brainstorm/023, the Turn Stack): the last
   * MAIN-chain event's nature + time, and tool_use blocks still awaiting a
   * tool_result (an open dialog, a tool mid-run). A real human input clears
   * the open set — an interrupt abandons whatever dialog was up. */
  lastMainAt?: string
  lastMainKind?: 'human' | 'assistant-text' | 'assistant-tool' | 'tool-result'
  /** The agent's last words — the most recent assistant text preview.
   * Surfaced verbatim on waiting rows: it IS the question, usually. */
  lastMainText?: string
  openTools: Record<string, { name: string; at?: string; question?: string; options?: string[] }>
  /** tool_use blocks seen, main and sidechains alike. */
  toolCallCount: number
  /** tool_use blocks by tool name — the session's tool fingerprint. */
  toolCounts: Record<string, number>
  /** API message ids already billed, with what each cost — usage repeats on
   * every content-block line of one response, so each id counts exactly
   * once. Values are immutable once written (clone shares them). Keeping
   * the per-id usage lets the snapshot detect forks (two sessions sharing
   * an API message id can only mean copied history) and un-double-count
   * the inherited turns. */
  billedMessageIds: Record<string, { model: string } & UsageTotals>
  /** The CLI's human-readable session slug (last observed). */
  slug?: string
  /** Effort level (last observed). */
  effort?: string
  /** From usage lines (last observed). */
  serviceTier?: string
  inferenceGeo?: string
  /** True once any response ran at fast-mode speed. */
  fastMode?: boolean
  /** Synthetic assistant lines recording API errors. */
  apiErrorCount: number
  /** Compaction markers: uuid-less system boundary lines, and the summary
   * user turns. One compaction usually writes both, so the snapshot takes
   * the max rather than the sum. */
  compactBoundaries: number
  compactSummaries: number
  /** Context size around the most recent compaction boundary seen. */
  lastCompaction?: { preTokens?: number; postTokens?: number; droppedTokens?: number }
  /** Hook executions by command, from stop_hook_summary system lines. */
  hookStats: Record<string, { runs: number; totalMs: number }>
  hookErrorCount: number
  hookBlockCount: number
  /** Tokens in context at the latest main-thread response (input + cache
   * read + cache writes of that response), tracked max-by-timestamp so
   * event order never matters. */
  contextTokens?: number
  contextTs?: string
  /** Checkpoints (/rewind): snapshot ids seen — one per prompt that starts
   * a turn, deduped by id so snapshot updates never double-count. */
  checkpointIds: Record<string, true>
  /** Files ever tracked by checkpoints (resolved paths). */
  checkpointFiles: Record<string, true>
  /** file-history-delta lines: tracked file-modification events. */
  checkpointEdits: number
  lastCheckpointAt?: string
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
  /** gitKey(storeId, root) → memory files probed there ([] = none found). */
  memoryFiles: Record<
    string,
    { storeId: StoreId; root: string; userLevel: boolean; files: MemoryFileInfo[] }
  >
  /** gitKey(storeId, sessionId) → backup files found in the store's
   * file-history dir (0 = probed, none there — expired or restored). */
  checkpointBackups: Record<string, number>
  /** Cloud sessions from the last listing (full replacement each scan). */
  cloud: {
    sessions: CloudSession[]
    scannedAt?: string
    error?: string
    /** Cloud session id → outcome branch still resolvable; false =
     * confirmed gone, absent = unknown. Survives rescans. */
    branchPresence?: Record<string, boolean>
  }
  /** User organizing logic output (session id → labels), replaced whole. */
  organize: { labels: Record<string, string[]>; errors: string[]; evaluatedAt?: string }
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
  memoryFiles: {},
  checkpointBackups: {},
  cloud: { sessions: [] },
  organize: { labels: {}, errors: [] },
  metas: {},
  runtimes: {},
  config: {},
  userPlane: { projects: [] },
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
    toolCounts: {},
    billedMessageIds: {},
    apiErrorCount: 0,
    compactBoundaries: 0,
    compactSummaries: 0,
    hookStats: {},
    hookErrorCount: 0,
    hookBlockCount: 0,
    checkpointIds: {},
    checkpointFiles: {},
    checkpointEdits: 0,
    main: { messageCount: 0 },
    sidechains: [],
    uuidToSidechain: {},
    agentToSidechain: {},
    agentMeta: {},
    openTools: {},
  }
}

function touchCheckpoint(accum: SessionAccum, ts: string | undefined): void {
  if (ts === undefined) return
  if (accum.lastCheckpointAt === undefined || ts > accum.lastCheckpointAt) {
    accum.lastCheckpointAt = ts
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
  for (const name of line.toolNames ?? []) {
    accum.toolCallCount += 1
    accum.toolCounts[name] = (accum.toolCounts[name] ?? 0) + 1
  }
  if (line.isApiError === true) accum.apiErrorCount += 1
  if (line.usage === undefined || line.model === undefined) return
  // Lines without a message id can't be deduped; bill them individually
  // (observed only on synthetic lines, which carry no usage anyway).
  if (line.messageId !== undefined) {
    if (accum.billedMessageIds[line.messageId] !== undefined) return
    accum.billedMessageIds[line.messageId] = { model: line.model, ...line.usage }
  }
  thread.usageByModel ??= {}
  const totals = (thread.usageByModel[line.model] ??= emptyUsage())
  addUsage(totals, line.usage)

  // Context fill: the newest main-thread response's input-side tokens ARE
  // the context size at that moment. Max-by-timestamp, so order is moot.
  if (thread === accum.main && line.timestamp !== undefined) {
    if (accum.contextTs === undefined || line.timestamp >= accum.contextTs) {
      accum.contextTs = line.timestamp
      accum.contextTokens =
        line.usage.input + line.usage.cacheRead + line.usage.cacheWrite5m + line.usage.cacheWrite1h
    }
  }
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

  if (line.slug !== undefined) accum.slug = line.slug
  if (line.effort !== undefined) accum.effort = line.effort
  if (line.serviceTier !== undefined) accum.serviceTier = line.serviceTier
  if (line.inferenceGeo !== undefined) accum.inferenceGeo = line.inferenceGeo
  if (line.speed === 'fast') accum.fastMode = true
  if (line.isCompactSummary === true) accum.compactSummaries += 1

  for (const run of line.hookRuns ?? []) {
    const entry = (accum.hookStats[run.command] ??= { runs: 0, totalMs: 0 })
    entry.runs += 1
    entry.totalMs += run.durationMs ?? 0
  }
  if (line.hookErrorCount !== undefined) accum.hookErrorCount += line.hookErrorCount
  if (line.hookBlocked === true) accum.hookBlockCount += 1

  // Boundary lines appear with a uuid (message path) or without (other
  // path, handled in the fold's line loop) depending on CLI version.
  if (line.subtype === 'compact_boundary') {
    accum.compactBoundaries += 1
    if (line.compact !== undefined) accum.lastCompaction = { ...line.compact }
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

  // Turn-state tracking. tool_result lines resolve pending tools; a real
  // human input abandons whatever was pending (interrupts kill dialogs);
  // assistant lines record whether the turn's last word was text or an
  // unresolved tool_use.
  if (line.type === 'assistant' && line.isApiError !== true) {
    accum.lastMainKind = (line.toolUses?.length ?? 0) > 0 ? 'assistant-tool' : 'assistant-text'
    if (ts !== undefined) accum.lastMainAt = ts
    if (line.textPreview !== undefined) accum.lastMainText = line.textPreview
    for (const use of line.toolUses ?? []) {
      accum.openTools[use.id] = {
        name: use.name,
        ...(ts !== undefined ? { at: ts } : {}),
        ...(use.question !== undefined ? { question: use.question } : {}),
        ...(use.options !== undefined ? { options: use.options } : {}),
      }
    }
  } else if (line.type === 'user') {
    if (line.toolResultIds !== undefined) {
      for (const id of line.toolResultIds) delete accum.openTools[id]
      accum.lastMainKind = 'tool-result'
      if (ts !== undefined) accum.lastMainAt = ts
    } else if (!line.isMeta && line.isCompactSummary !== true) {
      // Any non-meta user line without tool_results is human-side input —
      // prompts, slash commands, and interrupt markers alike. All of them
      // abandon whatever dialog was on screen.
      accum.lastMainKind = 'human'
      if (ts !== undefined) accum.lastMainAt = ts
      accum.openTools = {}
    }
  }
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
    toolCounts: { ...accum.toolCounts },
    hookStats: Object.fromEntries(
      Object.entries(accum.hookStats).map(([command, s]) => [command, { ...s }]),
    ),
    checkpointIds: { ...accum.checkpointIds },
    checkpointFiles: { ...accum.checkpointFiles },
    openTools: { ...accum.openTools },
    ...(accum.lastCompaction !== undefined ? { lastCompaction: { ...accum.lastCompaction } } : {}),
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
        else if (line.kind === 'other') {
          if (line.subtype === 'compact_boundary') {
            accum.compactBoundaries += 1
            if (line.compact !== undefined) accum.lastCompaction = { ...line.compact }
          }
          if (line.checkpoint !== undefined) {
            accum.checkpointIds[line.checkpoint.id] = true
            for (const file of line.checkpoint.files) accum.checkpointFiles[file] = true
            touchCheckpoint(accum, line.checkpoint.ts)
          }
          if (line.checkpointDelta !== undefined) {
            accum.checkpointEdits += 1
            if (line.checkpointDelta.file !== undefined) {
              accum.checkpointFiles[line.checkpointDelta.file] = true
            }
            touchCheckpoint(accum, line.checkpointDelta.ts)
          }
        }
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

    case 'memory-scanned':
      return {
        ...state,
        memoryFiles: {
          ...state.memoryFiles,
          [gitKey(event.storeId, event.root)]: {
            storeId: event.storeId,
            root: event.root,
            userLevel: event.userLevel,
            files: event.files,
          },
        },
      }

    case 'organize-results':
      return {
        ...state,
        organize: { labels: event.labels, errors: event.errors, evaluatedAt: event.evaluatedAt },
      }

    case 'cloud-sessions-scanned':
      return {
        ...state,
        cloud: {
          sessions: event.sessions,
          scannedAt: event.scannedAt,
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(state.cloud.branchPresence !== undefined
            ? { branchPresence: state.cloud.branchPresence }
            : {}),
        },
      }

    case 'cloud-branches-checked':
      return {
        ...state,
        cloud: { ...state.cloud, branchPresence: event.presence },
      }

    case 'checkpoint-backups-scanned':
      return {
        ...state,
        checkpointBackups: {
          ...state.checkpointBackups,
          [gitKey(event.storeId, event.sessionId)]: event.backupFiles,
        },
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

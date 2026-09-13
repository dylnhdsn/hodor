/**
 * Canonical schema for hodor's data core.
 *
 * Strawman drafted in docs/brainstorm/003-schema-draft.md — expect iteration.
 * Ids are plain string aliases for now; branding can come later if mixups
 * become a real hazard.
 */

import type { UsageTotals } from './pricing.js'

export type StoreId = string
export type SessionId = string
export type ThreadId = string
export type ProjectId = string

/** ISO 8601 timestamp, as found in transcript lines. */
export type Timestamp = string

/** One discovered `~/.claude` root. All OS-specific knowledge lives here. */
export interface SessionStore {
  id: StoreId
  rootPath: string
  /** How to interpret cwd strings found inside this store's transcripts. */
  pathFlavor: 'posix' | 'win32'
  origin:
    | { kind: 'native' }
    /** A WSL distro's store, reached from Windows via \\wsl$. */
    | { kind: 'wsl'; distro: string }
    /** The Windows store, reached from inside WSL via a drive mount. */
    | { kind: 'windows'; mountRoot: string }
  watchStrategy: 'fs-events' | 'poll'
}

/**
 * Whose turn is it (docs/brainstorm/023, the Turn Stack). Derived purely
 * from transcript structure — never from summarizing content:
 *
 * - waiting: the ball is in the human's court — the agent's last word was
 *   text and the file has gone quiet, or an interactive dialog
 *   (AskUserQuestion / ExitPlanMode) is unresolved. No idle downgrade:
 *   an overnight wait is still a wait; consumers gate by recency/desk.
 * - working: activity is fresh, or a non-interactive tool_use is still
 *   unresolved (a tool mid-run and a permission prompt are
 *   indistinguishable in the transcript — stay honest, say working).
 * - idle: trailing human input or trailing tool noise long gone quiet —
 *   the process is dead.
 */
export interface SessionTurn {
  state: 'working' | 'waiting' | 'idle'
  /** When the wait began — the agent's last word, or the dialog's tool_use. */
  since?: string
  /** An unresolved tool_use; dialogs carry real question + option labels. */
  pending?: { tool: string; question?: string; options?: string[] }
}

export interface Session {
  id: SessionId
  storeId: StoreId
  transcriptPath: string
  /** Last observed working directory (from inside the transcript), if any. */
  cwd?: string
  /** Every working directory observed — sessions can move. */
  cwds: string[]
  gitBranch?: string
  /** Claude-derived summary/title, if any. */
  summary?: string
  /** Hodor rename from user config — the highest-priority display title. */
  rename?: string
  /** First real user prompt, truncated — the display-title fallback. */
  promptPreview?: string
  /** First slash command that started the session, e.g. "/gsd-resume-work". */
  firstCommand?: string
  /** Unique entrypoint values observed on this session's lines (cli, sdk, …). */
  entrypoints: string[]
  /** Ancestor session id when this session was forked/resumed-as-new. */
  forkedFrom?: SessionId
  /** Set when a visibility rule classified this session as noise (provenance). */
  hiddenBy?: string
  createdAt?: Timestamp
  lastActivityAt?: Timestamp
  cliVersion?: string
  counts: { user: number; assistant: number; sidechains: number; toolCalls: number }
  /** tool_use blocks by tool name — the session's tool fingerprint. */
  toolCounts?: Record<string, number>
  /** The CLI's human-readable session slug, e.g. "structured-munching-map". */
  slug?: string
  /** Effort level last in force (low…max). */
  effort?: string
  /** Service tier / inference geography last observed on usage. */
  serviceTier?: string
  inferenceGeo?: string
  /** True when any response ran at fast-mode speed (priced differently). */
  fastMode?: boolean
  /** Synthetic assistant lines recording API errors. */
  apiErrors?: number
  /** How many times this session's context was compacted. */
  compactions?: number
  /** Context size around the most recent compaction. */
  lastCompaction?: { preTokens?: number; postTokens?: number; droppedTokens?: number }
  /** Tokens in context at the latest response — how full the session is. */
  contextTokens?: number
  /** Checkpoints (the CLI's /rewind feature), from file-history lines in
   * the transcript. Absent when the session recorded none (checkpointing
   * is off in print/SDK and remote sessions unless opted in). */
  checkpoints?: {
    /** Distinct checkpoints — one per prompt that started a turn. */
    count: number
    /** Tracked file-modification events (first touch per file per turn). */
    edits: number
    /** Every file path ever tracked, sorted. */
    files: string[]
    lastAt?: string
    /** Backup files on disk under the store's file-history/<id> dir;
     * absent = not probed, 0 = probed and gone (expired or restored). */
    backupFiles?: number
  }
  /** Hook executions by command (stop_hook_summary lines). */
  hooks?: Record<string, { runs: number; totalMs: number }>
  /** Hooks that errored / blocked continuation. */
  hookErrors?: number
  hookBlocks?: number
  /** Token usage by model, summed across all threads. */
  usage?: Record<string, UsageTotals>
  /** Estimated USD from usage × the pricing table. */
  costUsd?: number
  /** Models with tokens but no pricing entry — costUsd is a floor, not a total. */
  costUnpriced?: string[]
  turn?: SessionTurn
  threads: Thread[]
  runtime: Runtime
}

export interface Thread {
  id: ThreadId
  kind: 'main' | 'sidechain'
  /** Sidechains only: the tool call in the parent that spawned this run. */
  spawnedBy?: { toolUseId: string; assistantUuid: string }
  /** Modern subagent runs: id stamped on their lines / sidecar meta. */
  agentId?: string
  /** From agent-<id>.meta.json: e.g. "Explore", "general-purpose". */
  agentType?: string
  /** From agent-<id>.meta.json: the run's short task description. */
  description?: string
  firstTs: Timestamp
  lastTs: Timestamp
  messageCount: number
  /** Token usage by model for this thread alone. */
  usage?: Record<string, UsageTotals>
  /** Estimated USD for this thread alone. */
  costUsd?: number
}

export type Runtime =
  | { kind: 'hosted'; pid: number; startedAt: Timestamp }
  | { kind: 'inferred-active'; lastAppendAt: Timestamp }
  | { kind: 'idle' }

/** A raw fact usable for grouping, with provenance. */
export interface Signal {
  sessionId: SessionId
  source: 'cwd' | 'git-root' | 'git-remote' | 'worktree-of' | 'package-name' | 'config-split'
  value: string
  observedAt: Timestamp
}

export interface Project {
  id: ProjectId
  name: string
  identity:
    | { kind: 'git-remote'; url: string }
    | { kind: 'path'; storeId: StoreId; root: string }
  /** Folders/worktrees this project claims, across stores. */
  roots: Array<{ storeId: StoreId; path: string }>
}

export interface Assignment {
  sessionId: SessionId
  projectId: ProjectId
  /** 0..1 */
  confidence: number
  /** Why this session is in this project — the UI can always explain itself. */
  reasons: Signal[]
  /** User override; heuristics never touch pinned assignments. */
  pinned: boolean
}

/** Hodor-owned annotations. Persisted; must survive rescans. */
export interface SessionMeta {
  sessionId: SessionId
  rename?: string
  archived?: boolean
  pinned?: boolean
  tags?: string[]
  /** User override: force this session into a project. Beats all heuristics. */
  pinnedProject?: ProjectId
}

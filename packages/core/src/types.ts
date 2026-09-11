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
  /** Token usage by model, summed across all threads. */
  usage?: Record<string, UsageTotals>
  /** Estimated USD from usage × the pricing table. */
  costUsd?: number
  /** Models with tokens but no pricing entry — costUsd is a floor, not a total. */
  costUnpriced?: string[]
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

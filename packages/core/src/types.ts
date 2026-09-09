/**
 * Canonical schema for hodor's data core.
 *
 * Strawman drafted in docs/brainstorm/003-schema-draft.md — expect iteration.
 * Ids are plain string aliases for now; branding can come later if mixups
 * become a real hazard.
 */

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
  origin: { kind: 'native' } | { kind: 'wsl'; distro: string }
  watchStrategy: 'fs-events' | 'poll'
}

export interface Session {
  id: SessionId
  storeId: StoreId
  transcriptPath: string
  /** Last observed working directory (from inside the transcript). */
  cwd: string
  /** Every working directory observed — sessions can move. */
  cwds: string[]
  gitBranch?: string
  /** Claude-derived summary/title, if any. A hodor rename lives in SessionMeta. */
  summary?: string
  createdAt: Timestamp
  lastActivityAt: Timestamp
  cliVersion?: string
  counts: { user: number; assistant: number; sidechains: number }
  threads: Thread[]
  runtime: Runtime
}

export interface Thread {
  id: ThreadId
  kind: 'main' | 'sidechain'
  /** Sidechains only: the tool call in the parent that spawned this run. */
  spawnedBy?: { toolUseId: string; assistantUuid: string }
  firstTs: Timestamp
  lastTs: Timestamp
  messageCount: number
}

export type Runtime =
  | { kind: 'hosted'; pid: number; startedAt: Timestamp }
  | { kind: 'inferred-active'; lastAppendAt: Timestamp }
  | { kind: 'idle' }

/** A raw fact usable for grouping, with provenance. */
export interface Signal {
  sessionId: SessionId
  source: 'cwd' | 'git-root' | 'git-remote' | 'worktree-of' | 'package-name'
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
}

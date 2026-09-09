# 003 — Round 3 decisions + canonical schema draft

Date: 2026-09-09
Status: brainstorming — schema is a strawman for reaction, not final

## Decisions from round 2 answers

1. **Platforms**: Windows + WSL is the primary (author's) environment, but
   hodor is built to work on **any OS**. The `SessionStore` abstraction is
   the mechanism: macOS/Linux are just single-store setups; nothing outside
   the store layer may assume an OS.
2. **Terminal hosting**: hodor will eventually run the actual `claude` CLI
   **inside the app** as managed terminal windows (implies xterm.js +
   node-pty in Electron). This upgrades hodor from pure observer to
   *host* — see consequences below.
3. **Sidechains**: subagent runs are **linked to their parent session** and
   modeled as structured children, so presentation can show them together,
   collapsed, or separately — the data layer doesn't pre-decide.

## Consequences of hosting terminals

- Hodor gets two classes of sessions: **hosted** (we spawned the PTY, we own
  authoritative liveness: pid, exit status) and **foreign** (launched
  outside hodor; liveness inferred from transcript appends). This resolves
  the round-2 activity question: `runtime` is a per-session facet —
  `hosted | inferred-active | idle` — and append-recency is the fallback,
  not the whole story.
- The data core must treat hosted and foreign sessions **identically** for
  data purposes. Hosting is a separate subsystem (`SessionHost`) that emits
  runtime events into the same event stream the watchers feed; the fold
  doesn't care who spawned the process.
- Launching into WSL from a Windows app = spawn via `wsl.exe -d <distro>
  claude …`. Launch strategy is per-store, like watch strategy.
- Correlating a spawned PTY with its transcript: prefer pre-assigning the
  session id at launch if the CLI supports it (`--session-id` — to verify);
  fallback is watching for the new JSONL appearing in the expected cwd
  bucket right after spawn.
- None of this is iteration 1, but the schema reserves the seams now.

## Sidechain modeling

Sidechain lines live interleaved in the parent's JSONL, flagged
`isSidechain: true`, with their own uuid/parentUuid chains and a link back
to the spawning tool call. Model: a `Session` contains **threads** — one
`main` thread plus zero or more `sidechain` threads, each with its own
timespan/counts and a `spawnedBy` link. Presentation composes them however
it likes.

## Memory discipline

Transcripts are large (this short brainstorm session is already ~375 KB).
Core entities hold **metadata and byte offsets, never full message bodies**;
message content is lazily read on demand (by thread / range). The fold's
state stays small no matter how many sessions exist.

## Canonical schema draft (strawman)

```ts
// ---- stores ----
interface SessionStore {
  id: StoreId
  rootPath: string                       // e.g. /home/d/.claude, C:\Users\d\.claude, \\wsl$\Ubuntu\home\d\.claude
  pathFlavor: 'posix' | 'win32'          // how to interpret cwd strings inside
  origin: { kind: 'native' } | { kind: 'wsl'; distro: string }
  watchStrategy: 'fs-events' | 'poll'
}

// ---- sessions ----
interface Session {
  id: SessionId                          // Claude's uuid
  storeId: StoreId
  transcriptPath: string
  cwd: string                            // last observed inside transcript
  cwds: string[]                         // all observed (sessions can move)
  gitBranch?: string                     // last observed
  summary?: string                       // Claude-derived title, if any
  createdAt: Timestamp
  lastActivityAt: Timestamp
  cliVersion?: string
  counts: { user: number; assistant: number; sidechains: number }
  threads: Thread[]
  runtime: Runtime
}

interface Thread {
  id: ThreadId
  kind: 'main' | 'sidechain'
  spawnedBy?: { toolUseId: string; assistantUuid: string }  // sidechains only
  firstTs: Timestamp
  lastTs: Timestamp
  messageCount: number
}

type Runtime =
  | { kind: 'hosted'; pid: number; startedAt: Timestamp }   // we own the PTY
  | { kind: 'inferred-active'; lastAppendAt: Timestamp }    // foreign, appending
  | { kind: 'idle' }

// ---- evidence & grouping ----
interface Signal {
  sessionId: SessionId
  source: 'cwd' | 'git-root' | 'git-remote' | 'worktree-of' | 'package-name'
  value: string
  observedAt: Timestamp
}

interface Project {
  id: ProjectId                          // hodor-assigned, stable
  name: string
  identity:                              // canonical key, best-available
    | { kind: 'git-remote'; url: string }
    | { kind: 'path'; storeId: StoreId; root: string }
  roots: Array<{ storeId: StoreId; path: string }>  // folders/worktrees claimed
}

interface Assignment {
  sessionId: SessionId
  projectId: ProjectId
  confidence: number                     // 0..1
  reasons: Signal[]                      // provenance — UI can explain itself
  pinned: boolean                        // user override; heuristics never touch
}

// ---- hodor-owned annotations (persisted JSON; survive rescans) ----
interface SessionMeta {
  sessionId: SessionId
  rename?: string                        // wins over Session.summary
  archived?: boolean
  pinned?: boolean
  tags?: string[]
}

// ---- the event stream (input to the pure fold) ----
type SourceEvent =
  | { type: 'store-discovered'; store: SessionStore }
  | { type: 'transcript-appended'; storeId: StoreId; path: string; lines: RawLine[] }
  | { type: 'transcript-removed'; storeId: StoreId; path: string }
  | { type: 'signal-resolved'; signal: Signal }                 // from git enricher
  | { type: 'runtime-changed'; sessionId: SessionId; runtime: Runtime }
  | { type: 'meta-changed'; meta: SessionMeta }
  | { type: 'assignment-pinned'; sessionId: SessionId; projectId: ProjectId }

// core = (SourceEvent, State) => State ; ProjectResolver runs inside the fold
```

Notes on the draft:

- `ProjectResolver` remains the single component consuming `Signal`s +
  pins to produce `Project`s and `Assignment`s (round-1 decision 3).
- `Assignment.reasons` carries provenance so the UI can always answer
  "why is this session here?".
- Everything the user owns (`SessionMeta`, pins, project renames) lives in
  hodor's JSON persistence, separate from anything recomputable.

## Proposed iteration-1 milestones (for discussion)

1. **Scaffold**: pnpm workspace monorepo — `packages/core`, `packages/cli`;
   Vitest + fast-check + Stryker wired from day one; strict tsconfig.
2. **Discovery + parsing**: store discovery, transcript parser (zod, fixtures
   captured from real transcripts, tolerant of unknown fields/versions).
3. **Event fold + watcher**: incremental tailing; the
   fold-equals-full-rescan property test.
4. **Enrichment + resolving**: git enricher, `ProjectResolver` v0
   (remote-URL → repo-root → folder chain).
5. **CLI consumer**: `hodor scan --json`, `hodor watch` streaming updates —
   the inspection loop until React prototypes exist.

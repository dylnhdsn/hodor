# 002 — Round 2: decisions, and how Claude stores sessions

Date: 2026-09-09
Status: brainstorming

## Decisions from round 1 answers

1. **Session source (v1)**: Claude CLI sessions. Other sources (remote
   claude.ai/code, other agents, tmux) stay on the adapter roadmap only.
2. **Management actions (eventually)**: resume, fork, rename, archive, pin,
   activity display — open-ended, more later. Iteration 1 remains data-only,
   but the data model must leave room for hodor-owned metadata (rename/
   archive/pin are *our* annotations, not Claude's).
3. **Project identity**: will be iterated. Requirement: **one component**
   (working name: `ProjectResolver`) is the single place that consumes all
   evidence and assembles projects + assignments.
4. **Live updating**: in scope **from the start**, not a later add-on.
5. **Persistence**: JSON files for now, behind a small storage interface so we
   can swap later (SQLite etc.).

## How Claude Code organizes `~/.claude/projects` (verified on a live store)

Layout observed:

```
~/.claude/projects/
  -home-user-hodor/                      ← one dir per working directory
    0d6e5057-….jsonl                     ← one JSONL transcript per session
    0d6e5057-…/                          ← per-session sidecar dir (extras)
```

- **Directory name = munged cwd**: `/home/user/hodor` → `-home-user-hodor`
  (path separators and special chars flattened to `-`). This is **lossy**:
  `-` inside real folder names is indistinguishable from a separator, so the
  dir name cannot be reliably un-munged.
- **One dir per cwd**, so two worktrees of the same repo — or the repo root
  vs. a subdirectory you launched from — land in *different* dirs.
- **Transcript = append-only JSONL**, one line per event. Line types observed:
  `user`, `assistant`, `system`, `attachment`, `summary`, plus operational
  records (`queue-operation`, `last-prompt`, …). Message lines carry rich
  metadata: `sessionId`, `uuid`/`parentUuid`, `timestamp`, **`cwd`**,
  **`gitBranch`**, `version`, `isSidechain`, `permissionMode`, and the full
  message payload.
- On a normal install, `~/.claude.json` additionally holds a `projects` map
  keyed by the **real, unmunged absolute path** (per-project settings/
  history). To verify on a real machine — this container's install is
  nonstandard — but if present it's an authoritative list of real cwds.
  Other dirs of interest to inventory later: `todos/`, `shell-snapshots/`.

### Verdict: can we lift Claude's organization?

**Use it as a discovery index, not as the project structure.**

- Lift: enumerate `projects/*/` to *find* transcripts cheaply; one dir per
  cwd is a free first-pass bucketing.
- Don't lift: the munged name is lossy and cwd-granular. Ground truth for
  grouping is the `cwd` (and `gitBranch`) **inside** the JSONL lines — never
  un-munge directory names. And "project" for us spans cwds (all worktrees of
  a repo), which Claude's layout structurally cannot express.

## Windows + WSL simultaneously

Model this as **multiple session stores**, first-class from day one:

```ts
interface SessionStore {
  id: string
  rootPath: string            // e.g. C:\Users\d\.claude  or  \\wsl$\Ubuntu\home\d\.claude
  pathFlavor: 'posix' | 'win32'  // how to interpret cwd strings found inside
  origin: 'native' | `wsl:${string}` // distro-tagged
}
```

- Native Windows sessions live under `C:\Users\<u>\.claude`; each WSL distro
  has its own `~/.claude` reachable from Windows via `\\wsl$\<distro>\…`.
- Never use bare `node:path` on cwd strings — pick `path.posix`/`path.win32`
  per store's flavor. cwds inside WSL transcripts are Linux paths even when
  the store is read from Windows.
- **Cross-boundary unification**: the same repo touched from Windows and from
  WSL (or via `/mnt/c/...`) must resolve to one project. Path equality can't
  do that; **git remote URL as canonical project identity** does. This
  hardens the earlier fallback chain: remote URL → repo root → folder.
- **Watching caveat**: file-change events across `\\wsl$` (9P) are
  unreliable. The watcher needs a per-store strategy: native fs events where
  trustworthy, polling fallback where not. Same interface, two impls.

## Live-first core (consequence of decision 4)

Live updating from the start changes the core's shape: not
`scan() → snapshot` but a **subscribable store fed by events**.

- Transcripts are append-only → incremental tailing: keep a byte offset per
  file, parse only appended lines. New session = new file; new cwd dir = new
  bucket.
- Core stays pure: `state' = fold(event, state)`. Watchers and scanners are
  edge adapters that *emit* events; the fold is where unit/property/mutation
  testing concentrates.
- **Flagship property test**: for any sequence of file mutations, folding the
  incremental events ≡ one full rescan of the final tree. If that invariant
  holds, live mode can never drift from truth.
- Activity display falls out for free: "session is active" ≈ its transcript
  received appends within the last N seconds — the watcher already knows.

## Notes on future actions (not iteration 1)

- Resume/fork map to `claude --resume <id>` / `--fork-session`; both need a
  real terminal. Eventually hodor must either embed one (xterm.js +
  node-pty) or launch an external terminal — significant decision, deferred,
  no impact on the data core.
- Rename/archive/pin = hodor-owned annotations → live in our JSON
  persistence next to user grouping overrides, keyed by sessionId; must
  survive rescans and Claude version upgrades.

## Open questions (round 2)

1. **Platform target**: is Windows + WSL your daily environment (i.e. the
   primary target), and do we also need macOS/Linux from the start, or just
   keep them cheap via the store abstraction?
2. **Activity semantics**: is mtime/append-recency good enough for "active",
   or do we want process-level detection (is a `claude` process actually
   attached?) eventually?
3. **Sidechains/subagents**: transcripts mark `isSidechain` lines — do
   subagent runs count as part of the parent session only, or ever as their
   own entries in the UI?

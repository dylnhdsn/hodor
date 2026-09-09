# 001 — Initial idea: session manager ("hodor")

Date: 2026-09-09
Status: brainstorming — nothing here is final except the items under "Decisions"

## Problem statement

Existing tooling around managing sessions is unsatisfying. We want a session
manager: a tool that discovers sessions, extracts every useful piece of data
about them, and organizes them — ultimately into "projects" — so that a UI can
present them coherently.

## Decisions (stated)

- **Language**: TypeScript, entirely.
- **Testing**: all the kinds —
  - unit: Vitest
  - e2e: Playwright
  - property-based: (library TBD — likely fast-check)
  - mutation: (library TBD — likely Stryker)
- **UI**: React + TailwindCSS.
- **Shell**: Electron app.
- **Build order**: core first. The core is a system that produces structured
  data; presentation layers are built on top later. Iteration 1 is only about
  getting and organizing the data. Prototype components may exist purely to
  inspect the organized data.

## Product goal (first concrete one)

A UI that organizes all sessions into **projects**. The grouping should use any
signal available: folder, worktree, repo, or anything else we can find.

## Working assumptions (to confirm)

- "Sessions" primarily means **Claude Code sessions** (local CLI sessions on
  disk under `~/.claude/projects/`), possibly extended later to remote
  (claude.ai/code) sessions, other agents, tmux, etc.
- Iteration 1 is **read-only**: discover and organize; no actions on sessions
  (resume/kill/archive) yet.
- Primary platform is the user's dev machine (macOS?); Electron implies
  cross-platform is cheap but paths/sources are OS-specific.

## Architecture sketch (proposal, not decided)

A pipeline of layers, each independently testable:

1. **Collectors / source adapters** — one per session source. Read raw data
   (e.g. JSONL transcripts, metadata files) and emit raw session records.
   Adapter interface so new sources (remote sessions, tmux, other agents) plug
   in later without touching the rest.
2. **Normalizer** — raw records → canonical `Session` entities. Parse with a
   schema library (zod), tolerate unknown/missing fields; external formats are
   unversioned and will drift.
3. **Enrichers** — derive facts a collector can't know alone. Chiefly git:
   given a session's cwd, resolve repo root, whether it's a worktree and of
   which primary repo, remote URLs, branch.
4. **Grouping engine** — rules/heuristics that map sessions → projects, with
   confidence and provenance ("in project X because remote URL matches").
   User overrides are a separate layer that always beats heuristics.
5. **Store / query layer** — the structured output. Possibly just in-memory +
   serialized snapshot at first; user overrides need real persistence.
6. **Presentation** — later. First consumer could be a CLI/JSON dump for fast
   iteration, then prototype React components, then the real Electron UI.

Key property: the core should be a **pure transformation** from source data to
structured output wherever possible — that's what makes unit, property, and
mutation testing pleasant. I/O (filesystem scanning, git calls) lives at the
edges behind interfaces so tests can feed fixtures.

## Data model sketch (strawman)

- `Session` — id, source, title/summary, cwd, startedAt / lastActiveAt,
  status, transcript location, cheap metrics (message count, models used…).
- `Signal` / `Evidence` — raw facts usable for grouping: folder path, repo
  root, worktree gitdir link, remote URL, branch, package.json name, …
- `Project` — id, display name, canonical identity (probably remote URL when
  available), set of roots (folders/worktrees) it claims.
- `Assignment` — sessionId → projectId, with confidence + reasons, and a flag
  for user-pinned assignments.

Keeping `Assignment` separate from `Session` and `Project` means the UI can
explain groupings, and re-running heuristics never destroys user intent.

## Open questions

1. **Scope of "session"**: Claude Code local sessions only for v1? What about
   remote (claude.ai/code) sessions, other agents (Codex, Cursor), tmux/
   terminal sessions? What's in v1 vs. the adapter roadmap?
2. **What does "manage" include** beyond organizing/browsing? Resume, launch
   new session in a project, kill, archive, delete transcripts? (Assumed
   read-only for iteration 1.)
3. **Project identity semantics**:
   - Do all worktrees of one repo collapse into one project? (Assumed yes.)
   - Two separate clones of the same repo — one project?
   - Monorepo — one project, or per-package projects?
4. **Freshness**: on-demand scan vs. live filesystem watching for v1?
5. **Persistence**: where do project definitions and user overrides live —
   JSON file, SQLite?
6. **Platform**: macOS-first? Cross-platform from the start?

## Parking lot / ideas

- Sessions carry rich per-message metadata (cwd, git branch, timestamps,
  models) — grouping signals can come from *inside* the transcript, not just
  from where the file sits. A session that cd'd across repos is a fun edge
  case: project membership might be plural or time-weighted.
- Confidence-scored fallback chain for project identity: remote URL → repo
  root path → folder path.
- Property-test candidates: grouping is deterministic and order-independent;
  path normalization idempotent; user overrides always survive re-scan.
- Monorepo layout: `packages/core` (pure, heavily tested), `packages/cli`
  (thin prototype consumer), `packages/app` (Electron + React later).
- Playwright drives Electron directly (experimental support) — e2e plan is
  compatible with the Electron choice.

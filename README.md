# hodor

A session manager: discovers Claude CLI sessions, extracts structured data
about them, and organizes them into projects. Data core first; UI (Electron +
React) later.

**Status**: iteration 1 complete — the data core works end to end: store
discovery, tolerant transcript parsing, an event-folding state model with
incremental live tailing, git enrichment (repos, worktrees, remotes, no git
binary needed), and a ProjectResolver that groups sessions into projects
with confidence and provenance. See [docs/brainstorm](docs/brainstorm/) for
design notes.

## Layout

- `packages/core` — the data core: pure pipeline from source events to a
  structured `Snapshot` (sessions, threads, projects, assignments). All I/O
  behind a `FileSystem` interface; tests run against an in-memory fake.
- `packages/cli` — thin consumer of core; the inspection loop until real UI
  exists.

## CLI

```sh
hodor scan            # discover + organize sessions, human-readable
hodor scan --json     # the full structured snapshot
hodor watch           # scan, then live-update as transcripts change
hodor stats           # entrypoint + visibility histograms
hodor bucket <cwd>    # the ~/.claude/projects bucket name for a cwd
```

Stores default to `<home>/.claude`; pass `--root <path>` to add or replace
store roots (a `\\wsl$\...` root is recognized as a WSL store).

## Development

Requires Node >= 22 and pnpm.

```sh
pnpm install
pnpm verify      # build + typecheck + test, in that order
pnpm test        # unit + property tests (Vitest + fast-check)
pnpm mutation    # mutation testing on @hodor/core (Stryker)
```

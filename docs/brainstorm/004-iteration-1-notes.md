# 004 — Iteration 1 shipped: what exists, what's decided, what's deferred

Date: 2026-09-09
Status: all five iteration-1 milestones complete.

## What exists now

Pipeline (all in `@hodor/core`, pure except the edges):

```
StoreTailer ──► SourceEvent[] ──► fold ──► CoreState ──► buildSnapshot ──► Snapshot
 (fs edge)          ▲                          │             (now enters here)
                    └── enrichGitContexts ◄────┘  (git edge, cached per cwd)
```

- **Discovery = tailing**: a fresh `StoreTailer`'s first poll *is* the scan,
  so incremental mode and rescans share one code path. The flagship property
  test (`tailer.property.test.ts`) checks: for arbitrary mutation sequences,
  folding incremental events ≡ one full rescan of the final tree.
- **Parser** (`claude/transcript.ts`): zod, tolerant — unknown types/fields
  pass through, malformed lines degrade to `invalid`, never throws. Fixtures
  captured from a real live store (`claude/fixtures.ts`).
- **Git enricher** (`git.ts`): reads `.git` directly over the FileSystem
  interface (no git binary): repo root walk-up, linked worktrees via
  `commondir`, submodule pointers, remote extraction from config.
- **ProjectResolver v0** (`resolver.ts`): remote URL → repo root → folder,
  confidences 0.9 / 0.7 / 0.5, `Assignment.reasons` carries provenance,
  `SessionMeta.pinnedProject` beats everything.
- **CLI**: `hodor scan [--json]`, `hodor watch [--interval ms]`,
  `hodor bucket <cwd>`; `--root` adds/replaces store roots (`\\wsl$\...`
  roots are recognized as WSL stores with posix cwds).

Validated against the real store in the dev container: this very session was
discovered, its mid-session cwd move tracked, branch + remote resolved, and
assigned to `git-remote:github.com/dylnhdsn/hodor` at 0.9 with full reasons.

## Decisions taken during implementation

- **Same-size rewrite detection** via mtime; a rewrite that *grows* a file
  between polls is indistinguishable from an append by size/mtime alone and
  is declared out of contract (transcripts are append-only). Revisit with
  inode/birthtime if it ever bites.
- **Summary lines attach to the file they appear in**, last one wins.
  (Resumed sessions may carry summaries referencing other leaves — v0
  ignores `leafUuid` targeting.)
- **Assignment is by last cwd only** for now; all cwds still produce signals
  and enrich the project's roots. Plural/time-weighted membership stays open.
- **Sessions with zero message lines are omitted** from snapshots (queue
  noise only, nothing to group).
- **uuid→thread maps grow with message count** — accepted for v0; if memory
  matters later, drop maps for idle sessions.
- `gitKey` uses a NUL separator so store/cwd concatenation can't collide.

## Testing state

94 unit + property tests; mutation score 83% (break threshold 70). The
surviving mutants are mostly error-string tweaks and sort tiebreakers;
worth a pass someday, not blocking.

## Deferred (next iterations)

- Watch strategy per store beyond polling (fs events where trustworthy).
- Persistence layer for SessionMeta/pins (JSON file behind an interface) —
  the fold already consumes `meta-changed`, nothing writes it yet.
- WSL store auto-discovery on Windows (`wsl.exe -l -q`); `--root \\wsl$\...`
  works manually today.
- `~/.claude.json` as an authoritative real-path index (verify on a real
  Windows/WSL machine).
- Session hosting (PTY), rename/archive/pin commands, Electron/React shell.

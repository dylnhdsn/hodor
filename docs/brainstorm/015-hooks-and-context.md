# 015 — Hooks and context-memory metadata

Date: 2026-09-11
Status: implemented. Dylan's ask: "what about metadata about memory
usage and hooks?"

## Hooks

`stop_hook_summary` system lines carry full hook telemetry:
`hookInfos` (command + durationMs per run), `hookErrors`,
`preventedContinuation`, `stopReason`. Per session hodor now keeps
`hooks` (runs and total wall-clock by command), `hookErrors`, and
`hookBlocks` (times a hook blocked continuation). The detail pane shows
a HOOKS section (command basename, runs, total time, amber
error/block line). Validated live: this machine's session shows
`stop-hook-git-check.sh · 25× · 1.6s`.

Only stop hooks leave this summary today; PreToolUse/PostToolUse
denials would surface as tool results, not system lines — nothing to
extract there yet.

## Memory, two meanings

1. **Context fill** (`contextTokens`): the newest main-thread
   response's `input + cacheRead + cacheWrite` IS the context size at
   that moment. Tracked max-by-timestamp so event order never matters;
   subagent responses never count (their context is their own). Shown
   in facts: `context 631.8k tokens`.
2. **Compaction sizes** (`lastCompaction`): boundary lines carry
   `compactMetadata` — preTokens, postTokens, cumulativeDroppedTokens.
   The compactions fact now reads `1× (last 785.6k → 14.7k)`.

**CLAUDE.md memory files leave no transcript trace** — the CLI folds
them into the system prompt, which is never written to the store. An
earlier grep that seemed to find memory markers was matching this
session's own tool commands (searching a transcript for strings while
working inside the session being transcribed is a hall of mirrors).
Detecting memory files would be a filesystem enrichment instead —
probe project roots and `~/.claude` for CLAUDE.md and report
presence/size per project. Deferred; easy if wanted.

## A parser lesson

Compaction boundary lines appear WITH a uuid (current CLI — parses as
a message line) and the uuid-less shape is also kept for tolerance;
the fold counts the boundary and captures sizes on both paths. The
directed test used the uuid-less shape and passed while the real store
silently took the other path — real-store validation caught it, again.

# 005 — First real-world scan: noise, titles, and what it taught us

Date: 2026-09-09
Trigger: Dylan's first local scan — 481 sessions, 89 "projects", most of it
noise from the peri eval harness.

## What the real data showed

- **~80% of sessions were programmatic**: peri runs under
  `~/.peri/runs/<ts>-<hash>/cache/{blind,body-blind,comments-off,name-blind,…}`
  and `/worktree`, plus `/tmp` scratchpads. Each non-repo cache dir became
  its own cwd-project (60+ of them); eval-clones grouped *correctly* into
  real projects (MacApp, styx, user-backend…) but polluted them.
- **Grouping itself held up**: 60+ BrowserExtension sessions unified across
  `.claude/worktrees/*`; `browser-extension` vs `BrowserExtension` split
  correctly by remote; `.peri` worktrees resolved to their repos via git.
- **Every session was "(untitled)"**: summary lines are sparse in practice.

## What shipped in response

1. **Visibility layer** (`visibility.ts`): sessions matching hide rules get
   `hiddenBy: "<rule>"` (provenance, e.g. `dot-segment:.peri`). Nothing is
   deleted or ungrouped — JSON keeps everything; the human formatter
   suppresses hidden sessions with a count and `--all` reveals them.
   Default rules: `/tmp`-like prefixes, `node_modules`, and any
   dot-directory segment except `.claude` (worktrees there are real work).
   `--hide <rule>` adds prefixes (contains a separator) or segment names.
2. **Prompt-preview titles**: the first real (non-meta) user prompt is
   captured (collapsed, 120 chars) as `promptPreview`; display title is
   `summary ?? promptPreview ?? '(untitled)'`.
3. **Entrypoint capture**: unique `entrypoint` values per session
   (`cli`, `sdk`, `remote`, …) now ride along in the snapshot. This is the
   raw material for a future *interactive vs programmatic* split — path
   rules are a stopgap; entrypoint is likely the principled signal.
   TODO: check what entrypoint peri's sessions carry vs interactive ones
   (`hodor scan --all --json | jq '[.sessions[].entrypoints] | flatten | group_by(.) | map({(.[0]): length}) | add'`).
4. `isMeta` user lines (synthetic context) no longer count as user messages
   and never provide titles.

## Open questions raised by the data

- Should hide rules live in a persisted hodor config (they're exactly the
  shape of the planned JSON persistence layer)? Currently CLI flags only.
- Cross-file summaries: titles may exist as summary lines in *other*
  transcripts (`leafUuid` linkage). Needs a uuid→session index — measure
  cost before building.
- Eval-clone sessions group into real projects (MacApp). With hiding they
  disappear; is that right, or should they be a separate "agent runs"
  sub-bucket per project someday?

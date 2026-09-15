# Backlog

Agreed-but-not-started work, in no particular order. Items graduate to a
brainstorm doc when they get built. Living file — prune on completion.

## Metadata & data core

- **Nested subagents** — subagent transcripts that themselves spawn
  agents; today we only read one level.
- **Memory walk-up completeness** — CLAUDE.md discovery walks roots
  only; walk parent dirs and subdirectories-with-memories like the CLI
  does.
- **Same-id-two-buckets merge edge** — same session id in two buckets
  folds into one accumulator (seen with nested claude inheriting
  CLAUDE_CODE_SESSION_ID). Revisit if it appears outside containers.
- **Fast-mode pricing** — fast mode is flagged per session but priced
  at normal rates.

## UI

- **Turn Stack follow-ups** — the stack shipped in 0.2.0 (real waiting
  terminals; skip/snooze/send-to-phone/done over the turn-state
  detector). Remaining: quick-reply presets are a UI constant — make
  them user config; a global OS hotkey to summon the stack from
  anywhere; surface cloud sessions awaiting input once the API exposes
  that cleanly.
- **Mint session ids for teleport and fork tiles** — 'new' tiles get
  `claude --session-id <uuid>` at spawn (build 58), so desk restore
  truly resumes them. Teleport tiles still re-teleport (stored id is
  the CLOUD id) and fork tiles re-fork (stored id is the parent's);
  mint ids for both so every tile restores its own conversation —
  verify `--teleport`/`--fork-session` accept `--session-id` first.
- **Full transcript viewer** — today only the conversation tail.
- **Live-leaf conversation tail** — the tail renders in timestamp
  order, so dead branches (from double-resume or rewinds) interleave;
  follow the last-prompt leaf chain instead (see 016).
- **Fork grouping in the session list** — forks render flat with
  badges; group them under their parent.
- **Hide-rules UI** — visibility rules are config-only.
- **Settings panel UX pass** — functional, not pretty.
- **Cosmetics & tags** — project colors/icons/tags (deferred by Dylan:
  "cosmetics later").
- **Cost-over-time analytics** — spend charts per project/model/day.

- **Claude settings control** — researched + verified in
  [024](brainstorm/024-settings-control.md): read all layers with
  effective-value provenance, write user/local/project + global-config
  keys on a safety ladder, doctor-grade validation, cross-boundary
  view. Awaits go-ahead (UI part waits on the 023 design pass).

## Platform & distribution

- **Detached sessions (survive closing hodor)** — researched in
  [025](brainstorm/025-detach-pause-native-ui.md): the CLI already has a
  supervisor (`claude --bg`, `/bg` on a running session, `attach`,
  `stop`, `agents --json`). Plan: offer "detach instead of kill" on quit,
  show background sessions as first-class rows (their
  `waitingFor: permission prompt` is a needs-you), per-tile detach verb.
  Note `--bg` REJECTS `--session-id`, and `--bg` on Windows/WSL is
  undocumented — test on Windows before promising it.
- **Travel mode (pause everything to change network)** — researched in
  [025](brainstorm/025-detach-pause-native-ui.md). There is no pause
  primitive and SIGSTOP is unsafe, but the CLI already retries hard
  through network loss. Real shape: interrupt-or-finish in-flight turns,
  then `/bg` every session, then re-attach on arrival.
- **Native session UI (no terminal)** — researched in
  [025](brainstorm/025-detach-pause-native-ui.md). Cropping the TUI below
  the prompt box is a dead end (modals live in that region, no way to find
  it, breaks every release). The supported path is the stream-json /
  Agent SDK protocol with our own React UI. Verified it carries streaming
  text, tool calls, cost, compaction, rate limits, and a native
  `post_turn_summary` turn state. Gaps to own: plan-mode approval,
  dialog slash commands, file pickers, interrupt-over-stream-json.
  Big enough to split hodor into two session kinds — spike before
  committing.
- **Authoritative turn state from the CLI** — `claude agents --json`
  reports live `status`/`waitingFor` for interactive AND background
  sessions, and stream-json emits `post_turn_summary` with
  `status_category`/`needs_action`. We fold transcripts to guess the same
  thing; adopt these as a cross-check. Free win, independent of 025.

- **Workspace v3/v4** — the desk shipped in 0.2.0 (workspace-first
  posture, named zones with open-into-zone routing, restore-all).
  Next per 022: named workspaces + templates with slot rules, then
  multi-window arrangements.
- **Desktop polish** — app icon, keyboard shortcuts (next/prev
  terminal), signing, multiple manager windows.
- **WSL-native install** — installer assumes shared Windows home;
  support a WSL-only setup.

## Quality

- **Playwright e2e** — drive the real UI against a seeded store.
- **Mutation hardening** — score drifted 82.5% → 78.35% (threshold
  70); push it back into the 80s.
- **Perf pass on subagent dir polling** — every tick stats every
  session's subagents dir.
- **Absorb-rule revisit** — the custom-project absorb rule has known
  rough edges around overlapping evidence.

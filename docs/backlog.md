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

## Platform & distribution

- **Window management v2–v4** — v1 (dockview splits/tabs, autosaved
  implicit workspace, restore-by-resume) shipped; named workspaces,
  templates + slot rules, and multi-window documents remain
  ([022](brainstorm/022-window-management.md)).
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

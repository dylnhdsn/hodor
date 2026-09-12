# 019 — Cloud sessions

Date: 2026-09-12
Status: implemented (list + teleport + message; see caveat).

Claude Code sessions that run in Anthropic's cloud (claude.ai/code,
mobile) have no local transcript, so they were invisible to hodor.
Now they're first-class rows with actions.

## Where the data comes from — and the caveat

The CLI's own cloud features (`--cloud`, `--teleport`, `/tasks`) drive
`api.anthropic.com/v1/code/sessions`, authenticated with the claude.ai
OAuth token `claude login` stores in `~/.claude/.credentials.json`.
There is NO documented REST API — this endpoint was found by reading
the installed CLI. Same posture as the transcript format (also
unversioned): parse tolerantly, and let the whole feature degrade to
absence. No credentials → no cloud section, and any listing failure is
a one-line hint (verified live: a bad token yields the 401 hint), never
an error that touches local features.

What the listing gives us is richer than local transcripts in places:
status (running/idle) plus a triage bucket (working / blocked /
review-ready / completed), the source repo and outcome branches,
model/effort, context fill, server-computed cost, origin (web, android),
and the session's own post-turn words — status detail and a literal
"needs action" text. Shapes verified against real listings.

## The join

Cloud sessions join projects by the same evidence the matcher engine
uses: the source repository's git remote, normalized like local
remotes. A cloud session on `github.com/acme/app` lands in whatever
rail project owns that remote (custom remote matcher or auto
git-remote identity); unmatched ones appear only in All sessions.

## Surfaces

- UI: a `cloud` strip above the session list (All + per-project),
  bucket badges (blocked = "needs you"), the needs-action line, and an
  expandable row with detail, model, context, cost, branches. Actions:
  **teleport** (embedded terminal in the desktop app; external
  terminal or copyable command in the browser), **message** — queue
  one instruction via `claude -p <text> --cloud <id>` while the
  session keeps running in the cloud — and **web ↗**.
- `hodor cloud` — the same listing in the terminal.
- Server: cloud scan every 60s inside the refresh loop;
  `POST /api/cloud/message`; `/api/launch` gained kind `teleport`,
  which lands in a local checkout of the same repo when one is known
  (teleport checks out the session's branch).

## Semantics worth remembering

- Teleport moves the live copy to the terminal; the web copy goes
  read-only. The button's title text says so.
- Messaging does NOT take the session over — documented CLI behavior:
  the message is queued and the cloud session continues.
- Same-account requirement and org policy (`allow_remote_sessions`)
  apply; failures surface as the cloudError hint.

## Later

- Windows+WSL split: credentials are read from the hodor host's home
  only; a WSL-side hodor with a Windows-side login won't see them.
- Archive from hodor (endpoint exists); events/detail feeds.
- Cost-over-time could fold cloud cost_usd into analytics.

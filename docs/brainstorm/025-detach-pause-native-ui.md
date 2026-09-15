# 025 — Detached sessions, pausing, and a native session UI

Research for three questions Dylan raised. All CLI behavior below was
verified empirically against Claude Code **2.1.272** in this container
unless marked otherwise; doc claims carry their URL.

The headline: **questions 1 and 2 are mostly already built into the CLI**
and hodor's job is to expose them. Question 3 has a supported path, but it
is not "crop the TUI" — it is "stop using the TUI".

---

## 1. Sessions that outlive hodor

### What the CLI already gives us

Claude Code 2.1.x ships a **supervisor** (a persistent background service)
that hosts sessions with no terminal attached:

| Command | Effect |
| --- | --- |
| `claude --bg "task"` | start detached; prints an 8-hex short id |
| `/bg` (or `/background`) **inside a running session** | moves THAT conversation into the background |
| `claude agents` | interactive list; `--json` for scripting |
| `claude attach <id>` | opens the live session in this terminal |
| `claude logs <id>` | recent output without attaching |
| `claude stop <id>` | stops the process, keeps the conversation |
| `claude rm <id>` | deletes the session (and its worktree when safe) |
| `claude respawn <id> \| --all` | restart under the current CLI version |

`/bg` is the key one for us: it moves an **already-running** conversation,
and per the docs, "If Claude is responding when you run `/bg`, the response
continues in the background session."
(<https://code.claude.com/docs/en/agent-view.md>)

Detaching never stops a session: `←` on an empty prompt, `Ctrl+Z`, `/exit`,
double `Ctrl+C`/`Ctrl+D` all leave it running. `/stop` from inside ends it.

### Verified here

- `claude --bg` returned `backgrounded · fa45e953`; the session kept
  running after the launching shell exited.
- `claude attach fa45e953` in a PTY gave a **full live TUI**, mid-turn,
  showing the pending permission prompt — i.e. exactly the thing hodor
  puts in a tile today.
- **`--bg` refuses `--session-id`**: `warning: --bg manages the session id;
  ignoring --session-id (use --resume <id> to continue an existing
  session)`. Undocumented; matters because our 'new' tiles mint ids.
- The **short id is the first 8 hex of the session uuid**
  (`fa45e953` → `fa45e953-1bc4-4bcb-9daa-9af7155cd383`), so the mapping
  back to a transcript is free.
- `claude stop` then `claude rm` cleaned up without touching the transcript.

### On-disk surface (undocumented, but stable-looking and very useful)

- `~/.claude/daemon/roster.json` — supervisor pid + every worker:
  short id, pid, `sessionId`, cwd, cliVersion, and its sockets.
- `~/.claude/jobs/<id>/state.json` — live status per session:
  ```json
  { "state": "working", "detail": "Writing bg-proof.txt", "tempo": "blocked",
    "needs": "approve Write: /path/bg-proof.txt", "tokens": 200,
    "linkScanPath": "…/<sessionId>.jsonl", "respawnFlags": ["--model","haiku"] }
  ```
- `~/.claude/sessions/<pid>.json` — every LIVE session (interactive too):
  `sessionId`, `cwd`, `name`, `nameSource`, `status`, `messagingSocketPath`.

`claude agents --json` is the supported read of the same thing and needs no
TTY. Verified output for a live interactive session:
```json
[{ "pid":105, "cwd":"/home/user/hodor", "kind":"interactive",
   "sessionId":"0d6e…", "name":"hodor-8a", "status":"busy" }]
```
and for a blocked background one: `"status":"waiting"`,
`"waitingFor":"permission prompt"`, `"state":"blocked"`.

**This is an authoritative turn-state feed.** hodor currently derives
busy/waiting by folding transcripts; the CLI just tells us. Worth adopting
as a cross-check even before any detach work (see backlog).

### Caveats

- A background session **blocks indefinitely on permission prompts** — it
  does not auto-approve. Verified. So "run it detached" is not "run it
  unattended" unless the permission mode says so.
- The supervisor **stops idle-and-unattached sessions after ~1 hour** to
  free resources; the conversation stays on disk and resumes on next
  attach/reply. `Ctrl+T` pins a session to keep its process alive.
- Machines that **sleep** keep their sessions (processes resume on wake);
  a **shutdown** stops them — within 48h they show as failed and restart
  from where they left off on attach. Logout is undocumented.
- Windows: docs mention a Windows-specific `←` ambiguity on attach, so
  attach is supported there. `--bg` on Windows/WSL is **not explicitly
  documented** — needs a real test on Dylan's box before we promise it.

### Proposed shape for hodor

1. **"Detach on close"** — when hodor quits with live tiles, offer to send
   `/bg` to each one instead of killing the PTY. Sessions survive; hodor
   reopens them with `claude attach <id>` next launch. This replaces the
   current `before-quit` kill-everything behavior.
2. **Background sessions are first-class rows** — read `agents --json` (and
   the jobs/ state files) so detached sessions appear in Home and the turn
   stack with their real status, including `waitingFor: permission prompt`.
   Those are precisely "needs you" items.
3. **Per-tile "detach" verb** — move one session to background without
   closing it; the tile becomes a detached row.
4. Do **not** mint ids for background tiles (`--bg` rejects them); key off
   the short id and expand to the uuid when we need the transcript.

---

## 2. Cleanly pausing everything to change location/network

### What actually happens on network loss (documented)

Claude Code is already resilient — this matters more than any pause button.
(<https://code.claude.com/docs/en/errors.md>,
<https://code.claude.com/docs/en/network-config.md>)

- Before the response streams: automatic retries with exponential backoff,
  **up to 10 attempts**.
- Dropped after thinking, before text: two quick retries.
- Mid-stream, three independent watchdogs abort and retry/end the turn:
  first-byte (180s direct API / 300s otherwise), event-level idle (300s),
  byte-level idle including SSE keep-alives (180/300s). All tunable via
  `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`,
  `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`.
- Partial output is kept and shown with an "incomplete response" notice.
- Transcripts are written continuously, so a hard kill loses at most the
  in-flight turn. (<https://code.claude.com/docs/en/sessions.md>)

There is **no documented pause/suspend command**, and **SIGSTOP/SIGCONT is
undocumented and unsafe** with in-flight HTTP streaming — do not ship it.

### So "pause" means: reach a safe point, then stop cleanly

The honest version of this feature is a **"travel mode"** that, for every
live session:

1. Reports which sessions are mid-turn (we already know this).
2. Offers to **interrupt** in-flight turns (ESC / `Ctrl+C` semantics keep
   the work done so far) — or waits for them to finish, user's choice.
3. Once each session is idle, moves it to the background with `/bg` (or
   `claude stop <id>` for ones already detached), which preserves the
   conversation.
4. On arrival, "resume travel mode" re-attaches every session.

That is a real, safe pause built only out of supported operations, and it
composes with the detach work above rather than needing new mechanics.

**Open question for Dylan:** should travel mode also flip a *"don't start
new work"* flag so a session that's mid-tool doesn't kick off a long build
right as you close the lid? There's no CLI support for that; we'd only be
choosing not to send input.

---

## 3. Replacing the CLI's prompt UI with our own

### Approach A — crop the TUI below the prompt box: NO

There is no supported way to do this and it would be permanently fragile:

- Nothing exposes where the prompt box starts; its height is dynamic
  (multi-line input, `\`+Enter, pasted blocks).
- Permission prompts, plan approval, `/permissions`, `/theme` and friends
  are **modal dialogs drawn in exactly the region we'd be cropping** —
  cropping them away removes the ability to answer them.
- Alternate-screen + full redraw on resize/`Ctrl+L` means crop coordinates
  go stale mid-conversation.

The TUI is a rendering target, not an API. Cropping it buys a UI that
breaks on every CLI release.

### Approach B — drive the documented stream-json protocol: YES

`claude -p --input-format stream-json --output-format stream-json --verbose`
is a bidirectional NDJSON protocol designed for exactly this, and the
TypeScript Agent SDK wraps it. No terminal, no scraping — hodor renders
everything natively.

**Verified protocol capture** (one real run here, `--include-partial-messages`):

| message | what it carries |
| --- | --- |
| `system/init` | `tools`, `slash_commands`, `terminal_slash_commands`, `agents`, `skills`, `model`, `permissionMode`, `capabilities`, `messaging_socket_path` |
| `stream_event/*` | `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` — token-level streaming |
| `assistant` | the assembled message |
| `system/post_turn_summary` | **`status_category`, `status_detail`, `needs_action`** |
| `autocompact_state` | `effective_window`, `threshold`, `enabled` |
| `rate_limit_event` | 5-hour and 7-day `utilization` + `resetsAt` |
| `result/success` | `total_cost_usd`, full `usage` breakdown, `stop_reason`, `duration_api_ms` |
| `system/commands_changed`, `system/status` | live command list / status |

Two of those are gifts: `post_turn_summary` is **the turn-state detector we
hand-built**, emitted natively; `rate_limit_event` is usage data we don't
surface anywhere today. `capabilities` advertised
`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`,
`queued_notifications` — i.e. interrupt and message-queue semantics are
first-class in the protocol.

**Parity: what's covered.** Streaming text and thinking, tool calls and
results, permission prompts (via the SDK's `canUseTool` callback, which
also always fires for `AskUserQuestion`), session resume/fork
(`--resume`/`--fork-session`), cost/token accounting, compaction
boundaries, slash commands (sent as ordinary input; `system/init` hands us
the full list to build a palette from), skills, subagents.

**Parity: the real gaps** (<https://code.claude.com/docs/en/agent-sdk/>)

- **Plan mode approval** — you can *start* in plan mode, but the approval
  dialog ("yes and auto-accept" / "yes, manual" / "keep planning", `Ctrl+G`
  to edit the plan) is interactive-only; it has to be synthesized from
  `AskUserQuestion`.
- **Dialog-based slash commands** — `/permissions`, `/theme`, `/help` are
  interactive-only; we'd rebuild those screens ourselves (we already
  researched settings control in 024, which covers `/permissions`).
- **File pickers** and `@`-mention autocomplete — the protocol takes paths;
  the picker UI is ours to build.
- **Interrupt over raw stream-json is underdocumented** — documented on the
  Python SDK (`client.interrupt()`); the `interrupt_receipt_v1` capability
  suggests it exists on the wire, but we must verify before committing.
- Ctrl+O transcript viewer, Ctrl+T task display, background-task toasts —
  all ours to build (we want our own anyway).

No official guidance discourages custom frontends; the Agent SDK exists to
support them.

### The catch, stated plainly

This is not a UI change — it is **a second way to run a session**, and it
would split hodor down the middle: PTY sessions (what we have, full TUI
fidelity, everything works) versus native sessions (our UI, better
integration, and a permanent tail of parity gaps to chase). Every feature
after that gets built twice or gated per mode.

Recommended sequencing if we want it:

1. **Spike, don't commit.** One native session next to the desk, read-only
   at first: render `stream_event` text + tool calls in React from a real
   `-p` subprocess. Cheap, proves the rendering model.
2. **Add input and permissions** via the SDK's `canUseTool`. This is the
   fork in the road — once permissions work, it's a usable session.
3. **Decide** whether native sessions are the future or a second mode, with
   the gap list above in hand and something real to click on.

Meanwhile there's a free win regardless of the outcome: adopt
`post_turn_summary` / `agents --json` as authoritative turn state for the
sessions we already run.

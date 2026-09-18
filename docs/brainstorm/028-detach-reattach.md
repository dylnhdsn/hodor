# 028 — Detach and reattach: closing hodor without ending sessions

## The ask

Close or restart hodor and lose nothing: the session keeps doing what it
was doing; reopening hodor puts it back in its tile.

## Why it is not free

A tile's `claude` runs in a PTY owned by hodor's main process. When that
process exits the PTY closes and the child gets SIGHUP; a TUI without a
terminal cannot continue. Today `before-quit` kills every PTY on purpose
(main.ts). The only way a session outlives hodor is to be hosted by
something else: Claude Code's own **supervisor**, the thing behind
`claude --bg`, `claude attach`, `claude agents` (025 §1).

## Two mechanisms, one of which we get to keep

**A. Move on close.** On quit, hodor writes `/bg` into each live claude
tile, waits for the foreground process to exit, and remembers the tile
as detached. Next launch, the tile runs `claude attach <short>` (short =
first 8 hex of the session id, so no bookkeeping). Manual verb: "detach
(keep running)" on a tab.

**B. Supervised from birth.** hodor never runs `claude` in the tile
directly: it starts the session under the supervisor (`claude --bg …`)
and the tile is only ever an `attach` client. Closing hodor closes
clients; nothing else happens. Restart = re-attach every tile.

B is the cleaner model — a tile is a window onto a session, never its
owner — but it changes how EVERY session starts and depends on `--bg`
accepting both `--resume <id>` and starting with no prompt. A is a bolt-on
that leaves normal sessions exactly as they are and only acts at the
edge. **Start with A; consider B once A has proven `attach` in tiles.**

## What is verified (025) and what is not

Verified on Linux, CLI 2.1.272:
- `claude --bg "task"` starts a supervised session; it survives its shell.
- `claude attach <short>` in a PTY shows the full live TUI, mid-turn.
- `--bg` refuses `--session-id` (ignores it).
- short id = first 8 hex of the session uuid.
- `claude agents --json` lists supervised and interactive sessions; a
  blocked one reports `waiting` / `permission prompt`.
- The supervisor stops an idle unattached session after ~1h and resumes
  it on the next attach; conversations persist across that.

Not verified — and decisive for A:
1. **`/bg` from a plain interactive session**: does the foreground
   process exit (so hodor's tile sees an exit), and does the session then
   appear in `claude agents --json` as `kind: background`?
2. **`claude --bg --resume <id>`**: can an existing conversation be
   restarted under the supervisor? (Needed for B, and for A's recovery
   when a detached session was stopped by the idle timer and `attach`
   alone does not revive it.)
3. **`claude --bg` with no prompt**: does it start idle? (B only.)
4. **Windows and WSL**: `--bg` is not explicitly documented there. A
   Windows-hosted hodor sends `/bg` into a PowerShell-hosted claude and
   into `wsl.exe`-hosted ones; either could refuse.

These could not be run from this sandbox: driving keystrokes into a live
Claude session, and starting supervised agents, were declined by the
environment's policy. They take two minutes on a real machine:

```
# 1: in a normal interactive claude, after any reply, type:   /bg
#    then:   claude agents --json          (expect kind: background)
#    then:   claude attach <first 8 hex of the session id>
# 2: claude --bg --resume <an existing session id>
# 3: claude --bg
```

## Verified since, by Dylan on WSL

- `claude --bg` with no prompt starts an idle supervised session
  (question 3: yes).
- `/bg` typed in a plain interactive session drops straight back to the
  shell (question 1: yes). The CLI binary (2.1.273) confirms the command
  is `/background`, alias `/bg`, always enabled in an interactive
  session; the two refusals seen on the way were the `claude agents`
  list view ("not available in agent view") and an already-supervised
  session reached through `attach` ("not available in this
  environment" — it is headless by kind).

Still open: `claude --bg --resume <id>` (no longer needed — `attach`
revives a session the idle timer stopped) and Windows-native claude.

## Shipped (Plan A)

- **Settings → WHEN HODOR CLOSES → keep sessions running.** Off by
  default. The renderer pushes the pref to the main process at boot and
  on change; on quit, main types `/bg` into every live claude tile
  (shells and teleports excluded), waits up to 5s for them to exit, and
  kills whatever is left as before. A tile sitting in a dialog will not
  take a slash command and gets killed, so the wait is bounded.
- **Restore attaches.** A resume launch (the slot's "resume into place",
  the library's resume) asks `claude agents --json` fresh — the periodic
  listing may not have run yet right after a restart — and composes
  `claude attach <short>` when the session is live in the background;
  otherwise `claude --resume <id>` as before. Forks always fork.
- **Tab menu → detach (keep running).** Types `/bg` into the tile. A
  clean exit (code 0: `/bg`, `/exit`) turns the tile back into its
  slot, so "resume into place" is right there and attaches; a crash
  keeps its output on screen.

Not done: auto-reattach on boot (the desk restore stays a click), and
the "attach into a tile" verb on library rows — resume already does the
right thing for a background session.

## Plan for A, once (1) holds

- **Settings toggle** "keep sessions running when hodor closes" (off
  until Windows is confirmed).
- **Quit path**: for each tile whose target is a claude session and whose
  PTY is alive: write `/bg\r`; wait up to 5s for the PTY to exit; mark
  the slot `detached: true` in its params (the workspace doc saves it);
  PTYs that did not exit in time are killed as today.
- **Restore path**: a slot with `detached: true` resumes with
  `claude attach <short>` instead of `claude --resume <id>`; if attach
  fails ("no such session"), fall back to `--resume` — the conversation
  is always on disk.
- **Row and tile state**: `session.live.kind === 'background'` already
  drives the background chip and the agents cross-check; the stack shows
  `waitingFor: permission prompt` for a blocked detached session.
- **Manual verbs**: tab menu "detach (keep running)" and, on a
  background row, "attach into a tile".

## Not in this

Travel mode / pausing everything for a network change (025 §2) is a
different problem: it is about reaching a safe point, not about who
hosts the process.

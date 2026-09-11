# 016 — Resume & fork: the launcher

Date: 2026-09-11
Status: implemented. The pre-Electron resume story: hodor opens your
real terminal; owning the terminal comes with the PTY milestone.

## Shape

One pure function, `composeLaunch(env, target)`, turns (where hodor
runs) × (where the session lives) into an ordered list of spawn
candidates — argv vectors, no shell strings except where a shell IS the
terminal's syntax. The launcher tries candidates until one spawns.
Every path also yields a copyable command, so a failed spawn leaves the
user one paste away — the universal fallback across the platform zoo.

The matrix mirrors store origins:

- Windows session (hodor on Windows, or a Windows store seen from WSL):
  `wt.exe -d <cwd> cmd /k claude …`, falling back to `cmd /c start`.
  cmd /k keeps the window open so "claude not found" stays readable.
- WSL session (from Windows or from inside WSL): `wt.exe wsl.exe -d
  <distro> --cd <cwd> -e bash -lic "claude …"` — the right distro, a
  login+interactive shell so PATH setup finds claude.
- macOS: osascript → Terminal `do script`, shell-quoted cwd.
- Plain Linux: x-terminal-emulator → gnome-terminal → konsole → xterm.

Verbs (flags verified against the installed CLI): resume =
`claude --resume <id>`, fork = `claude --resume <id> --fork-session`,
new session = bare `claude` in a project root.

## The first-cwd rule

Sessions move (`cwds` is a list), but the store bucket is keyed by the
FIRST cwd — resuming from the last one would re-home the continued
session into a different bucket. Caught live: this build session
started in `/home/user/hodor` but its last cwd was `packages/ui`.
Resume always uses `cwds[0]`.

## Surfaces

- UI rows (hover): resume · fork. Detail pane header: resume · fork ·
  copy cmd · copy id. Project header: **+ new session** in the
  project's first known root.
- `POST /api/launch` `{kind: resume|fork, sessionId}` or
  `{kind: new, storeId, root}` — new-session roots must already be
  known to the data (project roots or session cwds); the server never
  launches into arbitrary paths. Responses always carry
  `{command, cwd}`; the UI copies `cd <cwd> && <command>` to the
  clipboard when no terminal opens.
- `hodor resume <id> [--fork] [--print]` — id prefixes work when
  unique; `--print` emits the cd + command pair instead of launching.

## Fork forensics (same day, answering "how do we know it's forking
## and not just removing?")

Tested empirically against the installed CLI: seeded a tiny session,
ran `claude --resume <id> --fork-session -p`, and examined the store.

1. **Fork copies, never removes.** The original transcript was
   byte-identical (md5) after the fork.
2. **History genuinely carries** — the fork answered a question only
   the original conversation could answer.
3. **Modern forks leave no embedded trace of the parent.** The copied
   lines are rewritten with the NEW session id; zero occurrences of the
   original id anywhere in the forked file. Our old lineage detection
   (embedded-id mismatch) only catches old-style copies and
   continuation handoffs — it misses modern forks entirely.
4. **But copied lines keep their API message ids and usage verbatim** —
   and two sessions can only share an API message id by copying. That's
   the durable fork fingerprint, and it also means a fork's usage
   re-bills its inherited history.

Both fixed in one move: the fold now remembers what each API message id
cost, and the snapshot correlates sessions sharing ids —
`forkedFrom` falls back to the shared-message evidence (direction by
lastActivityAt; copied timestamps make createdAt identical, so this is
a stated heuristic), and the fork's inherited usage is subtracted from
its totals (fully-inherited model buckets are dropped), keeping store
cost totals honest. Snapshots stay pure: subtraction operates on
copies, and a second snapshot over the same state gives the same
numbers. Verified live: a real forked session shows
`forkedFrom: <original>` and only its own new turn's tokens.

Also observed, worth remembering: a nested `claude` inherits
`CLAUDE_CODE_SESSION_ID` and will reuse it (we passed `--session-id`
to isolate the test), which means same-id transcripts in two buckets
can exist in the wild; hodor currently merges them into one session —
a known edge, revisit if it ever appears outside containers.

## Later

- Electron/PTY milestone: same LaunchTarget, but the terminal is ours.
- "Resume here" (last cwd) as an explicit secondary action if wanted.
- Windows Terminal profile selection (default profile is used today).

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

## Later

- Electron/PTY milestone: same LaunchTarget, but the terminal is ours.
- "Resume here" (last cwd) as an explicit secondary action if wanted.
- Windows Terminal profile selection (default profile is used today).

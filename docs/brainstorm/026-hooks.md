# 026 — Claude hooks: exact turn state

## Why

Whose turn it is has been inferred from transcript shape and file quiet,
cross-checked against `claude agents --json`. Both are guesses about
moments Claude Code knows exactly: a prompt was submitted, the agent
finished (and what it said), permission is being asked for, the process
ended. Claude's hooks fire at those moments. With them on, the turn is a
fact, not an inference, and a whole class of "it thinks it's still
active" bugs disappears at the root.

## Transport: a file in the store, not a request to hodor

The hook command hodor installs copies the hook's stdin JSON into
`<store>/hodor/events/<stamp>.json` (write `.tmp`, then rename) and
exits. hodor drains that directory on every tick, folds each file as a
`hook-event`, and deletes it.

Not HTTP, because from inside WSL2 `127.0.0.1` is the VM, not Windows: a
WSL session could never reach a Windows-hosted hodor. Not a hodor binary,
because the CLI may not be installed on every host that runs Claude. A
file inside the Claude store is read across the Windows/WSL boundary
exactly the way transcripts already are, needs nothing but the shell
Claude already runs hooks in, and queues while hodor is closed.

Hooks are `async`, so a hook never holds a turn up (`UserPromptSubmit`
hooks otherwise gate the prompt). Windows uses `"shell": "powershell"`,
which Claude runs directly; PowerShell 5 writes a BOM, which the drain
strips.

## Events and what they mean

| hook | fact | turn |
| --- | --- | --- |
| `UserPromptSubmit` | the user took their turn | working |
| `Stop` | the agent finished; `last_assistant_message` | waiting, with the words — unless `background_tasks`/`session_crons` are pending (the agent will wake itself): working |
| `StopFailure` | the turn died on an API error | waiting, "API error" |
| `PermissionRequest` | Claude is asking for a tool, right now | waiting, pending that tool, one line of what it wants |
| `Notification` `permission_prompt` / `idle_prompt` | the six-second and sixty-second versions of the above | waiting |
| `SessionEnd` | the process is gone | idle |
| `SessionStart` | the process is alive | no turn change; liveness |

## Precedence

A hook fact is decisive while nothing in the transcript is newer than it
(`fact.at >= lastMainAt`). A tool_result after a permission ask, a prompt
line after a Stop — any newer main-line event retires the fact and the
inference resumes. `UserPromptSubmit` and `Stop` are themselves main-line
events: they do the same bookkeeping a transcript line would, under the
same clock guard, so a stale file can never roll the turn backwards
(023's lesson, again).

The `claude agents --json` listing never overrides a hook-decided turn:
an exact fact beats a poll that can be four seconds stale.

`turn.source` records who decided (`hook` / `cli` / `transcript`).

## Settings

The toggle writes one group per event into every store's
`~/.claude/settings.json` — the Windows store and each distro get their
own dialect. hodor's groups are recognisable by the events path in their
command, so **off** removes exactly those; every other hook and key the
user wrote survives byte-for-byte in content. A file hodor cannot parse
is left alone and reported. Claude's file watcher picks up the edit
without a restart.

`hodor hooks on|off|status` does the same from the CLI.

## Not yet

- `SubagentStart/Stop`, `PreCompact/PostCompact`, `CwdChanged` — useful
  metadata, not turn state.
- Hooks as the wake source for the turn stack's skip/snooze (it already
  keys on the ask's signature, which a Stop fact now feeds).

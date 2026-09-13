# 024 — Controlling all Claude Code settings from hodor

Date: 2026-09-13
Status: research complete, verified against CLI 2.1.270 in-container;
feature not yet built. Dylan's ask: "control all Claude settings from
hodor. Like all of them."

## The verified map (CLI 2.1.270)

**Where settings live — six stores, five precedence layers:**

1. **Managed** (highest; three delivery mechanisms): a
   `managed-settings.json` at `/etc/claude-code` (Linux),
   `/Library/Application Support/ClaudeCode` (macOS),
   `C:\Program Files\ClaudeCode` (Windows); OR MDM/registry (HKLM
   policies); OR remote org policy fetched from api.anthropic.com
   (`claude doctor` reports both: "Managed settings (remote)" and
   "Organization policy: Loaded from api.anthropic.com").
2. **`--settings` CLI flag** (per-invocation).
3. **`.claude/settings.local.json`** — project-local, gitignored.
4. **`.claude/settings.json`** — shared project file (some keys are
   IGNORED from repo files; others wait for folder trust).
5. **`~/.claude/settings.json`** — user.

Plus **`~/.claude.json`**: the CLI's own state file (oauth account,
per-project state, MCP approvals) that ALSO holds the ~10 "global
config" keys (`theme`, `editorMode`, `diffTool`, `verbose`,
`autoConnectIde`, `copyOnSelect`, `externalEditorContext`,
`preferredNotifChannel`, …) — those apply ONLY from this file.

**Scope classes**: every key has an allowed-layers class (Any ·
User-or-managed · Managed-only · User/local/managed · Global-config).
Notables: `permissions.defaultMode` values `auto`/`bypassPermissions`
don't take effect from project or local files (since 2.1.257);
`modelPicker`, `availableModels` and the `allowManaged*Only` locks are
managed/user territory.

**How many knobs**: the published JSON schema
(https://json.schemastore.org/claude-code-settings.json) lists **142
top-level keys** (fetched and counted). The binary's own zod schema is
self-documenting — every key carries a `.describe()`; we extracted
210 described keys including sub-schemas (permissions, statusLine,
attribution, breakReminder, sandbox, plugins…). The schema can lag
the CLI; unknown keys are TOLERATED (verified below).

**Live reload — the load-bearing fact**: Claude Code watches user,
project, local, and managed settings FILES and applies most edits to
RUNNING sessions — including `permissions`, `hooks`, and
`apiKeyHelper` — firing a `ConfigChange` hook per detected change.
Exceptions read once at session start: `model`, `effortLevel`,
`modelSettings`, `agent`, and some admin keys
(`requiredMinimumVersion`…). MDM/remote-managed changes arrive on a
schedule, not on save. (Docs-asserted; re-verify the permissions case
live when building.) So hodor's writes reach running sessions — a
settings panel can be genuinely live, not "restart to apply".

**Validation & failure modes** (verified in-container):
- Unknown keys pass silently (forward-compat) — a bogus key produced
  no complaint.
- Type errors are reported per file+key+reason by `claude doctor`
  ("`cleanupPeriodDays: Expected number`"); interactive sessions show
  a fix-it dialog instead of crashing.
- A corrupt `~/.claude.json` is backed up to `~/.claude/backups/`
  (five most recent kept, written before every rewrite) and offered a
  reset — the CLI itself treats that file as hazardous.

**The `claude config` CLI is GONE** (verified: 2.1.270 has no
`config` subcommand — only `doctor`, `mcp`, `plugin`, `project`,
`import`, `auth`…). External tools write the files directly; there is
no supported write API. In-session, `/config` writes user settings or
global config on your behalf.

**Adjacent config surfaces** beyond settings.json: `~/.claude/
keybindings.json`, memory files (CLAUDE.md tree — already hodor
domain), MCP servers (`.mcp.json`, per-project approvals in
`~/.claude.json`, `claude mcp` CLI, managed-mcp), agents/skills/
output-styles directories, plugins, and env vars (settable via the
`env` block — the biggest hidden surface).

## What "all of them" decomposes into for hodor

**Read side (safe everywhere, cross-boundary for free):**
- Parse every layer through the FileSystem abstraction — which means
  hodor can show BOTH sides of a Windows⇄WSL setup at once
  (`wslInheritsWindowsSettings` surfaced), something no other tool
  does.
- Compute the EFFECTIVE value per key by re-implementing precedence +
  scope classes, and show which layer wins and why — the thing
  `/status` explicitly does not do ("it doesn't show which file
  supplied each key"). This is the killer read feature.
- Run doctor-grade validation continuously: flag type errors per
  file/key with the same tolerance for unknown keys.

**Write side (a safety ladder, not one mechanism):**
- **Green — direct writes**: `~/.claude/settings.json`, project
  `.claude/settings.local.json`, project `.claude/settings.json`
  (with a "teammates see this; some keys wait for trust" note), and
  `keybindings.json`. Atomic replace; read-modify-write that
  preserves unknown keys byte-for-byte at the JSON level (NEVER strip
  what we don't recognize — the CLI tolerates unknowns and so must
  we); hodor-side backup before every write.
- **Yellow — `~/.claude.json` global-config keys**: theme, diffTool,
  editorMode… must be written there or nowhere. The CLI rewrites this
  file constantly, so: read fresh, patch only the target key, atomic
  rename, keep our own backup (the CLI keeps five of its own). The
  race with a concurrent CLI write is the same one two parallel
  `/config` sessions already have — last writer wins, key-level blast
  radius.
- **Red — display-only, never write**: all managed sources, and the
  credentials/oauth/state portions of `~/.claude.json`.
- Security-sensitive keys (`permissions.*`, `hooks`, `apiKeyHelper`,
  `env`) get an explicit confirm in any UI — these change what agents
  are allowed to DO.

**Schema strategy**: vendor the schemastore schema (types, enums,
descriptions) for the editor UI; refresh it with hodor releases;
degrade to raw-JSON editing for keys newer than the vendored copy —
the docs themselves warn the schema lags the CLI, so a validation
warning is advisory, never a write-blocker.

**Effect feedback**: after a write, say which world it changed —
"applies to running sessions" (most keys) vs "new sessions only"
(model, effortLevel, agent…) — straight from the session-start-only
list above.

## Verification log

Tested in-container (isolated `HOME=/tmp/h1` so real data was never
touched): `claude config` removal; subcommand inventory; `doctor`
validation output on a settings.json with a valid key, a bogus key,
and a type error (only the type error was reported); managed-path
strings and `.claude.json.backup`/`backups/` machinery in the binary;
the 210-key `.describe()` schema extraction; the published schema
fetch (142 keys). Docs-asserted, to re-verify at build time: the live
settings-file watcher (especially permissions reload into a running
session) and the `ConfigChange` hook firing on external writes.

## Proposed milestone shape (when Dylan says build)

1. **Core**: a settings reader over FileSystem — all layers, all
   stores, effective-value resolution with per-key winning-layer
   provenance (the same provenance discipline as placements), doctor-
   grade validation results in the snapshot.
2. **Server**: GET /api/claude-settings (layers + effective + diagnostics),
   POST with {layer, key, value} honoring the safety ladder.
3. **CLI**: `hodor claude-settings list|get <key>|set <key> <value>
   --layer user|local|project [--root …]` and `hodor claude-settings
   doctor` for the cross-boundary view.
4. **UI**: waits for the 023 design pass — a settings surface with a
   layer picker, effective-value column, and the green/yellow/red
   write affordances.

## Open questions

- MCP server management (add/remove/approve across `.mcp.json`,
  `~/.claude.json`, `claude mcp`) — same milestone or its own? It has
  its own CLI and trust semantics.
- Keybindings and output-styles editing: worth first-class UI, or
  "open in editor" buttons?
- Should hodor expose `--settings` profile launching (per-workspace
  setting overlays for sessions hodor starts)? Powerful with 022
  workspaces — a zone could carry a settings profile.

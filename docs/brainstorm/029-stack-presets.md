# 029 — Turn-stack presets and skill lookup

Dylan's note: "Turn stack presets. Need controls and configs. Skill lookup."

## What shipped

**Presets are yours now.** The chips under a stack card used to be a
constant in the UI. They live in `~/.hodor/ui.json` as `stackPresets`
(the same durable prefs file as theme and rail), seeded with the three
originals: `go ahead`, `use your judgment`, `looks good — proceed`.

- Right-click a chip on the card: *remove preset*, *add a preset…*,
  *reset presets*.
- Settings → TURN STACK PRESETS: the same chips (right-click to remove),
  an *add a preset…* box, *reset* when the list differs from the seed.
- Clicking a chip still types the text plus Enter into the card's
  terminal. A structured dialog (AskUserQuestion, ExitPlanMode) still
  shows its own options display-only — the TUI owns that selection.

**Skill lookup.** A dashed `/ skill…` chip sits after the presets. It
asks the server for the session's slash commands and opens a picker;
the pick types `/name` plus Enter.

- `GET /api/skills?sessionId=` lists, in order: the project's
  `<cwd>/.claude/skills/*/SKILL.md` and `<cwd>/.claude/commands/*.md`,
  then the store's `~/.claude/skills` and `~/.claude/commands`. A project
  name shadows a user name, as in the CLI. Description = front matter
  `description:`, else the file's first line.
- Cross-store works the same way as hooks: the store's filesystem is
  used, so a WSL session seen from Windows lists WSL's skills.
- Not covered yet: plugin skills (`~/.claude/plugins/…`), MCP prompts,
  built-in commands (`/compact`, `/clear`…), and skills that need
  arguments (the pick runs the bare command; add args in the terminal).

Core: `packages/core/src/skills.ts` (`listSkills`, `skillDescription`,
tested). UI: `packages/ui/src/presets.ts` (store + prefs), `Stack.tsx`
(chips, menu, picker), `Appearance.tsx` (`PresetControls`).

## Open questions

1. **Per-project presets?** Today one list for everything. A project
   that always wants `run the tests first` could carry its own set —
   the natural home is the custom project's config split, which the
   organizing rules already read.
2. **Presets that are skills.** A preset could be `/review` — it works
   today because chips type text verbatim, but it is not distinguished
   from prose. Worth a marker (a `/` prefix rendered mono) or a separate
   "pinned skills" row?
3. **Arguments.** Should picking a skill leave `/name ` in the terminal
   for you to finish (needs focus handoff into the card's terminal)
   instead of running it? Running was chosen so a pick is one click
   like a preset.
4. **Plugin skills.** The plugin layout under `~/.claude/plugins` is
   not stable enough to read yet; when it is, the same lister grows a
   third scope.

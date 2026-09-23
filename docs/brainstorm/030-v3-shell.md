# 030 — The v3 shell

Dylan's Claude Design mock ("hodor v3", seven screens: the desk, the
projects drawer, the turn stack, the project overlay and its settings
page, the text dialog, popped-out zones and workspaces). Built as drawn
wherever the app already had the underlying operation; the decisions
below cover what had to differ. Ships on the experimental channel from
`exp/workspaces`, because the mock assumes workspaces everywhere.

## Decisions

1. **Branch.** v3 lands on `exp/workspaces`; nightly keeps the previous
   UI until promoted.
2. **Desk engine.** dockview stays, restyled to the mock's hairline look:
   a 26px zone header reading *name · tabs · +*, 1px tile borders with
   4px radii, 6px gutters (each leaf view pads 3px, the sash rides the
   gap), the focused zone one shade brighter. Tabs still drag between
   zones and splits still resize — the mock's fixed grid would have lost
   both.
3. **What the drawer absorbs.** The mock has no Home, no All sessions,
   no archived or hidden lists, no update pill. The drawer's search box
   is real and searches every session across projects; a project's
   overlay is the per-project library (archived behind its chip); the
   gear's *archive* page lists archived sessions, hidden sessions (with
   the rule that hid each) and archived projects, each with its restore
   verb; channel, version and update state sit in the status bar.
4. **Session detail and settings.** *session detail* opens the project
   overlay's third page (‹ sessions / detail), reusing the detail pane.
   The gear opens app settings in the same 940×540 frame, with pages:
   appearance, behavior, archive.
5. **Pop-outs.** Per-tab pop-out exists. Zone and workspace pop-out are
   phase 4 — a workspace window needs the server to merge the workspace
   document per workspace.
6. **Turn stack.** Phase 2: the mock's list + follow pane, composer with
   presets, skill and reply box; snooze variants stay in the row menu.

## Substitutions

- The cloud and gear glyphs are the existing SVG icons (emoji risk on
  Windows). Every other glyph is the mock's: ▲ ● ○ ❯ ◐ ▪ ⧉ ☰ ⌕.
- *$ today* needs per-day spend: the fold now buckets billed usage by
  local calendar day (`ThreadAccum.usageByDay`) and the snapshot sums
  today's into `Session.costTodayUsd`. Forks are not de-duplicated for
  the day figure (they are for totals) — a glance number.
- *ctx N% left* derives from `contextTokens` against the model's window
  (1M for the [1m] variants, 200k otherwise).
- A matcher's *N sessions* comes from the preview endpoint when the
  settings page opens.
- Workspace *intent* is a new field in the v2 document.
- The tab keeps a small WSL / PowerShell / cmd mark after the glyph when
  that distinction exists (never on a plain shell); the mock had none.
- The idle stack keeps the dashboard (the mock calls that screen a
  stand-in).

## Phase 1 — shipped

- `TopBar.tsx`: 30px; projects menu, wordmark, workspace tabs with one
  badge each (▲ your turn first, else ● working, else cloud), the
  workspace's intent, the your-turn button (this workspace's count),
  settings, window controls.
- `StatusBar.tsx`: 24px; *⧉ workspace · zone* (right-click for the
  workspace's verbs), the focused tile's directory · branch · model,
  context left; then waiting and running across every workspace, spent
  today, hooks, server, build and update state.
- `ProjectsPanel.tsx`: the 264px drawer (overlay, or pinned via the
  `panel` pref). Search over every session; projects with ▲ and ●
  counts and the total (click: all sessions); expanded, the sessions
  worth a glance (your turn, working, touched in two days). Click a
  session to land on its tile, else its detail; right-click for the
  rest. Project menu: all sessions, settings, new session, shell,
  expand, pin, rename, archive.
- `ProjectOverlay.tsx`: sessions table (checkbox, glyph, session with
  branch/PR/fork/skip line, on the desk, model, last, spent), chips
  all / needs you / running / idle / archived (+ hidden when nonzero),
  bulk bar (skip, archive/unarchive, add to…, exclude, clear), the
  two-column settings page (`ProjectSettings.tsx`), the detail page
  (`SessionDetail.tsx`). Double-click a row for detail.
- `SettingsOverlay.tsx`: appearance / behavior / archive.
- Desk: zone header with the zone's verbs (new session here, rename,
  default zone, close every tab), glyph tabs (middle-click closes), the
  tab menu gains skip and session detail, `deskState.focusPanelId`,
  `tileOf(id)` for "where is it" and "jump to its tile".
- The browser build (`hodor ui`) pins the panel and renders the project
  overlay inline as the page.

## Phase 2 — shipped: the turn stack

`Stack.tsx` is the mock's list plus follow pane. The list (320px) holds
every session whose turn is yours, waiting-longest first, then the ones
you answered from the pane as "working · you said …"; the longest wait
carries the amber edge (up next) and the followed row the *◂ pane* tag.
The pane is the followed session's terminal (a dead slot offers resume)
under a header with its project, branch and state; below it the
composer — preset chips, `/ skill…`, a reply box — or, once answered,
the pulsing *working* line. Answering keeps you on that session; it
counts as working on its own for eight seconds while the transcript
catches up, then the real turn state takes over (a session that asks
again moves back up the list; one that stopped reads *stopped — back to
you*). Typing in the terminal itself counts as answering too. A cloud
row shows its ask with the same composer; a reply queues into the cloud
session and skips it until its ask changes. Row menu: jump to its tile,
session detail, skip, skip with a note, skip until the PR moves, snooze
30 minutes or 2 hours, hold until I unskip it, send to phone, close its
tile. Scope chips: *⧉ workspace* / *everywhere*; *desk* goes back. With
nothing waiting and nothing followed, the pane shows the dashboard.

Gone from the old stack: *later* (pick any row instead), the snooze
dropdown and the done/kill buttons (the row menu), the "next up" strip
(the list).

## Phase 4 — shipped: pop-outs

A zone or a whole workspace in its own window. Each pop-out is another
renderer on the same local server — the main process holds the PTYs, so
the new window attaches to the same terminals and the desk shows a
placeholder for what moved out (*⧉ open in its own window · bring it
back*). Closing the window IS bringing it back.

- **Zone** (zone header menu, or the workspace menu's *pop <zone> out*):
  `#zone=<workspace>/<group>` renders `ZoneWindow.tsx` — the zone's tabs
  read from the workspace document, the active tab's terminal below. A
  dead slot's *resume into place* asks the desk that holds the workspace
  (an IPC relay); the document update that follows lights the tab up.
  The flag lives in the zone's meta (`zones[group].popped`).
- **Workspace** (workspace menu): `#workspace=<id>` renders the whole app
  locked to that workspace — same chrome, its tab alone, no switching,
  its own turn stack. The main window shows the placeholder and keeps
  the tab (with ⧉ and its badge, counted from the document). The flag is
  `Workspace.popped`.
- **Two windows, one document.** Saves are per workspace now: a window
  posts `{ workspace }` (its own), the main window also `{ active }`, a
  close posts `{ remove }`; the server merges (`mergeWorkspaceDoc`) and
  announces the document to every window over the snapshot's SSE stream
  (`event: workspace`). Each window takes the server's word for every
  workspace but the one mounted in it; a popped-out active workspace
  takes the server's copy too, except its own popped flag, which only
  the window's close may clear. Popping out is one write (layout plus
  flag), so no stale echo can race it.
- On boot the main window reopens every pop-out the document says is
  open. Closing the main window closes them.

## Next

Open: should the drawer's search also list projects and actions (the
mock's unused omnibox data had both)?

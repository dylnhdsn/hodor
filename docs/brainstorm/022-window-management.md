# 022 — Window management: workspaces, templates, saved arrangements

Date: 2026-09-12
Status: v1 implemented (see Phasing) — the main-window dock is a dockview
region of tab groups and splits, terminals only, autosaved to
`~/.hodor/workspaces.json` (one implicit workspace) via `/api/workspace`,
with dead slots degrading to a resume affordance on restore. v2+ (named
workspaces, templates, multi-window documents) remain design.

The ask: beyond the project/session viewer, **workspace views** —
persistent window, tab, and split arrangements that can be (a) templated
and (b) saved with concrete sessions bound into them.

## The one distinction that organizes everything

Every tool in this space is some mix of two artifacts that are usually
conflated:

- **Templates** — structure plus *rules* for what fills each slot.
  tmuxinator/tmuxp YAML, Warp launch configurations, Zellij layout
  files. "Two columns: editor left, server logs right, in project X."
- **Saved state** — structure plus *the concrete things* that were in
  it. tmux-resurrect, resurrect.wezterm, iTerm2 arrangements. "The
  exact five terminals I had open Friday."

The tools that feel best unify them. Zellij serializes the live session
*into an ordinary layout file* every second — resurrection is just
loading a layout, so one format serves both. i3 goes further with the
key mechanism: a saved layout is a tree of **placeholder slots, each
carrying swallow criteria**; restore builds the frame and fills slots
as matching windows appear. Template and instance are the same
document — an instance is just a template whose criteria are very
specific.

That's the design center for hodor: **one workspace document; leaves
are slots; a slot holds a binding (a concrete session id) and/or a
rule (criteria for what belongs there); "save" captures bindings,
"save as template" strips them back to rules.**

## Survey

### Multiplexers (the semantics)

- **tmux** — the reference model: session > window > pane tree,
  detach/attach, panes survive their views. Layouts are checksummed
  geometry strings. Two ecosystems bolt on what we want: templates
  (tmuxinator/tmuxp, YAML; `tmuxp freeze` snapshots a live session
  into a template) and persistence (tmux-resurrect saves state, restores
  by *re-running commands* — inherently brittle: a re-run `claude` is a
  new conversation).
- **tmux control mode (`tmux -CC`)** — a text protocol where tmux stops
  rendering and instead streams structured notifications; iTerm2 turns
  tmux windows into *native* tabs/splits. Proof that "mux state in one
  process, native chrome in another" works — which is exactly hodor
  desktop's shape (PTYs in Electron main, xterm.js views in renderer
  windows).
- **Zellij** — layouts as first-class KDL documents with pane/tab
  templates; **swap layouts** (alternative arrangements the same panes
  flow into as their count changes — responsive design for terminals);
  session resurrection by continuous serialization into the same layout
  format.

### Terminals with workspace features (the UX patterns)

- **iTerm2** — saved window arrangements (restore window/tab/split
  geometry + profiles), plus the tmux integration above.
- **WezTerm** — mux domains (a server owning workspaces/windows/tabs;
  the GUI is a view over a domain), `resurrect.wezterm` saving state as
  JSON.
- **Warp** — launch configurations (YAML: windows > tabs > split trees,
  each pane with cwd + startup command) and newer per-tab "tab configs"
  (TOML). The closest commercial analog to our template side.
- **Wave Terminal** — the closest overall analog (Electron + Go): every
  tile is a uniform **block** (terminal, web page, file preview, AI
  chat) in a tiled layout; workspaces persist automatically; layouts
  can be saved and named. Two lessons: blocks-not-just-terminals (a
  hodor session *detail pane* or a cloud-session view could be a tile
  someday), and autosave-by-default (nobody "saves" their workspace;
  reopening just works).

### Agent-session managers (our direct neighbors)

Claude Squad (tmux + worktrees TUI), Conductor (mac app, worktree per
agent), Crystal→Nimbalyst. All solve *isolation and review* for
parallel agents; none offer user-composable, persistent, templateable
workspace layouts. That is a gap hodor can own — and our substrate is
stronger: we know sessions' identities, projects, and git context, so
slots can be *smart* ("newest session in project X") instead of
"re-run this command in this cwd".

### Layout engines for the renderer (the build path)

The dock is React in Electron; the layout tree should be a library, not
hand-rolled:

- **Dockview** (recommended) — zero-dependency docking manager, active
  (v6.x, 2026), React bindings (16.8–19): tabs, groups, grids,
  splitviews, drag-and-drop, floating groups, **popout windows**, and
  first-class layout serialization (`toJSON`/`fromJSON`). Caveats: its
  popout uses `window.open` + a same-origin `popout.html`; in Electron
  that means intercepting window-open in main — or keeping our existing
  main-process popout mechanism and simply hosting a dockview root per
  BrowserWindow (cleaner: PTY moves are already detach/attach).
- **FlexLayout** (Caplin) — solid JSON-model docking, React-only.
- **react-mosaic** — elegant binary-split trees, simpler feature set
  (no tab stacks per tile without extra work).
- **golden-layout** — the classic, maintenance has waned; the ecosystem
  moved to dockview.
- **react-resizable-panels / Allotment** — split panes only; would
  leave tabs/drag/serialize on us.

Decision: dockview unless something disqualifies it in a spike; its
serialized JSON becomes the geometry half of our workspace document.

## What hodor already has

The multiplexer core exists in embryo (018): PTYs live in the main
process with a 512KB backlog ring and survive their views; dock ⇄
popout re-attach is tmux detach/attach; `composePtySpec` routes a
session's terminal into the right host (native/WSL). Missing: real
layout containers (splits + tab groups instead of one dock), the
workspace document, slot semantics, and persistence.

And the unfair advantage on restore: **a slot holds a Claude session
identity, not a shell command.** `claude --resume <id>` reconstructs
the whole conversation — the transcript *is* the state. Where
tmux-resurrect re-runs commands and hopes, hodor restores losslessly.
Cloud sessions slot in the same way (viewer + teleport/message verbs).

## Proposed model

### The document

`~/.hodor/workspaces.json` (same user-plane treatment as
projects.json: durable evidence, survives rescans, shared across the
Windows/WSL boundary):

```jsonc
{
  "workspaces": [{
    "id": "hodor-dev",
    "name": "hodor dev",
    "template": false,            // true = never auto-binds, only spawns copies
    "windows": [{
      "layout": { /* dockview toJSON — geometry only */ },
      "slots": {                  // keyed by panel id in the layout
        "p1": { "rule": { "kind": "session", "sessionId": "0d6e…" } },
        "p2": { "rule": { "kind": "project-latest", "projectId": "hodor" },
                 "boundTo": "8f3a…" },       // what filled it last time
        "p3": { "rule": { "kind": "new-session", "storeId": "s1",
                 "root": "/home/dylan/code/hodor" } }
      }
    }]
  }]
}
```

Slot rules (i3-swallow, but over hodor evidence): `session` (pinned
id), `project-latest` (newest visible session in a project),
`new-session` (root + store), `cloud` (a cloud session id — opens the
cloud pane, teleport/message at hand). Later, Wave-style view tiles
(`view: session-list`, `view: detail`) ride the same union.

### The verbs

- **Open workspace** — build the frame from `layout`, fill each slot:
  prefer `boundTo` if that session still exists, else evaluate `rule`,
  else show an empty slot with a "pick a session / start new" affordance
  (never fail the whole restore because one slot went stale).
- **Autosave** (Zellij lesson) — geometry and bindings persist on every
  change; quitting and reopening the app restores the live workspace
  with zero ceremony. PTYs can't outlive the app, so restore =
  `claude --resume` per slot; within an app run, moving tiles is pure
  detach/attach.
- **Save as template** — copy the workspace, strip `boundTo`, loosen
  `session` rules to their project (`tmuxp freeze`, inverted). Opening
  a template instantiates a new workspace bound to fresh matches.
- Workspaces appear in the rail below projects; a project's "open as
  workspace" seeds a one-window layout from its recent sessions.

### Multi-window

A workspace's `windows` array maps to BrowserWindows, each hosting a
dockview root. PTYs stay in main, so dragging a terminal between
windows is detach/attach (already proven by popout). Bounds ride along
in the same document, replacing the single-window `desktop.json` entry.

### Phasing

1. **v1 — real layout in the main window.** Replace the single dock
   with a dockview region: tab groups + splits, terminals as panels,
   autosaved as one implicit workspace. Proves the engine and the
   document.
2. **v2 — named workspaces.** Save/open/rename/delete; rail section;
   restore-by-resume for dead sessions; empty-slot affordance.
3. **v3 — templates.** Save-as-template, slot rules beyond `session`,
   "open as workspace" on a project.
4. **v4 — multi-window documents** + keyboard model (next/prev pane,
   move-pane, quick-open workspace) + maybe view tiles.

## Open questions

- Are tiles terminals-only at first, or do hodor views (session list,
  detail pane, cloud pane) become tiles early (Wave's block model)?
- Does the browser (non-desktop) UI get workspaces at all? It has no
  PTYs; read-only arrangement + external-terminal launch might be v0
  or might be skipped.
- Swap-layouts (Zellij) — worth stealing for small screens, or YAGNI?
- Keyboard-first vs mouse-first as the primary model.

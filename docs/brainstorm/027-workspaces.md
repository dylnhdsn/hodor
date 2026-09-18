# 027 — Workspaces

## The model (agreed 2026-09-18)

A **workspace** is a named set of tiles (today's desk layout, with its
zones) plus its **own turn stack** and its **own skip state**. Workspaces
are tabs in the title bar, a tier above the views. One is always active.
The turn stack is a view *inside* a workspace; an **all turns** view
spans every workspace. A workspace can be scoped to a project, which
only changes what "new session" defaults to.

Today's single desk becomes the workspace "main".

## Switching without killing anything

A tile's PTY lives in the main process; the renderer only attaches.
Today, removing a panel closes its PTY (`onDidRemovePanel → close`),
which is right for "close tab" and wrong for "show a different
workspace". A switch therefore:

1. sets a `switching` latch — `onDidRemovePanel` skips the close;
2. saves the active workspace (layout, zones, defer);
3. `fromJSON` the target layout; each tile re-attaches to its PTY
   (`pty:attach` replays the backlog, exactly as pop-out and restore
   already do); dead ones show the resume affordance as today;
4. swaps `deskState` (entries, defer) and the zone metas;
5. clears the latch.

PTYs of the workspace you left keep running with no subscriber; the
main process keeps their backlog. Closing a *workspace* is the one
place PTYs die, and it asks first.

## Persistence — its own file

Nightly and experimental installs share `~/.hodor` on purpose (projects,
renames, prefs are one set of user data). But the pre-workspaces code
saves `workspaces.json` back as exactly one workspace, so two channels
writing the same file would fight and the older one would win by
erasure. Workspaces therefore live in `workspaces.v2.json`:

```
{ v: 2, active: "main",
  workspaces: [{ id, name, scope?: { projectId }, windows: [{ layout, zones }], defer }] }
```

On first run, an absent v2 is seeded from v1's `default`. v1 is never
written again by a build that knows v2. When workspaces reach nightly
and stable, they read v2 the same way; v1 stays as the seed.

## The stack, per workspace and across all

`stackQueue` already reads the desk's live entries and defers, so once
those swap on switch, the stack is per-workspace with no further change.

**All turns** needs the *inactive* workspaces too. Their entries are
derivable from the saved layout's panel params (`target.sessionId`,
teleport cloud ids) and their defers are in the doc — no mounting.
Items carry the workspace; picking one switches to it and focuses the
tile.

## Title bar

`[wordmark] [channel]  main · peri · billing  +   /  Desk   [update pill] [turn stack] [settings]`

A tab's context menu: rename, new workspace, scope to project, close
(confirm: N terminals will end). The crumb keeps naming the view within
the workspace; the rail's Desk / turn stack entries become that
workspace's.

## Stages

1. v2 doc + seed migration; `active`; save/load the active workspace
   only. (No visible change yet.)
2. Title-bar tabs; new / rename / switch with PTY survival; close.
3. All-turns view.
4. Project scope → new-session default.

Ships on the experimental channel first.

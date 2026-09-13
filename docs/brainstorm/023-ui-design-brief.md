# 023 — UI design brief: what hodor is, so a designer can draw it

Date: 2026-09-13
Status: alignment doc for the UI redesign. The prototype UI proved the
data plumbing; this brief is the input to a real design pass (Claude
Design). Everything here describes what EXISTS in the core today unless
marked (later).

## What hodor is

Mission control for every Claude Code session you have — local
transcripts on all your machines' stores (Windows ⇄ WSL both ways) and
cloud sessions on claude.ai/code — organized into projects, with real
terminals to act on them. One sentence for the designer: **a
mail-client-shaped library of AI coding sessions, fused with a
tmux-shaped workbench, sharing one project spine.**

The UI has exactly three jobs:

1. **Triage** — "what needs me right now?" Cloud sessions blocked on
   input, review-ready runs, things still executing, what happened
   since I last looked.
2. **Recall** — "find that session where we fixed the pricing bug."
   Search, projects, fork lineage, conversation tails, metadata.
3. **Act** — resume/fork/new/teleport into embedded terminals, arranged
   in a persistent workspace; send a message to a running cloud session
   without taking it over.

The prototype does Recall passably, Act adequately, Triage not at all.

## The mental model the UI must teach

- **One rail, one kind of thing** (doc 010). The user sees "projects" —
  never the machinery (auto-derived vs custom, materialization,
  placements). A project that exists only in the cloud looks identical
  to one with 200 local sessions.
- **A session is one species with two homes.** Local (a transcript in a
  store) and cloud (a record at claude.ai/code) differ in available
  facts and verbs, not in kind. The prototype renders cloud sessions as
  a separate strip bolted above the local list — the single biggest
  design wrong to fix. One list, one row anatomy, an origin mark.
- **Curation never fights the machine.** Rename, pin, exclude, archive
  — all survive every rescan and every improvement to auto-grouping.
  The UI should radiate that safety: nothing here deletes data, every
  hide is reversible, provenance is always inspectable.
- **Degradation is a feature.** No cloud login → the cloud simply isn't
  there. A failed listing → one quiet hint. A dead branch → a calm
  label ("opens on your current branch"), not an error. The voice is
  informative-calm, never alarmed.

## Design material: the entities and their facts

What the snapshot actually carries — this is the palette. Nothing needs
to be fetched; the UI is a pure function of one SSE-updated snapshot.

**Project** (the rail): name, sessions (local + cloud), roots/cwds,
git remotes, archived?, matchers (evidence rules incl. branch/title/
model/entrypoint + all/any/not combinators), pins (include/exclude),
aggregate stats (session count, last activity, total cost). Auto vs
custom is internal; settings reveal it only as "materialized from
evidence" vs "yours".

**Local session**: title (rename ?? summary ?? prompt preview ?? first
command), cwd(s), git branch, created/lastActivity, entrypoints (cli /
vscode / sdk…), fork parent + forks, hidden-by (with reason),
message counts (user/assistant/sidechains/tool calls), per-tool call
histogram, model usage + tokens (input/output/cache-by-TTL) + est. cost
(unpriced models flagged), context fill (tokens vs window), compactions
(+ last compaction sizes), API errors, hooks (runs/ms/errors/blocks),
checkpoints (count, edits, files, backup blobs), subagent runs
(threads: agent type, message count, usage), memory files in scope
(CLAUDE.md & friends, per root), CLI version, effort/service tier/
inference geo/fast-mode, slug, store it lives in.

**Cloud session**: title, status (running/idle) + triage bucket
(working / blocked="needs you" / review-ready / completed), the
session's own words (statusDetail, needsAction, recentAction), repo +
ALL source repos, outcome branches (+ branchGone pre-flight), model,
effort, origin (web/android/…), context used/max, cost, url, joined
project (same rail as everything else), age.

**Workspace** (desktop): dockview layout of terminal tiles; each tile
is a slot = live PTY + the rule that opened it (resume/fork/new/
teleport target); autosaved; dead slots restore by offering
`claude --resume` back into place. (later: named workspaces,
templates, multi-window — doc 022 phasing.)

**Cross-cutting**: placement provenance per session (matcher X /
pinned / your organize logic / archived-by), organize-logic errors
(banner today), stores (native/WSL/Windows origins), update state
(restart pill / mac notice), hodor build version.

## The verbs

On a session: resume, fork, open-in-terminal vs external terminal,
rename, archive/unarchive, pin to project, exclude from project,
inspect provenance, view transcript tail (full viewer later).
Cloud-only: teleport (pulls it local; web copy goes read-only — say
so), send message (queues without taking over), open on web.
On a project: create, rename, add/remove matchers (with live preview of
what a matcher would claim), include/exclude/unpin sessions, merge,
split by root, archive/unarchive, revert-to-auto (materialized only),
new session in root. On the workspace: open/split/tab/pop-out/close
terminals, resume dead slots. Global: search (substring + `has:agents`,
`is:fork` — status:/model:/project: wanted), update.

## Where the prototype fails (be honest, design against these)

1. **No triage layer.** The home view is a flat recency list. Nothing
   answers "what needs me?" — the single most valuable question. Cloud
   buckets (needs-you / review-ready / running) exist in the data and
   get buried in a strip.
2. **Two species.** Cloud rows and local rows have different anatomy,
   different actions, different visual weight. They must be one list.
3. **The detail pane is a fact dump.** ~20 facts in a flat column, no
   grouping, no hierarchy between "the conversation" (the point) and
   "telemetry" (occasionally useful). Cost, checkpoints, hooks, memory
   files, forks, agents all shout equally.
4. **Zinc-on-zinc soup.** One neutral ramp, one text size, everywhere.
   Status never reads as color; identity never reads as type. Rows,
   headers, panes, settings all have the same visual voice.
5. **Settings are a form dump** — functional matcher editing, zero
   affordance for what matchers MEAN or the preview's power.
6. **The workbench is bolted on.** The dockview region (022 v1) is
   functionally right and visually an afterthought: no relationship to
   the session rows that spawned it (a session row and its running
   terminal don't acknowledge each other).
7. **No keyboard model.** A tool for terminal people with zero
   shortcuts.
8. **Provenance is noise, not reassurance** — raw strings like
   `project-archived:<id>` leak into the UI.

## Proposed information architecture

Three-region app, one window (desktop adds terminals; web hides them):

- **Rail** (left, unchanged in spirit): Home (triage), All sessions,
  projects by recency with unified counts, archived/hidden, version +
  update pill. Projects may later take colors/icons (cosmetics
  backlog).
- **Library** (center): the list. Two lenses over the same rows —
  **Home** groups by state (Needs you → Running → Review-ready →
  Recent), cross-project, capped and quiet; **Project/All** is the
  flat recency list with search. One row anatomy for both species:
  status dot + origin mark (local store / cloud) + title + project
  chip (in cross-project lenses) + right-aligned facts (age, cost,
  branch/branch-gone, agents/forks badges). Selection opens detail.
- **Detail** (right pane): layered, not dumped. Header = title,
  status, project, primary verbs. Body = the conversation tail first
  (it's the point), then collapsed groups: Usage & cost · Git &
  checkpoints · Agents & forks · Environment (hooks, memory, CLI,
  geo/tier) · Provenance ("here because matcher `remote=…`" in human
  words). Cloud detail = same skeleton, its facts (status story,
  context meter, branch pre-flight) in the same slots.
- **Workbench** (bottom region on desktop, drag-height, or popped-out
  windows): dockview tiles as today, but visually of-a-piece, with a
  two-way link: a session row shows a "terminal open" glyph; a tile's
  tab links back to the session detail.

## Design principles for the pass

- **Density with hierarchy.** This is a dev tool: rows stay compact
  (Linear-like), but introduce a real type scale and a second neutral
  ramp so panes/headers/rows read as different layers.
- **Status is color; identity is type.** One accent for interaction;
  a fixed 4-color semantic set for session state (needs-you amber,
  running green, review-ready blue, done/idle neutral); everything
  else stays neutral. Monospace is reserved for identifiers (branches,
  ids, paths) — it's an accent, not a body face.
- **One species, graded disclosure.** Any fact can be absent (local
  sessions lack buckets; cloud lacks tool histograms) — the row/pane
  anatomy holds slots that collapse silently.
- **Calm degradation voice.** Hints and labels, never red except for
  actual failures of the user's own logic (organize errors).
- **Keyboard skeleton from day one:** j/k rows, enter = detail,
  r = resume, / = search, cmd+1..9 projects, cmd+` cycle terminals.
- **Scale target:** 1,000 local sessions, 50 cloud, 30 projects —
  lists must virtualize; Home lens must cap-and-summarize, never
  scroll forever.
- **Dark-first, light-capable.** Ship dark; keep tokens honest so
  light is a palette swap later, not a redesign.

## Constraints the design must respect

React + Tailwind, embedded single-file build (no external asset
pipeline; fonts = system stacks). The UI is a pure render of one
snapshot over SSE — every visual state must map to snapshot data that
exists today (this doc IS that inventory; don't invent facts). Desktop
= same UI + PTY bridge + dockview; web = same minus terminals (launch
falls back to external terminal / clipboard). Primary viewport
≥1280px; usable at 960; phone is a non-goal. No destructive actions
anywhere in the UI.

## What to ask Claude Design for (artboards)

1. **Home (triage lens)** — the "what needs me" answer, with realistic
   mixed data: 2 needs-you cloud sessions, 1 running, a review-ready,
   recents across 3 projects, one branch-gone label.
2. **Project view** — unified list, ~14 rows mixed local/cloud, search
   active, bulk-select state, project stats header.
3. **Session detail, local** — tail + collapsed fact groups + forks.
4. **Session detail, cloud** — status story, context meter, teleport/
   message verbs, branch pre-flight label.
5. **Workbench** — dock open with 3 tiles (one split), row↔tile link
   visible, one dead slot offering resume.
6. **Project settings** — matchers with preview, pins, danger-free
   archive/revert affordances.
7. **States sheet** — row anatomy at every status; empty states (no
   sessions, no cloud login, fresh install); the update pill; organize
   error banner, humane provenance strings.

Feed each artboard this doc plus real snapshot JSON (`hodor scan
--json`) so the data is never lorem.

## Open questions (Dylan decides, then we design)

- Is **Home/triage the default view** on launch, or All sessions?
- Workbench posture: keep the **stacked bottom region**, or promote to
  a **mode/tab** (library ⇄ workbench) with popouts for multi-monitor?
- How loud should **cost** be — a per-row fact, detail-only, or a
  dedicated analytics surface (backlog: cost-over-time)?
- Do projects get **colors/icons** now (they'd carry the rail, rows,
  and terminal tabs) or stay text-only until the cosmetics pass?
- Any appetite for a **light theme** at ship, or dark-only?

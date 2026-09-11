# 011 — Session detail: subagents, lineage, conversation tail

Date: 2026-09-11
Status: implemented. Fulfills the oldest unmet display requirement from
001: "side chains or subagents should be linked to their parent session
so we can display them together."

## What a session row was hiding

The core has parsed sidechains (subagent runs) since M3 — every
`isSidechain` line chains into a `Thread` on its parent session, with
the `toolUseID`/`sourceToolAssistantUUID` link preserved as `spawnedBy`.
Nothing displayed them. This iteration is presentation for data we
already trusted, plus two small extractions.

## Detail pane

Clicking a session row opens a right-side pane (same slot as the project
settings panel — one or the other):

- **Facts**: last activity, created, message counts (you/claude),
  branch, entrypoints, CLI version, cwd. Copy-id, rename,
  archive/unarchive inline.
- **Subagents**: each sidechain thread as a row — message count and
  recency. Rows in the session list carry a `⑂ N` badge.
- **Lineage** (new detection, below): "forked from X" and "fork: Y",
  each a click-to-jump.
- **Projects**: every placement with provenance ("Extension v4 —
  remote=github.com/…", "pinned by you", archived claims marked), plus
  the auto grouping and its evidence. The pane is the always-available
  answer to "why is this session here".
- **Conversation**: the transcript tail (below). Sidechain turns render
  dimmed with a ⑂ prefix, inline in time order — the parent-and-subagent
  view from 001.
- A hidden session's pane leads with its `hiddenBy` provenance.

## Fork lineage

A forked/resumed-as-new session's transcript carries copied history
whose lines still hold the ORIGINAL session id; new turns carry its own.
The fold records the first mismatching embedded id as
`Session.forkedFrom`. No config, no heuristics beyond that — the
evidence is in the file. The UI builds the reverse index (`forksOf`) so
lineage is walkable in both directions, and the ancestor is jumpable
even when hidden.

## Conversation tail

`GET /api/transcript?id=<sessionId>&limit=N` (default 40, cap 200):
reads the transcript through the same `FileSystem` the tailers use,
parses with the same tolerant parser, and returns only human-readable
turns — user prompts, slash commands, and assistant text — meta and
tool-only lines skipped. To support this, the parser now extracts
`textPreview` for assistant messages (first text block, collapsed,
200 chars), the same way it has always extracted `promptText`.

Read-only by design: the pane shows the tail; a full transcript viewer
can come with the PTY milestone if living in the pane proves cramped.

## Later

- Sessions grouped under their fork ancestor in the list view (today
  lineage lives in the pane; the list shows a `fork` badge).
- Resume/fork actions from the pane — next iteration's territory.
- Live tail streaming (the pane refetches when `lastActivityAt` moves,
  which SSE already pushes; per-token streaming waits for PTY).

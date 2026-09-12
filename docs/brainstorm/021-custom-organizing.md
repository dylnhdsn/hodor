# 021 — Custom organizing logic

Date: 2026-09-12
Status: implemented; both hooks verified live (JS and a Python exec
hook labeling real sessions in one run).

Users bring their own organizing logic, statically and
programmatically. Everything flows through the ONE existing placement
channel, so precedence stays coherent everywhere: your pins >
organize labels > matchers > auto-derivation, and every placement
still explains itself (via: 'organize').

## Tier 1 — rule expressions (projects.json)

The matcher vocabulary grew leaves for facts the snapshot already
extracts — `branch` (glob), `title` and `model` (substring or
/regex/flags), `entrypoint` — plus combinators `all`/`any`/`not`
that nest arbitrarily. Existing matcher kinds are unchanged leaves;
old files parse as before. New leaves evaluate on local sessions
(cloud sessions get their organizing from the hooks below, which see
cloud facts). CLI: `hodor project match id branch=claude/deadlock-*`;
combinator trees are written in projects.json directly.

## Tier 2 — ~/.hodor/organize.js

An ES module, picked up by presence:

    export default function organize(session, { glob }) {
      if ((session.costUsd ?? 0) > 100) return ['expensive']
      if (session.type === 'cloud' && !session.repo) return ['inbox']
    }

Contract: pure over the fact object (results are memoized per
session-version + script mtime — editing the file reloads it on the
next tick, so the rail reorganizes live); throws are isolated per
session and surface as an amber banner, never a broken rail; return
up to 8 label strings or nothing. Facts are deep-cloned before the
call, so user code can't corrupt the snapshot. Trust model: the
user's own code in their own data home — .bashrc standing; nothing is
ever loaded from elsewhere.

## Tier 3 — exec hook (any language)

config.json:

    { "organize": { "command": "python3 ~/my-organizer.py" } }

The command runs through the user's shell, receives
`{apiVersion: 1, sessions: [facts]}` on stdin, prints
`{"labels": {"<sessionId>": ["label"]}}`. Re-run only when the fact
fingerprint changes. Labels union with organize.js labels.

## Labels become projects

A label resolves to a custom project by id or case-insensitive name.
Unknown labels: the SERVER silently creates the custom project (the
materialization move), suffix-free — a label maps to exactly one base
slug, so re-creation is a no-op. Read-only commands report them as
"would create". Cloud sessions get labels via claimedBy, local ones
via placements.

Hardening found live: refreshes now serialize (a refresh writes
projects.json for auto-create, and two overlapping refreshes over a
stale plane produced "expensive" AND "expensive-2").

## Facts (apiVersion 1)

Local: the snapshot Session plus type:'local', title (rename >
summary > promptPreview > firstCommand) and normalized `remotes`.
Cloud: the CloudSession plus type:'cloud'. Additive changes only;
apiVersion is passed in helpers and stamped on exec stdin.

## Tooling

- `hodor organize` — dry run: labels with counts, would-create marks,
  errors. Never writes.
- `hodor organize --explain <id>` — one session's full fact object
  next to the labels it earned.
- `hodor organize --json` — labels + unresolved + errors.
- UI: amber banner on evaluation errors; placement provenance reads
  "your organize logic".

## Later

- Combinator UI in the settings panel (JSON-only today).
- organize.js returning hide/rename/pin, not just labels.
- Published .d.ts for the fact object.

# 007 — Local-clone identity and the persisted config layer

Date: 2026-09-10
Trigger: two "peri" projects — peri-stable was a local clone, so its origin
was the path `/home/dylan/peri`, a different identity string from the
GitHub remote.

## Local-remote chasing (default: combine)

When a repo's remote URL is really a filesystem path (`git clone /some/dir`
writes exactly that, also `file://` and relative forms), the enricher now
resolves *that* directory's git context and adopts its real remote —
depth-capped at 3 hops, cycle-safe, and falling back to the local path when
the chain dead-ends. A local clone therefore groups with its origin, same
as a second clone from GitHub would.

## ~/.hodor/config.json (the split, and everything else durable)

First shipping of the persisted config layer. Loaded by the CLI, parsed in
core (zod, tolerant of unknown fields; a broken file warns on stderr and is
ignored), and folded into state as a `config-changed` event so the resolver
stays pure.

```jsonc
{
  "hide": {                       // extends defaults; toggles override
    "pathPrefixes": [], "pathSegments": [], "pathInfixes": [],
    "dotSegmentAllowlist": [], "interactiveEntrypoints": [],
    "hideDotSegments": true, "hideNonInteractive": true
  },
  "splitRoots": [                 // detach a checkout from its remote's project
    "/home/dylan/peri-stable"
  ],
  "projectNames": {               // rename by project id (see scan --json)
    "split:local:/home/dylan/peri-stable": "peri-stable"
  },
  "sessions": {                   // per-session overrides by session id
    "0d6e5057-…": { "rename": "hodor kickoff", "archived": false,
                     "pinnedProject": "…", "tags": [] }
  }
}
```

- **splitRoots** is the answer to "combine but let me split later": chasing
  merges by default; a split root forces sessions at/under it into their own
  path-identity project (`split:<store>:<root>`), confidence 1, provenance
  signal `config-split`.
- **sessions.rename** becomes the top-priority display title;
  **archived** classifies a session as `hiddenBy: "archived"` (revealed by
  `--all` like everything else); **pinnedProject** was already honored by
  the resolver.
- Config is read once per command invocation (watch does not hot-reload it).

## Still open

- Config is hand-edited for now; `hodor rename/pin/split` commands writing
  it are the natural next step, and the Electron UI's edits will go through
  the same file.
- splitRoots match across all stores by path shape; per-store scoping if it
  ever bites.

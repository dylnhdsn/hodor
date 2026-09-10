# 008 — The two-plane model: derived data + user layer

Date: 2026-09-10
Status: implemented (core/userplane.ts, snapshot placements, CLI
projects.json + data-home resolution). Decisions below marked DECIDED
came from Dylan; the PROPOSED absorb rule shipped as the default
presentation policy and remains a formatter-only concern to revisit.

## The planes

- **Base plane** (exists today): a pure function of watchable sources —
  transcripts, git metadata, built-in heuristics. Produces derived
  entities: sessions, signals, derived projects, visibility
  classifications. Always rederivable; never carries user edits.
- **User plane**: a durable user-owned document — **custom projects** plus
  a **mapping** from base-plane evidence to them. Survives any rescan and
  any base-plane improvement.
- **Presented view** = apply(user plane, derived). Computed, deterministic,
  never stored.

## Custom projects and matchers

```jsonc
// projects.json (user plane)
{
  "projects": {
    "p_9f3k": {
      "name": "Extension v4",
      "matchers": [
        { "kind": "remote", "url": "github.com/8flowinc/BrowserExtension" },
        { "kind": "remote", "url": "github.com/8flowinc/browser-extension" },
        { "kind": "root",   "path": "/home/dylan/ext-scratch" },
        { "kind": "cwd",    "prefix": "/home/dylan/demos/ext" }
      ],
      "include": ["<sessionId>"],   // explicit adds (UI drag-in)
      "exclude": ["<sessionId>"]    // explicit removes; beat matchers
    }
  }
}
```

Key rule: matchers reference **evidence, never derived ids**. Derived
project ids legitimately change as the base improves (peri-stable's did,
twice); remote identities, roots, cwds, and session ids are the stable
vocabulary. A UI gesture on a derived project records its identity key.

## Membership semantics (DECIDED: labels, multi-membership)

- A session belongs to EVERY custom project that claims it (matcher or
  include), minus its excludes. No conflict resolution exists because
  there is no exclusivity.
- The engine computes `placements`: sessionId → [{customProjectId,
  provenance: matcher | include}] — the full match set, presentation-
  agnostic.

### PROPOSED: the inbox guarantee + absorb rule

- Every derived project still auto-presents as a virtual project.
- **Absorb (default)**: an auto project displays only its sessions not
  claimed by any custom project. So "merge BrowserExtension +
  browser-extension into Extension v4" makes the two auto views give way,
  while a session claimed by two custom projects shows in both (labels).
- **Inbox guarantee**: every session appears somewhere — in its claiming
  custom projects, else its auto project. User edits can never make data
  disappear.
- Absorb is a presentation policy over `placements`, so flipping it (or
  making it per-project later) touches no engine code.

## User-plane home (DECIDED: per OS install, Windows-homed on Windows)

- Plain unix (Linux/macOS, incl. a WSL-only install): `~/.hodor/`.
- Windows machines: everything homes on the Windows side
  (`C:\Users\<u>\.hodor`), including when running inside WSL — WSL
  resolves the data home through `/mnt/c/Users/<u>/.hodor` when it exists.
  Discovery rule: from WSL, a unique `/mnt/c/Users/*/.hodor` wins;
  ambiguity or absence falls back to the local home (with a warning);
  `HODOR_HOME` overrides everything. A Windows user who wants a
  WSL-native-only setup just installs only in WSL.
- Files: `config.json` (settings/policy) and `projects.json` (user data),
  both in the data home.

## Auto projects (DECIDED: virtual until edited)

Auto projects are never written to projects.json by a scan. Only an
explicit user action (rename, merge, add matcher) materializes one as a
custom project — recording its identity key as the first matcher. Reads
never mutate user data.

## Migration of existing config keys

They are primitive special cases and fold into this model:
- `splitRoots` → a custom project with a root matcher (compiled
  internally until removed from config).
- `projectNames` → rename of an auto project; still keyed by derived id
  (drift-prone) — superseded by materializing a custom project.
- `sessions.pinnedProject` → an `include` entry.
- `sessions.{rename,archived,tags}` stay per-session user-plane facts.

## Invariants (fast-check targets)

1. Rederivability: presented view is a pure function of (sources, user
   plane); deleting all derived state changes nothing.
2. Inbox guarantee: every visible session appears in ≥1 presented project.
3. Stability: arbitrary base-plane improvements (id changes, store
   renames) never orphan user-plane entries that reference evidence.
4. Excludes beat matchers; includes beat nothing (they only add).
5. Determinism/order-independence, as everywhere else in the core.

# 010 — Project operations: archive, materialize, settings

Date: 2026-09-10
Status: implemented. All decisions below marked DECIDED came from Dylan.

## What a project can do

The settings surface for a project, and the operations behind it. The
guiding move (DECIDED): **auto and materialized are invisible to the
user.** The rail shows one list of projects; some happen to be derived,
and the user never has to learn what that means. A project's true status
(derived automatically / customized by you / created by you / archived)
lives in its settings panel as a detail, not in the layout.

## No delete (DECIDED)

Delete is too scary; archive is good enough. The UI has **zero
destructive actions**:

- **Archive** replaces delete as the removal gesture. Archived projects
  keep their record (matchers and all) and are recoverable.
- **Revert to auto** is the undo for a materialized project: dissolve
  the customization and let the derived layer re-derive it fresh.
  Nothing is destroyed because the user plane never owned anything but
  the mapping.
- Projects created from scratch have no auto counterpart; archive is
  their only exit.
- `hodor project delete` survives as a CLI-only escape hatch (it deletes
  the mapping record, never session data).

## Archive semantics (DECIDED)

Archiving a project hides its sessions **unless another live project
claims them**. Concretely: a session gets
`hiddenBy: "project-archived:<id>"` when it has at least one claim and
every project claiming it is archived. Revealable via `--all` and the
hidden view, with provenance, like every other hiding.

Archiving an *auto* project materializes it as archived — that is the
gesture for dismissing a noise lane: archive it once, its sessions
follow it into hidden.

## Materialization

Any edit that targets an auto project — rename, matcher change,
include/exclude, archive — silently creates a custom project first:

- matchers seeded from the auto project's identity at materialize time
  (`remote` if it has one, else `root`);
- `derivedFrom` records the auto project id, which is what makes
  "revert to auto" offerable;
- the API/CLI then applies the requested edit to the new record and
  reports the new id.

Seeding at materialize time means later improvements to auto-derivation
do **not** retroactively shift materialized projects — the two-plane
promise. A materialized project can therefore drift from what auto
would now derive; the settings panel is where that would surface if it
ever matters.

## Exclude matchers (new)

`excludeMatchers` on a custom project veto evidence matches the way
per-session excludes veto sessions. Precedence, strongest first:
session excludes → includes → exclude matchers → matchers. An explicit
pin beats a broad exclusion; an explicit per-session exclude beats
everything.

They exist chiefly to make **split** real: splitting root R out of
project P = new project with `root=R` matcher + `excludeMatchers:
[root=R]` on P. Future sessions under R land only in the carved-out
project. (Without this, split would rely on per-session excludes that
drift as new sessions appear.)

## Settings panel (DECIDED: yes)

Per project:

- **Status**: derived automatically / customized (was <auto name>) /
  created by you / archived.
- **Matchers** with per-placement provenance in the session list, add
  and remove, and **preview before save** (DECIDED): the server answers
  "which sessions would this matcher claim" from the same engine that
  computes placements, so the preview cannot lie.
- Includes / excludes / exclude-matchers, each removable.
- Rename. Archive/unarchive. Revert to auto (materialized only).
- **Merge** (DECIDED: lives in settings): merge B into A = union B's
  matchers, includes, excludes, exclude-matchers into A; B's record
  goes away. If B was materialized, its auto project may re-derive —
  and is immediately re-absorbed because A now claims the sessions.
  Self-consistent with no special cases.
- **Split** (DECIDED: lives in settings): carve a root out, per the
  exclude-matchers mechanics above.

## Also in this iteration

- **Header stats** (DECIDED): session count, active now, last
  activity, roots spanned.
- **Bulk session actions** (DECIDED): select rows → archive, add to a
  project, exclude from the current project.
- **Cosmetics deferred** (DECIDED): color/emoji, description, pinning,
  manual ordering — later.

## Rail composition

One "projects" list: non-archived custom projects, plus auto projects
that still have unclaimed visible sessions (the absorb rule from 008,
now the only rule — there is no separate AUTO section). Sorted by most
recent activity, then name. Archived projects live behind a footer
count, like hidden sessions.

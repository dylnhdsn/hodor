# hodor

A session manager: discovers Claude CLI sessions, extracts structured data
about them, and organizes them into projects. Data core first; UI (Electron +
React) later.

**Status**: milestone 1 — workspace scaffolded, testing pipeline proven on a
seed module. See [docs/brainstorm](docs/brainstorm/) for design notes and the
milestone plan.

## Layout

- `packages/core` — the data core: pure, heavily tested. Canonical schema
  types plus the Claude projects-dir munging rules (seed module).
- `packages/cli` — thin consumer of core; the inspection loop until real UI
  exists. `hodor bucket <cwd>` prints the `~/.claude/projects` bucket for a
  working directory.

## Development

Requires Node >= 22 and pnpm.

```sh
pnpm install
pnpm verify      # build + typecheck + test, in that order
pnpm test        # unit + property tests (Vitest + fast-check)
pnpm mutation    # mutation testing on @hodor/core (Stryker)
```

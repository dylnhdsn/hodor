# hodor

A session manager: discovers Claude CLI sessions, extracts structured data
about them, and organizes them into projects. Data core first; UI second;
Electron shell later.

**Status**: data core + two-plane mapping + web UI. Store discovery
(Windows ⇄ WSL both directions), tolerant transcript parsing, an
event-folding state model with incremental live tailing, git enrichment
(repos, worktrees, remotes, local-remote chasing — no git binary needed),
visibility rules with provenance, a user plane (custom projects with
evidence matchers), curation commands, and a live web UI served from the
single-file build: unified project rail, per-project settings with
matcher preview, and a session detail pane with subagent runs, fork
lineage, placement provenance, and the conversation tail. See
[docs/brainstorm](docs/brainstorm/) for design notes.

## Layout

- `packages/core` — the data core: pure pipeline from source events to a
  structured `Snapshot` (sessions, threads, projects, assignments, custom
  projects, placements). All I/O behind a `FileSystem` interface; tests run
  against an in-memory fake.
- `packages/cli` — commands, the local HTTP/SSE server, and the release
  bundle entrypoint.
- `packages/ui` — React + Tailwind web app; built with Vite and embedded
  into the release bundle.

## CLI

```sh
hodor ui              # start the local server and open the UI in a browser
hodor serve           # same server, no browser (default port 4477; --port N)
hodor scan            # discover + organize sessions, human-readable
hodor scan --all      # include hidden sessions
hodor scan --json     # the full structured snapshot
hodor watch           # scan, then live-update as transcripts change
hodor stats           # entrypoint + visibility histograms
hodor bucket <cwd>    # the ~/.claude/projects bucket name for a cwd
hodor update          # self-update to the newest published build
```

Stores default to `<home>/.claude` plus auto-discovered stores across the
Windows/WSL boundary; pass `--root <path>` to add or replace store roots
(`--no-discover` disables cross-boundary discovery).

### Curation

Sessions are grouped automatically (folder, worktree, repo remote); the
user plane lets you organize on top of that without ever fighting a rescan.
Commands accept auto project ids too — editing one silently materializes
it into a custom project seeded from its evidence:

```sh
hodor project list                          # custom projects + matchers
hodor project create "Extension v4"
hodor project match ext-v4 remote=github.com/acme/BrowserExtension
hodor project match ext-v4 root=/home/me/code/extension
hodor project include ext-v4 <sessionId>    # pin one session in
hodor project exclude ext-v4 <sessionId>    # force one session out
hodor project unpin ext-v4 <sessionId>      # drop a pin, matchers decide again
hodor project rename ext-v4 "Extension v5"
hodor project archive ext-v4                # hides its sessions too, reversibly
hodor project unarchive ext-v4
hodor project revert ext-v4                 # materialized only: back to auto
hodor project merge ext-v4 old-lane         # union old-lane into ext-v4
hodor project split ext-v4 /home/me/code/fork "The fork"
hodor project exclude-match ext-v4 root=/home/me/code/fork

hodor session rename <sessionId> "the migration spike"
hodor session archive <sessionId>           # hide (provenance: archived)
hodor session unarchive <sessionId>
```

Matcher kinds: `remote` (git remote URL), `root` (subtree under a repo
root), `cwd` (subtree of raw cwds), `dir` (exact folder), `session` (one
id). Archiving a project hides its sessions unless a live project claims
them (`hiddenBy: project-archived:<id>`, revealed by `--all`). Nothing in
the UI deletes; `hodor project delete` remains as a CLI-only escape hatch
that only ever removes the mapping record.

Everything lands in `~/.hodor` (`projects.json`, `config.json`) — on
Windows+WSL setups the Windows home is shared so both sides see one truth.
Matchers reference durable evidence, never derived ids, so your curation
survives any improvement to the automatic grouping.

## Install

Every push to the default branch publishes a rolling build to the
[`latest` release](https://github.com/dylnhdsn/hodor/releases/tag/latest).
Requires Node >= 22 on your PATH.

Linux / WSL / macOS:

```sh
curl -fsSL https://github.com/dylnhdsn/hodor/releases/download/latest/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/dylnhdsn/hodor/releases/download/latest/install.ps1 | iex
```

Both install to `~/.hodor/bin` (override with `HODOR_HOME`) and add it to
your PATH. After that, get the newest build any time with:

```sh
hodor update    # alias: hodor upgrade
```

`hodor update` updates the UI too — it's embedded in the same file.

## Development

Requires Node >= 22 and pnpm.

```sh
pnpm install
pnpm verify      # build + typecheck + test, in that order
pnpm test        # unit + property tests (Vitest + fast-check)
pnpm mutation    # mutation testing on @hodor/core (Stryker)
pnpm bundle      # single-file dist-release/hodor.mjs with embedded UI
```

UI dev loop with hot reload against your real data:

```sh
hodor serve                      # data + API on 4477
pnpm --filter @hodor/ui dev      # Vite on 5177, proxies /api to 4477
```

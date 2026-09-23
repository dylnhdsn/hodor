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
single-file build: a projects drawer with search, a per-project overlay
(every session as one table, bulk verbs, settings with matcher preview)
and a session detail page with subagent runs, fork lineage, placement
provenance, and the conversation tail. See
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
hodor resume <id>     # open a terminal resuming that session (--fork, --print)
hodor scan            # discover + organize sessions, human-readable
hodor scan --all      # include hidden sessions
hodor scan --json     # the full structured snapshot
hodor watch           # scan, then live-update as transcripts change
hodor stats           # entrypoints, subagent runs, token usage + est. cost
hodor cloud           # list this account's cloud sessions (claude.ai/code)
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

### Custom organizing logic

Bring your own rules, three ways, all feeding the same placement
channel (pins > organize > matchers > auto):

- **Rule matchers** in projects.json: new leaves `branch=` (glob),
  `title=` / `model=` (substring or /regex/i), `entrypoint=`, and
  `all`/`any`/`not` combinator trees.
- **`~/.hodor/organize.js`** — `export default (session, {glob}) =>
  ['label', …]`; picked up by presence, reloads on edit, errors show
  as a banner instead of breaking anything.
- **Any language** via `{ "organize": { "command": "python3 my.py" } }`
  in config.json: facts on stdin, `{"labels": {id: [..]}}` on stdout.

Labels become custom projects automatically (created on first sight).
`hodor organize` dry-runs your logic; `--explain <id>` shows exactly
what your function sees for one session.

### Usage & cost

Token usage (input, output, cache reads, cache writes by TTL) is read
off every session and every subagent run, deduplicated per API message,
and priced per model at first-party API list rates — an estimate of
API-equivalent spend, not an invoice. Unknown models are counted but
flagged unpriced rather than silently costing $0; add or correct rates
via `pricing` in `~/.hodor/config.json` (USD per million tokens):

```jsonc
{ "pricing": { "claude-sonnet-4-5": { "input": 3, "output": 15 } } }
```

## Install

Three release channels, each its own GitHub release:

| channel | release | built from |
| --- | --- | --- |
| `nightly` | [`latest`](https://github.com/dylnhdsn/hodor/releases/tag/latest) | every push to the default branch |
| `stable` | [`stable`](https://github.com/dylnhdsn/hodor/releases/tag/stable) | by hand: Actions → build → Run workflow → pick the ref, channel `stable` |
| `experimental` | [`experimental`](https://github.com/dylnhdsn/hodor/releases/tag/experimental) | every push to an `exp/*` branch |

The channel is baked into each build. Desktop builds are separate
products per channel (`hodor`, `hodor stable`, `hodor experimental`) with
their own install and data directories and their own update feed, so two
can run side by side; to change channel, install the other one. The CLI
remembers the channel it was installed from and `hodor update` follows it
(`hodor update --channel stable` moves it). Swap `latest` for `stable` or
`experimental` in any URL below. Requires Node >= 22 on your PATH.
On Windows each channel installs into its own folder
(`%LOCALAPPDATA%\Programs\hodor-desktop`, `…-stable`, `…-experimental`);
experimental installers published before build 94 shared the nightly
folder — uninstall both and reinstall if you ran one of those.

Linux / WSL / macOS:

```sh
curl -fsSL https://github.com/dylnhdsn/hodor/releases/download/latest/install.sh | sh
# a channel: HODOR_CHANNEL=stable sh -c "$(curl -fsSL https://github.com/dylnhdsn/hodor/releases/download/stable/install.sh)"
```

Windows PowerShell:

```powershell
irm https://github.com/dylnhdsn/hodor/releases/download/latest/install.ps1 | iex
# a channel: $env:HODOR_CHANNEL="stable"; irm https://github.com/dylnhdsn/hodor/releases/download/stable/install.ps1 | iex
```

The desktop app auto-updates itself from the same release (Windows/Linux; unsigned macOS shows a notice linking the fresh dmg). Both CLI installers install to `~/.hodor/bin` (override with `HODOR_HOME`) and add it to
your PATH. After that, get the newest build any time with:

```sh
hodor update                     # alias: hodor upgrade — stays on its channel
hodor update --channel stable    # move to another channel
```

`hodor update` updates the UI too — it's embedded in the same file.

### Desktop app

The same UI as a desktop app with EMBEDDED terminals: resume, fork, and
new-session open real `claude` PTYs on the desk — named zones of tabs,
drag-to-split layouts, pop-out windows — routed into the right place (a
WSL store's session opens inside its distro even from the Windows app).
Workspaces are tabs in the title bar, each with its own desk, turn stack
and skips; the status bar says where you are (workspace · zone, the
focused tile's directory, branch, model and context left) and what the
desk is doing (waiting, running, spent today, hooks, server). The
projects drawer (☰, or pinned) lists every project with its counts; a
project's overlay is its library. A zone or a whole workspace can pop
out to its own window (right-click it) and come back. The arrangement persists across
restarts: reopening the app rebuilds your layout, and each dead tile
offers to `claude --resume` its session right back into place. The
experimental channel carries the v3 shell (docs/brainstorm/030). Unsigned builds on the same rolling release
(expect a SmartScreen/Gatekeeper warning):

- [Windows installer](https://github.com/dylnhdsn/hodor/releases/download/latest/hodor-desktop-win-x64.exe)
- [Linux AppImage](https://github.com/dylnhdsn/hodor/releases/download/latest/hodor-desktop-linux-x86_64.AppImage)
- [macOS (Apple silicon) dmg](https://github.com/dylnhdsn/hodor/releases/download/latest/hodor-desktop-mac-arm64.dmg)

### Sessions that outlive hodor

Settings › behavior → *keep sessions running when hodor closes*: on quit each
claude tile is sent to the CLI's supervisor with `/background` instead
of being killed, and restoring the tile later runs `claude attach`.
A tab's menu has *detach (keep running)* for one session at a time.
Verified on Linux and WSL; Windows-native claude untested.

### Appearance

Every color derives from a terminal colorscheme. Settings ships a curated
list plus a catalog of 600+ schemes packed from
[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)
(MIT, © Mark Badolato; each theme stays its author's) — search by name,
filter dark/light, a page at a time, click to adopt. Regenerate the catalog with
`node scripts/import-schemes.mjs`. Pasting any Windows Terminal, iTerm2,
Alacritty, kitty or Ghostty scheme file works too.

Terminal fonts: four ship with hodor, forty more are fetched from
[Fontsource](https://fontsource.org) (jsDelivr) the first time you pick
them, and any installed family can be typed in. A symbols-only
[Nerd Font](https://github.com/ryanoasis/nerd-fonts) (MIT) sits behind
whichever face is active, so statusline and powerline glyphs render in
every font without patched variants.

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

# 009 — UI on-ramp: local server, SSE, embedded React app

Date: 2026-09-10
Status: implemented (cli/server.ts, packages/ui, bundle embedding).
Decisions below marked DECIDED came from Dylan during the pre-work
discussion ("easy way into the ui with easy updating and live reload").

## Shape

One binary, one door. `hodor serve` starts a localhost HTTP server from
the same bundle that does everything else; `hodor ui` is `serve` plus
opening the browser. No second install, no separate release artifact —
pushing to GitHub still produces exactly one `hodor.mjs`, and
`hodor update` updates the UI along with everything else.

- **DECIDED: browser-first.** Electron is deferred until the PTY
  milestone actually needs a shell (embedding terminals). Until then a
  browser tab pointed at localhost gets us the entire management UI with
  zero packaging cost per platform.
- **DECIDED: fixed default port 4477, `--port` to override.** A stable
  port means bookmarkable, muscle-memory URL; `--port 0` picks a free one
  (tests use this).
- **DECIDED: no extra v1 scope.** First draft ships list + rail + search
  + the curation mutations; iteration happens after Dylan sees it.

## Server (packages/cli/src/server.ts)

`startServer(deps, { port, intervalMs })` — the same `CliDeps` injection
as every other command, so the whole server is testable against `MemFs`.

- Binds `127.0.0.1` only. This is a local tool; nothing listens on
  0.0.0.0.
- **State model mirrors the two planes.** A `baseState` folds only
  source events (stores, transcripts, git). Each refresh overlays
  freshly-loaded user files (config.json + projects.json) on top:
  `state = fold(baseState, configEvents(userFiles))`. Editing
  projects.json by hand or via another hodor process is picked up on the
  next tick — the server never holds a stale user plane.
- Routes:
  - `GET /api/snapshot` — the full `Snapshot` (sessions, projects,
    assignments, customProjects, placements), same selector the CLI
    formatter uses.
  - `GET /api/events` — SSE. Sends the current snapshot on connect, then
    pushes a new frame only when the serialized snapshot changes.
    Reconnect is the browser's native EventSource behavior.
  - `POST /api/project`, `POST /api/session` — curation mutations. The
    request body is a `PlaneOp`/`SessionOp`, the exact same pure edit
    ops the `hodor project`/`hodor session` commands use
    (userplane-edit.ts). Apply → persist via `fs.writeFile` (atomic
    tmp+rename) → refresh → 200 with the result, or 400 with
    `{ error }`. One code path for CLI and UI edits, by construction.
- Polling interval 2s by default (`intervalMs`); `tick()` is exposed for
  tests so they never sleep.

## Embedded assets

`packages/cli/src/ui-assets.ts` is a stub (`uiAssets = {}`) in dev. At
bundle time, `scripts/bundle.mjs` walks `packages/ui/dist` and replaces
the module with base64-encoded files + MIME types via an esbuild plugin.
The server serves those; with no embedded UI (dev, or ui build skipped)
it serves a fallback page that points at `/api/snapshot`, and warns in
the bundle log.

## UI (packages/ui)

React 19 + Vite 6 + Tailwind 4, dark zinc theme. TypeScript throughout;
imports `Snapshot`/`Session` types from `@hodor/core` so the wire format
is compiler-checked against the server.

- `useSnapshot()` — fetch `/api/snapshot` for first paint, then
  EventSource for live frames. Connection dot in the header.
- `deriveView()` (data.ts) — client-side mirror of the formatter's
  presentation policy: visible/hidden split, placements → label chips,
  and the absorb rule (auto projects list only unclaimed sessions, and
  drop out of the rail entirely when fully claimed).
- Rail: All sessions / custom projects (+ create) / auto projects /
  hidden-count footer that flips into the hidden list with `hiddenBy`
  provenance badges.
- Row actions (hover): add-to-project select (include matcher), rename,
  archive/unarchive — all through `postMutation`, all landing in
  projects.json/config.json with provenance identical to the CLI
  commands.

## Dev loop (live reload)

Two processes, both cheap:

```sh
hodor serve                      # real data, port 4477
pnpm --filter @hodor/ui dev      # Vite on 5177, HMR
```

vite.config.ts proxies `/api` → `127.0.0.1:4477`, so the dev UI runs
against live data with hot module reload; the embedded copy is what
ships. No mock data layer to drift.

## Testing

server.test.ts drives the real HTTP server over `fetch` against MemFs:
snapshot API, mutation → persisted file → reflected snapshot, structured
400s, SSE push on change, fallback page. The UI package is type-checked
in `pnpm verify`; component/e2e testing waits for Playwright against
`hodor serve` (planned milestone).

## Later

- Electron shell at the PTY milestone (reuse this server verbatim;
  Electron is just a chrome around `http://127.0.0.1:4477`).
- Session detail pane (transcript preview, matcher explain view).
- Hide-rule editing in the UI (config.json is already round-tripped).
- Playwright e2e: boot `hodor serve --port 0` on a fixture store, drive
  the embedded UI.

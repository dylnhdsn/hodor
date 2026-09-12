# 018 — Desktop app: embedded terminals & window management

Date: 2026-09-12
Status: implemented. The Electron + PTY milestone.

## Why Electron

An embedded terminal needs a real PTY, and node-pty is a native module —
it can't ride in the single-file hodor.mjs. So the terminal host is a
desktop app; the browser UI keeps its external-terminal launch behavior
unchanged.

## Shape

The app is a thin shell around what already exists:

- **Main process** runs the SAME `startServer` the CLI uses (port 0,
  loopback), with the UI embedded exactly like hodor.mjs embeds it. The
  window just loads that URL — the renderer IS the web UI.
- **PTYs live in the main process**, not in any window. Each keeps a
  bounded 512KB backlog, so a terminal can move between views (dock tab
  ⇄ pop-out window) with scrollback replayed, tmux-style. Windows are
  views; closing one never kills the session.
- **A preload bridge** (`window.hodorDesktop`) is the only new surface:
  open/attach/write/resize/close/list/popOut + data/event streams. The
  UI detects it and grows a terminal dock; absent the bridge, nothing
  changes.

Launch routing reuses the 016 matrix as `composePtySpec`: on Windows, a
native store runs `cmd /c claude …` and a WSL store runs
`wsl.exe -d <distro> --cd <cwd> -e bash -lic …` — so the Windows app
opens terminals INTO the right distro. Posix hosts spawn `$SHELL -lic`
(a GUI app has no shell PATH). Combinations with no PTY route (e.g. a
Windows store from a mac) return null and the UI falls back to the
external-terminal path. The server composes specs via
`POST /api/launch {mode:"pty"}`; the renderer never dictates argv.

## Window management (v1)

- Terminal dock in the main window: tabs, drag-to-resize height, per-tab
  kill/close and pop-out.
- Pop-out: a dedicated window per terminal (`#pty=<id>` route renders
  just that terminal). Closing it returns the terminal to the dock.
- Main-window bounds persist in `~/.hodor/desktop.json`.

## Build & distribution

`packages/desktop` is deliberately OUTSIDE the pnpm workspace and
npm-managed: electron-builder wants a flat node_modules and rebuilds
node-pty against Electron's ABI. esbuild bundles main+preload from the
workspace TS sources (scripts/bundle-desktop.mjs, sharing the UI-embed
plugin with bundle.mjs); electron-builder packs them with node-pty
asar-unpacked.

CI builds three unsigned targets on a matrix and attaches them to the
same rolling `latest` release:

- `hodor-desktop-win-x64.exe` (NSIS one-click)
- `hodor-desktop-linux-x86_64.AppImage`
- `hodor-desktop-mac-arm64.dmg`

Unsigned means Windows SmartScreen / macOS Gatekeeper will warn on
first run (More info → Run anyway; on mac right-click → Open).

## Verified in-container (headless, Playwright + Xvfb)

Against the packaged Linux build: app boots, embedded server serves
real snapshots, bridge present, `openTerminal` spawns a PTY whose
output renders in the dock's xterm (a real `claude` TUI came up), and a
pop-out window replays the same PTY's backlog. Windows/mac builds are
CI-only; first live test is on real machines.

## Later

- Auto-update for the desktop app (the CLI's `hodor update` doesn't
  cover it).
- Keyboard shortcuts (next/prev terminal, quick-open).
- Session detail “open here” splits; multiple manager windows.
- App icon; signing if it ever matters.

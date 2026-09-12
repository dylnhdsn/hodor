# 020 — Desktop auto-update

Date: 2026-09-12
Status: implemented; full cycle verified end-to-end in-container.

The CLI has `hodor update`; the desktop app now updates itself off the
same rolling release.

## Shape

electron-updater with a GENERIC feed — the release tag `latest` isn't
semver, so the GitHub provider can't parse it; instead clients read
`latest.yml` / `latest-linux.yml` published next to the installers at
the fixed download URL. electron-builder generates the yml (sha512,
size, artifact name) because the publish config now declares that URL;
CI uploads installer + blockmaps first, yml LAST, so a mid-upload
client sees a stale feed rather than a feed pointing at a missing
binary. Any mismatch heals on the next check (30 min cadence, first
check 15s after launch).

Versioning: the updater compares semver, and the old stamping
flattened everything to 0.0.1 — no update would ever fire. The desktop
package now stamps 0.0.<CI run number>; the full build string stays in
__HODOR_VERSION__ for display.

## Per-platform reality

- **Windows (NSIS) and Linux (AppImage)**: true auto-update. Download
  in the background; a quiet "↻ restart to update" pill appears in the
  sidebar footer; clicking installs and relaunches. Quitting normally
  also installs (autoInstallOnAppQuit). AppImage updates need the app
  to run AS an AppImage (APPIMAGE env — normal usage).
- **macOS unsigned**: Squirrel refuses unsigned installs, so darwin
  never runs the updater. It compares build numbers against the
  release's version.json and shows "update available ↗" linking the
  dmg.

## Verified (Playwright + Xvfb, local http feed)

Built 0.0.98, pointed its app-update.yml at a local server hosting the
0.0.99 AppImage + latest-linux.yml: detected, downloaded and
sha512-verified in ~20s, pill rendered, click quit-and-replaced the
AppImage byte-for-byte with the new build.

## Notes

- Updater errors are deliberately quiet (rolling-release races).
- update:state IPC lets a late-mounting renderer catch up.
- Dev checkouts (unpackaged) never run the updater.

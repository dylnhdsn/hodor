# 006 — Distribution: rolling builds, installers, self-update

Date: 2026-09-10

## Shape

- **One artifact for every platform**: `hodor.mjs`, a single-file ESM bundle
  (esbuild, `scripts/bundle.mjs`) that runs on any Node >= 22. No per-OS
  binaries yet; Node is a given on the machines that have Claude sessions.
  The build version is stamped in via esbuild define
  (`0.0.1-build.<run>.<sha>`), so `hodor --version` identifies exact builds.
- **Rolling release**: `.github/workflows/build.yml` runs verify + bundle on
  every push; pushes to the default branch upload `hodor.mjs`,
  `version.json`, and both install scripts to the GitHub release tagged
  `latest` (`--clobber`, prerelease). A separate non-blocking-ish job runs
  mutation testing.
- **Install**: `install.sh` (Linux/WSL/macOS) and `install.ps1` (PowerShell)
  download the bundle to `~/.hodor/bin` (or `HODOR_HOME`), write a launcher
  (`hodor` shell script / `hodor.cmd` shim), and add the dir to PATH
  (rc-file append with marker on unix, user PATH env var on Windows).
- **Self-update**: `hodor update` (alias `upgrade`) fetches the `latest`
  release metadata, compares `version.json` against the embedded version,
  downloads the new bundle, and atomically renames it over itself
  (write `.new` + rename; safe on Windows since Node doesn't lock the
  script file it's running). Refuses to run from a dev checkout.
  Auth: unauthenticated first (repo is public); `HODOR_GITHUB_TOKEN` /
  `GITHUB_TOKEN` / `gh auth token` are picked up automatically so nothing
  breaks if the repo ever goes private (API asset URLs + Bearer token).

## Structure notes

- `packages/cli/src/bin.ts` is now the real entrypoint (deps wiring,
  token resolution, self-path detection); `bin/hodor.js` is a thin dev
  launcher; the bundle is built straight from `src/bin.ts`.
- Update logic (`update.ts`) is pure over an injected `UpdateIO`, unit
  tested for: dev-checkout refusal, fetch failures, missing assets,
  up-to-date no-op, replace flow, and token vs anonymous URL selection.
- The `latest` git tag does not track the default branch tip (gh release
  assets are replaced in place); `version.json` is the source of truth.

## Known trade-offs / later

- Node >= 22 prerequisite. If that ever chafes, switch CI to also emit
  self-contained binaries (bun build --compile) per platform — the release
  layout and update flow already accommodate more assets.
- Rolling only; no versioned releases yet. When the schema stabilizes,
  add tagged semver releases alongside `latest`.
- `hodor update` trusts the release assets (no signature verification).

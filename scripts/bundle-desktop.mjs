// Bundle the Electron main + preload into packages/desktop/dist/.
// Run from the repo root AFTER building the UI (pnpm --filter @hodor/ui build):
//   node scripts/bundle-desktop.mjs
// electron and node-pty stay external: electron is the runtime itself, and
// node-pty is a native module electron-builder packs (asar-unpacked) and
// rebuilds against the Electron ABI.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { collectUiAssets, embedUiAssetsPlugin } from './embed-ui.mjs'

const pkg = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
)
const version = process.env.HODOR_BUILD_VERSION ?? `${pkg.version}-dev`

// One PRODUCT per channel, so stable and experimental install side by
// side: their own appId (Windows uninstall key, notification identity),
// install directory and user-data directory (both follow productName),
// and their own update feed (electron-builder writes app-update.yml
// from build.publish). nightly keeps the original identity and the
// 'latest' tag — every install shipped before channels existed IS a
// nightly and must keep updating without noticing.
const IDENTITY = {
  nightly: { appId: 'dev.dylnhdsn.hodor', productName: 'hodor', tag: 'latest' },
  stable: { appId: 'dev.dylnhdsn.hodor.stable', productName: 'hodor stable', tag: 'stable' },
  experimental: {
    appId: 'dev.dylnhdsn.hodor.experimental',
    productName: 'hodor experimental',
    tag: 'experimental',
  },
}
const channel = process.env.HODOR_CHANNEL ?? 'nightly'
const identity = IDENTITY[channel]
if (identity === undefined) {
  throw new Error(`HODOR_CHANNEL must be stable, nightly or experimental (got "${channel}")`)
}

const assets = collectUiAssets()

await build({
  entryPoints: ['packages/desktop/src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'packages/desktop/dist/main.cjs',
  external: ['electron', 'node-pty', 'electron-updater'],
  define: {
    __HODOR_VERSION__: JSON.stringify(version),
    __HODOR_CHANNEL__: JSON.stringify(channel),
    __HODOR_APP_ID__: JSON.stringify(identity.appId),
  },
  plugins: [embedUiAssetsPlugin(assets)],
  logLevel: 'info',
})

await build({
  entryPoints: ['packages/desktop/src/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'packages/desktop/dist/preload.cjs',
  external: ['electron'],
  logLevel: 'info',
})

// The window icon rides next to main.cjs (BrowserWindow { icon } on
// win/linux); electron-builder picks the same art up from build/ for the
// exe, dock and installers. The splash paints before the server exists,
// so it ships as a plain file too.
copyFileSync(
  new URL('../packages/desktop/build/icon.png', import.meta.url),
  new URL('../packages/desktop/dist/icon.png', import.meta.url),
)
copyFileSync(
  new URL('../packages/desktop/src/splash.html', import.meta.url),
  new URL('../packages/desktop/dist/splash.html', import.meta.url),
)

// Stamp an INCREASING semver from the CI run number: the auto-updater
// compares versions, so a fixed version would mean no update ever fires.
// MAJOR.MINOR come from the cli package (the project's base version) and
// the PATCH is the run number — plain release semver, no prerelease tags,
// so every install ever shipped (0.0.<run> included) sees each new build
// as greater. Monotonic as long as the base minor only ever goes up.
const desktopPkgPath = new URL('../packages/desktop/package.json', import.meta.url)
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'))
const run = /-build\.(\d+)\./.exec(version)?.[1]
const [major = '0', minor = '0'] = version.split('-')[0].split('.')
desktopPkg.version = run !== undefined ? `${major}.${minor}.${run}` : '0.0.0'
desktopPkg.build.appId = identity.appId
desktopPkg.build.productName = identity.productName
desktopPkg.build.publish.url = `https://github.com/dylnhdsn/hodor/releases/download/${identity.tag}`
writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n')

// Keep the lockfile's own version fields in step, so CI can `npm ci`
// (it refuses a root-version mismatch): dependency versions then come
// from the LOCKFILE on every release build — two builds of the same
// commit ship the same electron/electron-builder/node-pty instead of
// whatever the registry resolved that hour.
const lockPath = new URL('../packages/desktop/package-lock.json', import.meta.url)
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
lock.version = desktopPkg.version
if (lock.packages?.[''] !== undefined) lock.packages[''].version = desktopPkg.version
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')

console.log(`bundled hodor desktop ${version} (${channel}: ${identity.productName})`)

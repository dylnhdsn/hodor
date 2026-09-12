// Bundle the Electron main + preload into packages/desktop/dist/.
// Run from the repo root AFTER building the UI (pnpm --filter @hodor/ui build):
//   node scripts/bundle-desktop.mjs
// electron and node-pty stay external: electron is the runtime itself, and
// node-pty is a native module electron-builder packs (asar-unpacked) and
// rebuilds against the Electron ABI.
import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { collectUiAssets, embedUiAssetsPlugin } from './embed-ui.mjs'

const pkg = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
)
const version = process.env.HODOR_BUILD_VERSION ?? `${pkg.version}-dev`

const assets = collectUiAssets()

await build({
  entryPoints: ['packages/desktop/src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'packages/desktop/dist/main.cjs',
  external: ['electron', 'node-pty', 'electron-updater'],
  define: { __HODOR_VERSION__: JSON.stringify(version) },
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

// Stamp an INCREASING semver from the CI run number: the auto-updater
// compares versions, so 0.0.1 forever would mean no update ever fires.
// 0.0.<run> per rolling build; dev checkouts stay at 0.0.0.
const desktopPkgPath = new URL('../packages/desktop/package.json', import.meta.url)
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'))
const run = /-build\.(\d+)\./.exec(version)?.[1]
desktopPkg.version = run !== undefined ? `0.0.${run}` : '0.0.0'
writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n')

console.log(`bundled hodor desktop ${version}`)

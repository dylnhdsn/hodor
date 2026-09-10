// Bundle the CLI into a single distributable file: dist-release/hodor.mjs.
// Run from the repo root: node scripts/bundle.mjs
// HODOR_BUILD_VERSION stamps the build (CI sets it); dev builds get "-dev".
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
)
const version = process.env.HODOR_BUILD_VERSION ?? `${pkg.version}-dev`

mkdirSync('dist-release', { recursive: true })

await build({
  entryPoints: ['packages/cli/src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-release/hodor.mjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { __HODOR_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
})

chmodSync('dist-release/hodor.mjs', 0o755)
writeFileSync('dist-release/version.json', JSON.stringify({ version }) + '\n')
console.log(`bundled hodor ${version}`)

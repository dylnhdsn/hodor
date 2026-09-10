// Bundle the CLI into a single distributable file: dist-release/hodor.mjs.
// Run from the repo root: node scripts/bundle.mjs
// HODOR_BUILD_VERSION stamps the build (CI sets it); dev builds get "-dev".
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
)
const version = process.env.HODOR_BUILD_VERSION ?? `${pkg.version}-dev`

mkdirSync('dist-release', { recursive: true })

// Collect the built UI (packages/ui/dist) to embed into the bundle so the
// single-file artifact serves the whole app.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}
function collectAssets(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectAssets(full, base, out)
    else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      out['/' + relative(base, full).replaceAll('\\', '/')] = {
        base64: readFileSync(full).toString('base64'),
        type: MIME[ext] ?? 'application/octet-stream',
      }
    }
  }
  return out
}

const uiDist = fileURLToPath(new URL('../packages/ui/dist', import.meta.url))
const assets = existsSync(uiDist) ? collectAssets(uiDist) : {}
if (Object.keys(assets).length === 0) {
  console.warn('warning: packages/ui/dist is missing — bundling without an embedded UI')
}

const embedUiAssets = {
  name: 'embed-ui-assets',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/ui-assets\.js$/ }, () => ({
      path: 'ui-assets',
      namespace: 'hodor-ui',
    }))
    builder.onLoad({ filter: /.*/, namespace: 'hodor-ui' }, () => ({
      contents: `export const uiAssets = ${JSON.stringify(assets)}`,
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: ['packages/cli/src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-release/hodor.mjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { __HODOR_VERSION__: JSON.stringify(version) },
  plugins: [embedUiAssets],
  logLevel: 'info',
})

chmodSync('dist-release/hodor.mjs', 0o755)
writeFileSync('dist-release/version.json', JSON.stringify({ version }) + '\n')
console.log(`bundled hodor ${version}`)

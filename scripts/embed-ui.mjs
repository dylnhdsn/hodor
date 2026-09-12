// Shared by bundle.mjs (the CLI single-file build) and bundle-desktop.mjs
// (the Electron main build): collect the built UI and replace the
// ./ui-assets.js stub so the server serves the whole app from memory.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export function collectUiAssets() {
  const uiDist = fileURLToPath(new URL('../packages/ui/dist', import.meta.url))
  const assets = existsSync(uiDist) ? collectAssets(uiDist) : {}
  if (Object.keys(assets).length === 0) {
    console.warn('warning: packages/ui/dist is missing — bundling without an embedded UI')
  }
  return assets
}

export function embedUiAssetsPlugin(assets) {
  return {
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
}

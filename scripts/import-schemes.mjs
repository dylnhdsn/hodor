// Regenerate the bundled scheme catalog from mbadolato/iTerm2-Color-Schemes
// (MIT). Reads the collection's ghostty/ directory — one line-based theme
// per file, named after the scheme — through the same parser the paste
// box uses, and writes packages/ui/src/assets/schemes-catalog.json.
//
//   node scripts/import-schemes.mjs [path/to/iTerm2-Color-Schemes]
//
// Without a path it makes a sparse, blobless clone into a temp dir.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packScheme, parseColorscheme } from '../packages/core/dist/colorscheme.js'

const REPO = 'https://github.com/mbadolato/iTerm2-Color-Schemes.git'
const out = fileURLToPath(new URL('../packages/ui/src/assets/schemes-catalog.json', import.meta.url))

let root = process.argv[2]
if (root === undefined) {
  root = mkdtempSync(join(tmpdir(), 'hodor-schemes-'))
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', REPO, root], { stdio: 'inherit' })
  execFileSync('git', ['sparse-checkout', 'set', 'ghostty'], { cwd: root, stdio: 'inherit' })
}
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim()
const dir = join(root, 'ghostty')

const seen = new Set()
const schemes = []
const skipped = []
for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en'))) {
  const scheme = parseColorscheme(readFileSync(join(dir, name), 'utf8'))
  if (scheme === null) {
    skipped.push(name)
    continue
  }
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  for (let n = 2; seen.has(id); n++) id = `${id}-${n}`
  seen.add(id)
  schemes.push({ id, name, colors: packScheme(scheme) })
}

const doc = {
  source: 'https://github.com/mbadolato/iTerm2-Color-Schemes',
  commit,
  license: 'MIT — Copyright (c) 2011 to Present Mark Badolato; each theme stays its author\'s',
  schemes,
}
writeFileSync(out, JSON.stringify(doc) + '\n')
console.log(`wrote ${schemes.length} schemes (${skipped.length} skipped) from ${commit} to ${out}`)
if (skipped.length > 0) console.log('skipped:', skipped.join(', '))

/**
 * Real-world entrypoint: wires node APIs into the injectable CLI. This file
 * is both what bin/hodor.js loads in a dev checkout (via dist/) and the
 * entry scripts/bundle.mjs bundles into the distributable hodor.mjs.
 */
import { spawnSync } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { run } from './main.js'
import { baseNodeDeps } from './node-deps.js'
import { runUpdate } from './update.js'
import { cliVersion } from './version.js'

function resolveToken(): string | undefined {
  const env = process.env['HODOR_GITHUB_TOKEN'] ?? process.env['GITHUB_TOKEN']
  if (env !== undefined && env.length > 0) return env
  try {
    const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
    const token = gh.status === 0 ? gh.stdout.trim() : ''
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

// Only the installed single-file bundle may self-update.
const selfFile = fileURLToPath(import.meta.url)
const selfPath = selfFile.endsWith('hodor.mjs') ? selfFile : undefined

const write = (text: string): void => {
  process.stdout.write(text)
}

// Set exitCode rather than calling process.exit(): stdout writes to a pipe
// are async, and exit() would truncate large output (e.g. scan --json | jq).
process.exitCode = await run(process.argv.slice(2), {
  ...baseNodeDeps(),
  write,
  writeErr: (text) => {
    process.stderr.write(text)
  },
  selfUpdate: () => {
    const token = resolveToken()
    return runUpdate({
      currentVersion: cliVersion(),
      ...(selfPath !== undefined ? { selfPath } : {}),
      ...(token !== undefined ? { token } : {}),
      http: async (url, headers) => {
        const res = await fetch(url, { headers })
        return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
      },
      replaceSelf: async (bytes) => {
        if (selfPath === undefined) throw new Error('no installed bundle to replace')
        const staging = `${selfPath}.new`
        await writeFile(staging, bytes, { mode: 0o755 })
        await rename(staging, selfPath)
      },
      write,
    })
  },
})

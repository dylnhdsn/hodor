import { createRequire } from 'node:module'
import { mungeCwd } from '@hodor/core'

export interface RunResult {
  exitCode: number
  output: string
}

const USAGE = `hodor — session manager (data core, early days)

Usage:
  hodor --version          Print the CLI version
  hodor bucket <cwd>       Print the ~/.claude/projects bucket name for a cwd
  hodor scan               (not implemented yet)
`.trim()

function version(): string {
  const require = createRequire(import.meta.url)
  const pkg = require('../package.json') as { version: string }
  return pkg.version
}

export function run(argv: string[]): RunResult {
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { exitCode: 0, output: USAGE }

    case '--version':
    case '-v':
      return { exitCode: 0, output: version() }

    case 'bucket': {
      const cwd = rest[0]
      if (cwd === undefined) {
        return { exitCode: 1, output: 'bucket: missing <cwd> argument' }
      }
      const munged = mungeCwd(cwd)
      return munged.kind === 'exact'
        ? { exitCode: 0, output: munged.dirName }
        : { exitCode: 0, output: `${munged.dirNamePrefix}-* (truncated; suffix is a CLI-internal hash)` }
    }

    case 'scan':
      return { exitCode: 1, output: 'scan: not implemented yet' }

    default:
      return { exitCode: 1, output: `unknown command: ${command}\n\n${USAGE}` }
  }
}

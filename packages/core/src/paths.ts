import { posix, win32 } from 'node:path'

/**
 * Path arithmetic (no I/O). node:path's posix/win32 implementations are pure
 * string manipulation, so they are safe inside the otherwise-pure core.
 */

export type PathFlavor = 'posix' | 'win32'

export function pathOps(flavor: PathFlavor): typeof posix | typeof win32 {
  return flavor === 'posix' ? posix : win32
}

/**
 * Guess how a path string itself is shaped (for joining onto it). Distinct
 * from SessionStore.pathFlavor, which describes the cwd strings *inside* a
 * store: a WSL store read from Windows has a win32-shaped rootPath
 * (\\wsl$\...) but posix cwds in its transcripts.
 */
export function flavorOfPath(path: string): PathFlavor {
  if (path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) {
    return 'win32'
  }
  return 'posix'
}

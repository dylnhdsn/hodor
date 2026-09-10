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
/**
 * Translate a posix path from inside a WSL store to the UNC path Windows
 * uses to reach that distro's filesystem: /home/d/x → \\wsl$\Ubuntu\home\d\x.
 * Identity stays posix everywhere; this is only for filesystem *access*.
 */
export function wslUncTranslator(distro: string): (path: string) => string {
  return (path) => `\\\\wsl$\\${distro}` + path.replace(/\//g, '\\')
}

/**
 * Translate a win32 path from inside a Windows store to the mount path WSL
 * uses to reach that drive: C:\Users\d\x → /mnt/c/Users/d/x. Non-drive
 * paths pass through untouched.
 */
export function driveMountTranslator(mountRoot: string): (path: string) => string {
  return (path) => {
    const m = path.match(/^([A-Za-z]):[\\/](.*)$/)
    if (m === null) return path
    return `${mountRoot}/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`
  }
}

/** Segment-aligned "is path at or under root", separator-agnostic. */
export function isUnder(path: string, root: string): boolean {
  const ps = path.split(/[\\/]+/).filter((s) => s.length > 0)
  const rs = root.split(/[\\/]+/).filter((s) => s.length > 0)
  return rs.length > 0 && rs.length <= ps.length && rs.every((seg, i) => seg === ps[i])
}

export function flavorOfPath(path: string): PathFlavor {
  if (path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) {
    return 'win32'
  }
  return 'posix'
}

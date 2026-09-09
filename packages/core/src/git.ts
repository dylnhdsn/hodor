import type { FileSystem } from './fs.js'
import { pathOps, type PathFlavor } from './paths.js'

/**
 * Git facts about a working directory, derived by reading `.git` directly —
 * no git binary needed, so it works identically over the in-memory fake and
 * across OS/WSL boundaries.
 */
export interface GitContext {
  /** Innermost directory at/above cwd containing a `.git` entry. */
  repoRoot: string
  isWorktree: boolean
  /** For worktrees: the primary repository's root. */
  mainRepoRoot?: string
  /** origin's URL, else the first configured remote's. */
  remoteUrl?: string
}

/** Minimal git config parse: remote name → url. */
export function parseGitRemotes(config: string): Record<string, string> {
  const remotes: Record<string, string> = {}
  let current: string | undefined
  for (const rawLine of config.split('\n')) {
    const line = rawLine.trim()
    const section = line.match(/^\[remote\s+"(.+)"\]$/)
    if (section) {
      current = section[1]
      continue
    }
    if (line.startsWith('[')) {
      current = undefined
      continue
    }
    if (current !== undefined && !(current in remotes)) {
      const kv = line.match(/^url\s*=\s*(.+)$/)
      if (kv?.[1] !== undefined) remotes[current] = kv[1].trim()
    }
  }
  return remotes
}

export function pickRemoteUrl(remotes: Record<string, string>): string | undefined {
  return remotes['origin'] ?? Object.values(remotes)[0]
}

async function remoteFromConfig(fs: FileSystem, configPath: string): Promise<string | undefined> {
  const config = await fs.readFile(configPath)
  if (config === undefined) return undefined
  return pickRemoteUrl(parseGitRemotes(config))
}

/**
 * Resolve the git context for a cwd by walking up to the nearest `.git`.
 *
 * - `.git` directory → normal repository.
 * - `.git` file with a `gitdir:` pointer and a `commondir` file inside the
 *   pointed-to directory → linked worktree; the primary repo's config is
 *   read through commondir, so worktrees carry the same remote URL.
 * - `.git` file without `commondir` (e.g. submodule) → treated as a normal
 *   repository rooted here.
 *
 * Returns null when no `.git` is found up to the filesystem root.
 */
export async function resolveGitContext(
  fs: FileSystem,
  flavor: PathFlavor,
  cwd: string,
): Promise<GitContext | null> {
  const p = pathOps(flavor)
  let dir = p.normalize(cwd)
  for (;;) {
    const gitPath = p.join(dir, '.git')
    const st = await fs.stat(gitPath)

    if (st?.kind === 'dir') {
      const remoteUrl = await remoteFromConfig(fs, p.join(gitPath, 'config'))
      return { repoRoot: dir, isWorktree: false, ...(remoteUrl !== undefined ? { remoteUrl } : {}) }
    }

    if (st?.kind === 'file') {
      const content = (await fs.readFile(gitPath)) ?? ''
      const pointer = content.match(/^gitdir:\s*(.+?)\s*$/m)
      if (pointer?.[1] !== undefined) {
        let gitdir = pointer[1]
        if (!p.isAbsolute(gitdir)) gitdir = p.normalize(p.join(dir, gitdir))

        const commondirRaw = await fs.readFile(p.join(gitdir, 'commondir'))
        if (commondirRaw !== undefined) {
          let common = commondirRaw.trim()
          if (!p.isAbsolute(common)) common = p.normalize(p.join(gitdir, common))
          const mainRepoRoot = p.dirname(common)
          const remoteUrl = await remoteFromConfig(fs, p.join(common, 'config'))
          return {
            repoRoot: dir,
            isWorktree: true,
            mainRepoRoot,
            ...(remoteUrl !== undefined ? { remoteUrl } : {}),
          }
        }

        const remoteUrl = await remoteFromConfig(fs, p.join(gitdir, 'config'))
        return { repoRoot: dir, isWorktree: false, ...(remoteUrl !== undefined ? { remoteUrl } : {}) }
      }
    }

    const parent = p.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Normalize a git remote URL to a canonical `host/path` identity so the
 * same repository unifies across protocols and mount points:
 *
 *   git@github.com:owner/repo.git      → github.com/owner/repo
 *   https://github.com/owner/repo.git  → github.com/owner/repo
 *   ssh://git@github.com/owner/repo    → github.com/owner/repo
 *
 * Anything unrecognized (local paths, file:// oddities) is returned as-is:
 * an un-normalized identity still groups sessions that share it exactly.
 */
export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim()

  let host: string | undefined
  let path: string | undefined

  const full = trimmed.match(/^[a-zA-Z][\w+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/)
  if (full) {
    host = full[1]
    path = full[2] ?? ''
  } else {
    const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/)
    if (scp) {
      host = scp[1]
      path = scp[2]
    }
  }

  if (host === undefined || path === undefined) return trimmed
  // A single-letter "host" is almost certainly a Windows drive path.
  if (/^[A-Za-z]$/.test(host)) return trimmed

  const cleanPath = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  return `${host.toLowerCase()}/${cleanPath}`
}

/** Display name for a normalized identity: its last path segment. */
export function repoNameOf(normalized: string): string {
  const segments = normalized.split('/').filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? normalized
}

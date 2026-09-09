/**
 * Claude Code buckets transcripts under `~/.claude/projects/<munged cwd>/`.
 *
 * The rule, read out of the installed CLI (v2.x, 2026-09):
 *
 *     munged = cwd.replace(/[^a-zA-Z0-9]/g, "-")
 *     dirName = munged.length <= 200
 *       ? munged
 *       : `${munged.slice(0, 200)}-${base36(abs(hash(cwd)))}`
 *
 * The hash in the long-path case is internal to the CLI, so we cannot
 * reproduce the full directory name for cwds whose munged form exceeds 200
 * chars — for those we can only predict the 200-char prefix. The munging is
 * lossy either way (`-` in a real folder name is indistinguishable from a
 * separator), so hodor only ever uses it forward: to locate the expected
 * bucket for a known cwd. Ground truth for grouping is always the `cwd`
 * recorded inside transcript lines, never an un-munged directory name.
 */

export const MUNGED_DIR_MAX_LENGTH = 200

export type MungedDirName =
  | { kind: 'exact'; dirName: string }
  | { kind: 'prefix'; dirNamePrefix: string }

export function mungeCwd(cwd: string): MungedDirName {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (munged.length <= MUNGED_DIR_MAX_LENGTH) {
    return { kind: 'exact', dirName: munged }
  }
  return { kind: 'prefix', dirNamePrefix: munged.slice(0, MUNGED_DIR_MAX_LENGTH) }
}

/**
 * Whether `dirName` (an entry of `~/.claude/projects/`) is the bucket the
 * CLI would use for `cwd`. Handles the truncated-with-hash-suffix case via
 * prefix matching.
 */
export function matchesMungedDir(cwd: string, dirName: string): boolean {
  const munged = mungeCwd(cwd)
  if (munged.kind === 'exact') {
    return dirName === munged.dirName
  }
  return dirName.startsWith(`${munged.dirNamePrefix}-`)
}

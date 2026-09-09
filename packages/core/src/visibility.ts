/**
 * Visibility classification: separates the sessions a person cares about
 * from ephemeral/programmatic noise (agent harness runs, /tmp scratchpads,
 * node_modules digs). Nothing is deleted — a hidden session carries the
 * rule that hid it (`hiddenBy`), presentation decides what to do with it,
 * and rules are plain data the user can override.
 */

export interface HideRules {
  /** Segment-aligned absolute path prefixes, e.g. "/tmp". */
  pathPrefixes: string[]
  /** Exact path segment names, e.g. "node_modules" or ".peri". */
  pathSegments: string[]
  /** Hide any dot-directory segment (".peri", ".cache", …). */
  hideDotSegments: boolean
  /** Dot segments that stay visible, e.g. ".claude" (worktrees are real work). */
  dotSegmentAllowlist: string[]
}

export const defaultHideRules: HideRules = {
  pathPrefixes: ['/tmp', '/private/tmp', '/var/folders'],
  pathSegments: ['node_modules'],
  hideDotSegments: true,
  dotSegmentAllowlist: ['.claude'],
}

const splitSegments = (path: string): string[] => path.split(/[\\/]+/).filter((s) => s.length > 0)

/**
 * The rule that hides this cwd, or undefined if it stays visible.
 * Returned strings are provenance, e.g. "prefix:/tmp" or "dot-segment:.peri".
 */
export function hiddenBy(cwd: string, rules: HideRules): string | undefined {
  const segments = splitSegments(cwd)

  for (const prefix of rules.pathPrefixes) {
    const prefixSegments = splitSegments(prefix)
    if (
      prefixSegments.length > 0 &&
      prefixSegments.length <= segments.length &&
      prefixSegments.every((seg, i) => seg === segments[i])
    ) {
      return `prefix:${prefix}`
    }
  }

  for (const segment of segments) {
    if (rules.pathSegments.includes(segment)) return `segment:${segment}`
    if (
      rules.hideDotSegments &&
      segment.startsWith('.') &&
      !rules.dotSegmentAllowlist.includes(segment)
    ) {
      return `dot-segment:${segment}`
    }
  }

  return undefined
}

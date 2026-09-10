import type { Project, Session, Snapshot } from '@hodor/core'

/**
 * Human-readable rendering of a Snapshot, built for reading in a terminal:
 * every line fits the given width (truncated, never wrapped), ages are
 * relative, and the most recent project/session prints LAST — the bottom of
 * the output is what sits above your prompt.
 */

const MIN_WIDTH = 60
const MAX_CWD_COL = 32
const MIN_TITLE_COL = 12

/** Truncate keeping the start: "long text…" */
export function fitEnd(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return text.slice(0, width - 1) + '…'
}

/** Truncate keeping the tail — the informative end of a path: "…ktrees/x" */
export function fitStart(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return '…' + text.slice(text.length - (width - 1))
}

/** Compact relative age: now, 5m, 3h, 12d, 6w, 3mo. '-' when unknown. */
export function formatAge(nowMs: number, timestamp?: string): string {
  if (timestamp === undefined) return '-'
  const then = Date.parse(timestamp)
  if (Number.isNaN(then)) return '-'
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 9) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Display form of a hiddenBy rule: the value after its kind prefix. */
const ruleLabel = (rule: string): string => rule.slice(rule.indexOf(':') + 1) || rule

function titleOf(session: Session): string {
  return (
    session.rename ?? session.summary ?? session.promptPreview ?? session.firstCommand ?? '(untitled)'
  )
}

function identityOf(project: Project): string {
  return project.identity.kind === 'git-remote' ? project.identity.url : project.identity.root
}

function sessionRow(
  session: Session,
  relCwd: string,
  nowMs: number,
  cwdCol: number,
  width: number,
): string {
  const mark = session.runtime.kind === 'idle' ? ' ' : '*'
  const age = fitEnd(formatAge(nowMs, session.lastActivityAt), 4).padStart(4)
  const cwd = fitStart(relCwd, cwdCol).padEnd(cwdCol)
  const prefix = `  ${mark} ${session.id.slice(0, 8)}  ${age}  ${cwd}  `
  return prefix + fitEnd(titleOf(session), width - prefix.length)
}

/** Display cwd relative to the project's shortest root that contains it. */
function relativeCwd(cwd: string | undefined, roots: Array<{ path: string }>): string {
  if (cwd === undefined) return '-'
  const containing = roots
    .map((r) => r.path)
    .filter((root) => cwd === root || cwd.startsWith(root + '/') || cwd.startsWith(root + '\\'))
    .sort((a, b) => a.length - b.length)[0]
  if (containing === undefined) return cwd
  return cwd === containing ? '.' : cwd.slice(containing.length + 1)
}

export function formatSnapshot(snapshot: Snapshot, columns: number): string {
  const width = Math.max(MIN_WIDTH, columns)
  const nowMs = Date.parse(snapshot.generatedAt)
  const lines: string[] = []

  const visible = snapshot.sessions.filter((s) => s.hiddenBy === undefined)
  const hidden = snapshot.sessions.filter((s) => s.hiddenBy !== undefined)
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]))

  const byProject = new Map<string, Session[]>()
  for (const a of snapshot.assignments) {
    const session = sessionById.get(a.sessionId)
    if (session === undefined || session.hiddenBy !== undefined) continue
    const list = byProject.get(a.projectId) ?? []
    list.push(session)
    byProject.set(a.projectId, list)
  }

  // Oldest project first: the most recently active block ends the output.
  const latestOf = (sessions: Session[]): string =>
    sessions.reduce((max, s) => ((s.lastActivityAt ?? '') > max ? (s.lastActivityAt ?? '') : max), '')
  const shownProjects = snapshot.projects
    .filter((p) => (byProject.get(p.id) ?? []).length > 0)
    .sort((a, b) => {
      const byRecency = latestOf(byProject.get(a.id)!).localeCompare(latestOf(byProject.get(b.id)!))
      return byRecency !== 0 ? byRecency : a.name.localeCompare(b.name)
    })

  for (const project of shownProjects) {
    const sessions = (byProject.get(project.id) ?? []).sort(
      (a, b) =>
        (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? '') || a.id.localeCompare(b.id),
    )
    const active = sessions.filter((s) => s.runtime.kind !== 'idle').length

    const meta = [plural(sessions.length, 'session'), ...(active > 0 ? [`${active} active`] : [])]
    lines.push('')
    lines.push(fitEnd(`${project.name} — ${meta.join(', ')} — ${identityOf(project)}`, width))

    const relCwds = new Map(sessions.map((s) => [s.id, relativeCwd(s.cwd, project.roots)]))
    const longest = Math.max(1, ...[...relCwds.values()].map((c) => c.length))
    let cwdCol = Math.min(MAX_CWD_COL, longest)
    const fixed = 4 + 8 + 2 + 4 + 2 + 2 // indent+mark, id, gaps, age, gaps
    if (width - fixed - cwdCol < MIN_TITLE_COL) {
      cwdCol = Math.max(4, width - fixed - MIN_TITLE_COL)
    }

    for (const session of sessions) {
      lines.push(sessionRow(session, relCwds.get(session.id)!, nowMs, cwdCol, width))
    }
  }

  const assigned = new Set(snapshot.assignments.map((a) => a.sessionId))
  const unassigned = visible.filter((s) => !assigned.has(s.id))
  if (unassigned.length > 0) {
    lines.push('')
    lines.push('(unassigned)')
    for (const s of unassigned) {
      lines.push(`    ${s.id.slice(0, 8)}  ${formatAge(nowMs, s.lastActivityAt).padStart(4)}`)
    }
  }

  lines.push('')
  if (hidden.length > 0) {
    const ruleCounts = new Map<string, number>()
    for (const s of hidden) {
      const label = ruleLabel(s.hiddenBy!)
      ruleCounts.set(label, (ruleCounts.get(label) ?? 0) + 1)
    }
    const rules = [...ruleCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, n]) => `${label} ${n}`)
      .join(', ')
    const hiddenProjects = snapshot.projects.length - shownProjects.length
    const parts = [plural(hidden.length, 'session')]
    if (hiddenProjects > 0) parts.push(plural(hiddenProjects, 'project'))
    lines.push(fitEnd(`hidden: ${parts.join(', ')} — ${rules} (--all to show)`, width))
  }
  const activeTotal = visible.filter((s) => s.runtime.kind !== 'idle').length
  lines.push(
    `${plural(visible.length, 'session')} in ${plural(shownProjects.length, 'project')}, ${activeTotal} active`,
  )

  return lines.join('\n').replace(/^\n+/, '')
}

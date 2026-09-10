import type { Placement, Project, Session, Snapshot } from '@hodor/core'

/** Client-side derivations over a Snapshot — mirrors the CLI formatter. */

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

export const titleOf = (s: Session): string =>
  s.rename ?? s.summary ?? s.promptPreview ?? s.firstCommand ?? '(untitled)'

export interface View {
  visible: Session[]
  hidden: Session[]
  claimsBySession: Map<string, string[]>
  sessionsByCustom: Map<string, Session[]>
  /** Absorb rule: derived projects keep only unclaimed visible sessions. */
  sessionsByAuto: Map<string, Session[]>
  autoProjects: Project[]
  derivedOf: Map<string, Project>
}

export function deriveView(snapshot: Snapshot): View {
  const byId = new Map(snapshot.sessions.map((s) => [s.id, s]))
  const visible = snapshot.sessions.filter((s) => s.hiddenBy === undefined)
  const hidden = snapshot.sessions.filter((s) => s.hiddenBy !== undefined)

  const claimsBySession = new Map<string, string[]>()
  const sessionsByCustom = new Map<string, Session[]>()
  for (const p of snapshot.placements as Placement[]) {
    const session = byId.get(p.sessionId)
    if (session === undefined || session.hiddenBy !== undefined) continue
    claimsBySession.set(p.sessionId, [...(claimsBySession.get(p.sessionId) ?? []), p.customProjectId])
    sessionsByCustom.set(p.customProjectId, [
      ...(sessionsByCustom.get(p.customProjectId) ?? []),
      session,
    ])
  }

  const derivedOf = new Map<string, Project>()
  const projectById = new Map(snapshot.projects.map((p) => [p.id, p]))
  const sessionsByAuto = new Map<string, Session[]>()
  for (const a of snapshot.assignments) {
    const project = projectById.get(a.projectId)
    const session = byId.get(a.sessionId)
    if (project === undefined || session === undefined) continue
    derivedOf.set(a.sessionId, project)
    if (session.hiddenBy !== undefined || claimsBySession.has(a.sessionId)) continue
    sessionsByAuto.set(a.projectId, [...(sessionsByAuto.get(a.projectId) ?? []), session])
  }

  const autoProjects = snapshot.projects.filter((p) => (sessionsByAuto.get(p.id) ?? []).length > 0)

  return { visible, hidden, claimsBySession, sessionsByCustom, sessionsByAuto, autoProjects, derivedOf }
}

export const byRecency = (sessions: Session[]): Session[] =>
  [...sessions].sort(
    (a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id),
  )

export function matchesQuery(session: Session, query: string): boolean {
  const q = query.toLowerCase()
  return (
    titleOf(session).toLowerCase().includes(q) ||
    (session.cwd ?? '').toLowerCase().includes(q) ||
    session.id.toLowerCase().includes(q) ||
    (session.promptPreview ?? '').toLowerCase().includes(q)
  )
}

export async function postMutation(
  path: '/api/project' | '/api/session',
  body: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { error?: string }
  return { ok: res.ok, ...(json.error !== undefined ? { error: json.error } : {}) }
}

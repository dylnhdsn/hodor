import type { CustomProject, Placement, Project, Session, Snapshot } from '@hodor/core'

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

/**
 * One rail, one kind of thing (docs/brainstorm/010): the user sees
 * "projects", never auto vs. custom. kind exists so edits know whether the
 * server will materialize first, and so settings can state the true status.
 */
export interface RailProject {
  kind: 'custom' | 'auto'
  id: string
  name: string
  sessions: Session[]
  custom?: CustomProject
  auto?: Project
}

export interface View {
  visible: Session[]
  hidden: Session[]
  byId: Map<string, Session>
  /** Live (non-archived) custom project ids claiming each session. */
  claimsBySession: Map<string, string[]>
  /** Every claim on each session, archived projects included (provenance). */
  placementsBySession: Map<string, Placement[]>
  rail: RailProject[]
  archivedProjects: CustomProject[]
  /** Sessions of an archived project (they're hidden, the panel shows them). */
  sessionsOfArchived: Map<string, Session[]>
  derivedOf: Map<string, Project>
  /** Fork lineage: ancestor session id → its forks. */
  forksOf: Map<string, Session[]>
}

const latestOf = (sessions: Session[]): string =>
  sessions.reduce((max, s) => ((s.lastActivityAt ?? '') > max ? (s.lastActivityAt ?? '') : max), '')

export function deriveView(snapshot: Snapshot): View {
  const byId = new Map(snapshot.sessions.map((s) => [s.id, s]))
  const visible = snapshot.sessions.filter((s) => s.hiddenBy === undefined)
  const hidden = snapshot.sessions.filter((s) => s.hiddenBy !== undefined)

  const liveCustom = snapshot.customProjects.filter((p) => p.archived !== true)
  const archivedProjects = snapshot.customProjects.filter((p) => p.archived === true)
  const liveIds = new Set(liveCustom.map((p) => p.id))
  const archivedIds = new Set(archivedProjects.map((p) => p.id))

  const claimsBySession = new Map<string, string[]>()
  const placementsBySession = new Map<string, Placement[]>()
  const sessionsByCustom = new Map<string, Session[]>()
  const sessionsOfArchived = new Map<string, Session[]>()
  for (const p of snapshot.placements) {
    const session = byId.get(p.sessionId)
    if (session === undefined) continue
    placementsBySession.set(p.sessionId, [...(placementsBySession.get(p.sessionId) ?? []), p])
    if (archivedIds.has(p.customProjectId)) {
      sessionsOfArchived.set(p.customProjectId, [
        ...(sessionsOfArchived.get(p.customProjectId) ?? []),
        session,
      ])
      continue
    }
    if (!liveIds.has(p.customProjectId) || session.hiddenBy !== undefined) continue
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
    // Absorb rule: auto projects keep only unclaimed visible sessions.
    if (session.hiddenBy !== undefined || claimsBySession.has(a.sessionId)) continue
    sessionsByAuto.set(a.projectId, [...(sessionsByAuto.get(a.projectId) ?? []), session])
  }

  const rail: RailProject[] = [
    ...liveCustom.map((p) => ({
      kind: 'custom' as const,
      id: p.id,
      name: p.name,
      sessions: sessionsByCustom.get(p.id) ?? [],
      custom: p,
    })),
    ...snapshot.projects
      .filter((p) => (sessionsByAuto.get(p.id) ?? []).length > 0)
      .map((p) => ({
        kind: 'auto' as const,
        id: p.id,
        name: p.name,
        sessions: sessionsByAuto.get(p.id) ?? [],
        auto: p,
      })),
  ].sort(
    (a, b) =>
      latestOf(b.sessions).localeCompare(latestOf(a.sessions)) || a.name.localeCompare(b.name),
  )

  const forksOf = new Map<string, Session[]>()
  for (const session of snapshot.sessions) {
    if (session.forkedFrom === undefined) continue
    forksOf.set(session.forkedFrom, [...(forksOf.get(session.forkedFrom) ?? []), session])
  }

  return {
    visible,
    hidden,
    byId,
    claimsBySession,
    placementsBySession,
    rail,
    archivedProjects,
    sessionsOfArchived,
    derivedOf,
    forksOf,
  }
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

/** Distinct cwds across a project's sessions — split targets, stats. */
export const cwdsOf = (sessions: Session[]): string[] =>
  [...new Set(sessions.map((s) => s.cwd).filter((c): c is string => c !== undefined))].sort()

export interface MutationResult {
  ok: boolean
  error?: string
  /** Post-materialize project id — may differ from the id sent. */
  id?: string
}

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system'
  timestamp?: string
  isSidechain: boolean
  text: string
}

export async function fetchTranscript(sessionId: string, limit = 24): Promise<TranscriptEntry[]> {
  try {
    const res = await fetch(`/api/transcript?id=${encodeURIComponent(sessionId)}&limit=${limit}`)
    if (!res.ok) return []
    const json = (await res.json()) as { messages?: TranscriptEntry[] }
    return json.messages ?? []
  } catch {
    return []
  }
}

export async function postMutation(
  path: '/api/project' | '/api/session' | '/api/preview',
  body: unknown,
): Promise<MutationResult & { sessionIds?: string[] }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { error?: string; id?: string; sessionIds?: string[] }
  return { ok: res.ok, ...json }
}

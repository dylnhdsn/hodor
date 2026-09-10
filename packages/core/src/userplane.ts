import { z } from 'zod'
import type { HodorConfig } from './config.js'
import { gitKey, type CoreState } from './fold.js'
import { flavorOfPath, isUnder, pathOps } from './paths.js'
import type { Session, SessionId } from './types.js'
import { normalizeGitUrl } from './urls.js'

/**
 * The user plane (docs/brainstorm/008): custom projects with matchers over
 * EVIDENCE — remote identities, roots, cwds, session ids — never derived
 * project ids, which legitimately drift as the base plane improves.
 *
 * Membership is label semantics: a session belongs to every custom project
 * that claims it (matcher or include), minus its excludes. Placements are
 * the full match set with provenance; whether auto projects absorb claimed
 * sessions is presentation policy, decided elsewhere.
 */

export type Matcher =
  | { kind: 'remote'; url: string }
  | { kind: 'root'; path: string }
  | { kind: 'cwd'; prefix: string }
  | { kind: 'session'; id: SessionId }

export interface CustomProject {
  id: string
  name: string
  matchers: Matcher[]
  /** Explicit adds (UI drag-in). Only ever add. */
  include: SessionId[]
  /** Explicit removes. Beat matchers and includes. */
  exclude: SessionId[]
}

export interface UserPlane {
  projects: CustomProject[]
}

export const emptyUserPlane: UserPlane = { projects: [] }

export interface Placement {
  sessionId: SessionId
  customProjectId: string
  via: 'include' | Matcher
}

const matcherSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), url: z.string() }).passthrough(),
  z.object({ kind: z.literal('root'), path: z.string() }).passthrough(),
  z.object({ kind: z.literal('cwd'), prefix: z.string() }).passthrough(),
  z.object({ kind: z.literal('session'), id: z.string() }).passthrough(),
])

const customProjectSchema = z
  .object({
    name: z.string(),
    matchers: z.array(matcherSchema).optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  })
  .passthrough()

const userPlaneSchema = z
  .object({ projects: z.record(z.string(), customProjectSchema).optional() })
  .passthrough()

export function parseUserPlane(content: string): { plane: UserPlane; error?: string } {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (error) {
    return { plane: emptyUserPlane, error: `not valid JSON (${String(error)})` }
  }
  const parsed = userPlaneSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
    return {
      plane: emptyUserPlane,
      error: `invalid projects file${where}: ${issue?.message ?? 'schema mismatch'}`,
    }
  }
  const projects = Object.entries(parsed.data.projects ?? {}).map(([id, p]) => ({
    id,
    name: p.name,
    matchers: (p.matchers ?? []) as Matcher[],
    include: p.include ?? [],
    exclude: p.exclude ?? [],
  }))
  return { plane: { projects } }
}

/**
 * Legacy config keys compile down to user-plane projects, so existing
 * configs keep their user-visible behavior:
 * - splitRoots → a custom project with a root matcher (id "split:<root>")
 * - projectNames "split:*:<root>" entries name that compiled project
 * - sessions.<id>.pinnedProject naming a custom project id → an include
 */
export function compileUserPlane(plane: UserPlane, config: HodorConfig): CustomProject[] {
  const projects = plane.projects.map((p) => ({
    ...p,
    include: [...p.include],
    exclude: [...p.exclude],
  }))
  const byId = new Map(projects.map((p) => [p.id, p]))

  for (const root of config.splitRoots ?? []) {
    const id = `split:${root}`
    if (byId.has(id)) continue
    const nameOverride = Object.entries(config.projectNames ?? {}).find(
      ([key]) => key === id || (key.startsWith('split:') && key.endsWith(`:${root}`)),
    )?.[1]
    const project: CustomProject = {
      id,
      name: nameOverride ?? pathOps(flavorOfPath(root)).basename(root) ?? root,
      matchers: [{ kind: 'root', path: root }],
      include: [],
      exclude: [],
    }
    projects.push(project)
    byId.set(id, project)
  }

  for (const [sessionId, override] of Object.entries(config.sessions ?? {})) {
    if (override.pinnedProject === undefined) continue
    const target = byId.get(override.pinnedProject)
    if (target !== undefined && !target.include.includes(sessionId)) {
      target.include.push(sessionId)
    }
  }

  return projects
}

interface SessionEvidence {
  cwds: string[]
  roots: string[]
  remotes: string[]
}

function evidenceFor(state: CoreState, session: Session): SessionEvidence {
  const roots: string[] = []
  const remotes: string[] = []
  for (const cwd of session.cwds) {
    const context = state.gitContexts[gitKey(session.storeId, cwd)]
    if (context == null) continue
    roots.push(context.repoRoot)
    if (context.mainRepoRoot !== undefined) roots.push(context.mainRepoRoot)
    if (context.remoteUrl !== undefined) remotes.push(normalizeGitUrl(context.remoteUrl))
  }
  return { cwds: session.cwds, roots, remotes }
}

function matches(matcher: Matcher, session: Session, evidence: SessionEvidence): boolean {
  switch (matcher.kind) {
    case 'remote':
      return evidence.remotes.includes(normalizeGitUrl(matcher.url))
    case 'root':
      return [...evidence.cwds, ...evidence.roots].some((p) => isUnder(p, matcher.path))
    case 'cwd':
      return evidence.cwds.some((p) => isUnder(p, matcher.prefix))
    case 'session':
      return matcher.id === session.id
  }
}

/**
 * The full match set: every (session, custom project) claim, with the
 * matcher (or include) that made it. Deterministic and order-independent —
 * sorted by sessionId then project id.
 */
export function computePlacements(
  state: CoreState,
  sessions: Session[],
  projects: CustomProject[],
): Placement[] {
  const placements: Placement[] = []
  for (const session of sessions) {
    const evidence = evidenceFor(state, session)
    for (const project of projects) {
      if (project.exclude.includes(session.id)) continue
      if (project.include.includes(session.id)) {
        placements.push({ sessionId: session.id, customProjectId: project.id, via: 'include' })
        continue
      }
      const matched = project.matchers.find((m) => matches(m, session, evidence))
      if (matched !== undefined) {
        placements.push({ sessionId: session.id, customProjectId: project.id, via: matched })
      }
    }
  }
  placements.sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.customProjectId.localeCompare(b.customProjectId),
  )
  return placements
}

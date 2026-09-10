import type { HodorConfig, SessionOverride } from './config.js'
import type { SessionId } from './types.js'
import type { CustomProject, Matcher, UserPlane } from './userplane.js'

/**
 * Pure edits to the user plane and config: (document, op) → document.
 * The CLI verbs and the HTTP API are both thin shells over these, so every
 * mutation path shares one tested implementation. Ops never throw — they
 * return an error string, keeping callers honest about reporting.
 */

export type PlaneOp =
  | { op: 'create-project'; id: string; name: string; matchers?: Matcher[] }
  | { op: 'delete-project'; id: string }
  | { op: 'rename-project'; id: string; name: string }
  | { op: 'add-matcher'; id: string; matcher: Matcher }
  | { op: 'remove-matcher'; id: string; matcher: Matcher }
  | { op: 'include'; id: string; sessionIds: SessionId[] }
  | { op: 'exclude'; id: string; sessionIds: SessionId[] }

export type SessionOp =
  | { op: 'rename-session'; sessionId: SessionId; name: string }
  | { op: 'archive-session'; sessionId: SessionId; archived: boolean }

export interface PlaneEdit {
  plane: UserPlane
  error?: string
}

const sameMatcher = (a: Matcher, b: Matcher): boolean => JSON.stringify(a) === JSON.stringify(b)

const cloneProject = (p: CustomProject): CustomProject => ({
  ...p,
  matchers: [...p.matchers],
  include: [...p.include],
  exclude: [...p.exclude],
})

export function applyPlaneOp(plane: UserPlane, op: PlaneOp): PlaneEdit {
  const projects = plane.projects.map(cloneProject)
  const found = projects.find((p) => p.id === op.id)

  switch (op.op) {
    case 'create-project': {
      if (found !== undefined) return { plane, error: `project "${op.id}" already exists` }
      projects.push({
        id: op.id,
        name: op.name,
        matchers: op.matchers ?? [],
        include: [],
        exclude: [],
      })
      return { plane: { projects } }
    }

    case 'delete-project': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      return { plane: { projects: projects.filter((p) => p.id !== op.id) } }
    }

    case 'rename-project': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      found.name = op.name
      return { plane: { projects } }
    }

    case 'add-matcher': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      if (!found.matchers.some((m) => sameMatcher(m, op.matcher))) found.matchers.push(op.matcher)
      return { plane: { projects } }
    }

    case 'remove-matcher': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      found.matchers = found.matchers.filter((m) => !sameMatcher(m, op.matcher))
      return { plane: { projects } }
    }

    case 'include': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      for (const sessionId of op.sessionIds) {
        // Including must actually take effect: it also clears an exclude.
        found.exclude = found.exclude.filter((id) => id !== sessionId)
        if (!found.include.includes(sessionId)) found.include.push(sessionId)
      }
      return { plane: { projects } }
    }

    case 'exclude': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      for (const sessionId of op.sessionIds) {
        found.include = found.include.filter((id) => id !== sessionId)
        if (!found.exclude.includes(sessionId)) found.exclude.push(sessionId)
      }
      return { plane: { projects } }
    }
  }
}

export function applySessionOp(config: HodorConfig, op: SessionOp): HodorConfig {
  const sessions: Record<string, SessionOverride> = { ...(config.sessions ?? {}) }
  const current: SessionOverride = { ...(sessions[op.sessionId] ?? {}) }
  if (op.op === 'rename-session') current.rename = op.name
  else current.archived = op.archived
  sessions[op.sessionId] = current
  return { ...config, sessions }
}

/** projects.json text for a plane — the inverse of parseUserPlane. */
export function serializeUserPlane(plane: UserPlane): string {
  const projects: Record<string, unknown> = {}
  for (const p of plane.projects) {
    projects[p.id] = {
      name: p.name,
      ...(p.matchers.length > 0 ? { matchers: p.matchers } : {}),
      ...(p.include.length > 0 ? { include: p.include } : {}),
      ...(p.exclude.length > 0 ? { exclude: p.exclude } : {}),
    }
  }
  return JSON.stringify({ projects }, null, 2) + '\n'
}

export function serializeConfig(config: HodorConfig): string {
  return JSON.stringify(config, null, 2) + '\n'
}

/** Stable, readable project id from a display name. */
export function slugifyProjectId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Parse a CLI/API matcher argument like "remote=github.com/o/r". */
export function parseMatcherArg(arg: string): Matcher | undefined {
  const eq = arg.indexOf('=')
  if (eq <= 0) return undefined
  const kind = arg.slice(0, eq)
  const value = arg.slice(eq + 1)
  if (value.length === 0) return undefined
  switch (kind) {
    case 'remote':
      return { kind, url: value }
    case 'root':
      return { kind, path: value }
    case 'cwd':
      return { kind, prefix: value }
    case 'session':
      return { kind, id: value }
    default:
      return undefined
  }
}

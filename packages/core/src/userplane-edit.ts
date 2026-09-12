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
  | {
      op: 'create-project'
      id: string
      name: string
      matchers?: Matcher[]
      derivedFrom?: string
      archived?: boolean
    }
  | { op: 'delete-project'; id: string }
  | { op: 'rename-project'; id: string; name: string }
  | { op: 'archive-project'; id: string; archived: boolean }
  | { op: 'add-matcher'; id: string; matcher: Matcher }
  | { op: 'remove-matcher'; id: string; matcher: Matcher }
  | { op: 'add-exclude-matcher'; id: string; matcher: Matcher }
  | { op: 'remove-exclude-matcher'; id: string; matcher: Matcher }
  | { op: 'include'; id: string; sessionIds: SessionId[] }
  | { op: 'exclude'; id: string; sessionIds: SessionId[] }
  | { op: 'remove-include'; id: string; sessionIds: SessionId[] }
  | { op: 'remove-exclude'; id: string; sessionIds: SessionId[] }
  | { op: 'merge-projects'; id: string; from: string }
  | { op: 'split-project'; id: string; path: string; newId: string; name: string }

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
  excludeMatchers: [...p.excludeMatchers],
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
        excludeMatchers: [],
        include: [],
        exclude: [],
        ...(op.archived === true ? { archived: true } : {}),
        ...(op.derivedFrom !== undefined ? { derivedFrom: op.derivedFrom } : {}),
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

    case 'archive-project': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      if (op.archived) found.archived = true
      else delete found.archived
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

    case 'add-exclude-matcher': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      if (!found.excludeMatchers.some((m) => sameMatcher(m, op.matcher))) {
        found.excludeMatchers.push(op.matcher)
      }
      return { plane: { projects } }
    }

    case 'remove-exclude-matcher': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      found.excludeMatchers = found.excludeMatchers.filter((m) => !sameMatcher(m, op.matcher))
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

    // Plain list removals: unpin without excluding, or lift an exclude
    // without pinning — matchers decide again.
    case 'remove-include': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      found.include = found.include.filter((id) => !op.sessionIds.includes(id))
      return { plane: { projects } }
    }

    case 'remove-exclude': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      found.exclude = found.exclude.filter((id) => !op.sessionIds.includes(id))
      return { plane: { projects } }
    }

    case 'merge-projects': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      const from = projects.find((p) => p.id === op.from)
      if (from === undefined) return { plane, error: `no project "${op.from}"` }
      if (from.id === found.id) return { plane, error: `cannot merge a project into itself` }
      for (const m of from.matchers) {
        if (!found.matchers.some((x) => sameMatcher(x, m))) found.matchers.push(m)
      }
      for (const m of from.excludeMatchers) {
        if (!found.excludeMatchers.some((x) => sameMatcher(x, m))) found.excludeMatchers.push(m)
      }
      for (const id of from.include) {
        if (!found.include.includes(id)) found.include.push(id)
      }
      for (const id of from.exclude) {
        // An include on the surviving project wins over the merged exclude.
        if (!found.exclude.includes(id) && !found.include.includes(id)) found.exclude.push(id)
      }
      return { plane: { projects: projects.filter((p) => p.id !== op.from) } }
    }

    case 'split-project': {
      if (found === undefined) return { plane, error: `no project "${op.id}"` }
      if (projects.some((p) => p.id === op.newId)) {
        return { plane, error: `project "${op.newId}" already exists` }
      }
      const carve: Matcher = { kind: 'root', path: op.path }
      if (!found.excludeMatchers.some((m) => sameMatcher(m, carve))) {
        found.excludeMatchers.push(carve)
      }
      projects.push({
        id: op.newId,
        name: op.name,
        matchers: [carve],
        excludeMatchers: [],
        include: [],
        exclude: [],
      })
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
      ...(p.excludeMatchers.length > 0 ? { excludeMatchers: p.excludeMatchers } : {}),
      ...(p.include.length > 0 ? { include: p.include } : {}),
      ...(p.exclude.length > 0 ? { exclude: p.exclude } : {}),
      ...(p.archived === true ? { archived: true } : {}),
      ...(p.derivedFrom !== undefined ? { derivedFrom: p.derivedFrom } : {}),
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
    case 'dir':
      return { kind, path: value }
    case 'cwd':
      return { kind, prefix: value }
    case 'session':
      return { kind, id: value }
    case 'branch':
      return { kind, glob: value }
    case 'title':
    case 'model':
      return { kind, match: value }
    case 'entrypoint':
      return { kind, value }
    default:
      return undefined
  }
}

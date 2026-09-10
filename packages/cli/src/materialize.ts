import {
  applyPlaneOp,
  buildSnapshot,
  emptyState,
  enrichGitContexts,
  foldAll,
  scanStore,
  seedMatchersFor,
  slugifyProjectId,
  type Project,
  type UserPlane,
} from '@hodor/core'
import type { CliDeps } from './main.js'
import { resolveStores, storeFs } from './stores.js'
import type { UserFiles } from './userdata.js'

/**
 * Materialization (docs/brainstorm/010): the user edits "a project" without
 * knowing whether it is derived; targeting an auto project id silently
 * creates a custom project seeded from its identity, then the edit applies.
 */

export interface ResolvedTarget {
  plane: UserPlane
  id: string
  /** Set when an auto project was materialized by this resolution. */
  materialized?: string
}

export function materializeTarget(
  plane: UserPlane,
  autoProjects: Project[],
  targetId: string,
): ResolvedTarget | { error: string } {
  if (plane.projects.some((p) => p.id === targetId)) return { plane, id: targetId }

  // Already materialized under another id — edits keep landing there.
  const existing = plane.projects.find((p) => p.derivedFrom === targetId)
  if (existing !== undefined) return { plane, id: existing.id }

  const auto = autoProjects.find((p) => p.id === targetId)
  if (auto === undefined) return { error: `no project "${targetId}"` }

  const id = slugifyProjectId(auto.name, new Set(plane.projects.map((p) => p.id)))
  const created = applyPlaneOp(plane, {
    op: 'create-project',
    id,
    name: auto.name,
    matchers: seedMatchersFor(auto),
    derivedFrom: auto.id,
  })
  if (created.error !== undefined) return { error: created.error }
  return { plane: created.plane, id, materialized: auto.id }
}

/** The derived projects a CLI curation command resolves auto ids against. */
export async function derivedProjects(deps: CliDeps, files: UserFiles): Promise<Project[]> {
  const stores = await resolveStores(deps, { roots: [], noDiscover: false }, files.config)
  let state = foldAll(emptyState, [
    { type: 'config-changed', config: files.config },
    { type: 'userplane-changed', plane: files.plane },
  ])
  for (const store of stores) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  state = foldAll(state, await enrichGitContexts(state, storeFs(deps, stores)))
  return buildSnapshot(state, { now: deps.now() }).projects
}

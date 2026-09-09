import { gitKey, type CoreState } from './fold.js'
import { flavorOfPath, pathOps } from './paths.js'
import type { Assignment, Project, Session, Signal } from './types.js'
import { normalizeGitUrl, repoNameOf } from './urls.js'

/**
 * ProjectResolver v0 — the single place that turns evidence into projects
 * and assignments (fallback chain: git remote URL → repo root → folder).
 *
 * Pure and deterministic: project ids are derived from identity, so the
 * same inputs always produce the same output regardless of event order.
 * User pins (SessionMeta.pinnedProject) beat every heuristic.
 */

const CONFIDENCE = { pinned: 1, 'git-remote': 0.9, 'git-root': 0.7, cwd: 0.5 } as const

interface Resolution {
  projects: Project[]
  assignments: Assignment[]
}

function lastSegment(path: string): string {
  const p = pathOps(flavorOfPath(path))
  return p.basename(path) || path
}

export function resolveProjects(state: CoreState, sessions: Session[]): Resolution {
  const projects = new Map<string, Project>()
  const assignments: Assignment[] = []

  const ensureProject = (project: Project): Project => {
    const existing = projects.get(project.id)
    if (existing === undefined) {
      projects.set(project.id, project)
      return project
    }
    return existing
  }

  const addRoot = (project: Project, storeId: string, path: string): void => {
    if (!project.roots.some((r) => r.storeId === storeId && r.path === path)) {
      project.roots.push({ storeId, path })
    }
  }

  for (const session of sessions) {
    const pinnedProject = state.metas[session.id]?.pinnedProject
    if (pinnedProject !== undefined) {
      ensureProject({
        id: pinnedProject,
        name: pinnedProject,
        identity: { kind: 'path', storeId: session.storeId, root: pinnedProject },
        roots: [],
      })
      assignments.push({
        sessionId: session.id,
        projectId: pinnedProject,
        confidence: CONFIDENCE.pinned,
        reasons: [],
        pinned: true,
      })
      continue
    }

    const cwd = session.cwd
    if (cwd === undefined) continue

    const observedAt = session.lastActivityAt ?? ''
    const reasons: Signal[] = [
      { sessionId: session.id, source: 'cwd', value: cwd, observedAt },
    ]

    const context = state.gitContexts[gitKey(session.storeId, cwd)]
    let project: Project

    if (context != null) {
      reasons.push({ sessionId: session.id, source: 'git-root', value: context.repoRoot, observedAt })
      if (context.isWorktree && context.mainRepoRoot !== undefined) {
        reasons.push({
          sessionId: session.id,
          source: 'worktree-of',
          value: context.mainRepoRoot,
          observedAt,
        })
      }
    }

    let confidence: number
    if (context?.remoteUrl !== undefined) {
      const identity = normalizeGitUrl(context.remoteUrl)
      reasons.push({ sessionId: session.id, source: 'git-remote', value: identity, observedAt })
      project = ensureProject({
        id: `git-remote:${identity}`,
        name: repoNameOf(identity),
        identity: { kind: 'git-remote', url: identity },
        roots: [],
      })
      confidence = CONFIDENCE['git-remote']
    } else if (context != null) {
      const root = context.mainRepoRoot ?? context.repoRoot
      project = ensureProject({
        id: `git-root:${session.storeId}:${root}`,
        name: lastSegment(root),
        identity: { kind: 'path', storeId: session.storeId, root },
        roots: [],
      })
      confidence = CONFIDENCE['git-root']
    } else {
      project = ensureProject({
        id: `cwd:${session.storeId}:${cwd}`,
        name: lastSegment(cwd),
        identity: { kind: 'path', storeId: session.storeId, root: cwd },
        roots: [],
      })
      confidence = CONFIDENCE.cwd
    }

    addRoot(project, session.storeId, context?.repoRoot ?? cwd)
    assignments.push({ sessionId: session.id, projectId: project.id, confidence, reasons, pinned: false })
  }

  const sortedProjects = [...projects.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  )
  for (const project of sortedProjects) {
    project.roots.sort((a, b) => a.storeId.localeCompare(b.storeId) || a.path.localeCompare(b.path))
  }
  assignments.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  return { projects: sortedProjects, assignments }
}

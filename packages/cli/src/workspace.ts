import { flavorOfPath, pathOps } from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Workspace documents (docs/brainstorm/022, 027): persistent window/tab/
 * split arrangements for the desktop app. The layout tree itself is the
 * dockview serialization — opaque to hodor; slot rules (how to re-create
 * a dead terminal) ride inside its panel params.
 *
 * v2 (027) is the same shape plus `active` and per-workspace `scope`,
 * and it lives in its OWN file, workspaces.v2.json. Two channels share
 * ~/.hodor on purpose, but a pre-027 build saves the v1 file back as
 * exactly one workspace — so if both wrote one file, the older build
 * would erase the newer one's workspaces on its next save. v1 is read
 * once as the seed and never written again by a build that knows v2.
 */

export interface WorkspaceWindow {
  layout?: unknown | undefined
  /** Zone identity per dockview group id: the user's named categories
   * ("ACTIVE", "PR REVIEWS") and which zone new terminals land in. */
  zones?: Record<string, { name?: string; def?: boolean }>
}

export interface Workspace {
  id: string
  name: string
  /** What you are doing here, in your words — the title bar shows it. */
  intent?: string | undefined
  /** Project-scoped: "new session" here defaults to this project. */
  scope?: { projectId: string } | undefined
  windows: WorkspaceWindow[]
  /** Turn-stack deferrals per session id (snooze / sent-to-phone). */
  defer?:
    | Record<string, { until?: string; untilMoves?: string; phone?: boolean }>
    | undefined
}

export interface WorkspaceDoc {
  v: 1 | 2
  /** The workspace shown; absent = the first. */
  active?: string
  /** Height of the main-window dock region, px. */
  dockHeight?: number
  workspaces: Workspace[]
}

export const emptyWorkspaceDoc: WorkspaceDoc = { v: 2, workspaces: [] }

/** Guardrail: a layout blob bigger than this is a bug, not a workspace. */
export const WORKSPACE_DOC_LIMIT = 2 * 1024 * 1024

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/** Tolerant parse: unknown fields pass through, wrong shapes reject. */
export function parseWorkspaceDoc(raw: unknown): WorkspaceDoc | undefined {
  if (!isRecord(raw) || !Array.isArray(raw['workspaces'])) return undefined
  const workspaces: Workspace[] = []
  for (const w of raw['workspaces']) {
    if (!isRecord(w) || typeof w['id'] !== 'string' || typeof w['name'] !== 'string') {
      return undefined
    }
    const windows = Array.isArray(w['windows']) ? w['windows'] : []
    if (!windows.every(isRecord)) return undefined
    const defer = w['defer']
    const scope = w['scope']
    workspaces.push({
      id: w['id'],
      name: w['name'],
      ...(typeof w['intent'] === 'string' && w['intent'] !== '' ? { intent: w['intent'] } : {}),
      ...(isRecord(scope) && typeof scope['projectId'] === 'string'
        ? { scope: { projectId: scope['projectId'] } }
        : {}),
      windows: windows as WorkspaceWindow[],
      ...(isRecord(defer) ? { defer: defer as Workspace['defer'] } : {}),
    })
  }
  const height = raw['dockHeight']
  const active = raw['active']
  return {
    v: raw['v'] === 2 ? 2 : 1,
    ...(typeof active === 'string' && workspaces.some((w) => w.id === active) ? { active } : {}),
    ...(typeof height === 'number' && Number.isFinite(height) ? { dockHeight: height } : {}),
    workspaces,
  }
}

const v1Path = (home: string): string => pathOps(flavorOfPath(home)).join(home, 'workspaces.json')
const v2Path = (home: string): string =>
  pathOps(flavorOfPath(home)).join(home, 'workspaces.v2.json')

async function readDoc(deps: CliDeps, path: string): Promise<WorkspaceDoc | undefined> {
  const text = await deps.fs.readFile(path)
  if (text === undefined) return undefined
  try {
    return parseWorkspaceDoc(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** The v2 doc; when there is none yet, the v1 doc lifted to v2 (its one
 * implicit workspace becomes "main"). The lift is in memory — v1 is left
 * exactly as it was for the builds that still read it. */
export async function loadWorkspaces(deps: CliDeps, home: string): Promise<WorkspaceDoc> {
  const v2 = await readDoc(deps, v2Path(home))
  if (v2 !== undefined) return { ...v2, v: 2 }
  const v1 = await readDoc(deps, v1Path(home))
  if (v1 === undefined) return emptyWorkspaceDoc
  return {
    v: 2,
    ...(v1.dockHeight !== undefined ? { dockHeight: v1.dockHeight } : {}),
    workspaces: v1.workspaces.map((w, i) =>
      i === 0 && w.id === 'default' ? { ...w, id: 'main', name: 'main' } : w,
    ),
    ...(v1.workspaces.length > 0
      ? { active: v1.workspaces[0]!.id === 'default' ? 'main' : v1.workspaces[0]!.id }
      : {}),
  }
}

export async function saveWorkspaces(deps: CliDeps, home: string, doc: WorkspaceDoc): Promise<void> {
  await deps.fs.writeFile(v2Path(home), JSON.stringify({ ...doc, v: 2 }, null, 2) + '\n')
}

import { flavorOfPath, pathOps } from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Workspace documents (docs/brainstorm/022): persistent window/tab/split
 * arrangements for the desktop app. The layout tree itself is the dockview
 * serialization — opaque to hodor; slot rules (how to re-create a dead
 * terminal) ride inside its panel params. v1 keeps exactly one implicit
 * workspace; the schema already carries the list so named workspaces and
 * templates extend it without a migration.
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
  windows: WorkspaceWindow[]
  /** Turn-stack deferrals per session id (snooze / sent-to-phone). */
  defer?:
    | Record<string, { until?: string; untilMoves?: string; phone?: boolean }>
    | undefined
}

export interface WorkspaceDoc {
  v: 1
  /** Height of the main-window dock region, px. */
  dockHeight?: number
  workspaces: Workspace[]
}

export const emptyWorkspaceDoc: WorkspaceDoc = { v: 1, workspaces: [] }

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
    workspaces.push({
      id: w['id'],
      name: w['name'],
      windows: windows as WorkspaceWindow[],
      ...(isRecord(defer) ? { defer: defer as Workspace['defer'] } : {}),
    })
  }
  const height = raw['dockHeight']
  return {
    v: 1,
    ...(typeof height === 'number' && Number.isFinite(height) ? { dockHeight: height } : {}),
    workspaces,
  }
}

const workspacePath = (home: string): string =>
  pathOps(flavorOfPath(home)).join(home, 'workspaces.json')

export async function loadWorkspaces(deps: CliDeps, home: string): Promise<WorkspaceDoc> {
  const text = await deps.fs.readFile(workspacePath(home))
  if (text === undefined) return emptyWorkspaceDoc
  try {
    return parseWorkspaceDoc(JSON.parse(text)) ?? emptyWorkspaceDoc
  } catch {
    return emptyWorkspaceDoc
  }
}

export async function saveWorkspaces(deps: CliDeps, home: string, doc: WorkspaceDoc): Promise<void> {
  await deps.fs.writeFile(workspacePath(home), JSON.stringify(doc, null, 2) + '\n')
}

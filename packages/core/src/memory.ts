import type { SourceEvent } from './events.js'
import { gitKey, type CoreState } from './fold.js'
import type { FileSystem } from './fs.js'
import { flavorOfPath, pathOps } from './paths.js'
import type { StoreId } from './types.js'

/**
 * Memory-file enrichment: CLAUDE.md and friends leave NO transcript trace
 * (the CLI folds them into the system prompt), so their existence is a
 * filesystem fact, probed the way git contexts are.
 *
 * Per project root: CLAUDE.md, CLAUDE.local.md, AGENTS.md. Per store root
 * (~/.claude): the user-level CLAUDE.md. Approximation, documented: the CLI
 * actually walks from cwd upward collecting memory at every level; hodor
 * probes the project root (and the cwd itself when no repo), which covers
 * the overwhelmingly common layouts.
 *
 * Results — including "none found" — are cached in state per (store, root),
 * so repeated polls only stat new roots.
 */

export interface MemoryFileInfo {
  /** Base name: CLAUDE.md, CLAUDE.local.md, AGENTS.md. */
  name: string
  path: string
  bytes: number
  mtimeMs: number
}

const ROOT_MEMORY_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']
const USER_MEMORY_NAMES = ['CLAUDE.md']

async function probe(
  fs: FileSystem,
  flavor: 'posix' | 'win32',
  root: string,
  names: string[],
): Promise<MemoryFileInfo[]> {
  const p = pathOps(flavor)
  const files: MemoryFileInfo[] = []
  for (const name of names) {
    const path = p.join(root, name)
    const stat = await fs.stat(path).catch(() => undefined)
    if (stat?.kind === 'file') {
      files.push({ name, path, bytes: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  return files
}

export async function enrichMemoryFiles(
  state: CoreState,
  fsFor: (storeId: StoreId) => FileSystem,
): Promise<SourceEvent[]> {
  const pending = new Map<string, { storeId: string; root: string; userLevel: boolean }>()

  const want = (storeId: string, root: string, userLevel: boolean): void => {
    const key = gitKey(storeId, root)
    if (!(key in state.memoryFiles) && !pending.has(key)) {
      pending.set(key, { storeId, root, userLevel })
    }
  }

  for (const store of Object.values(state.stores)) {
    want(store.id, store.rootPath, true)
  }
  for (const accum of Object.values(state.sessions)) {
    for (const cwd of accum.cwds) {
      const context = state.gitContexts[gitKey(accum.storeId, cwd)]
      if (context === undefined) continue // git not resolved yet; next poll
      if (context === null) {
        want(accum.storeId, cwd, false)
      } else {
        want(accum.storeId, context.repoRoot, false)
        if (context.mainRepoRoot !== undefined) want(accum.storeId, context.mainRepoRoot, false)
      }
    }
  }

  const events: SourceEvent[] = []
  for (const { storeId, root, userLevel } of pending.values()) {
    const flavor = state.stores[storeId]?.pathFlavor ?? flavorOfPath(root)
    const files = await probe(
      fsFor(storeId),
      flavor,
      root,
      userLevel ? USER_MEMORY_NAMES : ROOT_MEMORY_NAMES,
    )
    events.push({ type: 'memory-scanned', storeId, root, userLevel, files })
  }
  return events
}

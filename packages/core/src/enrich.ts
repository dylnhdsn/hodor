import type { SourceEvent } from './events.js'
import { gitKey, type CoreState } from './fold.js'
import type { FileSystem } from './fs.js'
import { resolveGitContext } from './git.js'
import { flavorOfPath } from './paths.js'
import type { StoreId } from './types.js'

/**
 * Git enrichment orchestrator: finds every (store, cwd) pair the state has
 * not yet resolved, resolves each via the store's filesystem, and returns
 * the resulting events for the fold. Results (including "not a repo") are
 * cached in state, so repeated calls only touch new cwds.
 *
 * fsFor exists because cwd strings are only meaningful relative to their
 * store: a WSL store scanned from Windows records posix cwds that must be
 * accessed through a \\wsl$ translation (see translatePathFs).
 */
export async function enrichGitContexts(
  state: CoreState,
  fsFor: (storeId: StoreId) => FileSystem,
): Promise<SourceEvent[]> {
  const pending = new Map<string, { storeId: string; cwd: string }>()
  for (const accum of Object.values(state.sessions)) {
    for (const cwd of accum.cwds) {
      const key = gitKey(accum.storeId, cwd)
      if (!(key in state.gitContexts) && !pending.has(key)) {
        pending.set(key, { storeId: accum.storeId, cwd })
      }
    }
  }

  const events: SourceEvent[] = []
  for (const { storeId, cwd } of pending.values()) {
    const flavor = state.stores[storeId]?.pathFlavor ?? flavorOfPath(cwd)
    const context = await resolveGitContext(fsFor(storeId), flavor, cwd)
    events.push({ type: 'git-context-resolved', storeId, cwd, context })
  }
  return events
}

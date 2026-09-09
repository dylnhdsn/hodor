import type { SourceEvent } from './events.js'
import { gitKey, type CoreState } from './fold.js'
import type { FileSystem } from './fs.js'
import { resolveGitContext } from './git.js'
import { flavorOfPath } from './paths.js'

/**
 * Git enrichment orchestrator: finds every (store, cwd) pair the state has
 * not yet resolved, resolves each via the filesystem, and returns the
 * resulting events for the fold. Results (including "not a repo") are
 * cached in state, so repeated calls only touch new cwds.
 */
export async function enrichGitContexts(state: CoreState, fs: FileSystem): Promise<SourceEvent[]> {
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
    const context = await resolveGitContext(fs, flavor, cwd)
    events.push({ type: 'git-context-resolved', storeId, cwd, context })
  }
  return events
}

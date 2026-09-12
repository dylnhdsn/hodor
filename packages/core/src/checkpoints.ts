import type { SourceEvent } from './events.js'
import { gitKey, type CoreState } from './fold.js'
import type { FileSystem } from './fs.js'
import { flavorOfPath, pathOps } from './paths.js'
import type { StoreId } from './types.js'

/**
 * Checkpoint-backup enrichment: the transcript says which checkpoints a
 * session wrote, but whether they are still RESTORABLE is a filesystem
 * fact — the CLI keeps backup blobs in `<store>/file-history/<sessionId>/`
 * and sweeps them ~30 days after the session's last snapshot
 * (cleanupPeriodDays). Counting the files there tells restorable from
 * expired.
 *
 * Only sessions whose transcripts carry checkpoint lines are probed, and
 * results — including "dir missing" — are cached per (store, session), so
 * repeated polls cost nothing new.
 */
export async function enrichCheckpointBackups(
  state: CoreState,
  fsFor: (storeId: StoreId) => FileSystem,
): Promise<SourceEvent[]> {
  const events: SourceEvent[] = []
  for (const accum of Object.values(state.sessions)) {
    if (Object.keys(accum.checkpointIds).length === 0 && accum.checkpointEdits === 0) continue
    if (gitKey(accum.storeId, accum.id) in state.checkpointBackups) continue
    const store = state.stores[accum.storeId]
    if (store === undefined) continue
    const p = pathOps(store.pathFlavor ?? flavorOfPath(store.rootPath))
    const dir = p.join(store.rootPath, 'file-history', accum.id)
    const names = await fsFor(accum.storeId)
      .listDir(dir)
      .catch(() => [])
    events.push({
      type: 'checkpoint-backups-scanned',
      storeId: accum.storeId,
      sessionId: accum.id,
      backupFiles: names.length,
    })
  }
  return events
}

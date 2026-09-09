import type { CoreState, SessionAccum, ThreadAccum } from './fold.js'
import { resolveProjects } from './resolver.js'
import type { Assignment, Project, Runtime, Session, SessionStore, Thread } from './types.js'
import { hiddenBy, type HideRules } from './visibility.js'

/**
 * Selectors: derive the presentation-ready structured output from folded
 * state. This is where wall-clock time enters (runtime inference), so the
 * fold itself stays clock-free.
 */

export interface Snapshot {
  generatedAt: string
  stores: SessionStore[]
  sessions: Session[]
  projects: Project[]
  assignments: Assignment[]
}

export interface SnapshotOptions {
  now: Date
  /** A foreign session counts as active if it appended within this window. */
  activeWindowMs?: number
  /** Visibility rules; when given, matching sessions get `hiddenBy` set. */
  hide?: HideRules
}

const DEFAULT_ACTIVE_WINDOW_MS = 120_000

function toThread(id: string, kind: Thread['kind'], accum: ThreadAccum): Thread {
  const thread: Thread = {
    id,
    kind,
    firstTs: accum.firstTs ?? '',
    lastTs: accum.lastTs ?? '',
    messageCount: accum.messageCount,
  }
  if (accum.spawnedBy !== undefined) thread.spawnedBy = accum.spawnedBy
  return thread
}

function inferRuntime(accum: SessionAccum, now: Date, windowMs: number): Runtime {
  if (accum.lastActivityAt === undefined) return { kind: 'idle' }
  const last = Date.parse(accum.lastActivityAt)
  if (Number.isNaN(last)) return { kind: 'idle' }
  if (now.getTime() - last <= windowMs) {
    return { kind: 'inferred-active', lastAppendAt: accum.lastActivityAt }
  }
  return { kind: 'idle' }
}

function toSession(accum: SessionAccum, runtime: Runtime): Session {
  const threads: Thread[] = []
  if (accum.main.messageCount > 0) threads.push(toThread(`${accum.id}:main`, 'main', accum.main))
  accum.sidechains.forEach((sc, i) => threads.push(toThread(`${accum.id}:sc${i}`, 'sidechain', sc)))

  const session: Session = {
    id: accum.id,
    storeId: accum.storeId,
    transcriptPath: accum.transcriptPath,
    cwds: [...accum.cwds],
    entrypoints: [...accum.entrypoints],
    counts: {
      user: accum.userCount,
      assistant: accum.assistantCount,
      sidechains: accum.sidechains.length,
    },
    threads,
    runtime,
  }
  const cwd = accum.cwds[accum.cwds.length - 1]
  if (cwd !== undefined) session.cwd = cwd
  if (accum.gitBranch !== undefined) session.gitBranch = accum.gitBranch
  if (accum.summary !== undefined) session.summary = accum.summary
  if (accum.promptPreview !== undefined) session.promptPreview = accum.promptPreview
  if (accum.firstCommand !== undefined) session.firstCommand = accum.firstCommand
  if (accum.createdAt !== undefined) session.createdAt = accum.createdAt
  if (accum.lastActivityAt !== undefined) session.lastActivityAt = accum.lastActivityAt
  if (accum.cliVersion !== undefined) session.cliVersion = accum.cliVersion
  return session
}

export function buildSnapshot(state: CoreState, options: SnapshotOptions): Snapshot {
  const windowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS

  const sessions = Object.values(state.sessions)
    .filter((accum) => accum.main.messageCount > 0 || accum.sidechains.length > 0)
    .map((accum) => {
      const session = toSession(
        accum,
        state.runtimes[accum.id] ?? inferRuntime(accum, options.now, windowMs),
      )
      if (options.hide !== undefined) {
        const rule = hiddenBy(
          { ...(session.cwd !== undefined ? { cwd: session.cwd } : {}), entrypoints: session.entrypoints },
          options.hide,
        )
        if (rule !== undefined) session.hiddenBy = rule
      }
      return session
    })
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id),
    )

  const { projects, assignments } = resolveProjects(state, sessions)

  return {
    generatedAt: options.now.toISOString(),
    stores: Object.values(state.stores).sort((a, b) => a.id.localeCompare(b.id)),
    sessions,
    projects,
    assignments,
  }
}

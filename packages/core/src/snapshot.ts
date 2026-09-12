import type { CloudSession } from './cloud.js'
import { gitKey, type CoreState, type SessionAccum, type ThreadAccum } from './fold.js'
import {
  addUsage,
  costOfUsage,
  emptyUsage,
  mergePricing,
  totalTokens,
  type ModelPricing,
  type UsageTotals,
} from './pricing.js'
import { resolveProjects } from './resolver.js'
import type { Assignment, Project, Runtime, Session, SessionStore, Thread } from './types.js'
import { normalizeGitUrl, repoNameOf } from './urls.js'
import { compileUserPlane, computePlacements, type CustomProject, type Placement } from './userplane.js'
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
  /** Derived (base-plane) projects — machine-owned, rederivable. */
  projects: Project[]
  assignments: Assignment[]
  /** User-plane custom projects, full records (config splits compiled in). */
  customProjects: CustomProject[]
  /** Label-semantics claims: every (session, custom project) match. */
  placements: Placement[]
  /** Cloud sessions from the last listing; empty when not signed in or
   * the listing is unavailable (cloudError explains a failed scan). */
  cloudSessions: CloudSession[]
  cloudError?: string
  /** Memory files found on disk (CLAUDE.md and friends), per probed root. */
  memoryFiles: Array<{
    storeId: string
    root: string
    userLevel: boolean
    name: string
    path: string
    bytes: number
    mtimeMs: number
  }>
}

export interface SnapshotOptions {
  now: Date
  /** A foreign session counts as active if it appended within this window. */
  activeWindowMs?: number
  /** Visibility rules; when given, matching sessions get `hiddenBy` set. */
  hide?: HideRules
}

const DEFAULT_ACTIVE_WINDOW_MS = 120_000

function toThread(
  id: string,
  kind: Thread['kind'],
  accum: ThreadAccum,
  pricing: Record<string, ModelPricing>,
  agentMeta?: { agentType?: string; description?: string },
): Thread {
  const thread: Thread = {
    id,
    kind,
    firstTs: accum.firstTs ?? '',
    lastTs: accum.lastTs ?? '',
    messageCount: accum.messageCount,
  }
  if (accum.spawnedBy !== undefined) thread.spawnedBy = accum.spawnedBy
  if (accum.agentId !== undefined) thread.agentId = accum.agentId
  if (agentMeta?.agentType !== undefined) thread.agentType = agentMeta.agentType
  if (agentMeta?.description !== undefined) thread.description = agentMeta.description
  if (accum.usageByModel !== undefined) {
    // Copies, never references: fork correlation subtracts inherited usage
    // from these, and the fold's accums must stay untouched.
    thread.usage = Object.fromEntries(
      Object.entries(accum.usageByModel).map(([model, totals]) => [model, { ...totals }]),
    )
    thread.costUsd = costOfUsage(thread.usage, pricing).usd
  }
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

function toSession(
  accum: SessionAccum,
  runtime: Runtime,
  pricing: Record<string, ModelPricing>,
  checkpointBackupFiles?: number,
): Session {
  const threads: Thread[] = []
  if (accum.main.messageCount > 0) {
    threads.push(toThread(`${accum.id}:main`, 'main', accum.main, pricing))
  }
  accum.sidechains.forEach((sc, i) =>
    threads.push(
      toThread(
        `${accum.id}:sc${i}`,
        'sidechain',
        sc,
        pricing,
        sc.agentId !== undefined ? accum.agentMeta[sc.agentId] : undefined,
      ),
    ),
  )

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
      toolCalls: accum.toolCallCount,
    },
    threads,
    runtime,
  }

  // Session usage = sum over threads, cost from the same table.
  const byModel: Record<string, UsageTotals> = {}
  for (const thread of [accum.main, ...accum.sidechains]) {
    for (const [model, totals] of Object.entries(thread.usageByModel ?? {})) {
      addUsage((byModel[model] ??= emptyUsage()), totals)
    }
  }
  if (Object.keys(byModel).length > 0) {
    session.usage = byModel
    const cost = costOfUsage(byModel, pricing)
    session.costUsd = cost.usd
    if (cost.unpriced.length > 0) session.costUnpriced = cost.unpriced
  }
  const cwd = accum.cwds[accum.cwds.length - 1]
  if (cwd !== undefined) session.cwd = cwd
  if (accum.forkedFrom !== undefined) session.forkedFrom = accum.forkedFrom
  if (accum.gitBranch !== undefined) session.gitBranch = accum.gitBranch
  if (Object.keys(accum.toolCounts).length > 0) session.toolCounts = { ...accum.toolCounts }
  if (accum.slug !== undefined) session.slug = accum.slug
  if (accum.effort !== undefined) session.effort = accum.effort
  if (accum.serviceTier !== undefined) session.serviceTier = accum.serviceTier
  if (accum.inferenceGeo !== undefined) session.inferenceGeo = accum.inferenceGeo
  if (accum.fastMode === true) session.fastMode = true
  if (accum.apiErrorCount > 0) session.apiErrors = accum.apiErrorCount
  // One compaction usually writes both a boundary line and a summary turn;
  // max (not sum) also tolerates stores that only carry one marker kind.
  const compactions = Math.max(accum.compactBoundaries, accum.compactSummaries)
  if (compactions > 0) session.compactions = compactions
  if (accum.lastCompaction !== undefined) session.lastCompaction = { ...accum.lastCompaction }
  if (accum.contextTokens !== undefined) session.contextTokens = accum.contextTokens
  const checkpointCount = Object.keys(accum.checkpointIds).length
  if (checkpointCount > 0 || accum.checkpointEdits > 0) {
    session.checkpoints = {
      count: checkpointCount,
      edits: accum.checkpointEdits,
      files: Object.keys(accum.checkpointFiles).sort(),
      ...(accum.lastCheckpointAt !== undefined ? { lastAt: accum.lastCheckpointAt } : {}),
      ...(checkpointBackupFiles !== undefined ? { backupFiles: checkpointBackupFiles } : {}),
    }
  }
  if (Object.keys(accum.hookStats).length > 0) {
    session.hooks = Object.fromEntries(
      Object.entries(accum.hookStats).map(([command, s]) => [command, { ...s }]),
    )
  }
  if (accum.hookErrorCount > 0) session.hookErrors = accum.hookErrorCount
  if (accum.hookBlockCount > 0) session.hookBlocks = accum.hookBlockCount
  if (accum.summary !== undefined) session.summary = accum.summary
  if (accum.promptPreview !== undefined) session.promptPreview = accum.promptPreview
  if (accum.firstCommand !== undefined) session.firstCommand = accum.firstCommand
  if (accum.createdAt !== undefined) session.createdAt = accum.createdAt
  if (accum.lastActivityAt !== undefined) session.lastActivityAt = accum.lastActivityAt
  if (accum.cliVersion !== undefined) session.cliVersion = accum.cliVersion
  return session
}

function subtractUsage(into: UsageTotals, sub: UsageTotals): void {
  into.input = Math.max(0, into.input - sub.input)
  into.output = Math.max(0, into.output - sub.output)
  into.cacheRead = Math.max(0, into.cacheRead - sub.cacheRead)
  into.cacheWrite5m = Math.max(0, into.cacheWrite5m - sub.cacheWrite5m)
  into.cacheWrite1h = Math.max(0, into.cacheWrite1h - sub.cacheWrite1h)
  into.thinking = Math.max(0, into.thinking - sub.thinking)
}

/**
 * Fork correlation via shared API message ids: two sessions can only share
 * one by copying history, so overlap IS lineage — the detection that works
 * on modern `--fork-session` transcripts, which rewrite the session id on
 * copied lines (verified empirically; docs/brainstorm/016). Two effects:
 *
 * - `forkedFrom` fallback when the embedded-id evidence is absent. The
 *   fork's copied timestamps equal the parent's, so direction comes from
 *   lastActivityAt (the continued lane) — a heuristic, stated in the docs.
 * - The fork's inherited turns carry the parent's usage verbatim and were
 *   paid for exactly once, so their usage is subtracted from the fork
 *   (session and main thread) to keep store totals honest.
 */
function correlateForks(
  state: CoreState,
  sessions: Session[],
  pricing: Record<string, ModelPricing>,
): void {
  const order = [...sessions].sort(
    (a, b) => (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? '') || a.id.localeCompare(b.id),
  )
  const owners = new Map<string, string[]>()
  const orderIndex = new Map<string, number>()

  order.forEach((session, index) => {
    orderIndex.set(session.id, index)
    const accum = state.sessions[session.id]
    if (accum === undefined) return
    const billed = Object.entries(accum.billedMessageIds)

    // Best earlier sharer: most shared ids, nearest in order on ties —
    // a fork-of-a-fork overlaps its direct parent more than its grandparent.
    const overlap = new Map<string, number>()
    for (const [msgId] of billed) {
      for (const owner of owners.get(msgId) ?? []) {
        overlap.set(owner, (overlap.get(owner) ?? 0) + 1)
      }
    }
    let parentId: string | undefined
    for (const [owner, count] of overlap) {
      if (
        parentId === undefined ||
        count > overlap.get(parentId)! ||
        (count === overlap.get(parentId)! && orderIndex.get(owner)! > orderIndex.get(parentId)!)
      ) {
        parentId = owner
      }
    }

    if (parentId !== undefined) {
      if (session.forkedFrom === undefined) session.forkedFrom = parentId
      const parentBilled = state.sessions[parentId]?.billedMessageIds ?? {}
      const main = session.threads.find((t) => t.kind === 'main')
      for (const [msgId, entry] of billed) {
        if (parentBilled[msgId] === undefined) continue
        const modelUsage = session.usage?.[entry.model]
        if (modelUsage !== undefined) subtractUsage(modelUsage, entry)
        const threadUsage = main?.usage?.[entry.model]
        if (threadUsage !== undefined) subtractUsage(threadUsage, entry)
      }
      // Fully-inherited model buckets subtract to zero — drop them.
      for (const record of [session.usage, main?.usage]) {
        if (record === undefined) continue
        for (const [model, totals] of Object.entries(record)) {
          if (totalTokens(totals) === 0 && totals.thinking === 0) delete record[model]
        }
      }
      if (session.usage !== undefined) {
        if (Object.keys(session.usage).length === 0) {
          delete session.usage
          delete session.costUsd
        } else {
          session.costUsd = costOfUsage(session.usage, pricing).usd
        }
      }
      if (main?.usage !== undefined) {
        if (Object.keys(main.usage).length === 0) {
          delete main.usage
          delete main.costUsd
        } else {
          main.costUsd = costOfUsage(main.usage, pricing).usd
        }
      }
    }

    for (const [msgId] of billed) {
      owners.set(msgId, [...(owners.get(msgId) ?? []), session.id])
    }
  })
}

/**
 * Case-insensitive join key for repository identities: normalizeGitUrl
 * lowercases only the host, but GitHub treats owner/repo case-insensitively
 * and Windows-side remotes drift in case.
 */
const remoteKeyOf = (url: string): string => normalizeGitUrl(url).toLowerCase()

/**
 * The GROUND-TRUTH map of which local sessions live on which remote:
 * every resolved git context of every session cwd, after local-remote
 * chasing — the same evidence that groups local sessions into repo
 * projects. Exported so `hodor cloud --json` can print it when a join
 * doesn't happen and the question is "what remotes does hodor think my
 * local sessions have?".
 */
export function localSessionsByRemote(state: CoreState): Map<string, string[]> {
  const byRemote = new Map<string, string[]>()
  for (const accum of Object.values(state.sessions)) {
    for (const cwd of accum.cwds) {
      const context = state.gitContexts[gitKey(accum.storeId, cwd)]
      if (context?.remoteUrl === undefined) continue
      const key = remoteKeyOf(context.remoteUrl)
      const list = byRemote.get(key) ?? []
      if (!list.includes(accum.id)) list.push(accum.id)
      byRemote.set(key, list)
    }
  }
  return byRemote
}

/**
 * Cloud↔project correlation, in evidence order:
 *
 * 1. A custom project's explicit remote matcher claims the repo.
 * 2. Shared repo: local sessions on the same remote (per git contexts,
 *    ALL cloud sources considered, case-insensitive) lend the cloud
 *    session their own placements — custom claims and auto assignment.
 *
 * Mutates only the passed COPIES; fold state is never touched.
 */
function correlateCloudSessions(
  state: CoreState,
  cloudSessions: CloudSession[],
  placements: Placement[],
  assignments: Assignment[],
  customProjects: CustomProject[],
): void {
  if (cloudSessions.length === 0) return
  const byRemote = localSessionsByRemote(state)

  const customByRemote = new Map<string, string[]>()
  for (const project of customProjects) {
    if (project.archived === true) continue
    for (const matcher of project.matchers) {
      if (matcher.kind !== 'remote') continue
      const key = remoteKeyOf(matcher.url)
      customByRemote.set(key, [...(customByRemote.get(key) ?? []), project.id])
    }
  }

  const claimsOfLocal = new Map<string, string[]>()
  for (const p of placements) {
    claimsOfLocal.set(p.sessionId, [...(claimsOfLocal.get(p.sessionId) ?? []), p.customProjectId])
  }
  const autoOfLocal = new Map(assignments.map((a) => [a.sessionId, a.projectId]))

  for (const cloud of cloudSessions) {
    const remotes = (cloud.remoteUrls ?? (cloud.remoteUrl !== undefined ? [cloud.remoteUrl] : [])).map(
      remoteKeyOf,
    )
    const claimed: string[] = []
    let autoProjectId: string | undefined
    for (const remote of remotes) {
      for (const id of customByRemote.get(remote) ?? []) {
        if (!claimed.includes(id)) claimed.push(id)
      }
      for (const sessionId of byRemote.get(remote) ?? []) {
        for (const id of claimsOfLocal.get(sessionId) ?? []) {
          if (!claimed.includes(id)) claimed.push(id)
        }
        autoProjectId ??= autoOfLocal.get(sessionId)
      }
    }
    if (claimed.length > 0) cloud.claimedBy = claimed
    if (autoProjectId !== undefined) cloud.autoProjectId = autoProjectId
  }
}

export function buildSnapshot(state: CoreState, options: SnapshotOptions): Snapshot {
  const windowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
  const pricing = mergePricing(state.config.pricing)

  const sessions = Object.values(state.sessions)
    .filter((accum) => accum.main.messageCount > 0 || accum.sidechains.length > 0)
    .map((accum) => {
      const session = toSession(
        accum,
        state.runtimes[accum.id] ?? inferRuntime(accum, options.now, windowMs),
        pricing,
        state.checkpointBackups[gitKey(accum.storeId, accum.id)],
      )
      const meta = state.metas[accum.id]
      if (meta?.rename !== undefined) session.rename = meta.rename
      if (options.hide !== undefined) {
        // Archived is an explicit user classification; rules come after.
        // With hiding off (--all), archived sessions surface like the rest.
        const rule =
          meta?.archived === true
            ? 'archived'
            : hiddenBy(
                {
                  ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
                  entrypoints: session.entrypoints,
                },
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

  correlateForks(state, sessions, pricing)

  const { projects, assignments } = resolveProjects(state, sessions)

  const customProjects = compileUserPlane(state.userPlane, state.config)
  const placements = computePlacements(state, sessions, customProjects)

  // Archived projects take their sessions with them — unless a live project
  // also claims the session. Provenance, revealable via --all like the rest.
  if (options.hide !== undefined) {
    const archivedIds = new Set(customProjects.filter((p) => p.archived === true).map((p) => p.id))
    if (archivedIds.size > 0) {
      const claims = new Map<string, string[]>()
      for (const placement of placements) {
        claims.set(placement.sessionId, [
          ...(claims.get(placement.sessionId) ?? []),
          placement.customProjectId,
        ])
      }
      for (const session of sessions) {
        if (session.hiddenBy !== undefined) continue
        const claimedBy = claims.get(session.id)
        if (claimedBy !== undefined && claimedBy.every((id) => archivedIds.has(id))) {
          session.hiddenBy = `project-archived:${claimedBy[0]!}`
        }
      }
    }
  }

  const memoryFiles = Object.values(state.memoryFiles)
    .flatMap((entry) =>
      entry.files.map((file) => ({
        storeId: entry.storeId,
        root: entry.root,
        userLevel: entry.userLevel,
        ...file,
      })),
    )
    .sort((a, b) => a.root.localeCompare(b.root) || a.name.localeCompare(b.name))

  const cloudSessions = state.cloud.sessions
    .map((s) => ({ ...s }))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  correlateCloudSessions(state, cloudSessions, placements, assignments, customProjects)

  // One rail, one kind of thing (010): a repo that exists only in the
  // cloud still IS a project — synthesize the same auto project the
  // resolver would have built had local sessions existed, id scheme and
  // all, so rename-materialization and matchers work unchanged.
  const projectIds = new Set(projects.map((p) => p.id))
  for (const cloud of cloudSessions) {
    if (cloud.autoProjectId !== undefined || (cloud.claimedBy?.length ?? 0) > 0) continue
    if (cloud.remoteUrl === undefined) continue
    const id = `git-remote:${cloud.remoteUrl}`
    if (!projectIds.has(id)) {
      projectIds.add(id)
      projects.push({
        id,
        name: repoNameOf(cloud.remoteUrl),
        identity: { kind: 'git-remote', url: cloud.remoteUrl },
        roots: [],
      })
    }
    cloud.autoProjectId = id
  }

  return {
    generatedAt: options.now.toISOString(),
    stores: Object.values(state.stores).sort((a, b) => a.id.localeCompare(b.id)),
    sessions,
    projects,
    assignments,
    cloudSessions,
    ...(state.cloud.error !== undefined ? { cloudError: state.cloud.error } : {}),
    memoryFiles,
    customProjects: [...customProjects].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    placements,
  }
}

import {
  gitKey,
  normalizePrListing,
  type CoreState,
  type PrInfo,
  type SessionStore,
  type SourceEvent,
} from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Which PR a session's branch is on, from `gh pr list --head <branch>`
 * run inside the session's repo (gh reads origin from the checkout).
 * Feeds the row chip and "snooze until the PR moves".
 *
 * Budgeted, not eager: at most a few gh calls per pass, oldest cache
 * first, so a desk full of branches refreshes over a couple of minutes
 * without ever stalling a tick. Only sessions touched recently are asked
 * about at all. Cross-host like the branch checker: a WSL store's repo
 * is reached through wsl.exe from Windows; a store this host cannot
 * enter is simply unknown.
 */

const PASS_INTERVAL_MS = 20_000
const TTL_MS = 3 * 60_000
const MAX_CALLS_PER_PASS = 6
const MAX_TARGETS = 40
const RECENT_MS = 3 * 24 * 3600_000
const GH_TIMEOUT_MS = 15_000

const GH_FIELDS = 'number,url,state,isDraft,reviewDecision,updatedAt,headRefOid'

interface Target {
  key: string
  storeId: string
  repoRoot: string
  branch: string
  sessionIds: string[]
}

interface CacheEntry {
  at: number
  /** null = no PR; undefined = the lookup failed (stays unknown). */
  pr: PrInfo | null | undefined
}

export interface PrChecker {
  check(state: CoreState, stores: SessionStore[]): Promise<SourceEvent | undefined>
}

/** The gh invocation that runs INSIDE the repo, for this host. */
export function ghListSpec(
  osPlatform: CliDeps['osPlatform'],
  store: SessionStore,
  repoRoot: string,
  branch: string,
): { file: string; args: string[]; cwd?: string } | undefined {
  const list = ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', GH_FIELDS]
  if (store.origin.kind === 'native') return { file: 'gh', args: list, cwd: repoRoot }
  if (store.origin.kind === 'wsl' && osPlatform === 'win32') {
    return { file: 'wsl.exe', args: ['-d', store.origin.distro, '--cd', repoRoot, '-e', 'gh', ...list] }
  }
  return undefined
}

/** Sessions worth asking about: a branch, a repo with a remote, recent. */
export function prTargets(state: CoreState, nowMs: number): Target[] {
  const byKey = new Map<string, Target & { latest: string }>()
  for (const accum of Object.values(state.sessions)) {
    const branch = accum.gitBranch
    const cwd = accum.cwds[accum.cwds.length - 1]
    if (branch === undefined || cwd === undefined) continue
    const last = accum.lastActivityAt ?? ''
    if (last === '' || nowMs - Date.parse(last) > RECENT_MS) continue
    const context = state.gitContexts[gitKey(accum.storeId, cwd)]
    if (context === undefined || context === null || context.remoteUrl === undefined) continue
    const key = `${accum.storeId}|${context.repoRoot}|${branch}`
    const entry = byKey.get(key) ?? {
      key,
      storeId: accum.storeId,
      repoRoot: context.repoRoot,
      branch,
      sessionIds: [],
      latest: '',
    }
    entry.sessionIds.push(accum.id)
    if (last > entry.latest) entry.latest = last
    byKey.set(key, entry)
  }
  return [...byKey.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, MAX_TARGETS)
    .map(({ latest: _l, ...t }) => t)
}

export function createPrChecker(deps: CliDeps): PrChecker {
  let nextPassAt = 0
  const cache = new Map<string, CacheEntry>()
  const emitted = new Map<string, string>()

  async function lookup(store: SessionStore, target: Target, now: number): Promise<void> {
    const spec = ghListSpec(deps.osPlatform, store, target.repoRoot, target.branch)
    if (spec === undefined) {
      cache.set(target.key, { at: now, pr: undefined })
      return
    }
    const result = await deps
      .runCapture(spec.file, spec.args, {
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        timeoutMs: GH_TIMEOUT_MS,
      })
      .catch(() => undefined)
    if (result === undefined || result.code !== 0) {
      cache.set(target.key, { at: now, pr: undefined })
      return
    }
    cache.set(target.key, { at: now, pr: normalizePrListing(result.output, deps.now().toISOString()) })
  }

  async function check(state: CoreState, stores: SessionStore[]): Promise<SourceEvent | undefined> {
    const now = Date.now()
    if (now < nextPassAt) return undefined
    nextPassAt = now + PASS_INTERVAL_MS
    const storeById = new Map(stores.map((s) => [s.id, s]))
    const targets = prTargets(state, now)

    // refresh the stalest first, within this pass's budget
    const stale = targets
      .filter((t) => {
        const c = cache.get(t.key)
        return c === undefined || now - c.at >= TTL_MS
      })
      .sort((a, b) => (cache.get(a.key)?.at ?? 0) - (cache.get(b.key)?.at ?? 0))
      .slice(0, MAX_CALLS_PER_PASS)
    for (const target of stale) {
      const store = storeById.get(target.storeId)
      if (store === undefined) continue
      await lookup(store, target, now)
    }

    // emit what changed since last time, for every target we know about
    const prs: Record<string, PrInfo | null> = {}
    for (const target of targets) {
      const c = cache.get(target.key)
      if (c === undefined || c.pr === undefined) continue
      const serialized = c.pr === null ? 'null' : c.pr.fingerprint
      for (const id of target.sessionIds) {
        if (emitted.get(id) !== serialized) {
          prs[id] = c.pr
          emitted.set(id, serialized)
        }
      }
    }
    if (Object.keys(prs).length === 0) return undefined
    return { type: 'prs-checked', prs, checkedAt: deps.now().toISOString() }
  }

  return { check }
}

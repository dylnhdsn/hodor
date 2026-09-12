import {
  branchKnownLocally,
  localReposByRemote,
  normalizeGitUrl,
  type CoreState,
  type FileSystem,
  type SessionStore,
  type SourceEvent,
} from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Cloud branch pre-flight (docs/brainstorm/019): opening a cloud session
 * makes the Claude CLI check out the session's outcome branch, and once
 * that branch is gone (deleted after its PR merged) every open fails with
 * "Session resumed without branch: …" forever. This checker predicts that
 * outcome ahead of time, mirroring the CLI's own fallback chain:
 *
 * 1. Refs already known to the joined local checkout (refs/heads or
 *    refs/remotes/origin, loose or packed) satisfy the checkout — pure
 *    filesystem reads through the same store translation as everything
 *    else, so this works across the Windows/WSL boundary.
 * 2. With no local knowledge, only the remote can distinguish "on origin
 *    but never fetched" from "deleted": one BATCHED `git ls-remote` per
 *    repo, cached, run only where the checkout is executable from this
 *    host. Failure means unknown, never a false "gone".
 */

const PASS_INTERVAL_MS = 30_000
const LS_REMOTE_TTL_MS = 5 * 60_000
const LS_REMOTE_TIMEOUT_MS = 10_000

interface RepoTarget {
  storeId: string
  repoRoot: string
}

interface LsRemoteCacheEntry {
  at: number
  /** branch → exists on origin; undefined entry = the run failed. */
  found?: Map<string, boolean>
}

export interface BranchChecker {
  check(
    state: CoreState,
    stores: SessionStore[],
    fsFor: (storeId: string) => FileSystem,
  ): Promise<SourceEvent | undefined>
}

const remoteKey = (url: string): string => normalizeGitUrl(url).toLowerCase()

export function createBranchChecker(deps: CliDeps): BranchChecker {
  let nextPassAt = 0
  let lastEmitted = ''
  const lsRemoteCache = new Map<string, LsRemoteCacheEntry>()

  /** ls-remote is only runnable where the repo path means something to
   * THIS host: native stores always; a WSL store from Windows via wsl.exe. */
  function execFor(
    store: SessionStore,
    repoRoot: string,
    refs: string[],
  ): { file: string; args: string[]; cwd?: string } | undefined {
    const ls = ['ls-remote', 'origin', ...refs]
    if (store.origin.kind === 'native') return { file: 'git', args: ls, cwd: repoRoot }
    if (store.origin.kind === 'wsl' && deps.osPlatform === 'win32') {
      return { file: 'wsl.exe', args: ['-d', store.origin.distro, '--cd', repoRoot, '-e', 'git', ...ls] }
    }
    return undefined
  }

  async function originHas(
    store: SessionStore,
    repoRoot: string,
    branches: string[],
  ): Promise<Map<string, boolean> | undefined> {
    const key = `${store.id}|${repoRoot}`
    const now = Date.now()
    const cached = lsRemoteCache.get(key)
    if (
      cached !== undefined &&
      now - cached.at < LS_REMOTE_TTL_MS &&
      (cached.found === undefined || branches.every((b) => cached.found!.has(b)))
    ) {
      return cached.found
    }
    const asked = new Set([...branches, ...(cached?.found?.keys() ?? [])])
    const spec = execFor(store, repoRoot, [...asked].map((b) => `refs/heads/${b}`))
    if (spec === undefined) {
      lsRemoteCache.set(key, { at: now })
      return undefined
    }
    const result = await deps
      .runCapture(spec.file, spec.args, {
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        timeoutMs: LS_REMOTE_TIMEOUT_MS,
      })
      .catch(() => undefined)
    if (result === undefined || result.code !== 0) {
      lsRemoteCache.set(key, { at: now })
      return undefined
    }
    const onOrigin = new Set(
      result.output
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((ref): ref is string => ref !== undefined && ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length)),
    )
    const found = new Map([...asked].map((b) => [b, onOrigin.has(b)]))
    lsRemoteCache.set(key, { at: now, found })
    return found
  }

  async function check(
    state: CoreState,
    stores: SessionStore[],
    fsFor: (storeId: string) => FileSystem,
  ): Promise<SourceEvent | undefined> {
    const now = Date.now()
    if (now < nextPassAt || state.cloud.sessions.length === 0) return undefined
    nextPassAt = now + PASS_INTERVAL_MS

    const reposByRemote = localReposByRemote(state)
    const storeById = new Map(stores.map((s) => [s.id, s]))
    const presence: Record<string, boolean> = {}
    const pending = new Map<string, { target: RepoTarget; asks: Array<{ id: string; branch: string }> }>()

    for (const cloud of state.cloud.sessions) {
      const branch = cloud.branches[0]
      if (branch === undefined) continue
      const urls = cloud.remoteUrls ?? (cloud.remoteUrl !== undefined ? [cloud.remoteUrl] : [])
      let target: RepoTarget | undefined
      for (const url of urls) {
        target = reposByRemote.get(remoteKey(url))?.[0]
        if (target !== undefined) break
      }
      if (target === undefined) continue
      const store = storeById.get(target.storeId)
      if (store === undefined) continue
      if (await branchKnownLocally(fsFor(store.id), store.pathFlavor, target.repoRoot, branch)) {
        presence[cloud.id] = true
        continue
      }
      const key = `${store.id}|${target.repoRoot}`
      const entry = pending.get(key) ?? { target, asks: [] }
      entry.asks.push({ id: cloud.id, branch })
      pending.set(key, entry)
    }

    for (const { target, asks } of pending.values()) {
      const store = storeById.get(target.storeId)
      if (store === undefined) continue
      const found = await originHas(store, target.repoRoot, [...new Set(asks.map((a) => a.branch))])
      if (found === undefined) continue // unknown: no verdict beats a wrong one
      for (const ask of asks) {
        const on = found.get(ask.branch)
        if (on !== undefined) presence[ask.id] = on
      }
    }

    const emitted = JSON.stringify(presence)
    if (emitted === lastEmitted) return undefined
    lastEmitted = emitted
    return {
      type: 'cloud-branches-checked',
      presence,
      checkedAt: deps.now().toISOString(),
    }
  }

  return { check }
}

import {
  gitKey,
  globMatches,
  normalizeGitUrl,
  type CloudSession,
  type CoreState,
  type Session,
  type Snapshot,
  type SourceEvent,
} from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Custom organizing logic (docs/brainstorm/021): users place sessions
 * into projects with their own code.
 *
 * Two hooks share one channel:
 * - `<data home>/organize.js` — an ES module whose default export is
 *   `(session, helpers) => string[] | undefined`. Picked up by presence;
 *   edited file reloads on the next tick (mtime cache-bust).
 * - `config.organize.command` — any executable: facts arrive as JSON on
 *   stdin, labels come back as JSON on stdout.
 *
 * Contracts that keep it safe: functions are treated as pure over the
 * fact object (results memoized per session version + script version),
 * every failure is isolated (an error line, never a broken rail), and
 * results flow through the ordinary placement channel with provenance.
 */

export const ORGANIZE_API_VERSION = 1

/** What user logic sees — one object per session, local and cloud. */
export type OrganizeFact =
  | ({ type: 'local'; title?: string; remotes: string[] } & Session)
  | ({ type: 'cloud' } & CloudSession)

export interface OrganizeHelpers {
  glob(value: string, pattern: string): boolean
  normalizeGitUrl(url: string): string
  apiVersion: number
}

/** Build the fact set from a snapshot (+ git-context remotes per session). */
export function buildOrganizeFacts(state: CoreState, snapshot: Snapshot): OrganizeFact[] {
  const facts: OrganizeFact[] = []
  for (const session of snapshot.sessions) {
    const remotes: string[] = []
    for (const cwd of session.cwds) {
      const context = state.gitContexts[gitKey(session.storeId, cwd)]
      if (context?.remoteUrl !== undefined) {
        const remote = normalizeGitUrl(context.remoteUrl)
        if (!remotes.includes(remote)) remotes.push(remote)
      }
    }
    const title = session.rename ?? session.summary ?? session.promptPreview ?? session.firstCommand
    facts.push({ type: 'local', ...session, ...(title !== undefined ? { title } : {}), remotes })
  }
  for (const cloud of snapshot.cloudSessions) {
    facts.push({ type: 'cloud', ...cloud })
  }
  return facts
}

const factVersion = (fact: OrganizeFact): string =>
  fact.type === 'local' ? (fact.lastActivityAt ?? '') : (fact.updatedAt ?? '')

function cleanLabels(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) return undefined
  const labels = value
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 8)
  return labels.length > 0 ? labels : undefined
}

export interface Organizer {
  /** Evaluate all hooks; undefined when none are configured (and none were). */
  evaluate(
    config: { organize?: { command?: string; timeoutMs?: number } },
    state: CoreState,
    snapshot: Snapshot,
  ): Promise<SourceEvent | undefined>
}

export function createOrganizer(deps: CliDeps, dataHome: string): Organizer {
  const p = dataHome.includes('\\') ? '\\' : '/'
  const scriptPath = dataHome.endsWith(p) ? `${dataHome}organize.js` : `${dataHome}${p}organize.js`
  const scriptCache = new Map<string, string[] | undefined>()
  let execCache: { fingerprint: string; labels: Record<string, string[]> } | undefined
  let hadResults = false

  const helpers: OrganizeHelpers = {
    glob: globMatches,
    normalizeGitUrl,
    apiVersion: ORGANIZE_API_VERSION,
  }

  async function runScript(
    facts: OrganizeFact[],
    errors: string[],
  ): Promise<Record<string, string[]>> {
    const stat = await deps.fs.stat(scriptPath).catch(() => undefined)
    if (stat?.kind !== 'file') return {}
    let fn: unknown
    try {
      const mod = (await deps.importModule(scriptPath, String(stat.mtimeMs))) as {
        default?: unknown
      }
      fn = mod.default
      if (typeof fn !== 'function') throw new Error('organize.js has no default export function')
    } catch (error) {
      errors.push(`organize.js: ${String(error)}`)
      return {}
    }
    const labels: Record<string, string[]> = {}
    for (const fact of facts) {
      const key = `${fact.id}|${factVersion(fact)}|${stat.mtimeMs}`
      if (!scriptCache.has(key)) {
        try {
          // Clone: user code must never mutate what the snapshot serializes.
          const result = (fn as (f: OrganizeFact, h: OrganizeHelpers) => unknown)(
            JSON.parse(JSON.stringify(fact)) as OrganizeFact,
            helpers,
          )
          scriptCache.set(key, cleanLabels(result))
        } catch (error) {
          scriptCache.set(key, undefined)
          if (errors.length < 5) errors.push(`organize.js on ${fact.id.slice(0, 12)}: ${String(error)}`)
        }
      }
      const cached = scriptCache.get(key)
      if (cached !== undefined) labels[fact.id] = cached
    }
    if (scriptCache.size > 50_000) scriptCache.clear()
    return labels
  }

  async function runCommand(
    command: string,
    timeoutMs: number | undefined,
    facts: OrganizeFact[],
    errors: string[],
  ): Promise<Record<string, string[]>> {
    const fingerprint =
      command + '\0' + facts.map((f) => `${f.id}:${factVersion(f)}`).join(',')
    if (execCache?.fingerprint === fingerprint) return execCache.labels
    // The user's command runs through their shell so PATH behaves like
    // their terminal (same reasoning as PTY launches).
    const argv =
      deps.osPlatform === 'win32'
        ? { file: 'cmd.exe', args: ['/c', command] }
        : { file: deps.env('SHELL') ?? 'bash', args: ['-lc', command] }
    const run = await deps.runCapture(argv.file, argv.args, {
      timeoutMs: timeoutMs ?? 30_000,
      stdin: JSON.stringify({ apiVersion: ORGANIZE_API_VERSION, sessions: facts }),
    })
    const labels: Record<string, string[]> = {}
    if (run.code !== 0) {
      errors.push(`organize command failed (exit ${run.code}): ${run.output.trim().slice(0, 200)}`)
    } else {
      try {
        const body = JSON.parse(run.output) as { labels?: Record<string, unknown> }
        for (const [sessionId, value] of Object.entries(body.labels ?? {})) {
          const clean = cleanLabels(value)
          if (clean !== undefined) labels[sessionId] = clean
        }
      } catch (error) {
        errors.push(`organize command printed invalid JSON: ${String(error)}`)
      }
    }
    execCache = { fingerprint, labels }
    return labels
  }

  return {
    async evaluate(config, state, snapshot) {
      const command = config.organize?.command
      const stat = await deps.fs.stat(scriptPath).catch(() => undefined)
      const hasScript = stat?.kind === 'file'
      if (!hasScript && command === undefined) {
        if (!hadResults) return undefined
        hadResults = false
        return {
          type: 'organize-results',
          labels: {},
          errors: [],
          evaluatedAt: deps.now().toISOString(),
        }
      }

      const facts = buildOrganizeFacts(state, snapshot)
      const errors: string[] = []
      const labels: Record<string, string[]> = {}
      if (hasScript) {
        for (const [id, ls] of Object.entries(await runScript(facts, errors))) labels[id] = ls
      }
      if (command !== undefined) {
        for (const [id, ls] of Object.entries(
          await runCommand(command, config.organize?.timeoutMs, facts, errors),
        )) {
          const merged = [...(labels[id] ?? [])]
          for (const l of ls) if (!merged.includes(l)) merged.push(l)
          labels[id] = merged
        }
      }
      hadResults = true
      return { type: 'organize-results', labels, errors, evaluatedAt: deps.now().toISOString() }
    },
  }
}

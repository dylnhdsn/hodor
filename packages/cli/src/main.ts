import {
  StoreTailer,
  buildSnapshot,
  defaultHideRules,
  emptyState,
  enrichGitContexts,
  foldAll,
  mungeCwd,
  pathOps,
  scanStore,
  type CoreState,
  type FileSystem,
  type HideRules,
  type PathFlavor,
  type SessionStore,
  type Snapshot,
  type SnapshotOptions,
} from '@hodor/core'
import { cliVersion } from './version.js'

/**
 * The CLI is the first presentation layer over the data core — the
 * inspection loop until real UI exists. All effects come in through
 * CliDeps so tests can drive everything against MemFs.
 */
export interface CliDeps {
  fs: FileSystem
  homedir(): string
  platformFlavor: PathFlavor
  now(): Date
  write(text: string): void
  sleep(ms: number): Promise<void>
  /** Replace the installed bundle with the latest release (hodor update). */
  selfUpdate(): Promise<number>
}

const USAGE = `hodor — session manager (data core, early days)

Usage:
  hodor scan [--json] [--root <path>]...    Discover and organize sessions
  hodor watch [--json] [--interval <ms>] [--root <path>]...
                                            Scan, then live-update on changes
  hodor stats [--json] [--root <path>]...   Entrypoint and visibility histograms
  hodor bucket <cwd>                        Print the ~/.claude/projects bucket for a cwd
  hodor update                              Update to the latest build (alias: upgrade)
  hodor --version                           Print the CLI version

Stores default to <home>/.claude; pass --root to add or replace store roots.

Visibility (scan/watch):
  --all            Show everything, including ephemeral/agent-run sessions
  --hide <rule>    Extra hide rule; with a path separator it's a path prefix
                   (e.g. /srv/tmp), otherwise a directory name (e.g. dist).
                   Defaults hide /tmp-like paths, node_modules, and
                   dot-directories except .claude. Hidden sessions stay in
                   --json output, tagged with the rule that hid them.
`.trim()

interface Flags {
  json: boolean
  all: boolean
  roots: string[]
  hide: string[]
  intervalMs: number
  ticks?: number
  rest: string[]
  error?: string
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { json: false, all: false, roots: [], hide: [], intervalMs: 2000, rest: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--json') flags.json = true
    else if (arg === '--all') flags.all = true
    else if (arg === '--root' || arg === '--interval' || arg === '--ticks' || arg === '--hide') {
      const value = args[++i]
      if (value === undefined) {
        flags.error = `${arg}: missing value`
        break
      }
      if (arg === '--root') flags.roots.push(value)
      if (arg === '--hide') flags.hide.push(value)
      if (arg === '--interval') flags.intervalMs = Number(value)
      if (arg === '--ticks') flags.ticks = Number(value)
    } else flags.rest.push(arg)
  }
  return flags
}

function hideRules(flags: Flags): HideRules | undefined {
  if (flags.all) return undefined
  const rules: HideRules = {
    ...defaultHideRules,
    pathPrefixes: [...defaultHideRules.pathPrefixes],
    pathSegments: [...defaultHideRules.pathSegments],
  }
  for (const value of flags.hide) {
    if (/[\\/]/.test(value)) rules.pathPrefixes.push(value)
    else rules.pathSegments.push(value)
  }
  return rules
}

function snapshotOptions(deps: CliDeps, flags: Flags): SnapshotOptions {
  const options: SnapshotOptions = { now: deps.now() }
  const hide = hideRules(flags)
  if (hide !== undefined) options.hide = hide
  return options
}

function makeStores(deps: CliDeps, roots: string[]): SessionStore[] {
  const rootPaths =
    roots.length > 0 ? roots : [pathOps(deps.platformFlavor).join(deps.homedir(), '.claude')]
  return rootPaths.map((rootPath, index) => {
    const wsl = rootPath.match(/^\\\\wsl\$\\([^\\]+)/)
    return {
      id: rootPaths.length === 1 ? 'local' : `store${index}`,
      rootPath,
      // A WSL store read from Windows holds posix cwds in its transcripts.
      pathFlavor: wsl ? 'posix' : deps.platformFlavor,
      origin: wsl?.[1] !== undefined ? { kind: 'wsl', distro: wsl[1] } : { kind: 'native' },
      watchStrategy: 'poll',
    }
  })
}

async function enrich(state: CoreState, fs: FileSystem): Promise<CoreState> {
  return foldAll(state, await enrichGitContexts(state, fs))
}

export function formatSnapshot(snapshot: Snapshot): string {
  const lines: string[] = []
  const visible = snapshot.sessions.filter((s) => s.hiddenBy === undefined)
  const hiddenCount = snapshot.sessions.length - visible.length
  const active = visible.filter((s) => s.runtime.kind !== 'idle').length
  const visibleIds = new Set(visible.map((s) => s.id))

  const byProject = new Map<string, string[]>()
  for (const a of snapshot.assignments) {
    if (!visibleIds.has(a.sessionId)) continue
    const list = byProject.get(a.projectId) ?? []
    list.push(a.sessionId)
    byProject.set(a.projectId, list)
  }
  const shownProjects = snapshot.projects.filter((p) => (byProject.get(p.id) ?? []).length > 0)

  let header = `${visible.length} session(s) in ${shownProjects.length} project(s), ${active} active`
  if (hiddenCount > 0) header += `; ${hiddenCount} hidden (--all to show)`
  lines.push(header)

  const assigned = new Set(snapshot.assignments.map((a) => a.sessionId))
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]))

  // Display cwds relative to the project's shortest root that contains them.
  const relativeCwd = (cwd: string | undefined, roots: Array<{ path: string }>): string => {
    if (cwd === undefined) return '-'
    const containing = roots
      .map((r) => r.path)
      .filter((root) => cwd === root || cwd.startsWith(root + '/') || cwd.startsWith(root + '\\'))
      .sort((a, b) => a.length - b.length)[0]
    if (containing === undefined) return cwd
    return cwd === containing ? '.' : cwd.slice(containing.length + 1)
  }

  for (const project of shownProjects) {
    lines.push('')
    lines.push(`${project.name}  [${project.id}]`)
    const sessions = (byProject.get(project.id) ?? [])
      .map((id) => sessionById.get(id))
      .filter((s) => s !== undefined)
      .sort(
        (a, b) =>
          (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id),
      )
    for (const s of sessions) {
      const rawTitle = s.summary ?? s.promptPreview ?? s.firstCommand ?? '(untitled)'
      const title = rawTitle.length > 60 ? rawTitle.slice(0, 59) + '…' : rawTitle
      const when = s.lastActivityAt ?? '-'
      const mark = s.runtime.kind === 'idle' ? ' ' : '*'
      lines.push(`  ${mark} ${s.id.slice(0, 8)}  ${when}  ${relativeCwd(s.cwd, project.roots)}  ${title}`)
    }
  }

  const unassigned = visible.filter((s) => !assigned.has(s.id))
  if (unassigned.length > 0) {
    lines.push('')
    lines.push('(unassigned)')
    for (const s of unassigned) lines.push(`    ${s.id.slice(0, 8)}  ${s.lastActivityAt ?? '-'}`)
  }
  return lines.join('\n')
}

export interface Stats {
  total: number
  visible: number
  hidden: number
  entrypointsVisible: Record<string, number>
  entrypointsHidden: Record<string, number>
  hiddenByRule: Record<string, number>
}

export function computeStats(snapshot: Snapshot): Stats {
  const stats: Stats = {
    total: snapshot.sessions.length,
    visible: 0,
    hidden: 0,
    entrypointsVisible: {},
    entrypointsHidden: {},
    hiddenByRule: {},
  }
  const bump = (record: Record<string, number>, key: string): void => {
    record[key] = (record[key] ?? 0) + 1
  }
  for (const session of snapshot.sessions) {
    const isHidden = session.hiddenBy !== undefined
    if (isHidden) {
      stats.hidden += 1
      bump(stats.hiddenByRule, session.hiddenBy!)
    } else {
      stats.visible += 1
    }
    const target = isHidden ? stats.entrypointsHidden : stats.entrypointsVisible
    const keys = session.entrypoints.length > 0 ? session.entrypoints : ['(none)']
    for (const key of keys) bump(target, key)
  }
  return stats
}

function formatHistogram(title: string, record: Record<string, number>): string[] {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (entries.length === 0) return []
  const width = Math.max(...entries.map(([key]) => key.length))
  return [``, `${title}:`, ...entries.map(([key, n]) => `  ${key.padEnd(width)}  ${n}`)]
}

export function formatStats(stats: Stats): string {
  return [
    `sessions: ${stats.total} (${stats.visible} visible, ${stats.hidden} hidden)`,
    ...formatHistogram('entrypoints (visible sessions)', stats.entrypointsVisible),
    ...formatHistogram('entrypoints (hidden sessions)', stats.entrypointsHidden),
    ...formatHistogram('hidden by rule', stats.hiddenByRule),
  ].join('\n')
}

function printSnapshot(deps: CliDeps, snapshot: Snapshot, json: boolean): void {
  deps.write((json ? JSON.stringify(snapshot, null, 2) : formatSnapshot(snapshot)) + '\n')
}

async function scan(deps: CliDeps, flags: Flags): Promise<number> {
  let state = emptyState
  for (const store of makeStores(deps, flags.roots)) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  state = await enrich(state, deps.fs)
  printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags)), flags.json)
  return 0
}

async function statsCommand(deps: CliDeps, flags: Flags): Promise<number> {
  let state = emptyState
  for (const store of makeStores(deps, flags.roots)) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  // Stats never need the git enricher — visibility and entrypoints are
  // transcript-derived, so skip the expensive part.
  const stats = computeStats(buildSnapshot(state, snapshotOptions(deps, flags)))
  deps.write((flags.json ? JSON.stringify(stats, null, 2) : formatStats(stats)) + '\n')
  return 0
}

async function watch(deps: CliDeps, flags: Flags): Promise<number> {
  const tailers = makeStores(deps, flags.roots).map((store) => new StoreTailer(deps.fs, store))
  let state = emptyState
  for (const tailer of tailers) state = foldAll(state, await tailer.poll())
  state = await enrich(state, deps.fs)
  printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags)), flags.json)

  for (let tick = 0; flags.ticks === undefined || tick < flags.ticks; tick++) {
    await deps.sleep(flags.intervalMs)
    let changed = false
    for (const tailer of tailers) {
      const events = await tailer.poll()
      if (events.length > 0) {
        state = foldAll(state, events)
        changed = true
      }
    }
    if (!changed) continue
    state = await enrich(state, deps.fs)
    deps.write('---\n')
    printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags)), flags.json)
  }
  return 0
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv
  const flags = parseFlags(args)
  if (flags.error !== undefined) {
    deps.write(flags.error + '\n')
    return 1
  }

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      deps.write(USAGE + '\n')
      return 0

    case '--version':
    case '-v':
      deps.write(cliVersion() + '\n')
      return 0

    case 'update':
    case 'upgrade':
      return deps.selfUpdate()

    case 'bucket': {
      const cwd = flags.rest[0]
      if (cwd === undefined) {
        deps.write('bucket: missing <cwd> argument\n')
        return 1
      }
      const munged = mungeCwd(cwd)
      deps.write(
        (munged.kind === 'exact'
          ? munged.dirName
          : `${munged.dirNamePrefix}-* (truncated; suffix is a CLI-internal hash)`) + '\n',
      )
      return 0
    }

    case 'scan':
      return scan(deps, flags)

    case 'stats':
      return statsCommand(deps, flags)

    case 'watch':
      return watch(deps, flags)

    default:
      deps.write(`unknown command: ${command}\n\n${USAGE}\n`)
      return 1
  }
}

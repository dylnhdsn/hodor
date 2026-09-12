import {
  StoreTailer,
  addUsage,
  buildSnapshot,
  costOfUsage,
  defaultHideRules,
  defaultPricing,
  emptyState,
  emptyUsage,
  driveMountTranslator,
  enrichGitContexts,
  enrichCheckpointBackups,
  enrichMemoryFiles,
  foldAll,
  mergeHideRules,
  mergePricing,
  mungeCwd,
  pathOps,
  scanStore,
  translatePathFs,
  wslUncTranslator,
  type CoreState,
  type ModelPricing,
  type UsageTotals,
  type FileSystem,
  type HodorConfig,
  type SessionMeta,
  type SourceEvent,
  type StoreId,
  type HideRules,
  type PathFlavor,
  type SessionStore,
  type Snapshot,
  type SnapshotOptions,
} from '@hodor/core'
import { scanCloudSessions } from './cloud.js'
import { projectCommand, sessionCommand } from './curate.js'
import { composeLaunch, runLaunch } from './launch.js'
import { resolveStores, storeFs } from './stores.js'
import { formatSnapshot } from './format.js'
import { loadUserFiles, type UserFiles } from './userdata.js'
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
  /** Warnings and diagnostics — kept off stdout so --json stays parseable. */
  writeErr(text: string): void
  /** Installed WSL distro names when running on Windows; [] elsewhere. */
  listWslDistros(): Promise<string[]>
  /** The current distro name when running inside WSL; undefined elsewhere. */
  wslDistro(): string | undefined
  /** Environment variable lookup (HODOR_HOME). */
  env(name: string): string | undefined
  sleep(ms: number): Promise<void>
  /** Terminal width for human-readable output. */
  columns(): number
  /** Open a URL in the user's browser (best effort). */
  openUrl(url: string): Promise<void>
  /** Replace the installed bundle with the latest release (hodor update). */
  selfUpdate(): Promise<number>
  /** The real OS family (platformFlavor only says how paths look). */
  osPlatform: 'win32' | 'darwin' | 'linux'
  /** Fire-and-forget spawn; rejects when the executable can't start. */
  spawnDetached(file: string, args: string[]): Promise<void>
  /** Authenticated-by-caller JSON GET (cloud session listing). */
  httpGetJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json?: unknown }>
  /** Run a command to completion, capturing combined output. */
  runCapture(
    file: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ code: number; output: string }>
}

const USAGE = `hodor — session manager (data core, early days)

Usage:
  hodor scan [--json] [--root <path>]...    Discover and organize sessions
  hodor watch [--json] [--interval <ms>] [--root <path>]...
                                            Scan, then live-update on changes
  hodor stats [--json] [--root <path>]...   Entrypoint and visibility histograms
  hodor cloud                               List this account's cloud sessions
  hodor resume <sessionId> [--fork] [--print]
                                            Open a terminal resuming that session
                                            (--fork: new session id; --print:
                                            show the command instead)
  hodor ui [--port <n>]                     Start the local web UI and open it
  hodor serve [--port <n>]                  Start the UI/API server (default :4477)
  hodor project <list|create|rename|delete|match|unmatch|include|exclude>
                                            Curate custom projects (projects.json)
  hodor session <rename|archive|unarchive>  Per-session overrides (config.json)
  hodor bucket <cwd>                        Print the ~/.claude/projects bucket for a cwd
  hodor update                              Update to the latest build (alias: upgrade)
  hodor --version                           Print the CLI version

Stores default to <home>/.claude PLUS auto-discovered cross-boundary stores
(WSL distros from Windows, the Windows store from inside WSL) — one combined
view from either side. --no-discover limits to the local store; --root
replaces discovery with exactly the roots given.
User data lives in the hodor data home (HODOR_HOME; from WSL a unique
Windows-side C:\\Users\\<u>\\.hodor is shared; else <home>/.hodor):
  config.json    settings — hide-rule overrides, discoverStores, sessions
                 (rename/archive/pin), legacy splitRoots/projectNames
  projects.json  custom projects with evidence matchers (remote/root/cwd/
                 session), include/exclude — label semantics, a session can
                 belong to many; claimed sessions leave their auto project.

Visibility (scan/watch):
  --all            Show everything, including ephemeral/agent-run sessions
  --hide <rule>    Extra hide rule: an absolute path is a prefix (/srv/tmp),
                   a relative path with separators is a segment run matched
                   anywhere (Some/Sub/Dir), a bare name a directory (dist).
                   Defaults hide /tmp-like paths, node_modules, and
                   dot-directories except .claude. Hidden sessions stay in
                   --json output, tagged with the rule that hid them.
`.trim()

interface Flags {
  json: boolean
  all: boolean
  noDiscover: boolean
  fork: boolean
  print: boolean
  roots: string[]
  hide: string[]
  intervalMs: number
  port: number
  ticks?: number
  rest: string[]
  error?: string
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    json: false,
    all: false,
    noDiscover: false,
    fork: false,
    print: false,
    roots: [],
    hide: [],
    intervalMs: 2000,
    port: 4477,
    rest: [],
  }
  const valueFlags = new Set(['--root', '--interval', '--ticks', '--hide', '--port'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--json') flags.json = true
    else if (arg === '--all') flags.all = true
    else if (arg === '--no-discover') flags.noDiscover = true
    else if (arg === '--fork') flags.fork = true
    else if (arg === '--print') flags.print = true
    else if (valueFlags.has(arg)) {
      const value = args[++i]
      if (value === undefined) {
        flags.error = `${arg}: missing value`
        break
      }
      if (arg === '--root') flags.roots.push(value)
      if (arg === '--hide') flags.hide.push(value)
      if (arg === '--interval') flags.intervalMs = Number(value)
      if (arg === '--ticks') flags.ticks = Number(value)
      if (arg === '--port') flags.port = Number(value)
    } else flags.rest.push(arg)
  }
  return flags
}

function hideRules(flags: Flags, config: HodorConfig): HideRules | undefined {
  if (flags.all) return undefined
  const rules = mergeHideRules(defaultHideRules, config.hide)
  for (const value of flags.hide) {
    const absolute = value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
    if (absolute) rules.pathPrefixes.push(value)
    else if (/[\\/]/.test(value)) rules.pathInfixes.push(value)
    else rules.pathSegments.push(value)
  }
  return rules
}

function snapshotOptions(deps: CliDeps, flags: Flags, config: HodorConfig): SnapshotOptions {
  const options: SnapshotOptions = { now: deps.now() }
  const hide = hideRules(flags, config)
  if (hide !== undefined) options.hide = hide
  return options
}

/** Config and user plane enter the pure fold as events, like every input. */
function configEvents({ config, plane }: UserFiles): SourceEvent[] {
  const events: SourceEvent[] = [
    { type: 'config-changed', config },
    { type: 'userplane-changed', plane },
  ]
  for (const [sessionId, override] of Object.entries(config.sessions ?? {})) {
    const meta: SessionMeta = { sessionId }
    if (override.rename !== undefined) meta.rename = override.rename
    if (override.archived !== undefined) meta.archived = override.archived
    if (override.pinnedProject !== undefined) meta.pinnedProject = override.pinnedProject
    if (override.tags !== undefined) meta.tags = override.tags
    events.push({ type: 'meta-changed', meta })
  }
  return events
}

async function enrich(
  state: CoreState,
  fsFor: (storeId: StoreId) => FileSystem,
): Promise<CoreState> {
  // Memory probing keys off resolved git roots, so it runs after git.
  const withGit = foldAll(state, await enrichGitContexts(state, fsFor))
  const withMemory = foldAll(withGit, await enrichMemoryFiles(withGit, fsFor))
  return foldAll(withMemory, await enrichCheckpointBackups(withMemory, fsFor))
}

export interface Stats {
  total: number
  visible: number
  hidden: number
  sessionsWithSubagents: number
  subagentRuns: number
  /** Runs split by whether their session is visible — the UI's default
   * list only shows visible sessions, so this answers "where are they". */
  subagentRunsVisible: number
  subagentRunsHidden: number
  topSubagentSessions: Array<{
    id: string
    runs: number
    hiddenBy?: string
    title: string
  }>
  usage: {
    /** Estimated USD across every session (hidden included — money is money). */
    totalUsd: number
    /** Portion spent inside subagent (sidechain) threads. */
    subagentUsd: number
    /** Models with tokens but no pricing entry — totalUsd is a floor. */
    unpriced: string[]
    byModel: Record<string, UsageTotals & { usd: number }>
  }
  topCostSessions: Array<{ id: string; usd: number; hiddenBy?: string; title: string }>
  /** tool_use blocks by tool name, across every session. */
  tools: Record<string, number>
  /** Memory files found on disk (CLAUDE.md and friends). */
  memory: { files: number; roots: number; totalBytes: number; userMemory: boolean }
  /** Checkpoint (/rewind) coverage across sessions. */
  checkpoints: { sessions: number; count: number; restorable: number }
  entrypointsVisible: Record<string, number>
  entrypointsHidden: Record<string, number>
  hiddenByRule: Record<string, number>
}

export function computeStats(
  snapshot: Snapshot,
  pricing: Record<string, ModelPricing> = defaultPricing,
): Stats {
  const stats: Stats = {
    total: snapshot.sessions.length,
    visible: 0,
    hidden: 0,
    sessionsWithSubagents: 0,
    subagentRuns: 0,
    subagentRunsVisible: 0,
    subagentRunsHidden: 0,
    topSubagentSessions: [],
    usage: { totalUsd: 0, subagentUsd: 0, unpriced: [], byModel: {} },
    topCostSessions: [],
    tools: {},
    memory: { files: 0, roots: 0, totalBytes: 0, userMemory: false },
    checkpoints: { sessions: 0, count: 0, restorable: 0 },
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
    if (session.counts.sidechains > 0) {
      stats.sessionsWithSubagents += 1
      stats.subagentRuns += session.counts.sidechains
      if (isHidden) stats.subagentRunsHidden += session.counts.sidechains
      else stats.subagentRunsVisible += session.counts.sidechains
      stats.topSubagentSessions.push({
        id: session.id,
        runs: session.counts.sidechains,
        ...(session.hiddenBy !== undefined ? { hiddenBy: session.hiddenBy } : {}),
        title:
          session.rename ?? session.summary ?? session.promptPreview ?? session.firstCommand ?? '(untitled)',
      })
    }
    if (session.costUsd !== undefined && session.costUsd > 0) {
      stats.usage.totalUsd += session.costUsd
      stats.topCostSessions.push({
        id: session.id,
        usd: session.costUsd,
        ...(session.hiddenBy !== undefined ? { hiddenBy: session.hiddenBy } : {}),
        title:
          session.rename ?? session.summary ?? session.promptPreview ?? session.firstCommand ?? '(untitled)',
      })
    }
    for (const thread of session.threads) {
      if (thread.kind === 'sidechain' && thread.costUsd !== undefined) {
        stats.usage.subagentUsd += thread.costUsd
      }
    }
    for (const [model, totals] of Object.entries(session.usage ?? {})) {
      const entry = (stats.usage.byModel[model] ??= { ...emptyUsage(), usd: 0 })
      addUsage(entry, totals)
    }
    for (const model of session.costUnpriced ?? []) {
      if (!stats.usage.unpriced.includes(model)) stats.usage.unpriced.push(model)
    }
    for (const [tool, n] of Object.entries(session.toolCounts ?? {})) {
      stats.tools[tool] = (stats.tools[tool] ?? 0) + n
    }
    if (session.checkpoints !== undefined) {
      stats.checkpoints.sessions += 1
      stats.checkpoints.count += session.checkpoints.count
      if ((session.checkpoints.backupFiles ?? 0) > 0) stats.checkpoints.restorable += 1
    }
    const target = isHidden ? stats.entrypointsHidden : stats.entrypointsVisible
    const keys = session.entrypoints.length > 0 ? session.entrypoints : ['(none)']
    for (const key of keys) bump(target, key)
  }
  const memoryRoots = new Set<string>()
  for (const file of snapshot.memoryFiles) {
    stats.memory.files += 1
    stats.memory.totalBytes += file.bytes
    if (file.userLevel) stats.memory.userMemory = true
    else memoryRoots.add(file.root)
  }
  stats.memory.roots = memoryRoots.size
  for (const [model, entry] of Object.entries(stats.usage.byModel)) {
    entry.usd = costOfUsage({ [model]: entry }, pricing).usd
  }
  stats.usage.unpriced.sort()
  stats.topSubagentSessions.sort((a, b) => b.runs - a.runs || a.id.localeCompare(b.id))
  stats.topSubagentSessions = stats.topSubagentSessions.slice(0, 8)
  stats.topCostSessions.sort((a, b) => b.usd - a.usd || a.id.localeCompare(b.id))
  stats.topCostSessions = stats.topCostSessions.slice(0, 8)
  return stats
}

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const formatUsd = (usd: number): string =>
  usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`

function formatHistogram(title: string, record: Record<string, number>): string[] {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (entries.length === 0) return []
  const width = Math.max(...entries.map(([key]) => key.length))
  return [``, `${title}:`, ...entries.map(([key, n]) => `  ${key.padEnd(width)}  ${n}`)]
}

export function formatStats(stats: Stats): string {
  const lines = [
    `sessions: ${stats.total} (${stats.visible} visible, ${stats.hidden} hidden)`,
    `subagent runs: ${stats.subagentRuns} across ${stats.sessionsWithSubagents} sessions` +
      (stats.subagentRuns > 0
        ? ` (${stats.subagentRunsVisible} on visible sessions, ${stats.subagentRunsHidden} on hidden)`
        : ''),
  ]
  if (stats.usage.totalUsd > 0 || stats.usage.unpriced.length > 0) {
    const unpriced =
      stats.usage.unpriced.length > 0 ? ` — unpriced: ${stats.usage.unpriced.join(', ')}` : ''
    lines.push(
      `est. cost: ${formatUsd(stats.usage.totalUsd)} total, ${formatUsd(stats.usage.subagentUsd)} in subagent runs${unpriced}`,
    )
    const models = Object.entries(stats.usage.byModel).sort((a, b) => b[1].usd - a[1].usd)
    if (models.length > 0) {
      lines.push('', 'by model:')
      const width = Math.max(...models.map(([m]) => m.length))
      for (const [model, u] of models) {
        const think = u.thinking > 0 ? `  think ${formatTokens(u.thinking).padStart(7)}` : ''
        lines.push(
          `  ${model.padEnd(width)}  in ${formatTokens(u.input).padStart(7)}  out ${formatTokens(u.output).padStart(7)}  cache r ${formatTokens(u.cacheRead).padStart(7)} w ${formatTokens(u.cacheWrite5m + u.cacheWrite1h).padStart(7)}${think}  ${formatUsd(u.usd)}`,
        )
      }
    }
  }
  if (stats.topCostSessions.length > 0) {
    lines.push('', 'top sessions by est. cost:')
    for (const s of stats.topCostSessions) {
      const state = s.hiddenBy !== undefined ? `hidden (${s.hiddenBy})` : 'visible'
      lines.push(`  ${s.id.slice(0, 8)}  ${formatUsd(s.usd).padStart(8)}  ${state}  ${s.title.slice(0, 55)}`)
    }
  }
  if (stats.topSubagentSessions.length > 0) {
    lines.push('', 'top sessions by subagent runs:')
    for (const s of stats.topSubagentSessions) {
      const state = s.hiddenBy !== undefined ? `hidden (${s.hiddenBy})` : 'visible'
      lines.push(`  ${s.id.slice(0, 8)}  ${String(s.runs).padStart(3)}  ${state}  ${s.title.slice(0, 60)}`)
    }
  }
  if (stats.checkpoints.sessions > 0) {
    lines.push(
      `checkpoints: ${stats.checkpoints.count} across ${stats.checkpoints.sessions} sessions, ${stats.checkpoints.restorable} still restorable`,
    )
  }
  if (stats.memory.files > 0) {
    lines.push(
      `memory files: ${stats.memory.files} across ${stats.memory.roots} project roots, ${(stats.memory.totalBytes / 1024).toFixed(1)}k total${stats.memory.userMemory ? ' (+ user memory)' : ''}`,
    )
  }
  lines.push(
    ...formatHistogram('tool calls', stats.tools),
    ...formatHistogram('entrypoints (visible sessions)', stats.entrypointsVisible),
    ...formatHistogram('entrypoints (hidden sessions)', stats.entrypointsHidden),
    ...formatHistogram('hidden by rule', stats.hiddenByRule),
  )
  return lines.join('\n')
}

function printSnapshot(deps: CliDeps, snapshot: Snapshot, json: boolean): void {
  deps.write(
    (json ? JSON.stringify(snapshot, null, 2) : formatSnapshot(snapshot, deps.columns())) + '\n',
  )
}

async function scan(deps: CliDeps, flags: Flags): Promise<number> {
  const files = await loadUserFiles(deps)
  const config = files.config
  const stores = await resolveStores(deps, { roots: flags.roots, noDiscover: flags.noDiscover }, config)
  let state = foldAll(emptyState, configEvents(files))
  for (const store of stores) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  state = await enrich(state, storeFs(deps, stores))
  printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags, config)), flags.json)
  return 0
}

/** hodor cloud — list this account's cloud sessions (claude.ai/code). */
async function cloudCommand(deps: CliDeps): Promise<number> {
  const event = await scanCloudSessions(deps)
  if (event === undefined) {
    deps.write('no claude.ai login found (~/.claude/.credentials.json) — cloud sessions unavailable\n')
    return 1
  }
  if (event.type !== 'cloud-sessions-scanned') return 1
  if (event.error !== undefined) {
    deps.write(`${event.error}\n`)
    return 1
  }
  if (event.sessions.length === 0) {
    deps.write('no cloud sessions\n')
    return 0
  }
  const nowMs = deps.now().getTime()
  for (const s of [...event.sessions].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  )) {
    const age = s.updatedAt !== undefined ? formatAgeMs(nowMs - Date.parse(s.updatedAt)) : '-'
    const bucket = s.bucket ?? s.status
    const line = [
      s.id.slice(0, 20).padEnd(20),
      age.padStart(4),
      bucket.padEnd(12),
      (s.repo ?? '').padEnd(28),
      s.title ?? '',
    ].join('  ')
    deps.write(`${line.trimEnd()}\n`)
    if (s.needsAction !== undefined) deps.write(`${' '.repeat(28)}needs you: ${s.needsAction}\n`)
  }
  deps.write(`\n${event.sessions.length} cloud sessions · teleport: claude --teleport <id>\n`)
  return 0
}

function formatAgeMs(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** hodor resume <sessionId> [--fork] [--print] — open a terminal on it. */
async function resumeCommand(deps: CliDeps, flags: Flags): Promise<number> {
  const idArg = flags.rest[0]
  if (idArg === undefined) {
    deps.writeErr('hodor: resume needs a session id (a unique prefix works)\n')
    return 1
  }
  const files = await loadUserFiles(deps)
  const stores = await resolveStores(
    deps,
    { roots: flags.roots, noDiscover: flags.noDiscover },
    files.config,
  )
  let state = foldAll(emptyState, configEvents(files))
  for (const store of stores) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }

  const matches = Object.values(state.sessions).filter((s) => s.id.startsWith(idArg))
  if (matches.length === 0) return fail(deps, `no session matches "${idArg}"`)
  if (matches.length > 1) {
    return fail(deps, `"${idArg}" is ambiguous (${matches.length} sessions) — give more of the id`)
  }
  const session = matches[0]!
  // First cwd, not last: the store bucket is keyed by where the session
  // started, and resuming elsewhere would re-home it into a new bucket.
  const cwd = session.cwds[0]
  if (cwd === undefined) return fail(deps, `session ${session.id.slice(0, 8)} has no cwd`)
  const store = state.stores[session.storeId]
  if (store === undefined) return fail(deps, 'session store unknown')

  const target = {
    cwd,
    flavor: store.pathFlavor,
    origin: store.origin,
    claudeArgs: ['--resume', session.id, ...(flags.fork ? ['--fork-session'] : [])],
  }
  if (flags.print) {
    const plan = composeLaunch({ os: deps.osPlatform, wslDistro: deps.wslDistro() }, target)
    deps.write(`cd ${JSON.stringify(plan.cwd)}\n${plan.command}\n`)
    return 0
  }
  const result = await runLaunch(deps, target)
  if (result.ok) {
    deps.write(`launched ${result.method} in ${result.cwd}\n`)
    return 0
  }
  deps.writeErr(`hodor: could not open a terminal (${result.error ?? 'unknown'})\n`)
  deps.write(`run it yourself:\n  cd ${JSON.stringify(result.cwd)}\n  ${result.command}\n`)
  return 1
}

function fail(deps: CliDeps, message: string): number {
  deps.writeErr(`hodor: ${message}\n`)
  return 1
}

async function statsCommand(deps: CliDeps, flags: Flags): Promise<number> {
  const files = await loadUserFiles(deps)
  const config = files.config
  const stores = await resolveStores(deps, { roots: flags.roots, noDiscover: flags.noDiscover }, config)
  let state = foldAll(emptyState, configEvents(files))
  for (const store of stores) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  // Enrichment earns its keep here now: memory files hang off git roots.
  state = await enrich(state, storeFs(deps, stores))
  const stats = computeStats(
    buildSnapshot(state, snapshotOptions(deps, flags, config)),
    mergePricing(config.pricing),
  )
  deps.write((flags.json ? JSON.stringify(stats, null, 2) : formatStats(stats)) + '\n')
  return 0
}

async function watch(deps: CliDeps, flags: Flags): Promise<number> {
  const files = await loadUserFiles(deps)
  const config = files.config
  const stores = await resolveStores(deps, { roots: flags.roots, noDiscover: flags.noDiscover }, config)
  const fsFor = storeFs(deps, stores)
  const tailers = stores.map((store) => new StoreTailer(deps.fs, store))
  let state = foldAll(emptyState, configEvents(files))
  for (const tailer of tailers) state = foldAll(state, await tailer.poll())
  state = await enrich(state, fsFor)
  printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags, config)), flags.json)

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
    state = await enrich(state, fsFor)
    deps.write('---\n')
    printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags, config)), flags.json)
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

    case 'serve':
    case 'ui': {
      const { startServer } = await import('./server.js')
      const server = await startServer(deps, { port: flags.port })
      deps.write(`hodor ui at ${server.url} (Ctrl+C to stop)\n`)
      if (command === 'ui') await deps.openUrl(server.url)
      // Runs until interrupted; tests use startServer directly instead.
      return new Promise<number>(() => {})
    }

    case 'resume':
      return resumeCommand(deps, flags)

    case 'project':
      return projectCommand(deps, args)

    case 'session':
      return sessionCommand(deps, args)

    case 'scan':
      return scan(deps, flags)

    case 'stats':
      return statsCommand(deps, flags)

    case 'cloud':
      return cloudCommand(deps)

    case 'watch':
      return watch(deps, flags)

    default:
      deps.write(`unknown command: ${command}\n\n${USAGE}\n`)
      return 1
  }
}

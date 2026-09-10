import {
  StoreTailer,
  buildSnapshot,
  defaultHideRules,
  emptyState,
  driveMountTranslator,
  enrichGitContexts,
  foldAll,
  emptyUserPlane,
  flavorOfPath,
  mergeHideRules,
  mungeCwd,
  parseHodorConfig,
  parseUserPlane,
  pathOps,
  scanStore,
  translatePathFs,
  wslUncTranslator,
  type CoreState,
  type FileSystem,
  type HodorConfig,
  type SessionMeta,
  type SourceEvent,
  type StoreId,
  type HideRules,
  type UserPlane,
  type PathFlavor,
  type SessionStore,
  type Snapshot,
  type SnapshotOptions,
} from '@hodor/core'
import { formatSnapshot } from './format.js'
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
  roots: string[]
  hide: string[]
  intervalMs: number
  ticks?: number
  rest: string[]
  error?: string
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    json: false,
    all: false,
    noDiscover: false,
    roots: [],
    hide: [],
    intervalMs: 2000,
    rest: [],
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--json') flags.json = true
    else if (arg === '--all') flags.all = true
    else if (arg === '--no-discover') flags.noDiscover = true
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

/**
 * Where the user plane lives (docs/brainstorm/008): HODOR_HOME wins; from
 * inside WSL a unique Windows-side install (/mnt/c/Users/<u>/.hodor) is the
 * home, so Windows and WSL share one set of user data; otherwise ~/.hodor.
 */
async function resolveDataHome(deps: CliDeps): Promise<string> {
  const override = deps.env('HODOR_HOME')
  if (override !== undefined && override.length > 0) return override
  if (deps.platformFlavor === 'posix' && deps.wslDistro() !== undefined) {
    const candidates: string[] = []
    for (const user of await deps.fs.listDir('/mnt/c/Users')) {
      const dir = `/mnt/c/Users/${user}/.hodor`
      if ((await deps.fs.stat(dir))?.kind === 'dir') candidates.push(dir)
    }
    if (candidates.length === 1) return candidates[0]!
    if (candidates.length > 1) {
      deps.writeErr(
        'hodor: multiple Windows .hodor homes found; using the local one (set HODOR_HOME to choose)\n',
      )
    }
  }
  return pathOps(deps.platformFlavor).join(deps.homedir(), '.hodor')
}

interface UserFiles {
  config: HodorConfig
  plane: UserPlane
}

async function loadUserFiles(deps: CliDeps): Promise<UserFiles> {
  const home = await resolveDataHome(deps)
  const p = pathOps(flavorOfPath(home))

  let config: HodorConfig = {}
  const configPath = p.join(home, 'config.json')
  const configRaw = await deps.fs.readFile(configPath)
  if (configRaw !== undefined) {
    const parsed = parseHodorConfig(configRaw)
    if (parsed.error !== undefined) deps.writeErr(`hodor: ignoring ${configPath}: ${parsed.error}\n`)
    config = parsed.config
  }

  let plane: UserPlane = emptyUserPlane
  const planePath = p.join(home, 'projects.json')
  const planeRaw = await deps.fs.readFile(planePath)
  if (planeRaw !== undefined) {
    const parsed = parseUserPlane(planeRaw)
    if (parsed.error !== undefined) deps.writeErr(`hodor: ignoring ${planePath}: ${parsed.error}\n`)
    plane = parsed.plane
  }

  return { config, plane }
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

const hasProjects = async (deps: CliDeps, root: string, sep: string): Promise<boolean> =>
  (await deps.fs.stat(`${root}${sep}projects`))?.kind === 'dir'

/**
 * Cross-boundary discovery: from Windows, find each WSL distro's stores
 * behind \\wsl$; from inside WSL, find Windows stores behind /mnt/c. Both
 * sides then present one combined view.
 */
async function discoverCrossStores(deps: CliDeps): Promise<SessionStore[]> {
  const stores: SessionStore[] = []

  if (deps.platformFlavor === 'win32') {
    for (const distro of await deps.listWslDistros()) {
      const base = `\\\\wsl$\\${distro}`
      const candidates = [
        ...(await deps.fs.listDir(`${base}\\home`)).map((user) => `${base}\\home\\${user}\\.claude`),
        `${base}\\root\\.claude`,
      ]
      const found: string[] = []
      for (const root of candidates) {
        if (await hasProjects(deps, root, '\\')) found.push(root)
      }
      for (const rootPath of found) {
        const user = rootPath.split('\\').slice(-2, -1)[0] ?? 'home'
        stores.push({
          id: found.length === 1 ? `wsl:${distro}` : `wsl:${distro}:${user}`,
          rootPath,
          pathFlavor: 'posix',
          origin: { kind: 'wsl', distro },
          watchStrategy: 'poll',
        })
      }
    }
    return stores
  }

  if (deps.wslDistro() !== undefined) {
    for (const user of await deps.fs.listDir('/mnt/c/Users')) {
      const rootPath = `/mnt/c/Users/${user}/.claude`
      if (await hasProjects(deps, rootPath, '/')) {
        stores.push({
          id: `win:${user}`,
          rootPath,
          // The Windows store's transcripts record win32 cwds; access to
          // those paths goes through the drive mount.
          pathFlavor: 'win32',
          origin: { kind: 'windows', mountRoot: '/mnt' },
          watchStrategy: 'poll',
        })
      }
    }
  }
  return stores
}

async function resolveStores(deps: CliDeps, flags: Flags, config: HodorConfig): Promise<SessionStore[]> {
  if (flags.roots.length > 0) return makeStores(deps, flags.roots)
  const stores = makeStores(deps, [])
  if (!flags.noDiscover && config.discoverStores !== false) {
    stores.push(...(await discoverCrossStores(deps)))
  }
  return stores
}

/**
 * Per-store filesystem for reading cwd-relative things (git metadata): a
 * WSL store's posix cwds are reachable from Windows only via \\wsl$\<distro>.
 */
function storeFs(deps: CliDeps, stores: SessionStore[]): (storeId: StoreId) => FileSystem {
  const byStore = new Map<StoreId, FileSystem>()
  for (const store of stores) {
    if (store.origin.kind === 'wsl') {
      byStore.set(store.id, translatePathFs(deps.fs, wslUncTranslator(store.origin.distro)))
    } else if (store.origin.kind === 'windows') {
      byStore.set(store.id, translatePathFs(deps.fs, driveMountTranslator(store.origin.mountRoot)))
    } else {
      byStore.set(store.id, deps.fs)
    }
  }
  return (storeId) => byStore.get(storeId) ?? deps.fs
}

async function enrich(
  state: CoreState,
  fsFor: (storeId: StoreId) => FileSystem,
): Promise<CoreState> {
  return foldAll(state, await enrichGitContexts(state, fsFor))
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
  deps.write(
    (json ? JSON.stringify(snapshot, null, 2) : formatSnapshot(snapshot, deps.columns())) + '\n',
  )
}

async function scan(deps: CliDeps, flags: Flags): Promise<number> {
  const files = await loadUserFiles(deps)
  const config = files.config
  const stores = await resolveStores(deps, flags, config)
  let state = foldAll(emptyState, configEvents(files))
  for (const store of stores) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  state = await enrich(state, storeFs(deps, stores))
  printSnapshot(deps, buildSnapshot(state, snapshotOptions(deps, flags, config)), flags.json)
  return 0
}

async function statsCommand(deps: CliDeps, flags: Flags): Promise<number> {
  const files = await loadUserFiles(deps)
  const config = files.config
  let state = foldAll(emptyState, configEvents(files))
  for (const store of await resolveStores(deps, flags, config)) {
    state = foldAll(state, await scanStore(deps.fs, store))
  }
  // Stats never need the git enricher — visibility and entrypoints are
  // transcript-derived, so skip the expensive part.
  const stats = computeStats(buildSnapshot(state, snapshotOptions(deps, flags, config)))
  deps.write((flags.json ? JSON.stringify(stats, null, 2) : formatStats(stats)) + '\n')
  return 0
}

async function watch(deps: CliDeps, flags: Flags): Promise<number> {
  const files = await loadUserFiles(deps)
  const config = files.config
  const stores = await resolveStores(deps, flags, config)
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

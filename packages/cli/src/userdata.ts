import {
  emptyUserPlane,
  flavorOfPath,
  parseHodorConfig,
  parseUserPlane,
  pathOps,
  serializeConfig,
  serializeUserPlane,
  type HodorConfig,
  type UserPlane,
} from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Where the user plane lives (docs/brainstorm/008): HODOR_HOME wins; from
 * inside WSL a unique Windows-side install (/mnt/c/Users/<u>/.hodor) is the
 * home, so Windows and WSL share one set of user data; otherwise ~/.hodor.
 */
export async function resolveDataHome(deps: CliDeps): Promise<string> {
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

export interface UserFiles {
  home: string
  config: HodorConfig
  plane: UserPlane
}

export async function loadUserFiles(deps: CliDeps): Promise<UserFiles> {
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

  return { home, config, plane }
}

export async function saveUserPlane(deps: CliDeps, home: string, plane: UserPlane): Promise<void> {
  const p = pathOps(flavorOfPath(home))
  await deps.fs.writeFile(p.join(home, 'projects.json'), serializeUserPlane(plane))
}

export async function saveConfig(deps: CliDeps, home: string, config: HodorConfig): Promise<void> {
  const p = pathOps(flavorOfPath(home))
  await deps.fs.writeFile(p.join(home, 'config.json'), serializeConfig(config))
}

import {
  translatePathFs,
  driveMountTranslator,
  pathOps,
  wslUncTranslator,
  type FileSystem,
  type HodorConfig,
  type SessionStore,
  type StoreId,
} from '@hodor/core'
import type { CliDeps } from './main.js'

export function makeStores(deps: CliDeps, roots: string[]): SessionStore[] {
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

export interface StoreSelection {
  roots: string[]
  noDiscover: boolean
}

export async function resolveStores(
  deps: CliDeps,
  selection: StoreSelection,
  config: HodorConfig,
): Promise<SessionStore[]> {
  if (selection.roots.length > 0) return makeStores(deps, selection.roots)
  const stores = makeStores(deps, [])
  if (!selection.noDiscover && config.discoverStores !== false) {
    stores.push(...(await discoverCrossStores(deps)))
  }
  return stores
}

/**
 * Per-store filesystem for reading cwd-relative things (git metadata): a
 * WSL store's posix cwds are reachable from Windows only via \\wsl$\<distro>.
 */
export function storeFs(deps: CliDeps, stores: SessionStore[]): (storeId: StoreId) => FileSystem {
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


import {
  applyPlaneOp,
  applySessionOp,
  parseMatcherArg,
  slugifyProjectId,
  type PlaneOp,
} from '@hodor/core'
import type { CliDeps } from './main.js'
import { loadUserFiles, saveConfig, saveUserPlane } from './userdata.js'

/**
 * Curation verbs: thin shells over the pure edit ops in core. The HTTP API
 * reuses the same ops, so CLI and UI mutations behave identically.
 */

const PROJECT_USAGE = `Usage:
  hodor project list
  hodor project create <name>... [--match <kind>=<value>]...
  hodor project rename <id> <name>...
  hodor project delete <id>
  hodor project match <id> <kind>=<value>     kinds: remote, root, cwd, session
  hodor project unmatch <id> <kind>=<value>
  hodor project include <id> <sessionId>...
  hodor project exclude <id> <sessionId>...`

const SESSION_USAGE = `Usage:
  hodor session rename <sessionId> <name>...
  hodor session archive <sessionId>...
  hodor session unarchive <sessionId>...`

function fail(deps: CliDeps, message: string): number {
  deps.writeErr(`hodor: ${message}\n`)
  return 1
}

async function applyAndSavePlane(deps: CliDeps, op: PlaneOp, done: string): Promise<number> {
  const files = await loadUserFiles(deps)
  const result = applyPlaneOp(files.plane, op)
  if (result.error !== undefined) return fail(deps, result.error)
  await saveUserPlane(deps, files.home, result.plane)
  deps.write(done + '\n')
  return 0
}

export async function projectCommand(deps: CliDeps, args: string[]): Promise<number> {
  const [sub, ...rest] = args

  switch (sub) {
    case 'list': {
      const files = await loadUserFiles(deps)
      if (files.plane.projects.length === 0) {
        deps.write('no custom projects yet — hodor project create <name>\n')
        return 0
      }
      for (const p of files.plane.projects) {
        const counts = [
          `${p.matchers.length} matcher${p.matchers.length === 1 ? '' : 's'}`,
          ...(p.include.length > 0 ? [`${p.include.length} included`] : []),
          ...(p.exclude.length > 0 ? [`${p.exclude.length} excluded`] : []),
        ]
        deps.write(`${p.id}  ${p.name}  (${counts.join(', ')})\n`)
        for (const m of p.matchers) {
          const value = 'url' in m ? m.url : 'path' in m ? m.path : 'prefix' in m ? m.prefix : m.id
          deps.write(`  ${m.kind}=${value}\n`)
        }
      }
      return 0
    }

    case 'create': {
      const matchers = []
      const nameParts: string[] = []
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--match') {
          const parsed = parseMatcherArg(rest[++i] ?? '')
          if (parsed === undefined) return fail(deps, `--match expects <kind>=<value>\n${PROJECT_USAGE}`)
          matchers.push(parsed)
        } else nameParts.push(rest[i]!)
      }
      const name = nameParts.join(' ').trim()
      if (name.length === 0) return fail(deps, `create needs a name\n${PROJECT_USAGE}`)
      const files = await loadUserFiles(deps)
      const id = slugifyProjectId(name, new Set(files.plane.projects.map((p) => p.id)))
      const result = applyPlaneOp(files.plane, { op: 'create-project', id, name, matchers })
      if (result.error !== undefined) return fail(deps, result.error)
      await saveUserPlane(deps, files.home, result.plane)
      deps.write(`created project "${name}" (${id})\n`)
      return 0
    }

    case 'rename': {
      const [id, ...nameParts] = rest
      const name = nameParts.join(' ').trim()
      if (id === undefined || name.length === 0) return fail(deps, PROJECT_USAGE)
      return applyAndSavePlane(deps, { op: 'rename-project', id, name }, `renamed ${id} to "${name}"`)
    }

    case 'delete': {
      const id = rest[0]
      if (id === undefined) return fail(deps, PROJECT_USAGE)
      return applyAndSavePlane(deps, { op: 'delete-project', id }, `deleted ${id}`)
    }

    case 'match':
    case 'unmatch': {
      const [id, arg] = rest
      const matcher = parseMatcherArg(arg ?? '')
      if (id === undefined || matcher === undefined) return fail(deps, PROJECT_USAGE)
      const op: PlaneOp =
        sub === 'match' ? { op: 'add-matcher', id, matcher } : { op: 'remove-matcher', id, matcher }
      return applyAndSavePlane(deps, op, `${sub === 'match' ? 'added' : 'removed'} ${arg} on ${id}`)
    }

    case 'include':
    case 'exclude': {
      const [id, ...sessionIds] = rest
      if (id === undefined || sessionIds.length === 0) return fail(deps, PROJECT_USAGE)
      return applyAndSavePlane(
        deps,
        { op: sub, id, sessionIds },
        `${sub}d ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'} on ${id}`,
      )
    }

    default:
      deps.write(PROJECT_USAGE + '\n')
      return sub === undefined ? 0 : 1
  }
}

export async function sessionCommand(deps: CliDeps, args: string[]): Promise<number> {
  const [sub, ...rest] = args

  switch (sub) {
    case 'rename': {
      const [sessionId, ...nameParts] = rest
      const name = nameParts.join(' ').trim()
      if (sessionId === undefined || name.length === 0) return fail(deps, SESSION_USAGE)
      const files = await loadUserFiles(deps)
      const config = applySessionOp(files.config, { op: 'rename-session', sessionId, name })
      await saveConfig(deps, files.home, config)
      deps.write(`renamed ${sessionId.slice(0, 8)} to "${name}"\n`)
      return 0
    }

    case 'archive':
    case 'unarchive': {
      if (rest.length === 0) return fail(deps, SESSION_USAGE)
      const files = await loadUserFiles(deps)
      let config = files.config
      for (const sessionId of rest) {
        config = applySessionOp(config, {
          op: 'archive-session',
          sessionId,
          archived: sub === 'archive',
        })
      }
      await saveConfig(deps, files.home, config)
      deps.write(`${sub}d ${rest.length} session${rest.length === 1 ? '' : 's'}\n`)
      return 0
    }

    default:
      deps.write(SESSION_USAGE + '\n')
      return sub === undefined ? 0 : 1
  }
}

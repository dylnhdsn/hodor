import {
  applyPlaneOp,
  applySessionOp,
  describeMatcher,
  parseMatcherArg,
  slugifyProjectId,
  type PlaneOp,
  type UserPlane,
} from '@hodor/core'
import type { CliDeps } from './main.js'
import { derivedProjects, materializeTarget, type ResolvedTarget } from './materialize.js'
import { loadUserFiles, saveConfig, saveUserPlane, type UserFiles } from './userdata.js'

/**
 * Curation verbs: thin shells over the pure edit ops in core. The HTTP API
 * reuses the same ops, so CLI and UI mutations behave identically.
 *
 * Ids may name auto (derived) projects: the edit materializes them first
 * (docs/brainstorm/010). delete and revert only ever touch custom records.
 */

const PROJECT_USAGE = `Usage:
  hodor project list
  hodor project create <name>... [--match <kind>=<value>]...
  hodor project rename <id> <name>...
  hodor project archive <id>
  hodor project unarchive <id>
  hodor project revert <id>                   dissolve a materialized project
  hodor project delete <id>
  hodor project match <id> <kind>=<value>     kinds: remote, root, cwd, dir, session
  hodor project unmatch <id> <kind>=<value>
  hodor project exclude-match <id> <kind>=<value>
  hodor project unexclude-match <id> <kind>=<value>
  hodor project include <id> <sessionId>...
  hodor project exclude <id> <sessionId>...
  hodor project unpin <id> <sessionId>...     remove includes without excluding
  hodor project merge <into> <from>
  hodor project split <id> <root> <name>...`

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

/** Resolve a target id, materializing an auto project when needed. */
async function resolveTarget(
  deps: CliDeps,
  files: UserFiles,
  plane: UserPlane,
  id: string,
): Promise<ResolvedTarget | { error: string }> {
  const direct = materializeTarget(plane, [], id)
  if (!('error' in direct)) return direct
  return materializeTarget(plane, await derivedProjects(deps, files), id)
}

/** Apply an op to a project that may still be auto, then save once. */
async function applyToProject(
  deps: CliDeps,
  targetId: string,
  makeOp: (id: string) => PlaneOp,
  done: (id: string) => string,
): Promise<number> {
  const files = await loadUserFiles(deps)
  const resolved = await resolveTarget(deps, files, files.plane, targetId)
  if ('error' in resolved) return fail(deps, resolved.error)
  const result = applyPlaneOp(resolved.plane, makeOp(resolved.id))
  if (result.error !== undefined) return fail(deps, result.error)
  await saveUserPlane(deps, files.home, result.plane)
  if (resolved.materialized !== undefined) {
    deps.write(`materialized ${resolved.materialized} as ${resolved.id}\n`)
  }
  deps.write(done(resolved.id) + '\n')
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
          ...(p.excludeMatchers.length > 0 ? [`${p.excludeMatchers.length} exclude-matchers`] : []),
          ...(p.include.length > 0 ? [`${p.include.length} included`] : []),
          ...(p.exclude.length > 0 ? [`${p.exclude.length} excluded`] : []),
          ...(p.archived === true ? ['archived'] : []),
          ...(p.derivedFrom !== undefined ? [`was ${p.derivedFrom}`] : []),
        ]
        deps.write(`${p.id}  ${p.name}  (${counts.join(', ')})\n`)
        for (const m of p.matchers) {
          deps.write(`  ${describeMatcher(m)}\n`)
        }
        for (const m of p.excludeMatchers) {
          deps.write(`  not ${describeMatcher(m)}\n`)
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
      return applyToProject(
        deps,
        id,
        (rid) => ({ op: 'rename-project', id: rid, name }),
        (rid) => `renamed ${rid} to "${name}"`,
      )
    }

    case 'archive':
    case 'unarchive': {
      const id = rest[0]
      if (id === undefined) return fail(deps, PROJECT_USAGE)
      const archived = sub === 'archive'
      return applyToProject(
        deps,
        id,
        (rid) => ({ op: 'archive-project', id: rid, archived }),
        (rid) => `${sub}d ${rid}`,
      )
    }

    case 'revert': {
      const id = rest[0]
      if (id === undefined) return fail(deps, PROJECT_USAGE)
      const files = await loadUserFiles(deps)
      const found = files.plane.projects.find((p) => p.id === id)
      if (found === undefined) return fail(deps, `no project "${id}"`)
      if (found.derivedFrom === undefined) {
        return fail(deps, `"${id}" was not materialized from an auto project — archive or delete it`)
      }
      return applyAndSavePlane(
        deps,
        { op: 'delete-project', id },
        `reverted ${id} — ${found.derivedFrom} derives automatically again`,
      )
    }

    case 'delete': {
      const id = rest[0]
      if (id === undefined) return fail(deps, PROJECT_USAGE)
      return applyAndSavePlane(deps, { op: 'delete-project', id }, `deleted ${id}`)
    }

    case 'match':
    case 'unmatch':
    case 'exclude-match':
    case 'unexclude-match': {
      const [id, arg] = rest
      const matcher = parseMatcherArg(arg ?? '')
      if (id === undefined || matcher === undefined) return fail(deps, PROJECT_USAGE)
      const ops = {
        match: 'add-matcher',
        unmatch: 'remove-matcher',
        'exclude-match': 'add-exclude-matcher',
        'unexclude-match': 'remove-exclude-matcher',
      } as const
      const added = sub === 'match' || sub === 'exclude-match'
      return applyToProject(
        deps,
        id,
        (rid) => ({ op: ops[sub], id: rid, matcher }),
        (rid) => `${added ? 'added' : 'removed'} ${arg} on ${rid}`,
      )
    }

    case 'include':
    case 'exclude':
    case 'unpin': {
      const [id, ...sessionIds] = rest
      if (id === undefined || sessionIds.length === 0) return fail(deps, PROJECT_USAGE)
      const op = sub === 'unpin' ? 'remove-include' : sub
      const doneWord = sub === 'unpin' ? 'unpinned' : `${sub}d`
      return applyToProject(
        deps,
        id,
        (rid) => ({ op, id: rid, sessionIds }),
        (rid) => `${doneWord} ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'} on ${rid}`,
      )
    }

    case 'merge': {
      const [into, from] = rest
      if (into === undefined || from === undefined) return fail(deps, PROJECT_USAGE)
      const files = await loadUserFiles(deps)
      const intoResolved = await resolveTarget(deps, files, files.plane, into)
      if ('error' in intoResolved) return fail(deps, intoResolved.error)
      const fromResolved = await resolveTarget(deps, files, intoResolved.plane, from)
      if ('error' in fromResolved) return fail(deps, fromResolved.error)
      const result = applyPlaneOp(fromResolved.plane, {
        op: 'merge-projects',
        id: intoResolved.id,
        from: fromResolved.id,
      })
      if (result.error !== undefined) return fail(deps, result.error)
      await saveUserPlane(deps, files.home, result.plane)
      deps.write(`merged ${fromResolved.id} into ${intoResolved.id}\n`)
      return 0
    }

    case 'split': {
      const [id, path, ...nameParts] = rest
      const name = nameParts.join(' ').trim()
      if (id === undefined || path === undefined || name.length === 0) {
        return fail(deps, PROJECT_USAGE)
      }
      const files = await loadUserFiles(deps)
      const resolved = await resolveTarget(deps, files, files.plane, id)
      if ('error' in resolved) return fail(deps, resolved.error)
      const newId = slugifyProjectId(name, new Set(resolved.plane.projects.map((p) => p.id)))
      const result = applyPlaneOp(resolved.plane, {
        op: 'split-project',
        id: resolved.id,
        path,
        newId,
        name,
      })
      if (result.error !== undefined) return fail(deps, result.error)
      await saveUserPlane(deps, files.home, result.plane)
      deps.write(`split ${path} out of ${resolved.id} as "${name}" (${newId})\n`)
      return 0
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

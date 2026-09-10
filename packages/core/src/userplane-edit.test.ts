import { describe, expect, it } from 'vitest'
import {
  applyPlaneOp,
  applySessionOp,
  parseMatcherArg,
  serializeConfig,
  serializeUserPlane,
  slugifyProjectId,
} from './userplane-edit.js'
import { emptyUserPlane, parseUserPlane, type UserPlane } from './userplane.js'

const planeWith = (...ops: Parameters<typeof applyPlaneOp>[1][]): UserPlane => {
  let plane = emptyUserPlane
  for (const op of ops) {
    const result = applyPlaneOp(plane, op)
    expect(result.error).toBeUndefined()
    plane = result.plane
  }
  return plane
}

describe('applyPlaneOp', () => {
  it('creates, renames, and deletes projects', () => {
    let plane = planeWith({ op: 'create-project', id: 'p1', name: 'One' })
    expect(plane.projects).toEqual([
      { id: 'p1', name: 'One', matchers: [], excludeMatchers: [], include: [], exclude: [] },
    ])

    plane = applyPlaneOp(plane, { op: 'rename-project', id: 'p1', name: 'Won' }).plane
    expect(plane.projects[0]!.name).toBe('Won')

    plane = applyPlaneOp(plane, { op: 'delete-project', id: 'p1' }).plane
    expect(plane.projects).toEqual([])
  })

  it('rejects duplicate creation and unknown ids without mutating', () => {
    const plane = planeWith({ op: 'create-project', id: 'p1', name: 'One' })
    expect(applyPlaneOp(plane, { op: 'create-project', id: 'p1', name: 'Again' }).error).toContain(
      'already exists',
    )
    expect(applyPlaneOp(plane, { op: 'rename-project', id: 'nope', name: 'X' }).error).toContain(
      'no project',
    )
    expect(plane.projects[0]!.name).toBe('One')
  })

  it('adds and removes matchers, deduplicating', () => {
    const matcher = { kind: 'remote', url: 'github.com/o/r' } as const
    let plane = planeWith(
      { op: 'create-project', id: 'p1', name: 'One' },
      { op: 'add-matcher', id: 'p1', matcher },
      { op: 'add-matcher', id: 'p1', matcher },
    )
    expect(plane.projects[0]!.matchers).toEqual([matcher])
    plane = applyPlaneOp(plane, { op: 'remove-matcher', id: 'p1', matcher }).plane
    expect(plane.projects[0]!.matchers).toEqual([])
  })

  it('include clears exclude and vice versa', () => {
    let plane = planeWith(
      { op: 'create-project', id: 'p1', name: 'One' },
      { op: 'exclude', id: 'p1', sessionIds: ['s1'] },
      { op: 'include', id: 'p1', sessionIds: ['s1'] },
    )
    expect(plane.projects[0]!.include).toEqual(['s1'])
    expect(plane.projects[0]!.exclude).toEqual([])

    plane = applyPlaneOp(plane, { op: 'exclude', id: 'p1', sessionIds: ['s1'] }).plane
    expect(plane.projects[0]!.include).toEqual([])
    expect(plane.projects[0]!.exclude).toEqual(['s1'])
  })

  it('never mutates the input plane', () => {
    const plane = planeWith({ op: 'create-project', id: 'p1', name: 'One' })
    applyPlaneOp(plane, { op: 'include', id: 'p1', sessionIds: ['s1'] })
    expect(plane.projects[0]!.include).toEqual([])
  })

  it('archives and unarchives, keeping the record', () => {
    let plane = planeWith(
      { op: 'create-project', id: 'p1', name: 'One' },
      { op: 'archive-project', id: 'p1', archived: true },
    )
    expect(plane.projects[0]!.archived).toBe(true)
    plane = applyPlaneOp(plane, { op: 'archive-project', id: 'p1', archived: false }).plane
    expect(plane.projects[0]).not.toHaveProperty('archived')
    expect(plane.projects[0]!.name).toBe('One')
  })

  it('materialize shape: create-project carries derivedFrom and archived', () => {
    const plane = planeWith({
      op: 'create-project',
      id: 'r4',
      name: 'r4',
      matchers: [{ kind: 'root', path: '/tmp/r4' }],
      derivedFrom: 'cwd:local:/tmp/r4',
      archived: true,
    })
    expect(plane.projects[0]).toMatchObject({
      derivedFrom: 'cwd:local:/tmp/r4',
      archived: true,
      matchers: [{ kind: 'root', path: '/tmp/r4' }],
    })
  })

  it('manages exclude matchers separately from matchers', () => {
    const matcher = { kind: 'root', path: '/d/stable' } as const
    let plane = planeWith(
      { op: 'create-project', id: 'p1', name: 'One' },
      { op: 'add-exclude-matcher', id: 'p1', matcher },
      { op: 'add-exclude-matcher', id: 'p1', matcher },
    )
    expect(plane.projects[0]!.excludeMatchers).toEqual([matcher])
    expect(plane.projects[0]!.matchers).toEqual([])
    plane = applyPlaneOp(plane, { op: 'remove-exclude-matcher', id: 'p1', matcher }).plane
    expect(plane.projects[0]!.excludeMatchers).toEqual([])
  })

  it('remove-include and remove-exclude just drop from the list', () => {
    let plane = planeWith(
      { op: 'create-project', id: 'p1', name: 'One' },
      { op: 'include', id: 'p1', sessionIds: ['a', 'b'] },
      { op: 'remove-include', id: 'p1', sessionIds: ['a'] },
    )
    expect(plane.projects[0]!.include).toEqual(['b'])
    expect(plane.projects[0]!.exclude).toEqual([])

    plane = applyPlaneOp(plane, { op: 'exclude', id: 'p1', sessionIds: ['z'] }).plane
    plane = applyPlaneOp(plane, { op: 'remove-exclude', id: 'p1', sessionIds: ['z'] }).plane
    expect(plane.projects[0]!.exclude).toEqual([])
    expect(plane.projects[0]!.include).toEqual(['b'])
  })

  it('merge unions everything into the survivor and drops the source', () => {
    let plane = planeWith(
      {
        op: 'create-project',
        id: 'keep',
        name: 'Keep',
        matchers: [{ kind: 'remote', url: 'github.com/o/a' }],
      },
      {
        op: 'create-project',
        id: 'gone',
        name: 'Gone',
        matchers: [
          { kind: 'remote', url: 'github.com/o/a' },
          { kind: 'root', path: '/d/b' },
        ],
      },
      { op: 'include', id: 'keep', sessionIds: ['x'] },
      { op: 'include', id: 'gone', sessionIds: ['y'] },
      { op: 'exclude', id: 'gone', sessionIds: ['x'] },
      { op: 'add-exclude-matcher', id: 'gone', matcher: { kind: 'root', path: '/d/junk' } },
    )
    plane = applyPlaneOp(plane, { op: 'merge-projects', id: 'keep', from: 'gone' }).plane
    expect(plane.projects.map((p) => p.id)).toEqual(['keep'])
    const keep = plane.projects[0]!
    expect(keep.matchers).toEqual([
      { kind: 'remote', url: 'github.com/o/a' },
      { kind: 'root', path: '/d/b' },
    ])
    expect(keep.excludeMatchers).toEqual([{ kind: 'root', path: '/d/junk' }])
    expect(keep.include.sort()).toEqual(['x', 'y'])
    // keep's include of 'x' beats gone's exclude of 'x'
    expect(keep.exclude).toEqual([])
  })

  it('merge rejects self and unknown projects', () => {
    const plane = planeWith({ op: 'create-project', id: 'p1', name: 'One' })
    expect(applyPlaneOp(plane, { op: 'merge-projects', id: 'p1', from: 'p1' }).error).toContain(
      'itself',
    )
    expect(applyPlaneOp(plane, { op: 'merge-projects', id: 'p1', from: 'nope' }).error).toContain(
      'no project',
    )
  })

  it('split carves a root into a new project and vetoes it on the original', () => {
    const plane = planeWith(
      {
        op: 'create-project',
        id: 'peri',
        name: 'peri',
        matchers: [{ kind: 'remote', url: 'github.com/o/peri' }],
      },
      { op: 'split-project', id: 'peri', path: '/d/peri-stable', newId: 'stable', name: 'Stable' },
    )
    expect(plane.projects.map((p) => p.id)).toEqual(['peri', 'stable'])
    expect(plane.projects[0]!.excludeMatchers).toEqual([{ kind: 'root', path: '/d/peri-stable' }])
    expect(plane.projects[1]!.matchers).toEqual([{ kind: 'root', path: '/d/peri-stable' }])
    expect(
      applyPlaneOp(plane, {
        op: 'split-project',
        id: 'peri',
        path: '/x',
        newId: 'stable',
        name: 'S',
      }).error,
    ).toContain('already exists')
  })
})

describe('serialization round-trips', () => {
  it('serializeUserPlane parses back to the same plane', () => {
    const plane = planeWith(
      {
        op: 'create-project',
        id: 'ext',
        name: 'Extension v4',
        matchers: [{ kind: 'remote', url: 'github.com/o/ext' }],
      },
      { op: 'include', id: 'ext', sessionIds: ['abc'] },
      { op: 'create-project', id: 'bare', name: 'Bare' },
      {
        op: 'create-project',
        id: 'old',
        name: 'Old lane',
        derivedFrom: 'git-remote:github.com/o/old',
      },
      { op: 'archive-project', id: 'old', archived: true },
      { op: 'add-exclude-matcher', id: 'ext', matcher: { kind: 'root', path: '/d/fork' } },
    )
    const text = serializeUserPlane(plane)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseUserPlane(text)).toEqual({ plane })
  })

  it('applySessionOp merges into existing overrides and serializes', () => {
    let config = applySessionOp({}, { op: 'rename-session', sessionId: 's1', name: 'Good one' })
    config = applySessionOp(config, { op: 'archive-session', sessionId: 's1', archived: true })
    expect(config.sessions?.['s1']).toEqual({ rename: 'Good one', archived: true })
    expect(JSON.parse(serializeConfig(config))).toEqual(config)
  })
})

describe('slugifyProjectId', () => {
  it('slugs names and uniquifies against taken ids', () => {
    expect(slugifyProjectId('Extension v4!', new Set())).toBe('extension-v4')
    expect(slugifyProjectId('Extension v4', new Set(['extension-v4']))).toBe('extension-v4-2')
    expect(slugifyProjectId('***', new Set(['project']))).toBe('project-2')
  })
})

describe('parseMatcherArg', () => {
  it('parses each kind and rejects junk', () => {
    expect(parseMatcherArg('remote=github.com/o/r')).toEqual({ kind: 'remote', url: 'github.com/o/r' })
    expect(parseMatcherArg('root=/a/b')).toEqual({ kind: 'root', path: '/a/b' })
    expect(parseMatcherArg('cwd=C:\\x')).toEqual({ kind: 'cwd', prefix: 'C:\\x' })
    expect(parseMatcherArg('dir=/home/d')).toEqual({ kind: 'dir', path: '/home/d' })
    expect(parseMatcherArg('session=abc')).toEqual({ kind: 'session', id: 'abc' })
    expect(parseMatcherArg('nope=1')).toBeUndefined()
    expect(parseMatcherArg('remote=')).toBeUndefined()
    expect(parseMatcherArg('=x')).toBeUndefined()
    expect(parseMatcherArg('plain')).toBeUndefined()
  })
})

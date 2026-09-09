import { MemFs, type Snapshot } from '@hodor/core'
import { describe, expect, it } from 'vitest'
import { run, type CliDeps } from './main.js'

function memDeps(fs = new MemFs()): { deps: CliDeps; output: string[]; fs: MemFs } {
  const output: string[] = []
  const deps: CliDeps = {
    fs,
    homedir: () => '/home/u',
    platformFlavor: 'posix',
    now: () => new Date('2026-06-01T12:00:00Z'),
    write: (text) => output.push(text),
    sleep: async () => {},
  }
  return { deps, output, fs }
}

const line = (uuid: string, ts: string, cwd: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: ts,
    cwd,
  }) + '\n'

function seedStore(fs: MemFs): void {
  fs.writeFile(
    '/home/u/.claude/projects/-repo-a/aaaa.jsonl',
    line('u1', '2026-06-01T11:59:00Z', '/repo/a') + line('u2', '2026-06-01T11:59:30Z', '/repo/a'),
  )
  fs.writeFile('/home/u/.claude/projects/-elsewhere/bbbb.jsonl', line('u3', '2026-06-01T08:00:00Z', '/elsewhere'))
  fs.writeFile('/repo/a/.git/config', '[remote "origin"]\n\turl = git@github.com:o/a.git\n')
}

describe('basic commands', () => {
  it('prints usage with no arguments', async () => {
    const { deps, output } = memDeps()
    expect(await run([], deps)).toBe(0)
    expect(output.join('')).toContain('Usage:')
  })

  it('prints a semver version', async () => {
    const { deps, output } = memDeps()
    expect(await run(['--version'], deps)).toBe(0)
    expect(output.join('')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('prints the bucket name for a cwd', async () => {
    const { deps, output } = memDeps()
    expect(await run(['bucket', '/home/user/hodor'], deps)).toBe(0)
    expect(output.join('')).toBe('-home-user-hodor\n')
  })

  it('fails on bucket without an argument', async () => {
    const { deps } = memDeps()
    expect(await run(['bucket'], deps)).toBe(1)
  })

  it('fails on unknown commands', async () => {
    const { deps, output } = memDeps()
    expect(await run(['frobnicate'], deps)).toBe(1)
    expect(output.join('')).toContain('unknown command: frobnicate')
  })

  it('fails on a flag missing its value', async () => {
    const { deps, output } = memDeps()
    expect(await run(['scan', '--root'], deps)).toBe(1)
    expect(output.join('')).toContain('--root: missing value')
  })
})

describe('scan', () => {
  it('emits a full structured snapshot as JSON', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan', '--json'], deps)).toBe(0)

    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['aaaa', 'bbbb'])
    expect(snapshot.projects.map((p) => p.id)).toEqual([
      'git-remote:github.com/o/a',
      'cwd:local:/elsewhere',
    ])
    const assignment = snapshot.assignments.find((a) => a.sessionId === 'aaaa')!
    expect(assignment.projectId).toBe('git-remote:github.com/o/a')
    expect(assignment.reasons.map((r) => r.source)).toEqual(['cwd', 'git-root', 'git-remote'])
    expect(snapshot.sessions[0]!.runtime.kind).toBe('inferred-active')
  })

  it('formats a human-readable summary by default', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('2 session(s) in 2 project(s), 1 active')
    expect(text).toContain('a  [git-remote:github.com/o/a]')
    expect(text).toContain('* aaaa')
  })

  it('accepts explicit store roots', async () => {
    const { deps, output, fs } = memDeps()
    fs.writeFile('/srv/claude/projects/-x/cccc.jsonl', line('u9', '2026-06-01T11:00:00Z', '/x'))
    expect(await run(['scan', '--json', '--root', '/srv/claude'], deps)).toBe(0)
    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['cccc'])
    expect(snapshot.stores[0]!.rootPath).toBe('/srv/claude')
  })
})

describe('watch', () => {
  it('prints the initial snapshot, then updates when transcripts change', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    let tick = 0
    deps.sleep = async () => {
      tick += 1
      if (tick === 1) {
        fs.appendFile(
          '/home/u/.claude/projects/-repo-a/aaaa.jsonl',
          line('u4', '2026-06-01T11:59:45Z', '/repo/a'),
        )
      }
      // tick 2: no changes
    }
    expect(await run(['watch', '--ticks', '2'], deps)).toBe(0)

    const text = output.join('')
    const snapshots = text.split('---\n')
    expect(snapshots).toHaveLength(2) // initial + one update; quiet tick prints nothing
    expect(snapshots[1]).toContain('2026-06-01T11:59:45Z')
  })
})

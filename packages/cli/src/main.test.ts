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

const line = (uuid: string, ts: string, cwd: string, prompt?: string, entrypoint?: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: ts,
    cwd,
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    ...(prompt !== undefined ? { message: { role: 'user', content: prompt } } : {}),
  }) + '\n'

function seedStore(fs: MemFs): void {
  fs.writeFile(
    '/home/u/.claude/projects/-repo-a/aaaa.jsonl',
    line('u1', '2026-06-01T11:59:00Z', '/repo/a', 'Fix the login bug please', 'cli') +
      line('u2', '2026-06-01T11:59:30Z', '/repo/a'),
  )
  fs.writeFile('/home/u/.claude/projects/-elsewhere/bbbb.jsonl', line('u3', '2026-06-01T08:00:00Z', '/elsewhere'))
  fs.writeFile('/repo/a/.git/config', '[remote "origin"]\n\turl = git@github.com:o/a.git\n')
  // Ephemeral noise: an agent-harness run in a dot directory and a /tmp scratchpad.
  fs.writeFile(
    '/home/u/.claude/projects/-noise/cccc.jsonl',
    line('u4', '2026-06-01T09:00:00Z', '/home/u/.peri/runs/2026/cache/blind', undefined, 'sdk'),
  )
  fs.writeFile('/home/u/.claude/projects/-scratch/dddd.jsonl', line('u5', '2026-06-01T09:30:00Z', '/tmp/scratch'))
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
  it('emits a full structured snapshot as JSON, hidden sessions tagged but kept', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan', '--json'], deps)).toBe(0)

    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['aaaa', 'dddd', 'cccc', 'bbbb'])
    expect(snapshot.projects.map((p) => p.id)).toContain('git-remote:github.com/o/a')
    const assignment = snapshot.assignments.find((a) => a.sessionId === 'aaaa')!
    expect(assignment.projectId).toBe('git-remote:github.com/o/a')
    expect(assignment.reasons.map((r) => r.source)).toEqual(['cwd', 'git-root', 'git-remote'])
    expect(snapshot.sessions[0]!.runtime.kind).toBe('inferred-active')
    expect(snapshot.sessions[0]!.promptPreview).toBe('Fix the login bug please')
    expect(snapshot.sessions.find((s) => s.id === 'cccc')!.hiddenBy).toBe('dot-segment:.peri')
    expect(snapshot.sessions.find((s) => s.id === 'dddd')!.hiddenBy).toBe('prefix:/tmp')
  })

  it('formats a human-readable summary hiding noise, with prompt-preview titles', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('2 session(s) in 2 project(s), 1 active; 2 hidden (--all to show)')
    expect(text).toContain('a  [git-remote:github.com/o/a]')
    expect(text).toContain('* aaaa')
    expect(text).toContain('Fix the login bug please')
    expect(text).not.toContain('.peri')
    expect(text).not.toContain('/tmp/scratch')
  })

  it('shows everything with --all', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan', '--all'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('4 session(s) in 4 project(s)')
    expect(text).not.toContain('hidden')
    expect(text).toContain('.peri')
  })

  it('accepts extra hide rules via --hide', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan', '--hide', 'elsewhere'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('1 session(s) in 1 project(s), 1 active; 3 hidden (--all to show)')
    expect(text).not.toContain('elsewhere')
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

describe('scan formatting details', () => {
  it('titles command-started sessions, sorts by recency, relativizes cwds', async () => {
    const { deps, output, fs } = memDeps()
    fs.writeFile('/repo/a/.git/config', '[remote "origin"]\n\turl = git@github.com:o/a.git\n')
    fs.writeFile(
      '/home/u/.claude/projects/-repo-a/old1.jsonl',
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        timestamp: '2026-06-01T09:00:00Z',
        cwd: '/repo/a/packages/web',
        message: { content: '<command-name>/deploy</command-name>' },
      }) + '\n',
    )
    fs.writeFile(
      '/home/u/.claude/projects/-repo-a/new1.jsonl',
      line('u2', '2026-06-01T10:00:00Z', '/repo/a', 'newer session'),
    )
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('/deploy')
    expect(text).not.toContain('<command-name>')
    // newer session listed before older within the project
    expect(text.indexOf('new1')).toBeLessThan(text.indexOf('old1'))
    // cwd shown relative to the project root
    expect(text).toMatch(/old1.*packages\/web/)
    expect(text).toMatch(/new1.*\d\dZ {2}\. {2}newer session/)
  })
})

describe('stats', () => {
  it('summarizes entrypoints split by visibility, plus hide-rule counts', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['stats'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('sessions: 4 (2 visible, 2 hidden)')
    expect(text).toMatch(/entrypoints \(visible sessions\):\n(.*\n)*.*cli\s+1/)
    expect(text).toMatch(/entrypoints \(hidden sessions\):\n(.*\n)*.*sdk\s+1/)
    expect(text).toMatch(/dot-segment:\.peri\s+1/)
    expect(text).toMatch(/prefix:\/tmp\s+1/)
  })

  it('emits stats as JSON', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['stats', '--json'], deps)).toBe(0)
    const stats = JSON.parse(output.join(''))
    expect(stats).toEqual({
      total: 4,
      visible: 2,
      hidden: 2,
      entrypointsVisible: { cli: 1, '(none)': 1 },
      entrypointsHidden: { sdk: 1, '(none)': 1 },
      hiddenByRule: { 'dot-segment:.peri': 1, 'prefix:/tmp': 1 },
    })
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

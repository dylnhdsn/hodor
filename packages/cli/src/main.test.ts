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
    columns: () => 100,
    selfUpdate: async () => {
      output.push('selfUpdate-stub\n')
      return 0
    },
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

  it('dispatches update and upgrade to selfUpdate', async () => {
    const { deps, output } = memDeps()
    expect(await run(['update'], deps)).toBe(0)
    expect(await run(['upgrade'], deps)).toBe(0)
    expect(output.filter((o) => o === 'selfUpdate-stub\n')).toHaveLength(2)
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
    expect(text).toContain('a — 1 session, 1 active — github.com/o/a')
    expect(text).toContain('* aaaa')
    expect(text).toContain('Fix the login bug please')
    expect(text).toContain('hidden: 2 sessions, 2 projects —')
    expect(text).toContain('(--all to show)')
    expect(text).toContain('2 sessions in 2 projects, 1 active')
    // hidden sessions never render rows; their rules may appear in the footer
    expect(text).not.toContain('/home/u/.peri')
    expect(text).not.toContain('/tmp/scratch')
    expect(text).not.toContain('cccc')
    expect(text).not.toContain('dddd')
  })

  it('shows everything with --all', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan', '--all'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('4 sessions in 4 projects, 1 active')
    expect(text).not.toContain('hidden')
    expect(text).toContain('.peri')
  })

  it('accepts extra hide rules via --hide', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan', '--hide', 'elsewhere'], deps)).toBe(0)
    const text = output.join('')
    expect(text).toContain('1 session in 1 project, 1 active')
    expect(text).toContain('hidden: 3 sessions')
    expect(text).not.toContain('bbbb')
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

describe('scan across a WSL store from Windows', () => {
  it('resolves git projects behind \\\\wsl$ and unifies worktrees', async () => {
    const fs = new MemFs('\\')
    const { deps, output } = memDeps(fs)
    deps.platformFlavor = 'win32'
    deps.homedir = () => 'C:\\Users\\d'

    const root = '\\\\wsl$\\Ubuntu\\home\\d\\.claude'
    fs.writeFile(
      `${root}\\projects\\-home-d-repo\\aaaa.jsonl`,
      line('u1', '2026-06-01T10:00:00Z', '/home/d/repo', 'main session', 'cli'),
    )
    fs.writeFile(
      `${root}\\projects\\-home-d-wt\\bbbb.jsonl`,
      line('u2', '2026-06-01T10:00:01Z', '/home/d/wt', 'worktree session', 'cli'),
    )
    // The git tree is only reachable through the UNC prefix.
    fs.writeFile(
      '\\\\wsl$\\Ubuntu\\home\\d\\repo\\.git\\config',
      '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
    )
    fs.writeFile('\\\\wsl$\\Ubuntu\\home\\d\\repo\\.git\\worktrees\\wt\\commondir', '../..\n')
    fs.writeFile('\\\\wsl$\\Ubuntu\\home\\d\\wt\\.git', 'gitdir: /home/d/repo/.git/worktrees/wt\n')

    expect(await run(['scan', '--json', '--root', root], deps)).toBe(0)
    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.stores[0]).toMatchObject({
      pathFlavor: 'posix',
      origin: { kind: 'wsl', distro: 'Ubuntu' },
    })
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.projects[0]).toMatchObject({
      id: 'git-remote:github.com/o/r',
      roots: [
        { path: '/home/d/repo' },
        { path: '/home/d/wt' },
      ],
    })
    const wt = snapshot.assignments.find((a) => a.sessionId === 'bbbb')!
    expect(wt.reasons.map((r) => r.source)).toContain('worktree-of')
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
    // oldest first: the newest session ends the block, right above the prompt
    expect(text.indexOf('old1')).toBeLessThan(text.indexOf('new1'))
    // cwd shown relative to the project root, timestamps as relative ages
    expect(text).toMatch(/old1 {2}\s*3h {2}packages\/web/)
    expect(text).toMatch(/new1 {2}\s*2h {2}\.\s+newer session/)
  })

  it('never emits a line wider than the terminal', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    fs.writeFile(
      '/home/u/.claude/projects/-repo-a/wide.jsonl',
      line(
        'u9',
        '2026-06-01T11:00:00Z',
        '/repo/a/deeply/nested/path/that/keeps/going/further/than/reason',
        'a very long prompt that would certainly wrap in a narrow terminal window '.repeat(3),
        'cli',
      ),
    )
    deps.columns = () => 72
    expect(await run(['scan'], deps)).toBe(0)
    for (const outputLine of output.join('').split('\n')) {
      expect(outputLine.length, outputLine).toBeLessThanOrEqual(72)
    }
  })

  it('prints the most recently active project last', async () => {
    const { deps, output, fs } = memDeps()
    seedStore(fs)
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    // 'elsewhere' (08:00) is older than project a (11:59)
    expect(text.indexOf('elsewhere')).toBeLessThan(text.indexOf('github.com/o/a'))
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
    expect(await run(['watch', '--ticks', '2', '--json'], deps)).toBe(0)

    const text = output.join('')
    const snapshots = text.split('---\n')
    expect(snapshots).toHaveLength(2) // initial + one update; quiet tick prints nothing
    expect(snapshots[1]).toContain('2026-06-01T11:59:45Z')
  })
})

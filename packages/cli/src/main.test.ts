import { MemFs, type Snapshot } from '@hodor/core'
import { describe, expect, it } from 'vitest'
import { run, type CliDeps } from './main.js'

function memDeps(fs = new MemFs()): {
  deps: CliDeps
  output: string[]
  errors: string[]
  spawns: Array<{ file: string; args: string[] }>
  fs: MemFs
} {
  const output: string[] = []
  const errors: string[] = []
  const spawns: Array<{ file: string; args: string[] }> = []
  const deps: CliDeps = {
    fs,
    homedir: () => '/home/u',
    platformFlavor: 'posix',
    now: () => new Date('2026-06-01T12:00:00Z'),
    write: (text) => output.push(text),
    writeErr: (text) => errors.push(text),
    sleep: async () => {},
    columns: () => 100,
    listWslDistros: async () => [],
    wslDistro: () => undefined,
    env: () => undefined,
    openUrl: async () => {},
    osPlatform: 'linux',
    spawnDetached: async (file, args) => {
      spawns.push({ file, args })
      if (file !== 'x-terminal-emulator') throw new Error(`spawn ${file}: not stubbed`)
    },
    selfUpdate: async () => {
      output.push('selfUpdate-stub\n')
      return 0
    },
  }
  return { deps, output, errors, spawns, fs }
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

function seedCloneScenario(fs: MemFs): void {
  fs.writeFile(
    '/home/u/.claude/projects/-repo-peri/mmmm.jsonl',
    line('u1', '2026-06-01T10:00:00Z', '/repo/peri', 'main peri work', 'cli'),
  )
  fs.writeFile(
    '/home/u/.claude/projects/-repo-peri-stable/ssss.jsonl',
    line('u2', '2026-06-01T10:00:01Z', '/repo/peri-stable', 'stable peri work', 'cli'),
  )
  fs.writeFile('/repo/peri/.git/config', '[remote "origin"]\n\turl = git@github.com:d/peri.git\n')
  // peri-stable is a local clone: origin points at the peri directory
  fs.writeFile('/repo/peri-stable/.git/config', '[remote "origin"]\n\turl = /repo/peri\n')
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

describe('user config', () => {
  it('merges local clones into their source project via remote chasing', async () => {
    const { deps, output, fs } = memDeps()
    seedCloneScenario(fs)
    expect(await run(['scan', '--json'], deps)).toBe(0)
    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.projects.map((p) => p.id)).toEqual(['git-remote:github.com/d/peri'])
    expect(snapshot.projects[0]!.roots.map((r) => r.path).sort()).toEqual([
      '/repo/peri',
      '/repo/peri-stable',
    ])
  })

  it('splits a configured root back out, with its configured name', async () => {
    const { deps, output, fs } = memDeps()
    seedCloneScenario(fs)
    fs.writeFile(
      '/home/u/.hodor/config.json',
      JSON.stringify({
        splitRoots: ['/repo/peri-stable'],
        projectNames: { 'split:local:/repo/peri-stable': 'peri-stable' },
        sessions: { mmmm: { rename: 'Main line of work' } },
        hide: { pathSegments: ['scratch'] },
      }),
    )
    fs.writeFile(
      '/home/u/.claude/projects/-x-scratch/zzzz.jsonl',
      line('u3', '2026-06-01T09:00:00Z', '/x/scratch/dir'),
    )
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    // absorb: the claimed session leaves the auto project, which keeps the rest
    expect(text).toContain('peri-stable — 1 session — custom')
    expect(text).toContain('peri — 1 session — github.com/d/peri')
    expect(text).toContain('Main line of work')
    expect(text).not.toContain('/x/scratch')
    expect(text).toContain('scratch 1')
  })

  it('renders label semantics from projects.json with the inbox guarantee', async () => {
    const { deps, output, fs } = memDeps()
    seedCloneScenario(fs)
    fs.writeFile(
      '/home/u/.hodor/projects.json',
      JSON.stringify({
        projects: {
          'all-peri': {
            name: 'All peri',
            matchers: [{ kind: 'remote', url: 'github.com/d/peri' }],
          },
          'stable-only': {
            name: 'Stable lane',
            matchers: [{ kind: 'root', path: '/repo/peri-stable' }],
          },
        },
      }),
    )
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    // both sessions match 'All peri' (chased remote); stable also matches
    // 'Stable lane' — labels, so it appears in BOTH custom blocks
    expect(text).toContain('All peri — 2 sessions — custom')
    expect(text).toContain('Stable lane — 1 session — custom')
    expect(text.match(/ssss/g)).toHaveLength(2)
    // absorb: nothing left for the auto project
    expect(text).not.toContain('github.com/d/peri\n')
    expect(text).toContain('2 sessions in 2 projects')

    // inbox guarantee: every visible session appears at least once
    for (const id of ['mmmm', 'ssss']) {
      expect(text).toContain(id)
    }
  })

  it('resolves the data home from the Windows side when run inside WSL', async () => {
    const fs = new MemFs()
    const { deps, output } = memDeps(fs)
    deps.homedir = () => '/home/d'
    deps.wslDistro = () => 'Ubuntu'
    fs.writeFile(
      '/home/d/.claude/projects/-r/aaaa.jsonl',
      line('u1', '2026-06-01T10:00:00Z', '/r', 'wsl session'),
    )
    // Windows-homed user plane, reachable through /mnt/c
    fs.writeFile(
      '/mnt/c/Users/d/.hodor/projects.json',
      JSON.stringify({
        projects: { w: { name: 'From Windows', matchers: [{ kind: 'cwd', prefix: '/r' }] } },
      }),
    )
    expect(await run(['scan', '--no-discover'], deps)).toBe(0)
    expect(output.join('')).toContain('From Windows — 1 session — custom')
  })

  it('warns and falls back locally when multiple Windows homes exist', async () => {
    const fs = new MemFs()
    const { deps, errors } = memDeps(fs)
    deps.homedir = () => '/home/d'
    deps.wslDistro = () => 'Ubuntu'
    fs.writeFile('/mnt/c/Users/a/.hodor/config.json', '{}')
    fs.writeFile('/mnt/c/Users/b/.hodor/config.json', '{}')
    fs.writeFile(
      '/home/d/.claude/projects/-r/aaaa.jsonl',
      line('u1', '2026-06-01T10:00:00Z', '/r'),
    )
    expect(await run(['scan', '--no-discover'], deps)).toBe(0)
    expect(errors.join('')).toContain('multiple Windows .hodor homes')
  })

  it('archives sessions from config, revealed again by --all', async () => {
    const { deps, output, fs } = memDeps()
    seedCloneScenario(fs)
    fs.writeFile(
      '/home/u/.hodor/config.json',
      JSON.stringify({ sessions: { ssss: { archived: true } } }),
    )
    expect(await run(['scan'], deps)).toBe(0)
    const text = output.join('')
    expect(text).not.toContain('ssss')
    expect(text).toContain('archived 1')

    output.length = 0
    expect(await run(['scan', '--all'], deps)).toBe(0)
    expect(output.join('')).toContain('ssss')
  })

  it('warns on stderr and continues when the config is invalid', async () => {
    const { deps, output, errors, fs } = memDeps()
    seedCloneScenario(fs)
    fs.writeFile('/home/u/.hodor/config.json', '{broken')
    expect(await run(['scan', '--json'], deps)).toBe(0)
    expect(errors.join('')).toContain('ignoring /home/u/.hodor/config.json')
    expect(() => JSON.parse(output.join(''))).not.toThrow()
  })
})

describe('project and session commands', () => {
  it('creates a project that the next scan reflects', async () => {
    const { deps, output, fs } = memDeps()
    seedCloneScenario(fs)
    expect(await run(['project', 'create', 'Peri', 'work', '--match', 'remote=github.com/d/peri'], deps)).toBe(0)
    expect(output.join('')).toContain('created project "Peri work" (peri-work)')
    expect(JSON.parse((await fs.readFile('/home/u/.hodor/projects.json'))!)).toEqual({
      projects: {
        'peri-work': { name: 'Peri work', matchers: [{ kind: 'remote', url: 'github.com/d/peri' }] },
      },
    })

    output.length = 0
    expect(await run(['scan'], deps)).toBe(0)
    expect(output.join('')).toContain('Peri work — 2 sessions — custom')
  })

  it('round-trips match/unmatch/include/exclude/rename/delete', async () => {
    const { deps, output, fs } = memDeps()
    expect(await run(['project', 'create', 'Lane'], deps)).toBe(0)
    expect(await run(['project', 'match', 'lane', 'root=/repo/x'], deps)).toBe(0)
    expect(await run(['project', 'include', 'lane', 'sess1', 'sess2'], deps)).toBe(0)
    expect(await run(['project', 'exclude', 'lane', 'sess2'], deps)).toBe(0)
    expect(await run(['project', 'rename', 'lane', 'Fast', 'Lane'], deps)).toBe(0)

    output.length = 0
    expect(await run(['project', 'list'], deps)).toBe(0)
    const listing = output.join('')
    expect(listing).toContain('lane  Fast Lane  (1 matcher, 1 included, 1 excluded)')
    expect(listing).toContain('root=/repo/x')

    expect(await run(['project', 'unmatch', 'lane', 'root=/repo/x'], deps)).toBe(0)
    expect(await run(['project', 'delete', 'lane'], deps)).toBe(0)
    expect(JSON.parse((await fs.readFile('/home/u/.hodor/projects.json'))!)).toEqual({ projects: {} })
  })

  it('fails with a clear error for unknown projects', async () => {
    const { deps, errors } = memDeps()
    expect(await run(['project', 'rename', 'ghost', 'X'], deps)).toBe(1)
    expect(errors.join('')).toContain('no project "ghost"')
  })

  it('session rename/archive write config.json preserving existing settings', async () => {
    const { deps, fs } = memDeps()
    fs.writeFile('/home/u/.hodor/config.json', JSON.stringify({ hide: { pathSegments: ['keepme'] } }))
    expect(await run(['session', 'rename', 'abc123', 'The', 'good', 'one'], deps)).toBe(0)
    expect(await run(['session', 'archive', 'abc123', 'def456'], deps)).toBe(0)
    const config = JSON.parse((await fs.readFile('/home/u/.hodor/config.json'))!)
    expect(config.hide).toEqual({ pathSegments: ['keepme'] })
    expect(config.sessions).toEqual({
      abc123: { rename: 'The good one', archived: true },
      def456: { archived: true },
    })
    expect(await run(['session', 'unarchive', 'def456'], deps)).toBe(0)
    const after = JSON.parse((await fs.readFile('/home/u/.hodor/config.json'))!)
    expect(after.sessions.def456).toEqual({ archived: false })
  })
})

describe('cross-boundary store discovery', () => {
  it('from Windows: combines the native store with discovered WSL stores', async () => {
    const fs = new MemFs('\\')
    const { deps, output } = memDeps(fs)
    deps.platformFlavor = 'win32'
    deps.homedir = () => 'C:\\Users\\d'
    deps.listWslDistros = async () => ['Ubuntu']

    fs.writeFile(
      'C:\\Users\\d\\.claude\\projects\\-C-Users-d-app\\wwww.jsonl',
      line('u1', '2026-06-01T10:00:00Z', 'C:\\Users\\d\\app', 'windows session', 'cli'),
    )
    // Ubuntu has two home dirs; only one holds a store. A userless distro
    // contributes nothing.
    fs.writeFile('\\\\wsl$\\Ubuntu\\home\\other\\notes.txt', 'no store here')
    fs.writeFile(
      '\\\\wsl$\\Ubuntu\\home\\d\\.claude\\projects\\-home-d-repo\\llll.jsonl',
      line('u2', '2026-06-01T10:00:01Z', '/home/d/repo', 'wsl session', 'cli'),
    )
    fs.writeFile(
      '\\\\wsl$\\Ubuntu\\home\\d\\repo\\.git\\config',
      '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
    )

    expect(await run(['scan', '--json'], deps)).toBe(0)
    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.stores.map((s) => s.id)).toEqual(['local', 'wsl:Ubuntu'])
    expect(snapshot.sessions.map((s) => s.id).sort()).toEqual(['llll', 'wwww'])
    // git enrichment still works for the discovered store
    expect(snapshot.assignments.find((a) => a.sessionId === 'llll')!.projectId).toBe(
      'git-remote:github.com/o/r',
    )
  })

  it('from WSL: combines the native store with the Windows store via /mnt', async () => {
    const fs = new MemFs()
    const { deps, output } = memDeps(fs)
    deps.homedir = () => '/home/d'
    deps.wslDistro = () => 'Ubuntu'

    fs.writeFile(
      '/home/d/.claude/projects/-home-d-x/pppp.jsonl',
      line('u1', '2026-06-01T10:00:00Z', '/home/d/x', 'wsl-side session', 'cli'),
    )
    fs.writeFile(
      '/mnt/c/Users/d/.claude/projects/-C-Users-d-app/qqqq.jsonl',
      line('u2', '2026-06-01T10:00:01Z', 'C:\\Users\\d\\app', 'windows-side session', 'cli'),
    )
    // The Windows repo is reachable from WSL only through the drive mount.
    fs.writeFile(
      '/mnt/c/Users/d/app/.git/config',
      '[remote "origin"]\n\turl = git@github.com:o/winapp.git\n',
    )
    // Junk Users entries without stores are skipped.
    fs.writeFile('/mnt/c/Users/Public/Desktop/readme.txt', '')

    expect(await run(['scan', '--json'], deps)).toBe(0)
    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.stores.map((s) => s.id)).toEqual(['local', 'win:d'])
    expect(snapshot.stores[1]).toMatchObject({
      pathFlavor: 'win32',
      origin: { kind: 'windows', mountRoot: '/mnt' },
    })
    expect(snapshot.assignments.find((a) => a.sessionId === 'qqqq')!.projectId).toBe(
      'git-remote:github.com/o/winapp',
    )
  })

  it('--no-discover keeps only the local store', async () => {
    const fs = new MemFs()
    const { deps, output } = memDeps(fs)
    deps.wslDistro = () => 'Ubuntu'
    fs.writeFile(
      '/home/u/.claude/projects/-a/aaaa.jsonl',
      line('u1', '2026-06-01T10:00:00Z', '/a'),
    )
    fs.writeFile(
      '/mnt/c/Users/d/.claude/projects/-b/bbbb.jsonl',
      line('u2', '2026-06-01T10:00:01Z', 'C:\\b'),
    )
    expect(await run(['scan', '--json', '--no-discover'], deps)).toBe(0)
    const snapshot = JSON.parse(output.join('')) as Snapshot
    expect(snapshot.stores.map((s) => s.id)).toEqual(['local'])
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['aaaa'])
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
      entrypointsVisible: { cli: 1, '(none)': 1 },
      entrypointsHidden: { sdk: 1, '(none)': 1 },
      hiddenByRule: { 'dot-segment:.peri': 1, 'prefix:/tmp': 1 },
    })
  })
})

describe('resume', () => {
  it('prints the command with --print, launches otherwise, rejects ambiguity', async () => {
    const { deps, output, errors, spawns, fs } = memDeps()
    // second cwd on the same session: resume must use the FIRST (the store
    // bucket is keyed by it)
    fs.writeFile(
      '/home/u/.claude/projects/-r/abc111.jsonl',
      line('u1', '2026-06-01T10:00:00Z', '/r/app') + line('u1b', '2026-06-01T10:05:00Z', '/r/app/sub'),
    )
    fs.writeFile('/home/u/.claude/projects/-r/abd222.jsonl', line('u2', '2026-06-01T10:00:00Z', '/r/app'))

    expect(await run(['resume', 'abc', '--print'], deps)).toBe(0)
    expect(output.join('')).toContain('cd "/r/app"')
    expect(output.join('')).toContain('claude --resume abc111')

    expect(await run(['resume', 'abc', '--fork', '--print'], deps)).toBe(0)
    expect(output.join('')).toContain('claude --resume abc111 --fork-session')

    expect(await run(['resume', 'abc'], deps)).toBe(0)
    expect(spawns.some((s) => s.file === 'x-terminal-emulator')).toBe(true)
    expect(output.join('')).toContain('launched x-terminal-emulator in /r/app')

    expect(await run(['resume', 'ab'], deps)).toBe(1)
    expect(errors.join('')).toContain('ambiguous')
    expect(await run(['resume', 'zzz'], deps)).toBe(1)
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

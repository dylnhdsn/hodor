import { describe, expect, it } from 'vitest'
import type { SessionStore } from '@hodor/core'
import { composeAgentScans, scanLiveAgents } from './agents.js'
import type { CliDeps } from './main.js'

const store = (id: string, origin: SessionStore['origin']): SessionStore => ({
  id,
  rootPath: `/stores/${id}`,
  pathFlavor: origin.kind === 'windows' ? 'win32' : 'posix',
  origin,
  watchStrategy: 'poll',
})

describe('composeAgentScans — one listing per host', () => {
  // The Windows claude cannot see processes inside a distro, so a WSL
  // store means a second listing run through wsl.exe in that distro.
  it('adds a wsl.exe listing for each WSL distro seen from Windows', () => {
    const specs = composeAgentScans({ os: 'win32' }, [
      store('win', { kind: 'native' }),
      store('ubuntu', { kind: 'wsl', distro: 'Ubuntu' }),
    ])
    expect(specs).toHaveLength(2)
    expect(specs[0]).toEqual({ file: 'cmd.exe', args: ['/c', 'claude', 'agents', '--json'] })
    expect(specs[1]).toEqual({
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '-e', 'bash', '-lic', 'claude agents --json'],
    })
  })

  it('lists a distro once however many of its stores are watched', () => {
    const specs = composeAgentScans({ os: 'win32' }, [
      store('a', { kind: 'wsl', distro: 'Ubuntu' }),
      store('b', { kind: 'wsl', distro: 'Ubuntu' }),
      store('c', { kind: 'wsl', distro: 'Debian' }),
    ])
    expect(specs.map((s) => (s.file === 'wsl.exe' ? s.args[1] : s.file))).toEqual([
      'cmd.exe',
      'Ubuntu',
      'Debian',
    ])
  })

  // From inside WSL the picture is mirrored: the Windows store's
  // sessions run under the Windows claude, reached through cmd.exe.
  it('adds a cmd.exe listing for the Windows store seen from inside WSL', () => {
    const specs = composeAgentScans({ os: 'linux', wslDistro: 'Ubuntu', shell: '/bin/zsh' }, [
      store('ubuntu', { kind: 'native' }),
      store('win', { kind: 'windows', mountRoot: '/mnt/c' }),
    ])
    expect(specs).toHaveLength(2)
    expect(specs[0]).toEqual({ file: '/bin/zsh', args: ['-lic', 'claude agents --json'] })
    expect(specs[1]).toEqual({ file: 'cmd.exe', args: ['/c', 'claude', 'agents', '--json'] })
  })

  it('is just the host listing on a plain posix machine', () => {
    const specs = composeAgentScans({ os: 'darwin', shell: '/bin/zsh' }, [
      store('mac', { kind: 'native' }),
    ])
    expect(specs).toEqual([{ file: '/bin/zsh', args: ['-lic', 'claude agents --json'] }])
  })

  // A foreign-origin store on a host that cannot reach it (a WSL store
  // recorded on a mac, say) gets no listing rather than a doomed spawn.
  it('does not compose a scan it has no route for', () => {
    const specs = composeAgentScans({ os: 'linux' }, [
      store('wsl', { kind: 'wsl', distro: 'Ubuntu' }),
      store('win', { kind: 'windows', mountRoot: '/mnt/c' }),
    ])
    expect(specs).toHaveLength(1)
    expect(specs[0]!.file).toBe('bash')
  })
})

describe('scanLiveAgents — merging the hosts', () => {
  const agent = (sessionId: string, status: string) =>
    JSON.stringify([{ pid: 1, cwd: '/x', kind: 'interactive', sessionId, status }])

  const deps = (byFile: Record<string, { code: number; output: string } | Error>): CliDeps =>
    ({
      osPlatform: 'win32',
      wslDistro: () => undefined,
      env: () => undefined,
      now: () => new Date('2026-09-18T10:00:00Z'),
      runCapture: (file: string) => {
        const r = byFile[file]
        if (r === undefined) return Promise.reject(new Error(`unexpected spawn ${file}`))
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
      },
    }) as unknown as CliDeps

  it('merges every host that answered into one listing', async () => {
    const event = await scanLiveAgents(
      deps({
        'cmd.exe': { code: 0, output: agent('win-1', 'busy') },
        'wsl.exe': { code: 0, output: `motd noise\n${agent('wsl-1', 'idle')}\n` },
      }),
      [store('ubuntu', { kind: 'wsl', distro: 'Ubuntu' })],
    )
    expect(event).toMatchObject({ type: 'agents-listed', scannedAt: '2026-09-18T10:00:00.000Z' })
    const agents = (event as { agents: Array<{ sessionId: string; status: string }> }).agents
    expect(agents.map((a) => [a.sessionId, a.status])).toEqual([
      ['win-1', 'busy'],
      ['wsl-1', 'idle'],
    ])
  })

  // One side being unreachable (distro stopped, claude missing there)
  // must not cost the other side its cross-check.
  it('keeps the hosts that answered when one fails', async () => {
    const event = await scanLiveAgents(
      deps({
        'cmd.exe': { code: 0, output: agent('win-1', 'waiting') },
        'wsl.exe': new Error('spawn wsl.exe ENOENT'),
      }),
      [store('ubuntu', { kind: 'wsl', distro: 'Ubuntu' })],
    )
    expect((event as { agents: unknown[] }).agents).toHaveLength(1)
  })

  it('is no listing at all when every host is silent', async () => {
    const event = await scanLiveAgents(
      deps({
        'cmd.exe': { code: 1, output: 'unknown command agents' },
        'wsl.exe': { code: 0, output: 'not json' },
      }),
      [store('ubuntu', { kind: 'wsl', distro: 'Ubuntu' })],
    )
    expect(event).toBeUndefined()
  })
})

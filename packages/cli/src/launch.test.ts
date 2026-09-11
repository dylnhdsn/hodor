import { describe, expect, it } from 'vitest'
import { composeLaunch, runLaunch, type LaunchTarget } from './launch.js'

const target = (over: Partial<LaunchTarget>): LaunchTarget => ({
  cwd: '/home/d/code/app',
  flavor: 'posix',
  origin: { kind: 'native' },
  claudeArgs: ['--resume', 'abc-123'],
  ...over,
})

describe('composeLaunch', () => {
  it('windows-native sessions on Windows: wt.exe, then cmd start', () => {
    const plan = composeLaunch(
      { os: 'win32' },
      target({ cwd: 'C:\\code\\app', flavor: 'win32' }),
    )
    expect(plan.command).toBe('claude --resume abc-123')
    expect(plan.candidates[0]).toEqual({
      file: 'wt.exe',
      args: ['-d', 'C:\\code\\app', 'cmd', '/k', 'claude', '--resume', 'abc-123'],
    })
    expect(plan.candidates[1]!.file).toBe('cmd.exe')
    expect(plan.candidates[1]!.args).toContain('start')
  })

  it('WSL-store sessions from Windows: wt.exe wrapping wsl.exe with the distro', () => {
    const plan = composeLaunch(
      { os: 'win32' },
      target({ origin: { kind: 'wsl', distro: 'Ubuntu' } }),
    )
    expect(plan.candidates[0]).toEqual({
      file: 'wt.exe',
      args: [
        'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/d/code/app',
        '-e', 'bash', '-lic', 'claude --resume abc-123',
      ],
    })
  })

  it('native sessions from inside WSL: wt.exe wsl.exe with the current distro', () => {
    const plan = composeLaunch({ os: 'linux', wslDistro: 'Ubuntu' }, target({}))
    expect(plan.candidates[0]!.file).toBe('wt.exe')
    expect(plan.candidates[0]!.args).toEqual([
      'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/d/code/app',
      '-e', 'bash', '-lic', 'claude --resume abc-123',
    ])
  })

  it('windows-store sessions from inside WSL: a Windows shell, not bash', () => {
    const plan = composeLaunch(
      { os: 'linux', wslDistro: 'Ubuntu' },
      target({ cwd: 'C:\\Users\\d\\app', flavor: 'win32', origin: { kind: 'windows', mountRoot: '/mnt/c' } }),
    )
    expect(plan.candidates[0]).toEqual({
      file: 'wt.exe',
      args: ['-d', 'C:\\Users\\d\\app', 'cmd', '/k', 'claude', '--resume', 'abc-123'],
    })
  })

  it('macOS: osascript Terminal with shell-quoted cwd', () => {
    const plan = composeLaunch({ os: 'darwin' }, target({ cwd: "/Users/d/it's here" }))
    expect(plan.candidates).toHaveLength(1)
    const script = plan.candidates[0]!.args[1]!
    expect(plan.candidates[0]!.file).toBe('osascript')
    // the shell string is AppleScript-escaped inside the arg; unescape to check
    expect(script.replace(/\\(.)/g, '$1')).toContain(
      "cd '/Users/d/it'\\''s here' && claude --resume abc-123",
    )
    expect(script).toContain('tell application "Terminal" to do script')
  })

  it('plain Linux: tries the common terminals in order', () => {
    const plan = composeLaunch({ os: 'linux' }, target({}))
    expect(plan.candidates.map((c) => c.file)).toEqual([
      'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm',
    ])
    expect(plan.candidates[1]!.args).toEqual([
      '--working-directory', '/home/d/code/app', '--', 'bash', '-lic', 'claude --resume abc-123',
    ])
  })

  it('fork appends --fork-session to the command', () => {
    const plan = composeLaunch(
      { os: 'linux' },
      target({ claudeArgs: ['--resume', 'abc-123', '--fork-session'] }),
    )
    expect(plan.command).toBe('claude --resume abc-123 --fork-session')
  })
})

describe('runLaunch', () => {
  it('walks candidates until one spawns, reporting the method', async () => {
    const tried: string[] = []
    const result = await runLaunch(
      {
        osPlatform: 'linux',
        wslDistro: () => undefined,
        spawnDetached: async (file) => {
          tried.push(file)
          if (file !== 'konsole') throw new Error(`ENOENT ${file}`)
        },
      },
      target({}),
    )
    expect(result).toMatchObject({ ok: true, method: 'konsole', command: 'claude --resume abc-123' })
    expect(tried).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole'])
  })

  it('keeps the copyable command when every terminal fails', async () => {
    const result = await runLaunch(
      {
        osPlatform: 'linux',
        wslDistro: () => undefined,
        spawnDetached: async () => {
          throw new Error('ENOENT')
        },
      },
      target({}),
    )
    expect(result.ok).toBe(false)
    expect(result.command).toBe('claude --resume abc-123')
    expect(result.cwd).toBe('/home/d/code/app')
  })
})

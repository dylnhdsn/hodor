import type { PathFlavor, SessionStore } from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Terminal launching for resume/fork/new-session (docs/brainstorm/016).
 *
 * Composition is pure — an environment plus a target yields an ordered list
 * of spawn candidates (argv vectors, no shell strings except where a shell
 * is the terminal's own command syntax). The launcher tries them in order;
 * the first terminal that spawns wins. Everything returns a copyable
 * command so "no terminal worked" still leaves the user one paste away.
 *
 * Cross-boundary rules mirror store origins: a WSL store's session resumes
 * inside that distro (wt.exe → wsl.exe --cd), a Windows store's session
 * resumes in a Windows shell even when hodor runs inside WSL.
 */

export interface LaunchEnv {
  os: 'win32' | 'darwin' | 'linux'
  /** Set when hodor itself runs inside WSL. */
  wslDistro?: string | undefined
  /** The user's login shell ($SHELL), for PTY specs on posix hosts. */
  shell?: string | undefined
}

export interface LaunchTarget {
  /** Store-native working directory for the new terminal. */
  cwd: string
  flavor: PathFlavor
  origin: SessionStore['origin']
  /** Arguments after `claude`, e.g. ['--resume', id, '--fork-session']. */
  claudeArgs: string[]
}

export interface LaunchCandidate {
  file: string
  args: string[]
}

export interface LaunchPlan {
  candidates: LaunchCandidate[]
  /** The command a human would run in a terminal already at cwd. */
  command: string
  cwd: string
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Escape for embedding inside an AppleScript double-quoted string. */
const appleQuote = (value: string): string => value.replace(/[\\"]/g, (c) => `\\${c}`)

export function composeLaunch(env: LaunchEnv, target: LaunchTarget): LaunchPlan {
  const claudeCmd = ['claude', ...target.claudeArgs]
  const command = claudeCmd.join(' ')
  const candidates: LaunchCandidate[] = []

  const wslSession = target.origin.kind === 'wsl' || (env.wslDistro !== undefined && target.origin.kind === 'native')
  const windowsSession =
    target.origin.kind === 'windows' || (env.os === 'win32' && target.origin.kind === 'native')

  if (env.os === 'win32' || env.wslDistro !== undefined) {
    if (wslSession) {
      // Run inside the right distro, with wt.exe (or a plain console) as
      // the window. bash -lic so login PATH setup finds claude.
      const distro = target.origin.kind === 'wsl' ? target.origin.distro : env.wslDistro
      const wsl = [
        'wsl.exe',
        ...(distro !== undefined ? ['-d', distro] : []),
        '--cd',
        target.cwd,
        '-e',
        'bash',
        '-lic',
        command,
      ]
      candidates.push({ file: 'wt.exe', args: wsl })
      candidates.push({ file: 'cmd.exe', args: ['/c', 'start', '', ...wsl] })
    } else if (windowsSession) {
      // cmd /k keeps the window open, so "claude not found" stays readable.
      candidates.push({ file: 'wt.exe', args: ['-d', target.cwd, 'cmd', '/k', ...claudeCmd] })
      candidates.push({
        file: 'cmd.exe',
        args: ['/c', 'start', '', '/d', target.cwd, 'cmd', '/k', ...claudeCmd],
      })
    }
  } else if (env.os === 'darwin') {
    const shell = `cd ${shellQuote(target.cwd)} && ${command}`
    candidates.push({
      file: 'osascript',
      args: [
        '-e',
        `tell application "Terminal" to do script "${appleQuote(shell)}"`,
        '-e',
        'tell application "Terminal" to activate',
      ],
    })
  } else {
    // Plain Linux desktop: try the common terminals in order.
    const shell = `cd ${shellQuote(target.cwd)} && ${command}`
    candidates.push({ file: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', shell] })
    candidates.push({
      file: 'gnome-terminal',
      args: ['--working-directory', target.cwd, '--', 'bash', '-lic', command],
    })
    candidates.push({ file: 'konsole', args: ['--workdir', target.cwd, '-e', 'bash', '-lic', command] })
    candidates.push({ file: 'xterm', args: ['-e', 'bash', '-lc', shell] })
  }

  return { candidates, command, cwd: target.cwd }
}

export interface PtySpec {
  file: string
  args: string[]
  /** Working directory for the PTY; absent when the command routes its own
   * (wsl.exe --cd takes a distro-native path a host spawn cwd can't). */
  cwd?: string
}

/**
 * The embedded-terminal variant of the launch matrix: instead of opening an
 * external terminal window, compose ONE argv to run inside a PTY the caller
 * owns (the desktop app). Same cross-boundary rules as composeLaunch; a
 * combination with no sensible PTY route returns undefined and the caller
 * falls back to the external-terminal path.
 */
export function composePtySpec(env: LaunchEnv, target: LaunchTarget): PtySpec | undefined {
  const claudeCmd = ['claude', ...target.claudeArgs]
  const command = claudeCmd.join(' ')
  const wslSession =
    target.origin.kind === 'wsl' || (env.wslDistro !== undefined && target.origin.kind === 'native')
  const windowsSession =
    target.origin.kind === 'windows' || (env.os === 'win32' && target.origin.kind === 'native')

  if (env.os === 'win32') {
    if (wslSession) {
      const distro = target.origin.kind === 'wsl' ? target.origin.distro : env.wslDistro
      return {
        file: 'wsl.exe',
        args: [
          ...(distro !== undefined ? ['-d', distro] : []),
          '--cd',
          target.cwd,
          '-e',
          'bash',
          '-lic',
          command,
        ],
      }
    }
    if (windowsSession) {
      return { file: 'cmd.exe', args: ['/c', ...claudeCmd], cwd: target.cwd }
    }
    return undefined
  }

  // Posix hosts can't enter a Windows store or a foreign WSL distro.
  if (target.origin.kind === 'windows') return undefined
  if (target.origin.kind === 'wsl' && env.wslDistro === undefined) return undefined
  // Login+interactive shell: a GUI-launched app has no shell PATH, and
  // claude usually lives in ~/.local/bin or a version-manager shim.
  return { file: env.shell ?? 'bash', args: ['-lic', command], cwd: target.cwd }
}

/**
 * An argv for running `claude …` on the HOST itself (no store routing):
 * used for capture-style runs like messaging a cloud session. Posix goes
 * through a login+interactive shell for the same PATH reason as PTYs.
 */
export function composeHostClaude(env: LaunchEnv, claudeArgs: string[]): PtySpec {
  if (env.os === 'win32') {
    return { file: 'cmd.exe', args: ['/c', 'claude', ...claudeArgs] }
  }
  const command = ['claude', ...claudeArgs].map(shellQuote).join(' ')
  return { file: env.shell ?? 'bash', args: ['-lic', command] }
}

export interface LaunchResult {
  ok: boolean
  /** The terminal that took the spawn, when ok. */
  method?: string
  error?: string
  command: string
  cwd: string
}

export async function runLaunch(
  deps: Pick<CliDeps, 'spawnDetached' | 'osPlatform' | 'wslDistro'>,
  target: LaunchTarget,
): Promise<LaunchResult> {
  const plan = composeLaunch({ os: deps.osPlatform, wslDistro: deps.wslDistro() }, target)
  if (plan.candidates.length === 0) {
    return { ok: false, error: 'no terminal launcher for this platform/store combination', ...plan }
  }
  let lastError = ''
  for (const candidate of plan.candidates) {
    try {
      await deps.spawnDetached(candidate.file, candidate.args)
      return { ok: true, method: candidate.file, command: plan.command, cwd: plan.cwd }
    } catch (error) {
      lastError = String(error)
    }
  }
  return { ok: false, error: lastError, command: plan.command, cwd: plan.cwd }
}

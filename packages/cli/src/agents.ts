import { normalizeAgentListing, type LiveAgent, type SessionStore, type SourceEvent } from '@hodor/core'
import { claudeCommand, composeHostClaude, type LaunchEnv, type PtySpec } from './launch.js'
import type { CliDeps } from './main.js'

/**
 * `claude agents --json`: the sessions the CLI has running right now,
 * interactive and background alike. Documented as the scripting-friendly
 * listing ("does not require a TTY"), so unlike the transcript format
 * this is a surface we are meant to read.
 *
 * It is the cross-check for hodor's inferred turn state. Inference is
 * still what covers the sessions that AREN'T running (most of them), but
 * for live ones the CLI owns the process and simply knows.
 *
 * One listing per HOST. The CLI on one side of the Windows/WSL boundary
 * cannot see the other side's processes: from Windows, a session living
 * in a distro is invisible to the Windows claude, and vice versa. Every
 * store hodor watches names the host its sessions run on, so each
 * foreign host gets its own listing and the results merge.
 *
 * Failure-tolerant by design: no claude on PATH, an old CLI without the
 * subcommand, or a slow spawn all mean "no cross-check from that host
 * this pass", never an error — the inference carries on alone.
 */

const ARGS = ['agents', '--json']
const TIMEOUT_MS = 10_000

/** The listing commands for hodor's own host plus each foreign store
 * host, deduplicated (two stores in one distro share a listing). */
export function composeAgentScans(env: LaunchEnv, stores: SessionStore[]): PtySpec[] {
  const specs = new Map<string, PtySpec>()
  const add = (spec: PtySpec): void => {
    specs.set(JSON.stringify([spec.file, ...spec.args]), spec)
  }
  add(composeHostClaude(env, ARGS))
  for (const store of stores) {
    if (store.origin.kind === 'wsl' && env.os === 'win32') {
      // Login+interactive shell so the distro's PATH setup finds claude.
      add({
        file: 'wsl.exe',
        args: ['-d', store.origin.distro, '-e', 'bash', '-lic', claudeCommand(ARGS)],
      })
    } else if (store.origin.kind === 'windows' && env.wslDistro !== undefined) {
      add({ file: 'cmd.exe', args: ['/c', 'claude', ...ARGS] })
    }
  }
  return [...specs.values()]
}

async function listFrom(deps: CliDeps, spec: PtySpec): Promise<LiveAgent[] | undefined> {
  const run = await deps
    .runCapture(spec.file, spec.args, { timeoutMs: TIMEOUT_MS })
    .catch(() => undefined)
  if (run === undefined || run.code !== 0) return undefined
  // The listing shares stdout with shell noise on some setups; take the
  // JSON array and ignore anything around it.
  const start = run.output.indexOf('[')
  const end = run.output.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(run.output.slice(start, end + 1))
  } catch {
    return undefined
  }
  return normalizeAgentListing(parsed)
}

export async function scanLiveAgents(
  deps: CliDeps,
  stores: SessionStore[] = [],
): Promise<SourceEvent | undefined> {
  const env: LaunchEnv = {
    os: deps.osPlatform,
    wslDistro: deps.wslDistro(),
    shell: deps.env('SHELL'),
  }
  const listings = await Promise.all(
    composeAgentScans(env, stores).map((spec) => listFrom(deps, spec)),
  )
  // Every host failing is "no cross-check"; one host answering is a
  // listing, even if another was silent this pass.
  if (listings.every((l) => l === undefined)) return undefined
  return {
    type: 'agents-listed',
    agents: listings.flatMap((l) => l ?? []),
    scannedAt: deps.now().toISOString(),
  }
}

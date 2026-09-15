import { normalizeAgentListing, type SourceEvent } from '@hodor/core'
import { composeHostClaude } from './launch.js'
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
 * Failure-tolerant by design: no claude on PATH, an old CLI without the
 * subcommand, or a slow spawn all mean "no cross-check this pass", never
 * an error — the inference carries on alone.
 */

const TIMEOUT_MS = 10_000

export async function scanLiveAgents(deps: CliDeps): Promise<SourceEvent | undefined> {
  const spec = composeHostClaude(
    { os: deps.osPlatform, wslDistro: deps.wslDistro(), shell: deps.env('SHELL') },
    ['agents', '--json'],
  )
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
  return {
    type: 'agents-listed',
    agents: normalizeAgentListing(parsed),
    scannedAt: deps.now().toISOString(),
  }
}

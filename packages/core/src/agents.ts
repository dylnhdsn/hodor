import type { SessionId } from './types.js'

/**
 * Live sessions as the CLI itself reports them (`claude agents --json`).
 *
 * hodor's turn state is INFERRED from transcripts, which is the only way
 * to know about sessions that aren't running. But for the ones that are,
 * the CLI knows the truth — it owns the process — and it says so in a
 * documented, TTY-free, machine-readable listing. We use it as the
 * cross-check: where the CLI speaks, it wins.
 *
 * This caught a real class of bug: a session the CLI reported `busy` was
 * being shown as "waiting since three hours ago" because a stale second
 * transcript had frozen the inference.
 */

export interface LiveAgent {
  sessionId: SessionId
  /** Short id (background sessions only) — what attach/stop/rm take. */
  shortId?: string
  pid?: number
  kind: 'interactive' | 'background'
  /** As reported: busy | idle | waiting | … (kept open-ended on purpose). */
  status: string
  /** Background sessions: what it is blocked on, e.g. "permission prompt". */
  waitingFor?: string
  /** Coarse lifecycle the CLI attaches to background rows, e.g. "blocked". */
  state?: string
  /** The CLI's own display name for the session. */
  name?: string
  cwd?: string
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

/** Parse a `claude agents --json` array. Unknown shapes yield []. */
export function normalizeAgentListing(body: unknown): LiveAgent[] {
  if (!Array.isArray(body)) return []
  const out: LiveAgent[] = []
  for (const row of body) {
    const r = obj(row)
    const sessionId = str(r['sessionId'])
    const status = str(r['status'])
    if (sessionId === undefined || status === undefined) continue
    const shortId = str(r['id'])
    const pid = typeof r['pid'] === 'number' ? r['pid'] : undefined
    const waitingFor = str(r['waitingFor'])
    const state = str(r['state'])
    const name = str(r['name'])
    const cwd = str(r['cwd'])
    out.push({
      sessionId,
      kind: str(r['kind']) === 'background' ? 'background' : 'interactive',
      status,
      ...(shortId !== undefined ? { shortId } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(waitingFor !== undefined ? { waitingFor } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    })
  }
  return out
}

/**
 * What the CLI's report means for the turn, when it means anything.
 *
 * - `busy`: the agent is working. Decisive — this is the one that fixes
 *   a stale "your turn".
 * - `waiting` / `blocked`: it stopped and wants a human. Decisive.
 * - anything else (notably `idle`, which just means "sitting at the
 *   prompt"): NOT decisive. Idle can't distinguish "just answered you,
 *   your turn" from "abandoned days ago" — the transcript can, so the
 *   inference keeps that call.
 */
export function turnFromAgent(agent: LiveAgent): 'working' | 'waiting' | undefined {
  if (agent.status === 'busy') return 'working'
  if (agent.status === 'waiting' || agent.state === 'blocked') return 'waiting'
  return undefined
}

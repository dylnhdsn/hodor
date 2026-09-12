import { normalizeGitUrl } from './urls.js'

/**
 * Cloud sessions: Claude Code sessions running in Anthropic-managed
 * containers (claude.ai/code, mobile). They have no local transcript —
 * everything hodor knows comes from the same session-list endpoint the
 * CLI's own cloud features use, so this is deliberately tolerant of
 * shape drift and the whole feature degrades to absence when the
 * listing is unavailable (no login, no scope, endpoint changed).
 */

export interface CloudSession {
  id: string
  title?: string
  /** RUNNING → 'running', everything else 'idle'. */
  status: 'running' | 'idle'
  /** Triage bucket: working | blocked | review-ready | completed. */
  bucket?: string
  createdAt?: string
  updatedAt?: string
  /** First source repository, normalized like local git remotes. */
  remoteUrl?: string
  /** ALL source repositories, normalized — cloud sessions can clone
   * several (e.g. an ideas repo plus the repo being built). */
  remoteUrls?: string[]
  /** owner/name of the first repository, for display. */
  repo?: string
  /** Filled by the snapshot: custom projects this session belongs to —
   * via a remote matcher, or by sharing a repo with a local session
   * those projects claim. */
  claimedBy?: string[]
  /** Filled by the snapshot: the auto project of a shared repo, when
   * local sessions on the same remote exist. */
  autoProjectId?: string
  /** Outcome branches the session pushed. */
  branches: string[]
  /** Filled by the snapshot: the first outcome branch no longer exists in
   * the joined local checkout or on its origin — opening this session
   * will resume without the branch (the Claude CLI's checkout will fail
   * and it proceeds on the current branch). */
  branchGone?: boolean
  model?: string
  effort?: string
  /** Where the session was started: web_claude_ai, android, … */
  origin?: string
  /** The session's own words about where it stands. */
  statusDetail?: string
  needsAction?: string
  recentAction?: string
  contextUsed?: number
  contextMax?: number
  costUsd?: number
  url: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

function bucketOf(raw: unknown): string | undefined {
  const s = str(raw)
  if (s === undefined) return undefined
  // SESSION_STATUS_BUCKET_REVIEW_READY → review-ready
  return s.replace(/^SESSION_STATUS_BUCKET_/, '').toLowerCase().replace(/_/g, '-')
}

/** Normalize one record from the session listing; null if it has no id. */
export function normalizeCloudSession(raw: unknown): CloudSession | null {
  const r = obj(raw)
  const id = str(r['id'])
  if (id === undefined) return null

  // Two record dialects exist (verified against the CLI's own record
  // normalizer): enriched records carry `session_context`, raw REST list
  // records keep the same data under `config` — and nest differently:
  // outcomes are {type:'git_repository', git_info} rather than
  // {git_repository:{git_info}}. Read both.
  const context = { ...obj(r['config']), ...obj(r['session_context']) }
  const sources = Array.isArray(context['sources']) ? context['sources'] : []
  const sourceUrls = sources
    .map((s) => str(obj(obj(obj(s)['git_repository']))['url']) ?? str(obj(s)['url']))
    .filter((u): u is string => u !== undefined)
  const firstSourceUrl = sourceUrls[0]
  const outcomes = Array.isArray(context['outcomes']) ? context['outcomes'] : []
  const branches: string[] = []
  for (const outcome of outcomes) {
    const entry = obj(outcome)
    const info = { ...obj(entry['git_info']), ...obj(obj(entry['git_repository'])['git_info']) }
    for (const branch of Array.isArray(info['branches']) ? info['branches'] : []) {
      const b = str(branch)
      if (b !== undefined && !branches.includes(b)) branches.push(b)
    }
  }

  const meta = obj(r['external_metadata'])
  // The summary appears at the top level and nested in external_metadata
  // depending on server version; prefer the top level.
  const summary = { ...obj(meta['post_turn_summary']), ...obj(r['post_turn_summary']) }
  const contextUsage = obj(meta['context_usage'])
  const usage = obj(meta['usage'])
  const remoteUrl = firstSourceUrl !== undefined ? normalizeGitUrl(firstSourceUrl) : undefined

  const running =
    str(r['session_status']) === 'SESSION_STATUS_RUNNING' ||
    str(r['worker_status']) === 'running'
  const session: CloudSession = {
    id,
    status: running ? 'running' : 'idle',
    branches,
    url: `https://claude.ai/code/${id}`,
  }
  const title = str(r['title'])
  if (title !== undefined) session.title = title
  const bucket = bucketOf(r['status_bucket'])
  if (bucket !== undefined) session.bucket = bucket
  const createdAt = str(r['created_at'])
  if (createdAt !== undefined) session.createdAt = createdAt
  // Raw records often carry last_event_at instead of updated_at.
  const updatedAt = str(r['updated_at']) ?? str(r['last_event_at'])
  if (updatedAt !== undefined) session.updatedAt = updatedAt
  if (remoteUrl !== undefined) {
    session.remoteUrl = remoteUrl
    session.remoteUrls = [...new Set(sourceUrls.map(normalizeGitUrl))]
    // owner/name for display: the last two path segments of the remote.
    const segments = remoteUrl.split('/').filter((s) => s.length > 0)
    session.repo = segments.slice(-2).join('/')
  }
  const model = str(context['model'])
  if (model !== undefined) session.model = model
  const effort = str(context['effort_level'])
  if (effort !== undefined) session.effort = effort
  const origin = str(r['origin'])
  if (origin !== undefined) session.origin = origin
  const statusDetail = str(summary['status_detail'])
  if (statusDetail !== undefined) session.statusDetail = statusDetail
  const needsAction = str(summary['needs_action'])
  if (needsAction !== undefined) session.needsAction = needsAction
  const recentAction = str(summary['recent_action'])
  if (recentAction !== undefined) session.recentAction = recentAction
  const used = num(contextUsage['used_tokens'])
  if (used !== undefined) session.contextUsed = used
  const max = num(contextUsage['max_tokens'])
  if (max !== undefined) session.contextMax = max
  const cost = num(usage['cost_usd'])
  if (cost !== undefined) session.costUsd = cost
  return session
}

/** Normalize a whole listing response body; tolerant of envelope shape. */
export function normalizeCloudListing(body: unknown): CloudSession[] {
  const b = obj(body)
  const rows = Array.isArray(b['data'])
    ? b['data']
    : Array.isArray(b['sessions'])
      ? b['sessions']
      : []
  const sessions: CloudSession[] = []
  for (const row of rows) {
    const session = normalizeCloudSession(row)
    if (session !== null) sessions.push(session)
  }
  return sessions
}

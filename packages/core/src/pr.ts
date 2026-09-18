/**
 * The pull request a session's branch is on, as `gh pr list` reports it
 * (docs/brainstorm/028 in spirit: "snooze until the PR moves"). hodor
 * keeps a one-line summary and a FINGERPRINT — the parts that change when
 * the PR moves: a push, a review, a comment, a merge. A skip taken
 * against the fingerprint lifts when it differs.
 */

export interface PrInfo {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed'
  draft?: boolean
  /** approved / changes requested / review required, when GitHub says. */
  review?: string
  /** state|head|review|updatedAt — differs whenever the PR moved. */
  fingerprint: string
  checkedAt: string
}

const REVIEWS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required',
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** One entry of `gh pr list --json number,url,state,isDraft,reviewDecision,updatedAt,headRefOid` → PrInfo. */
export function normalizePr(raw: unknown, checkedAt: string): PrInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const number = typeof r['number'] === 'number' ? r['number'] : undefined
  const url = str(r['url'])
  const stateRaw = str(r['state'])?.toUpperCase()
  if (number === undefined || url === undefined || stateRaw === undefined) return undefined
  const state = stateRaw === 'MERGED' ? 'merged' : stateRaw === 'CLOSED' ? 'closed' : 'open'
  const review = REVIEWS[str(r['reviewDecision']) ?? '']
  const draft = r['isDraft'] === true
  const head = str(r['headRefOid']) ?? ''
  const updatedAt = str(r['updatedAt']) ?? ''
  return {
    number,
    url,
    state,
    ...(draft ? { draft } : {}),
    ...(review !== undefined ? { review } : {}),
    fingerprint: `${state}|${head}|${review ?? ''}|${updatedAt}`,
    checkedAt,
  }
}

/** The whole `gh pr list` output (a JSON array) → the PR, null for none,
 * undefined for output that is not a listing at all. */
export function normalizePrListing(text: string, checkedAt: string): PrInfo | null | undefined {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  if (parsed.length === 0) return null
  return normalizePr(parsed[0], checkedAt) ?? undefined
}

/** How a chip says it: "#12 open · changes requested". */
export function prLabel(pr: PrInfo): string {
  const parts = [`#${pr.number} ${pr.state}`]
  if (pr.draft === true) parts.push('draft')
  if (pr.review !== undefined) parts.push(pr.review)
  return parts.join(' · ')
}

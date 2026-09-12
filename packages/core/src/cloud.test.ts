import { describe, expect, it } from 'vitest'
import { normalizeCloudListing, normalizeCloudSession } from './cloud.js'
import { emptyState, foldAll } from './fold.js'
import { buildSnapshot } from './snapshot.js'

// Shape modeled on real /v1/code/sessions records (docs/brainstorm/019).
const record = {
  id: 'session_01AAA',
  title: 'Fix the flux capacitor',
  session_status: 'SESSION_STATUS_RUNNING',
  status_bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY',
  created_at: '2026-09-10T02:16:54.841899Z',
  updated_at: '2026-09-10T02:57:11.398113Z',
  origin: 'android',
  session_context: {
    sources: [{ git_repository: { url: 'https://github.com/acme/flux', revision: 'refs/heads/main' } }],
    outcomes: [{ git_repository: { git_info: { repo: 'acme/flux', branches: ['claude/fix-flux-abc123'] } } }],
    model: 'claude-fable-5',
    effort_level: 'xhigh',
  },
  post_turn_summary: {
    status_category: 'need_input',
    status_detail: 'two designs possible',
    needs_action: 'pick a design',
    recent_action: 'benchmarked both',
  },
  external_metadata: {
    context_usage: { max_tokens: 1000000, used_tokens: 210133 },
    usage: { cost_usd: 35.005489, input_tokens: 1390918, output_tokens: 218237 },
  },
}

describe('normalizeCloudSession', () => {
  it('maps a full listing record', () => {
    expect(normalizeCloudSession(record)).toEqual({
      id: 'session_01AAA',
      title: 'Fix the flux capacitor',
      status: 'running',
      bucket: 'review-ready',
      createdAt: '2026-09-10T02:16:54.841899Z',
      updatedAt: '2026-09-10T02:57:11.398113Z',
      remoteUrl: 'github.com/acme/flux',
      repo: 'acme/flux',
      branches: ['claude/fix-flux-abc123'],
      model: 'claude-fable-5',
      effort: 'xhigh',
      origin: 'android',
      statusDetail: 'two designs possible',
      needsAction: 'pick a design',
      recentAction: 'benchmarked both',
      contextUsed: 210133,
      contextMax: 1000000,
      costUsd: 35.005489,
      url: 'https://claude.ai/code/session_01AAA',
    })
  })

  it('tolerates sparse records and rejects id-less ones', () => {
    expect(normalizeCloudSession({ id: 'session_x' })).toEqual({
      id: 'session_x',
      status: 'idle',
      branches: [],
      url: 'https://claude.ai/code/session_x',
    })
    expect(normalizeCloudSession({ title: 'no id' })).toBeNull()
    expect(normalizeCloudSession('nonsense')).toBeNull()
  })

  it('prefers the top-level post_turn_summary over the nested copy', () => {
    const s = normalizeCloudSession({
      id: 'session_y',
      post_turn_summary: { status_detail: 'top' },
      external_metadata: { post_turn_summary: { status_detail: 'nested', needs_action: 'from nested' } },
    })
    expect(s?.statusDetail).toBe('top')
    expect(s?.needsAction).toBe('from nested')
  })
})

describe('normalizeCloudListing', () => {
  it('accepts data or sessions envelopes and skips junk rows', () => {
    expect(normalizeCloudListing({ data: [record, null, 5] })).toHaveLength(1)
    expect(normalizeCloudListing({ sessions: [record] })).toHaveLength(1)
    expect(normalizeCloudListing({})).toEqual([])
    expect(normalizeCloudListing('nope')).toEqual([])
  })
})

describe('cloud sessions in the fold and snapshot', () => {
  it('replaces wholesale per scan and sorts newest first', () => {
    const older = { ...normalizeCloudSession(record)!, id: 'session_old', updatedAt: '2026-09-01T00:00:00Z' }
    const newer = { ...normalizeCloudSession(record)!, id: 'session_new', updatedAt: '2026-09-11T00:00:00Z' }
    let state = foldAll(emptyState, [
      { type: 'cloud-sessions-scanned', sessions: [older], scannedAt: '2026-09-11T01:00:00Z' },
      { type: 'cloud-sessions-scanned', sessions: [older, newer], scannedAt: '2026-09-11T02:00:00Z' },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-11T03:00:00Z') })
    expect(snapshot.cloudSessions.map((s) => s.id)).toEqual(['session_new', 'session_old'])
    expect(snapshot.cloudError).toBeUndefined()

    state = foldAll(state, [
      { type: 'cloud-sessions-scanned', sessions: [], scannedAt: '2026-09-11T04:00:00Z', error: 'HTTP 500' },
    ])
    const failed = buildSnapshot(state, { now: new Date('2026-09-11T05:00:00Z') })
    expect(failed.cloudSessions).toEqual([])
    expect(failed.cloudError).toBe('HTTP 500')
  })
})

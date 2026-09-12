import { describe, expect, it } from 'vitest'
import { normalizeCloudListing, normalizeCloudSession } from './cloud.js'
import type { SourceEvent } from './events.js'
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
      remoteUrls: ['github.com/acme/flux'],
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

  it('reads the raw REST dialect: config.*, last_event_at, worker_status, typed outcomes', () => {
    // Shape confirmed against the CLI's own record normalizer and a real
    // `hodor cloud` run: cse_ ids, sources under config, no updated_at.
    const raw = normalizeCloudSession({
      id: 'cse_01ABC',
      title: 'Hodor',
      worker_status: 'running',
      status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
      created_at: '2026-09-12T18:00:00Z',
      last_event_at: '2026-09-12T19:00:00Z',
      config: {
        sources: [{ git_repository: { url: 'https://github.com/dylnhdsn/hodor' } }],
        outcomes: [{ type: 'git_repository', git_info: { repo: 'dylnhdsn/hodor', branches: ['claude/x-1'] } }],
        model: 'claude-fable-5',
      },
      post_turn_summary: { needs_action: 'report back' },
    })
    expect(raw).toMatchObject({
      id: 'cse_01ABC',
      status: 'running',
      bucket: 'blocked',
      updatedAt: '2026-09-12T19:00:00Z',
      remoteUrl: 'github.com/dylnhdsn/hodor',
      repo: 'dylnhdsn/hodor',
      branches: ['claude/x-1'],
      model: 'claude-fable-5',
      needsAction: 'report back',
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

describe('cloud↔project correlation (Dylan case: shared repo with local sessions)', () => {
  const store = {
    id: 's1',
    rootPath: '/home/u/.claude',
    pathFlavor: 'posix' as const,
    origin: { kind: 'native' as const },
    watchStrategy: 'poll' as const,
  }
  const localSession = (id: string, cwd: string): SourceEvent => ({
    type: 'transcript-lines',
    storeId: 's1',
    transcriptPath: `/home/u/.claude/projects/-x/${id}.jsonl`,
    sessionId: id,
    lines: [
      {
        kind: 'message',
        type: 'user',
        uuid: `${id}-u1`,
        parentUuid: null,
        isSidechain: false,
        isMeta: false,
        timestamp: '2026-09-12T10:00:00Z',
        cwd,
        promptText: 'work',
      },
    ],
  })
  const cloudOn = (id: string, ...urls: string[]) =>
    normalizeCloudSession({
      id,
      session_context: { sources: urls.map((u) => ({ git_repository: { url: u } })) },
      updated_at: '2026-09-12T11:00:00Z',
    })!

  it('joins through git contexts, case-insensitively, across all sources', () => {
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession('local1', '/repo/app/src'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/repo/app/src',
        // local remote drifts in case; the cwd is a subdir of the root
        context: { repoRoot: '/repo/app', isWorktree: false, remoteUrl: 'git@github.com:Acme/App.git' },
      },
      {
        type: 'cloud-sessions-scanned',
        scannedAt: '2026-09-12T11:30:00Z',
        sessions: [
          // second source matches; first is an unrelated ideas repo
          cloudOn('session_hit', 'https://github.com/acme/ideas', 'https://github.com/acme/app'),
          cloudOn('session_miss', 'https://github.com/other/thing'),
        ],
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T12:00:00Z') })
    const hit = snapshot.cloudSessions.find((s) => s.id === 'session_hit')!
    expect(hit.autoProjectId).toBe(snapshot.assignments.find((a) => a.sessionId === 'local1')!.projectId)
    // no local sessions share other/thing → it becomes a cloud-only project
    expect(snapshot.cloudSessions.find((s) => s.id === 'session_miss')!.autoProjectId).toBe(
      'git-remote:github.com/other/thing',
    )
  })

  it('lends the local session s custom claims to the cloud session', () => {
    const state = foldAll(emptyState, [
      { type: 'store-discovered', store },
      localSession('local1', '/repo/app'),
      {
        type: 'git-context-resolved',
        storeId: 's1',
        cwd: '/repo/app',
        context: { repoRoot: '/repo/app', isWorktree: false, remoteUrl: 'https://github.com/acme/app' },
      },
      {
        type: 'userplane-changed',
        plane: {
          projects: [
            {
              id: 'my-lane',
              name: 'My Lane',
              // folder-based matcher: no remote evidence of its own
              matchers: [{ kind: 'root', path: '/repo/app' }],
              excludeMatchers: [],
              include: [],
              exclude: [],
            },
          ],
        },
      },
      {
        type: 'cloud-sessions-scanned',
        scannedAt: '2026-09-12T11:30:00Z',
        sessions: [cloudOn('session_c', 'https://github.com/acme/app.git')],
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T12:00:00Z') })
    expect(snapshot.cloudSessions[0]!.claimedBy).toEqual(['my-lane'])
  })

  it('remote matchers claim cloud sessions even with zero local sessions', () => {
    const state = foldAll(emptyState, [
      {
        type: 'userplane-changed',
        plane: {
          projects: [
            {
              id: 'ext',
              name: 'Ext',
              matchers: [{ kind: 'remote', url: 'https://github.com/Acme/Widget.git' }],
              excludeMatchers: [],
              include: [],
              exclude: [],
            },
          ],
        },
      },
      {
        type: 'cloud-sessions-scanned',
        scannedAt: '2026-09-12T11:30:00Z',
        sessions: [cloudOn('session_w', 'https://github.com/acme/widget')],
      },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T12:00:00Z') })
    expect(snapshot.cloudSessions[0]!.claimedBy).toEqual(['ext'])
  })

  it('snapshot purity: correlation never touches fold state', () => {
    const state = foldAll(emptyState, [
      {
        type: 'cloud-sessions-scanned',
        scannedAt: '2026-09-12T11:30:00Z',
        sessions: [cloudOn('session_p', 'https://github.com/acme/app')],
      },
    ])
    buildSnapshot(state, { now: new Date('2026-09-12T12:00:00Z') })
    expect(state.cloud.sessions[0]!.claimedBy).toBeUndefined()
    expect(state.cloud.sessions[0]!.autoProjectId).toBeUndefined()
  })
})

describe('cloud-only repos become ordinary projects', () => {
  it('synthesizes a resolver-style auto project and attaches the session', () => {
    const cloud = normalizeCloudSession({
      id: 'cse_solo',
      title: 'Hodor',
      config: { sources: [{ git_repository: { url: 'https://github.com/dylnhdsn/hodor' } }] },
      last_event_at: '2026-09-12T19:00:00Z',
    })!
    const state = foldAll(emptyState, [
      { type: 'cloud-sessions-scanned', sessions: [cloud], scannedAt: '2026-09-12T19:30:00Z' },
    ])
    const snapshot = buildSnapshot(state, { now: new Date('2026-09-12T20:00:00Z') })
    const project = snapshot.projects.find((p) => p.id === 'git-remote:github.com/dylnhdsn/hodor')
    expect(project).toMatchObject({
      name: 'hodor',
      identity: { kind: 'git-remote', url: 'github.com/dylnhdsn/hodor' },
      roots: [],
    })
    expect(snapshot.cloudSessions[0]!.autoProjectId).toBe('git-remote:github.com/dylnhdsn/hodor')
    // no repo → nothing to synthesize
    const bare = normalizeCloudSession({ id: 'cse_norepo', title: 'chat' })!
    const state2 = foldAll(emptyState, [
      { type: 'cloud-sessions-scanned', sessions: [bare], scannedAt: '2026-09-12T19:30:00Z' },
    ])
    const snapshot2 = buildSnapshot(state2, { now: new Date('2026-09-12T20:00:00Z') })
    expect(snapshot2.projects).toEqual([])
    expect(snapshot2.cloudSessions[0]!.autoProjectId).toBeUndefined()
  })
})

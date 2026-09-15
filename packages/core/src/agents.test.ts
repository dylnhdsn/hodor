import { describe, expect, it } from 'vitest'
import { normalizeAgentListing, turnFromAgent } from './agents.js'

describe('live agent listing', () => {
  it('parses real `claude agents --json` rows, interactive and background', () => {
    const agents = normalizeAgentListing([
      {
        pid: 105,
        cwd: '/home/user/hodor',
        kind: 'interactive',
        startedAt: 1789493686098,
        sessionId: '0d6e5057-8985-5d36-920b-d4f3548a8fe7',
        name: 'hodor-8a',
        status: 'busy',
      },
      {
        pid: 542,
        id: 'fa45e953',
        cwd: '/tmp/x',
        kind: 'background',
        sessionId: 'fa45e953-1bc4-4bcb-9daa-9af7155cd383',
        name: 'write banana',
        status: 'waiting',
        waitingFor: 'permission prompt',
        state: 'blocked',
      },
    ])
    expect(agents).toEqual([
      {
        sessionId: '0d6e5057-8985-5d36-920b-d4f3548a8fe7',
        kind: 'interactive',
        status: 'busy',
        pid: 105,
        name: 'hodor-8a',
        cwd: '/home/user/hodor',
      },
      {
        sessionId: 'fa45e953-1bc4-4bcb-9daa-9af7155cd383',
        kind: 'background',
        status: 'waiting',
        shortId: 'fa45e953',
        pid: 542,
        waitingFor: 'permission prompt',
        state: 'blocked',
        name: 'write banana',
        cwd: '/tmp/x',
      },
    ])
  })

  it('ignores junk rather than inventing sessions', () => {
    expect(normalizeAgentListing(undefined)).toEqual([])
    expect(normalizeAgentListing({ nope: true })).toEqual([])
    expect(normalizeAgentListing([{ sessionId: 'a' }, { status: 'busy' }, 7])).toEqual([])
  })

  it('is decisive only where the CLI actually knows', () => {
    const base = { sessionId: 'a', kind: 'interactive' as const }
    expect(turnFromAgent({ ...base, status: 'busy' })).toBe('working')
    expect(turnFromAgent({ ...base, status: 'waiting' })).toBe('waiting')
    expect(turnFromAgent({ ...base, status: 'idle', state: 'blocked' })).toBe('waiting')
    // idle just means "sitting at the prompt" — it cannot tell "your turn"
    // from "abandoned last week", so the transcript keeps that call
    expect(turnFromAgent({ ...base, status: 'idle' })).toBeUndefined()
    expect(turnFromAgent({ ...base, status: 'something-new' })).toBeUndefined()
  })
})

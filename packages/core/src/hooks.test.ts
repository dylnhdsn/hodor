import { describe, expect, it } from 'vitest'
import { hookIsCurrent, normalizeHookEvent, summarizeToolInput, turnFromHook } from './hooks.js'

const AT = '2026-09-18T18:00:00.000Z'
const base = { session_id: 's1', cwd: '/w', transcript_path: '/h/.claude/projects/-w/s1.jsonl' }

describe('normalizeHookEvent', () => {
  it('keeps the session, paths, and the words that matter per event', () => {
    const stop = normalizeHookEvent(
      { ...base, hook_event_name: 'Stop', last_assistant_message: 'Done.  Want me to  push?' },
      AT,
    )
    expect(stop).toEqual({
      sessionId: 's1',
      cwd: '/w',
      transcriptPath: '/h/.claude/projects/-w/s1.jsonl',
      fact: { name: 'Stop', at: AT, text: 'Done. Want me to push?' },
    })
    const perm = normalizeHookEvent(
      { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } },
      AT,
    )
    expect(perm?.fact).toEqual({ name: 'PermissionRequest', at: AT, tool: 'Bash', text: 'Bash: rm -rf dist' })
    const note = normalizeHookEvent(
      { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting' },
      AT,
    )
    expect(note?.fact).toEqual({ name: 'Notification', at: AT, notification: 'idle_prompt', text: 'Claude is waiting' })
    expect(normalizeHookEvent({ ...base, hook_event_name: 'SessionEnd', reason: 'other' }, AT)?.fact).toEqual({
      name: 'SessionEnd',
      at: AT,
      reason: 'other',
    })
  })

  // A Stop with work still pending is the agent pausing, not finishing.
  it('marks a Stop with background work as busy', () => {
    const out = normalizeHookEvent(
      { ...base, hook_event_name: 'Stop', background_tasks: [{ id: 't1' }], session_crons: [] },
      AT,
    )
    expect(out?.fact.busy).toBe(true)
  })

  it('ignores events hodor does not keep, and anything without a session', () => {
    expect(normalizeHookEvent({ ...base, hook_event_name: 'PreToolUse' }, AT)).toBeUndefined()
    expect(normalizeHookEvent({ hook_event_name: 'Stop' }, AT)).toBeUndefined()
    expect(normalizeHookEvent('nope', AT)).toBeUndefined()
    expect(normalizeHookEvent(null, AT)).toBeUndefined()
  })

  it('clips long previews to one line', () => {
    const long = 'x'.repeat(500)
    const out = normalizeHookEvent({ ...base, hook_event_name: 'Stop', last_assistant_message: long }, AT)
    expect(out?.fact.text?.length).toBe(200)
    expect(out?.fact.text?.endsWith('…')).toBe(true)
  })
})

describe('summarizeToolInput', () => {
  it('names the thing the tool wants', () => {
    expect(summarizeToolInput('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('Edit: /a/b.ts')
    expect(summarizeToolInput('WebFetch', { url: 'https://x.y' })).toBe('WebFetch: https://x.y')
    expect(summarizeToolInput('Weird', { nested: { a: 1 } })).toBe('Weird')
    expect(summarizeToolInput('Weird', undefined)).toBe('Weird')
  })
})

describe('turnFromHook', () => {
  it('maps each fact to the turn it states', () => {
    expect(turnFromHook({ name: 'UserPromptSubmit', at: AT })).toEqual({ state: 'working' })
    expect(turnFromHook({ name: 'Stop', at: AT, text: 'Done' })).toEqual({ state: 'waiting', since: AT, preview: 'Done' })
    expect(turnFromHook({ name: 'Stop', at: AT, busy: true })).toEqual({ state: 'working' })
    expect(turnFromHook({ name: 'StopFailure', at: AT })).toEqual({ state: 'waiting', since: AT, preview: 'API error' })
    expect(turnFromHook({ name: 'PermissionRequest', at: AT, tool: 'Bash', text: 'Bash: ls' })).toEqual({
      state: 'waiting',
      since: AT,
      preview: 'Bash: ls',
      pending: { tool: 'Bash' },
    })
    expect(turnFromHook({ name: 'Notification', at: AT, notification: 'permission_prompt' })).toMatchObject({
      state: 'waiting',
      pending: { tool: 'permission' },
    })
    expect(turnFromHook({ name: 'Notification', at: AT, notification: 'idle_prompt' })).toEqual({ state: 'waiting', since: AT })
    expect(turnFromHook({ name: 'Notification', at: AT, notification: 'auth_success' })).toBeUndefined()
    expect(turnFromHook({ name: 'SessionEnd', at: AT })).toEqual({ state: 'idle' })
    expect(turnFromHook({ name: 'SessionStart', at: AT, reason: 'resume' })).toBeUndefined()
  })
})

describe('hookIsCurrent', () => {
  it('is newer-wins with one second of slack for coarse stamps', () => {
    expect(hookIsCurrent('2026-09-18T18:00:05.000Z', undefined)).toBe(true)
    expect(hookIsCurrent('2026-09-18T18:00:05.000Z', '2026-09-18T18:00:04.900Z')).toBe(true)
    // a whole-second stamp from the same second as a millisecond line
    expect(hookIsCurrent('2026-09-18T18:00:05.000Z', '2026-09-18T18:00:05.376Z')).toBe(true)
    expect(hookIsCurrent('2026-09-18T18:00:05.000Z', '2026-09-18T18:00:06.001Z')).toBe(false)
    expect(hookIsCurrent('garbage', '2026-09-18T18:00:06.001Z')).toBe(false)
  })
})


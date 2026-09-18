import { describe, expect, it } from 'vitest'
import { emptyState, foldAll } from './fold.js'
import { classifyTurn } from './snapshot.js'
import type { SourceEvent } from './events.js'
import type { HookFact } from './hooks.js'

const NOW = new Date('2026-09-18T18:10:00.000Z')
const t = (s: string) => `2026-09-18T18:0${s}.000Z`

const hook = (fact: HookFact, over: Partial<Extract<SourceEvent, { type: 'hook-event' }>> = {}) =>
  ({ type: 'hook-event', storeId: 'st', sessionId: 's1', transcriptPath: '/t/s1.jsonl', fact, ...over }) as const

describe('hook facts in the fold', () => {
  it('creates the session from the hook when no transcript exists yet', () => {
    const state = foldAll(emptyState, [
      hook({ name: 'SessionStart', at: t('0:00'), reason: 'startup' }, { cwd: '/w' }),
    ])
    const accum = state.sessions['s1']!
    expect(accum.transcriptPath).toBe('/t/s1.jsonl')
    expect(accum.cwds).toEqual(['/w'])
    expect(accum.hook).toEqual({ name: 'SessionStart', at: t('0:00'), reason: 'startup' })
    expect(accum.lastMainAt).toBeUndefined()
  })

  it('treats a prompt and a finished turn as main-line events', () => {
    let state = foldAll(emptyState, [hook({ name: 'UserPromptSubmit', at: t('1:00') })])
    let accum = state.sessions['s1']!
    expect(accum.lastMainKind).toBe('human')
    expect(accum.lastMainAt).toBe(t('1:00'))
    state = foldAll(state, [hook({ name: 'Stop', at: t('1:30'), text: 'Shipped.' })])
    accum = state.sessions['s1']!
    expect(accum.lastMainKind).toBe('assistant-text')
    expect(accum.lastMainText).toBe('Shipped.')
    expect(classifyTurn(accum, NOW)).toEqual({ state: 'waiting', since: t('1:30'), preview: 'Shipped.', source: 'hook' })
  })

  // Files can be drained in any order; the clock, not the order, wins.
  it('never rolls the turn backwards on a stale file', () => {
    const state = foldAll(emptyState, [
      hook({ name: 'Stop', at: t('2:00'), text: 'Done' }),
      hook({ name: 'UserPromptSubmit', at: t('1:00') }),
    ])
    const accum = state.sessions['s1']!
    expect(accum.hook?.name).toBe('Stop')
    expect(accum.lastMainKind).toBe('assistant-text')
    expect(classifyTurn(accum, NOW)?.state).toBe('waiting')
  })

  it('a permission ask is decisive until the transcript moves past it', () => {
    let state = foldAll(emptyState, [
      hook({ name: 'PermissionRequest', at: t('3:00'), tool: 'Bash', text: 'Bash: rm -rf dist' }),
    ])
    expect(classifyTurn(state.sessions['s1']!, NOW)).toEqual({
      state: 'waiting',
      since: t('3:00'),
      preview: 'Bash: rm -rf dist',
      pending: { tool: 'Bash' },
      source: 'hook',
    })
    // a newer main-line event (the tool ran) retires the fact
    const accum = { ...state.sessions['s1']!, lastMainAt: t('3:05'), lastMainKind: 'tool-result' as const }
    expect(classifyTurn(accum, NOW)?.source).not.toBe('hook')
    void state
  })

  it('SessionEnd is a definitive idle; a later SessionStart lifts it', () => {
    let state = foldAll(emptyState, [
      hook({ name: 'Stop', at: t('4:00'), text: 'Bye' }),
      hook({ name: 'SessionEnd', at: t('4:30'), reason: 'other' }),
    ])
    expect(classifyTurn(state.sessions['s1']!, NOW)).toEqual({ state: 'idle', source: 'hook' })
    state = foldAll(state, [hook({ name: 'SessionStart', at: t('5:00'), reason: 'resume' })])
    // liveness only: the turn falls back to what the transcript says
    expect(classifyTurn(state.sessions['s1']!, NOW)?.source).not.toBe('hook')
    expect(classifyTurn(state.sessions['s1']!, NOW)?.state).toBe('waiting')
  })

  it('a Stop with background work pending is still working', () => {
    const state = foldAll(emptyState, [hook({ name: 'Stop', at: t('6:00'), busy: true })])
    expect(classifyTurn(state.sessions['s1']!, NOW)).toEqual({ state: 'working', source: 'hook' })
  })
})

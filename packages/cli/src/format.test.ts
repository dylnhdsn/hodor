import { describe, expect, it } from 'vitest'
import { fitEnd, fitStart, formatAge } from './format.js'

describe('fitEnd', () => {
  it('truncates keeping the start', () => {
    expect(fitEnd('hello world', 20)).toBe('hello world')
    expect(fitEnd('hello world', 11)).toBe('hello world')
    expect(fitEnd('hello world', 8)).toBe('hello w…')
    expect(fitEnd('hello', 1)).toBe('…')
    expect(fitEnd('hello', 0)).toBe('')
  })
})

describe('fitStart', () => {
  it('truncates keeping the tail', () => {
    expect(fitStart('.claude/worktrees/live-parity', 40)).toBe('.claude/worktrees/live-parity')
    expect(fitStart('.claude/worktrees/live-parity', 12)).toBe('…live-parity')
    expect(fitStart('abcdef', 4)).toBe('…def')
    expect(fitStart('abcdef', 1)).toBe('…')
    expect(fitStart('abcdef', 0)).toBe('')
  })
})

describe('formatAge', () => {
  const now = Date.parse('2026-06-01T12:00:00Z')
  const at = (iso: string) => formatAge(now, iso)

  it('formats compact relative ages', () => {
    expect(at('2026-06-01T11:59:40Z')).toBe('now')
    expect(at('2026-06-01T11:55:00Z')).toBe('5m')
    expect(at('2026-06-01T09:00:00Z')).toBe('3h')
    expect(at('2026-05-30T13:00:00Z')).toBe('47h')
    expect(at('2026-05-30T11:00:00Z')).toBe('2d')
    expect(at('2026-05-19T12:00:00Z')).toBe('13d')
    expect(at('2026-05-18T12:00:00Z')).toBe('2w')
    expect(at('2026-03-01T12:00:00Z')).toBe('3mo')
  })

  it('handles missing and malformed timestamps', () => {
    expect(formatAge(now)).toBe('-')
    expect(at('not-a-date')).toBe('-')
    // clock skew: future timestamps read as fresh, not negative
    expect(at('2026-06-01T12:05:00Z')).toBe('now')
  })
})

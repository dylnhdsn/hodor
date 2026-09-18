import { describe, expect, it } from 'vitest'
import { CHANNELS, cliChannel, feedUrlOf, isChannel, releaseTagOf } from './channel.js'

describe('release channels', () => {
  // 'latest' is what every install shipped so far tracks; renaming the
  // nightly tag would strand them on a feed that never moves again.
  it('keeps nightly on the historical latest tag', () => {
    expect(releaseTagOf('nightly')).toBe('latest')
    expect(releaseTagOf('stable')).toBe('stable')
    expect(releaseTagOf('experimental')).toBe('experimental')
  })

  it('builds each channel its own asset base', () => {
    expect(feedUrlOf('nightly')).toBe('https://github.com/dylnhdsn/hodor/releases/download/latest')
    expect(feedUrlOf('stable')).toBe('https://github.com/dylnhdsn/hodor/releases/download/stable')
  })

  it('recognizes exactly the three channels', () => {
    for (const c of CHANNELS) expect(isChannel(c)).toBe(true)
    expect(isChannel('latest')).toBe(false)
    expect(isChannel('')).toBe(false)
    expect(isChannel(undefined)).toBe(false)
  })

  it('is nightly in a dev checkout (no build define)', () => {
    expect(cliChannel()).toBe('nightly')
  })
})

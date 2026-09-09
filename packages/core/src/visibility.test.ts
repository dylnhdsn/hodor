import { describe, expect, it } from 'vitest'
import { defaultHideRules, hiddenBy } from './visibility.js'

describe('hiddenBy with default rules', () => {
  it('hides tmp paths by segment-aligned prefix', () => {
    expect(hiddenBy('/tmp/claude-1000/x/scratchpad', defaultHideRules)).toBe('prefix:/tmp')
    expect(hiddenBy('/tmp', defaultHideRules)).toBe('prefix:/tmp')
    // Not a naive startsWith: /tmpfoo is a different directory.
    expect(hiddenBy('/tmpfoo/project', defaultHideRules)).toBeUndefined()
  })

  it('hides dot-directory segments like .peri agent runs', () => {
    expect(hiddenBy('/home/d/.peri/runs/2026-09-06T0/cache/blind', defaultHideRules)).toBe(
      'dot-segment:.peri',
    )
    expect(hiddenBy('/home/d/.peri/eval-clones/MacApp', defaultHideRules)).toBe('dot-segment:.peri')
  })

  it('keeps .claude worktrees visible via the allowlist', () => {
    expect(
      hiddenBy('/home/d/8flow/BrowserExtension/.claude/worktrees/spike', defaultHideRules),
    ).toBeUndefined()
  })

  it('hides node_modules by exact segment', () => {
    expect(hiddenBy('/home/d/proj/node_modules/lib', defaultHideRules)).toBe(
      'segment:node_modules',
    )
  })

  it('keeps ordinary project paths visible', () => {
    expect(hiddenBy('/home/d/8flow/MacApp', defaultHideRules)).toBeUndefined()
    expect(hiddenBy('/home/d', defaultHideRules)).toBeUndefined()
  })

  it('handles win32 separators', () => {
    expect(hiddenBy('C:\\Users\\d\\proj\\node_modules\\x', defaultHideRules)).toBe(
      'segment:node_modules',
    )
  })
})

describe('hiddenBy with custom rules', () => {
  it('matches custom prefixes and segments', () => {
    const rules = {
      pathPrefixes: ['/srv/ephemeral'],
      pathSegments: ['dist'],
      hideDotSegments: false,
      dotSegmentAllowlist: [],
    }
    expect(hiddenBy('/srv/ephemeral/x', rules)).toBe('prefix:/srv/ephemeral')
    expect(hiddenBy('/a/dist/b', rules)).toBe('segment:dist')
    expect(hiddenBy('/home/d/.peri/runs', rules)).toBeUndefined()
  })
})

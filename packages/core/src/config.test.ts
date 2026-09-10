import { describe, expect, it } from 'vitest'
import { mergeHideRules, parseHodorConfig } from './config.js'
import { defaultHideRules } from './visibility.js'

describe('parseHodorConfig', () => {
  it('parses a full config', () => {
    const { config, error } = parseHodorConfig(
      JSON.stringify({
        hide: { pathSegments: ['scratch'], hideDotSegments: false },
        splitRoots: ['/home/d/peri-stable'],
        projectNames: { 'split:local:/home/d/peri-stable': 'peri-stable' },
        sessions: { abc: { rename: 'My session', archived: true } },
      }),
    )
    expect(error).toBeUndefined()
    expect(config.splitRoots).toEqual(['/home/d/peri-stable'])
    expect(config.sessions?.['abc']).toEqual({ rename: 'My session', archived: true })
  })

  it('tolerates unknown fields and empty objects', () => {
    expect(parseHodorConfig('{}')).toEqual({ config: {} })
    expect(parseHodorConfig('{"futureFeature": {"x": 1}}').error).toBeUndefined()
  })

  it('rejects malformed JSON and wrong shapes with a usable error', () => {
    const notJson = parseHodorConfig('{nope')
    expect(notJson.config).toEqual({})
    expect(notJson.error).toContain('not valid JSON')

    const wrongType = parseHodorConfig('{"splitRoots": "not-an-array"}')
    expect(wrongType.config).toEqual({})
    expect(wrongType.error).toContain('splitRoots')
  })
})

describe('mergeHideRules', () => {
  it('extends lists and overrides toggles', () => {
    const merged = mergeHideRules(defaultHideRules, {
      pathSegments: ['scratch'],
      dotSegmentAllowlist: ['.peri'],
      hideNonInteractive: false,
    })
    expect(merged.pathSegments).toEqual([...defaultHideRules.pathSegments, 'scratch'])
    expect(merged.dotSegmentAllowlist).toContain('.claude')
    expect(merged.dotSegmentAllowlist).toContain('.peri')
    expect(merged.hideNonInteractive).toBe(false)
    expect(merged.hideDotSegments).toBe(defaultHideRules.hideDotSegments)
  })

  it('deep-copies when no overrides are given', () => {
    const merged = mergeHideRules(defaultHideRules)
    expect(merged).toEqual(defaultHideRules)
    merged.pathSegments.push('mutated')
    expect(defaultHideRules.pathSegments).not.toContain('mutated')
  })
})

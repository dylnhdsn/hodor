import { describe, expect, it } from 'vitest'
import { defaultHideRules, hiddenBy, type VisibilityInput } from './visibility.js'

const at = (cwd: string, entrypoints: string[] = []): VisibilityInput => ({ cwd, entrypoints })

describe('hiddenBy with default rules', () => {
  it('hides tmp paths by segment-aligned prefix', () => {
    expect(hiddenBy(at('/tmp/claude-1000/x/scratchpad'), defaultHideRules)).toBe('prefix:/tmp')
    expect(hiddenBy(at('/tmp'), defaultHideRules)).toBe('prefix:/tmp')
    // Not a naive startsWith: /tmpfoo is a different directory.
    expect(hiddenBy(at('/tmpfoo/project'), defaultHideRules)).toBeUndefined()
  })

  it('hides dot-directory segments like .peri agent runs', () => {
    expect(hiddenBy(at('/home/d/.peri/runs/2026-09-06T0/cache/blind'), defaultHideRules)).toBe(
      'dot-segment:.peri',
    )
    expect(hiddenBy(at('/home/d/.peri/eval-clones/MacApp'), defaultHideRules)).toBe(
      'dot-segment:.peri',
    )
  })

  it('keeps .claude worktrees visible via the allowlist', () => {
    expect(
      hiddenBy(at('/home/d/8flow/BrowserExtension/.claude/worktrees/spike'), defaultHideRules),
    ).toBeUndefined()
  })

  it('hides Windows temp paths by segment run', () => {
    expect(hiddenBy(at('C:\\Users\\d\\AppData\\Local\\Temp\\tstest'), defaultHideRules)).toBe(
      'infix:AppData/Local/Temp',
    )
    // The run must be consecutive and complete.
    expect(hiddenBy(at('C:\\Users\\d\\AppData\\Local\\NotTemp'), defaultHideRules)).toBeUndefined()
    expect(hiddenBy(at('C:\\Users\\d\\AppData\\Temp'), defaultHideRules)).toBeUndefined()
  })

  it('hides node_modules by exact segment', () => {
    expect(hiddenBy(at('/home/d/proj/node_modules/lib'), defaultHideRules)).toBe(
      'segment:node_modules',
    )
  })

  it('keeps ordinary project paths visible', () => {
    expect(hiddenBy(at('/home/d/8flow/MacApp', ['cli']), defaultHideRules)).toBeUndefined()
    expect(hiddenBy(at('/home/d'), defaultHideRules)).toBeUndefined()
  })

  it('hides purely non-interactive sessions (sdk-cli agent runs)', () => {
    expect(hiddenBy(at('/home/d/proj', ['sdk-cli']), defaultHideRules)).toBe('entrypoint:sdk-cli')
    expect(hiddenBy(at('/home/d/proj', ['sdk-cli', 'sdk']), defaultHideRules)).toBe(
      'entrypoint:sdk,sdk-cli',
    )
  })

  it('keeps sessions with any interactive entrypoint, or none recorded', () => {
    expect(hiddenBy(at('/home/d/proj', ['cli', 'sdk-cli']), defaultHideRules)).toBeUndefined()
    expect(hiddenBy(at('/home/d/proj', ['remote']), defaultHideRules)).toBeUndefined()
    expect(hiddenBy(at('/home/d/proj', []), defaultHideRules)).toBeUndefined()
  })

  it('classifies by entrypoint even without a cwd', () => {
    expect(hiddenBy({ entrypoints: ['sdk-cli'] }, defaultHideRules)).toBe('entrypoint:sdk-cli')
    expect(hiddenBy({ entrypoints: [] }, defaultHideRules)).toBeUndefined()
  })

  it('reports the path rule when both path and entrypoint match', () => {
    expect(hiddenBy(at('/home/d/.peri/runs/x', ['sdk-cli']), defaultHideRules)).toBe(
      'dot-segment:.peri',
    )
  })

  it('handles win32 separators', () => {
    expect(hiddenBy(at('C:\\Users\\d\\proj\\node_modules\\x'), defaultHideRules)).toBe(
      'segment:node_modules',
    )
  })
})

describe('hiddenBy with custom rules', () => {
  it('matches custom prefixes and segments, and can disable the entrypoint rule', () => {
    const rules = {
      pathPrefixes: ['/srv/ephemeral'],
      pathSegments: ['dist'],
      pathInfixes: ['out/cache'],
      hideDotSegments: false,
      dotSegmentAllowlist: [],
      hideNonInteractive: false,
      interactiveEntrypoints: [],
    }
    expect(hiddenBy(at('/srv/ephemeral/x'), rules)).toBe('prefix:/srv/ephemeral')
    expect(hiddenBy(at('/a/dist/b'), rules)).toBe('segment:dist')
    expect(hiddenBy(at('/a/out/cache/b'), rules)).toBe('infix:out/cache')
    expect(hiddenBy(at('/home/d/.peri/runs'), rules)).toBeUndefined()
    expect(hiddenBy(at('/home/d/proj', ['sdk-cli']), rules)).toBeUndefined()
  })
})

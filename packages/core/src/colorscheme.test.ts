import { describe, expect, it } from 'vitest'
import {
  COLORSCHEMES,
  contrastRatio,
  deriveTheme,
  parseColorscheme,
  terminalThemeOf,
} from './colorscheme.js'

const WT_SAMPLE = JSON.stringify({
  name: 'Ubuntu',
  background: '#300A24',
  foreground: '#EEEEEC',
  black: '#2E3436',
  red: '#CC0000',
  green: '#4E9A06',
  yellow: '#C4A000',
  blue: '#3465A4',
  purple: '#75507B',
  cyan: '#06989A',
  white: '#D3D7CF',
  brightBlack: '#555753',
  brightRed: '#EF2929',
  brightGreen: '#8AE234',
  brightYellow: '#FCE94F',
  brightBlue: '#729FCF',
  brightPurple: '#AD7FA8',
  brightCyan: '#34E2E2',
  brightWhite: '#EEEEEC',
})

const ALACRITTY_SAMPLE = `[colors.primary]
background = "#1b2b34"
foreground = "#c0c5ce"

[colors.normal]
black = "#343d46"
red = "#ec5f67"
green = "#99c794"
yellow = "#fac863"
blue = "#6699cc"
magenta = "#c594c5"
cyan = "#5fb3b3"
white = "#d8dee9"

[colors.bright]
black = "#65737e"
red = "#ec5f67"
green = "#99c794"
yellow = "#fac863"
blue = "#6699cc"
magenta = "#c594c5"
cyan = "#5fb3b3"
white = "#ffffff"`

const KITTY_SAMPLE = `background #1a1b26
foreground #c0caf5
color0 #15161e
color1 #f7768e
color2 #9ece6a
color3 #e0af68
color4 #7aa2f7
color5 #bb9af7
color6 #7dcfff
color7 #a9b1d6`

const GHOSTTY_SAMPLE = `background = 1e1e2e
foreground = cdd6f4
palette = 0=#45475a
palette = 1=#f38ba8
palette = 2=#a6e3a1
palette = 3=#f9e2af
palette = 4=#89b4fa
palette = 5=#f5c2e7
palette = 6=#94e2d5
palette = 7=#bac2de`

describe('deriveTheme', () => {
  it('yields readable semantic colors on every shipped scheme', () => {
    for (const scheme of COLORSCHEMES) {
      const t = deriveTheme(scheme)
      for (const key of ['ac', 'ask', 'run', 'rev', 'err'] as const) {
        expect(
          contrastRatio(t[key]!, t['bg']!),
          `${scheme.id}.${key} contrast`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      // surfaces stay near the background; text tones stay near the fg
      expect(contrastRatio(t['fg']!, t['bg']!)).toBeGreaterThan(4)
      expect(t['s1']).not.toBe(t['bg'])
    }
  })

  it('flips the accent ink for light accents', () => {
    const light = deriveTheme(COLORSCHEMES.find((s) => s.id === 'sollight')!)
    const dark = deriveTheme(COLORSCHEMES.find((s) => s.id === 'hodor')!)
    expect(light['ink']).toMatch(/^#/)
    expect(dark['ink']).toBe('#ffffff')
  })
})

describe('parseColorscheme', () => {
  it('sniffs Windows Terminal JSON', () => {
    const sc = parseColorscheme(WT_SAMPLE)
    expect(sc).toMatchObject({ bg: '300a24', fg: 'eeeeec', name: 'Ubuntu · imported' })
    expect(sc!.ansi[1]).toBe('cc0000')
    expect(sc!.ansi[9]).toBe('ef2929')
    expect(sc!.ansi[13]).toBe('ad7fa8') // brightPurple → bright magenta slot
  })

  it('sniffs Alacritty TOML with section-aware banks', () => {
    const sc = parseColorscheme(ALACRITTY_SAMPLE)
    expect(sc).toMatchObject({ bg: '1b2b34', fg: 'c0c5ce' })
    expect(sc!.ansi[0]).toBe('343d46')
    expect(sc!.ansi[8]).toBe('65737e')
    expect(sc!.ansi[15]).toBe('ffffff')
  })

  it('sniffs kitty and Ghostty forms', () => {
    const kitty = parseColorscheme(KITTY_SAMPLE)
    expect(kitty).toMatchObject({ bg: '1a1b26' })
    expect(kitty!.ansi[5]).toBe('bb9af7')
    // bright bank backfills from normal when absent
    expect(kitty!.ansi[13]).toBe('bb9af7')

    const ghostty = parseColorscheme(GHOSTTY_SAMPLE)
    expect(ghostty).toMatchObject({ bg: '1e1e2e', fg: 'cdd6f4' })
    expect(ghostty!.ansi[2]).toBe('a6e3a1')
  })

  it('rejects garbage', () => {
    expect(parseColorscheme('')).toBeNull()
    expect(parseColorscheme('hello world')).toBeNull()
    expect(parseColorscheme('{"not": "a scheme"}')).toBeNull()
  })
})

describe('terminalThemeOf', () => {
  it('maps the 16 slots onto xterm names', () => {
    const t = terminalThemeOf(COLORSCHEMES[0]!)
    expect(t['background']).toBe('#0b0a10')
    expect(t['magenta']).toBe('#b78af7')
    expect(t['brightMagenta']).toBe('#c9a8f9')
    expect(t['brightWhite']).toBe('#e8e4f2')
  })
})

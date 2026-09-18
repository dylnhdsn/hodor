// Browser-safe subpath: the core barrel drags in node:path and friends.
import {
  COLORSCHEMES,
  deriveTheme,
  mixHex,
  parseColorscheme,
  terminalThemeOf,
  type Colorscheme,
} from '@hodor/core/colorscheme'
import { fetchPrefs, savePref } from './prefs.js'

/**
 * Theme runtime: applies a colorscheme's derived tokens as CSS variables
 * (the whole UI reads them via Tailwind token utilities) and hands the raw
 * ANSI table to every open terminal, so the app chrome and the TUIs inside
 * it share one palette. Choice persists in localStorage — cosmetic,
 * per-client state.
 */

export interface FontPack {
  id: string
  name: string
  monoName: string
  ui: string
  mono: string
}

export const FONT_PACKS: FontPack[] = [
  {
    id: 'hodor',
    name: 'Archivo',
    monoName: 'JetBrains Mono',
    ui: "'Archivo', system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
  },
  {
    id: 'system',
    name: 'System stacks',
    monoName: 'ui-monospace',
    ui: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace",
  },
]

/** Terminal typefaces worth offering: the bundled ones always work; the
 * rest are common system installs, checked at render time. Any family the
 * user types works too — xterm falls back down the stack if it's absent. */
export interface TermFontOption {
  name: string
  bundled?: boolean
}
export const TERM_FONTS: TermFontOption[] = [
  { name: 'JetBrains Mono', bundled: true },
  { name: 'Fira Code', bundled: true },
  { name: 'IBM Plex Mono', bundled: true },
  { name: 'Source Code Pro', bundled: true },
  { name: 'Cascadia Code' },
  { name: 'Cascadia Mono' },
  { name: 'Consolas' },
  { name: 'Menlo' },
  { name: 'SF Mono' },
  { name: 'Ubuntu Mono' },
]

export interface ThemeState {
  schemeId: string
  fontId: string
  custom?: Colorscheme
  /** Terminal font family ('' = follow the font pack's mono). */
  termFont: string
  termSize: number
  /** A swatch picked as the accent ("rrggbb"); absent = the scheme's magenta. */
  accent?: string
}

const listeners = new Set<() => void>()
let current: ThemeState = { schemeId: 'hodor', fontId: 'hodor', termFont: '', termSize: 13 }

export const allSchemes = (): Colorscheme[] =>
  current.custom !== undefined ? [...COLORSCHEMES, current.custom] : COLORSCHEMES

export const activeScheme = (): Colorscheme =>
  allSchemes().find((s) => s.id === current.schemeId) ?? COLORSCHEMES[0]!

export const activeFont = (): FontPack =>
  FONT_PACKS.find((f) => f.id === current.fontId) ?? FONT_PACKS[0]!

export const themeState = (): ThemeState => current

/** The terminal's own background: a shade OFF the app background, so the
 * screen-within-a-screen reads as its own surface (dark schemes go darker,
 * light schemes go slightly gray). */
export function terminalBg(): string {
  const scheme = activeScheme()
  const bg = '#' + scheme.bg
  const n = parseInt(scheme.bg, 16)
  const lum = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 255_000
  return lum < 0.5 ? mixHex(bg, '#000000', 0.45) : mixHex(bg, '#000000', 0.05)
}

/** The xterm theme for the ACTIVE scheme. */
export const activeTerminalTheme = (): Record<string, string> => ({
  ...terminalThemeOf(activeScheme()),
  background: terminalBg(),
})

/** Resolved terminal typography: the chosen family in front of the font
 * pack's mono stack (so a missing family degrades sanely), plus size. */
export const activeTermFont = (): { family: string; size: number } => ({
  family:
    current.termFont.trim() !== ''
      ? `'${current.termFont.trim().replace(/'/g, '')}', ${activeFont().mono}`
      : activeFont().mono,
  size: current.termSize,
})

export function onThemeChange(handler: () => void): () => void {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

function apply(): void {
  const tokens = deriveTheme(activeScheme(), current.accent !== undefined ? { accent: current.accent } : {})
  const el = document.documentElement
  for (const [key, value] of Object.entries(tokens)) {
    el.style.setProperty('--h-' + key.toLowerCase(), value)
  }
  const font = activeFont()
  // The mock set BOTH font vars to the mono face — chrome is the UI face.
  el.style.setProperty('--h-font-ui', font.ui)
  el.style.setProperty('--h-font-mono', font.mono)
  el.style.setProperty('--h-term-bg', terminalBg())
  for (const handler of listeners) handler()
}

function persistLocal(): void {
  try {
    localStorage.setItem('hodor-theme', current.schemeId)
    localStorage.setItem('hodor-font', current.fontId)
    localStorage.setItem('hodor-term-font', current.termFont)
    localStorage.setItem('hodor-term-size', String(current.termSize))
    if (current.accent !== undefined) localStorage.setItem('hodor-accent', current.accent)
    else localStorage.removeItem('hodor-accent')
    if (current.custom !== undefined) {
      localStorage.setItem('hodor-custom-scheme', JSON.stringify(current.custom))
    }
  } catch {
    // private windows etc. — the durable copy is on the server anyway
  }
}

function persist(): void {
  persistLocal()
  // The durable copy: ~/.hodor/ui.json outlives the desktop's random-port
  // origin, restarts and updates. localStorage is just the boot cache.
  savePref({
    theme: current.schemeId,
    font: current.fontId,
    termFont: current.termFont,
    termSize: current.termSize,
    accent: current.accent ?? null,
    ...(current.custom !== undefined ? { customScheme: current.custom } : {}),
  })
}

export function loadTheme(): void {
  try {
    const custom = localStorage.getItem('hodor-custom-scheme')
    if (custom !== null) current.custom = JSON.parse(custom) as Colorscheme
    const scheme = localStorage.getItem('hodor-theme')
    if (scheme !== null) current.schemeId = scheme
    const font = localStorage.getItem('hodor-font')
    if (font !== null) current.fontId = font
    const termFont = localStorage.getItem('hodor-term-font')
    if (termFont !== null) current.termFont = termFont
    const accent = localStorage.getItem('hodor-accent')
    if (accent !== null && /^[0-9a-f]{6}$/.test(accent)) current.accent = accent
    const termSize = Number(localStorage.getItem('hodor-term-size'))
    if (Number.isFinite(termSize) && termSize >= 8 && termSize <= 28) current.termSize = termSize
  } catch {
    // fall through to defaults
  }
  apply()
}

/** Overlay the durable server prefs onto the localStorage first guess. */
export async function hydrateTheme(): Promise<void> {
  const prefs = await fetchPrefs()
  let changed = false
  const custom = prefs['customScheme']
  if (typeof custom === 'object' && custom !== null && !Array.isArray(custom)) {
    current = { ...current, custom: custom as Colorscheme }
    changed = true
  }
  const scheme = prefs['theme']
  if (typeof scheme === 'string' && scheme !== current.schemeId) {
    current = { ...current, schemeId: scheme }
    changed = true
  }
  const font = prefs['font']
  if (typeof font === 'string' && font !== current.fontId) {
    current = { ...current, fontId: font }
    changed = true
  }
  const termFont = prefs['termFont']
  if (typeof termFont === 'string' && termFont !== current.termFont) {
    current = { ...current, termFont }
    changed = true
  }
  const accent = prefs['accent']
  if (typeof accent === 'string' && /^[0-9a-f]{6}$/.test(accent) && current.accent !== accent) {
    current.accent = accent
    changed = true
  } else if (accent === null && current.accent !== undefined) {
    delete current.accent
    changed = true
  }
  const termSize = prefs['termSize']
  if (typeof termSize === 'number' && termSize >= 8 && termSize <= 28 && termSize !== current.termSize) {
    current = { ...current, termSize }
    changed = true
  }
  if (changed) {
    persistLocal() // refresh the cache only — no write-back loop
    apply()
  }
}

export function setScheme(id: string): void {
  current = { ...current, schemeId: id }
  persist()
  apply()
}

export function setFont(id: string): void {
  current = { ...current, fontId: id }
  persist()
  apply()
}

export function setTermFont(family: string): void {
  current = { ...current, termFont: family }
  persist()
  apply()
}

/** Make one of the scheme's colors the accent; undefined restores the default. */
export function setAccent(hex: string | undefined): void {
  const clean = hex?.replace(/^#/, '').toLowerCase()
  const { accent: _drop, ...rest } = current
  current = clean !== undefined && /^[0-9a-f]{6}$/.test(clean) ? { ...rest, accent: clean } : rest
  persist()
  apply()
}

export function setTermSize(size: number): void {
  current = { ...current, termSize: Math.max(8, Math.min(28, size)) }
  persist()
  apply()
}

/** Import a pasted colorscheme file; returns its name, or null on failure. */
export function importScheme(text: string): string | null {
  const scheme = parseColorscheme(text)
  if (scheme === null) return null
  current = { ...current, custom: scheme, schemeId: scheme.id }
  persist()
  apply()
  return scheme.name
}

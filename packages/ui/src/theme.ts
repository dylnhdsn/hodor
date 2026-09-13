// Browser-safe subpath: the core barrel drags in node:path and friends.
import {
  COLORSCHEMES,
  deriveTheme,
  parseColorscheme,
  terminalThemeOf,
  type Colorscheme,
} from '@hodor/core/colorscheme'

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

export interface ThemeState {
  schemeId: string
  fontId: string
  custom?: Colorscheme
}

const listeners = new Set<() => void>()
let current: ThemeState = { schemeId: 'hodor', fontId: 'hodor' }

export const allSchemes = (): Colorscheme[] =>
  current.custom !== undefined ? [...COLORSCHEMES, current.custom] : COLORSCHEMES

export const activeScheme = (): Colorscheme =>
  allSchemes().find((s) => s.id === current.schemeId) ?? COLORSCHEMES[0]!

export const activeFont = (): FontPack =>
  FONT_PACKS.find((f) => f.id === current.fontId) ?? FONT_PACKS[0]!

export const themeState = (): ThemeState => current

/** The xterm theme for the ACTIVE scheme. */
export const activeTerminalTheme = (): Record<string, string> => terminalThemeOf(activeScheme())

export function onThemeChange(handler: () => void): () => void {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

function apply(): void {
  const tokens = deriveTheme(activeScheme())
  const el = document.documentElement
  for (const [key, value] of Object.entries(tokens)) {
    el.style.setProperty('--h-' + key.toLowerCase(), value)
  }
  const font = activeFont()
  // The mock set BOTH font vars to the mono face — chrome is the UI face.
  el.style.setProperty('--h-font-ui', font.ui)
  el.style.setProperty('--h-font-mono', font.mono)
  for (const handler of listeners) handler()
}

function persist(): void {
  try {
    localStorage.setItem('hodor-theme', current.schemeId)
    localStorage.setItem('hodor-font', current.fontId)
    if (current.custom !== undefined) {
      localStorage.setItem('hodor-custom-scheme', JSON.stringify(current.custom))
    }
  } catch {
    // private windows etc. — the session just won't remember
  }
}

export function loadTheme(): void {
  try {
    const custom = localStorage.getItem('hodor-custom-scheme')
    if (custom !== null) current.custom = JSON.parse(custom) as Colorscheme
    const scheme = localStorage.getItem('hodor-theme')
    if (scheme !== null) current.schemeId = scheme
    const font = localStorage.getItem('hodor-font')
    if (font !== null) current.fontId = font
  } catch {
    // fall through to defaults
  }
  apply()
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

/** Import a pasted colorscheme file; returns its name, or null on failure. */
export function importScheme(text: string): string | null {
  const scheme = parseColorscheme(text)
  if (scheme === null) return null
  current = { ...current, custom: scheme, schemeId: scheme.id }
  persist()
  apply()
  return scheme.name
}

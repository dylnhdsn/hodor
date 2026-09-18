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
 * ones with a Fontsource id are fetched from jsDelivr the first time they
 * are picked (latin, regular + bold); the rest are common system installs,
 * checked at render time. Any family the user types works too — xterm
 * falls back down the stack if it's absent. */
export interface TermFontOption {
  name: string
  bundled?: boolean
  /** Fontsource id — fetched on pick from cdn.jsdelivr.net/fontsource. */
  source?: string
  /** Static weights Fontsource ships for it (bold picks the one nearest 700). */
  weights?: number[]
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
  { name: 'Ubuntu Mono', source: 'ubuntu-mono', weights: [400, 700] },
  { name: 'Geist Mono', source: 'geist-mono', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { name: 'Commit Mono', source: 'commit-mono', weights: [200, 300, 400, 500, 600, 700] },
  { name: 'Iosevka', source: 'iosevka', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { name: 'Intel One Mono', source: 'intel-one-mono', weights: [300, 400, 500, 600, 700] },
  { name: 'Maple Mono', source: 'maple-mono', weights: [100, 200, 300, 400, 500, 600, 700, 800] },
  { name: 'Monaspace Neon', source: 'monaspace-neon', weights: [200, 300, 400, 500, 600, 700, 800] },
  { name: 'Monaspace Argon', source: 'monaspace-argon', weights: [200, 300, 400, 500, 600, 700, 800] },
  { name: 'Monaspace Krypton', source: 'monaspace-krypton', weights: [200, 300, 400, 500, 600, 700, 800] },
  { name: 'Victor Mono', source: 'victor-mono', weights: [100, 200, 300, 400, 500, 600, 700] },
  { name: 'Lilex', source: 'lilex', weights: [100, 200, 300, 400, 500, 600, 700] },
  { name: 'Mononoki', source: 'mononoki', weights: [400, 700] },
  { name: 'Hack', weights: [400, 700] },
  { name: 'Roboto Mono', source: 'roboto-mono', weights: [100, 200, 300, 400, 500, 600, 700] },
  { name: 'Red Hat Mono', source: 'red-hat-mono', weights: [300, 400, 500, 600, 700] },
  { name: 'Inconsolata', source: 'inconsolata', weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { name: 'Fira Mono', source: 'fira-mono', weights: [400, 500, 700] },
  { name: 'DM Mono', source: 'dm-mono', weights: [300, 400, 500] },
  { name: 'Space Mono', source: 'space-mono', weights: [400, 700] },
  { name: 'Martian Mono', source: 'martian-mono', weights: [100, 200, 300, 400, 500, 600, 700, 800] },
  { name: 'Google Sans Code', source: 'google-sans-code', weights: [300, 400, 500, 600, 700, 800] },
  { name: 'Ubuntu Sans Mono', source: 'ubuntu-sans-mono', weights: [400, 500, 600, 700] },
  { name: 'Overpass Mono', source: 'overpass-mono', weights: [300, 400, 500, 600, 700] },
  { name: 'Sometype Mono', source: 'sometype-mono', weights: [400, 500, 600, 700] },
  { name: 'Spline Sans Mono', source: 'spline-sans-mono', weights: [300, 400, 500, 600, 700] },
  { name: 'Reddit Mono', source: 'reddit-mono', weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { name: 'Kode Mono', source: 'kode-mono', weights: [400, 500, 600, 700] },
  { name: 'iA Writer Mono', source: 'ia-writer-mono', weights: [400, 700] },
  { name: 'DejaVu Mono', source: 'dejavu-mono', weights: [400, 700] },
  { name: 'Cousine', source: 'cousine', weights: [400, 700] },
  { name: 'Anonymous Pro', source: 'anonymous-pro', weights: [400, 700] },
  { name: 'Comic Mono', source: 'comic-mono', weights: [400, 700] },
  { name: 'Courier Prime', source: 'courier-prime', weights: [400, 700] },
  { name: 'PT Mono', source: 'pt-mono', weights: [400] },
  { name: 'Azeret Mono', source: 'azeret-mono', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { name: 'Chivo Mono', source: 'chivo-mono', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
]

/** Bundled symbols-only Nerd Font: sits right behind whatever terminal
 * font is chosen, so powerline and statusline glyphs render in every
 * font, patched or not (Nerd Fonts, MIT; icon sets keep their licenses). */
export const NERD_SYMBOLS = 'Symbols Nerd Font Mono'

const FONTSOURCE = 'https://cdn.jsdelivr.net/fontsource/fonts'
const fetched = new Map<string, Promise<void>>()
/** Counts fonts that finished loading after being applied — terminals
 * re-measure their cells when it moves (see Terminal.tsx). */
let fontEpoch = 0
export const termFontEpoch = (): number => fontEpoch

/** Fetch a catalog font's faces once (regular + the weight nearest bold).
 * Resolves either way: a failed fetch just leaves the fallback stack. */
export function ensureTermFont(name: string): Promise<void> {
  const opt = TERM_FONTS.find((f) => f.name === name)
  if (opt?.source === undefined || typeof FontFace === 'undefined') return Promise.resolve()
  const id = opt.source
  const pending = fetched.get(id)
  if (pending !== undefined) return pending
  const weights = opt.weights ?? [400]
  const regular = weights.includes(400) ? 400 : weights[0]!
  const bold = weights
    .filter((w) => w >= 600 && w !== regular)
    .sort((a, b) => Math.abs(a - 700) - Math.abs(b - 700))[0]
  const faces = [
    [regular, '400'],
    ...(bold !== undefined ? [[bold, '700'] as const] : []),
  ] as const
  const task = Promise.all(
    faces.map(async ([file, weight]) => {
      const face = new FontFace(
        name,
        `url(${FONTSOURCE}/${id}@latest/latin-${file}-normal.woff2) format('woff2')`,
        { weight, style: 'normal', display: 'swap' },
      )
      await face.load()
      document.fonts.add(face)
    }),
  ).then(
    () => {
      fontEpoch += 1
    },
    (err: unknown) => {
      fetched.delete(id) // so a later pick can retry
      console.warn(`hodor: could not fetch ${name}:`, err)
    },
  )
  fetched.set(id, task)
  return task
}

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
export const activeTermFont = (): { family: string; size: number } => {
  const chosen = current.termFont.trim().replace(/'/g, '')
  const mono = activeFont().mono
  // The chosen face first, the Nerd symbols right behind it (before any
  // generic family, which would otherwise swallow every fallback).
  const [head, ...rest] = mono.split(',')
  const stack =
    chosen !== ''
      ? [`'${chosen}'`, `'${NERD_SYMBOLS}'`, mono]
      : [head!.trim(), `'${NERD_SYMBOLS}'`, ...rest.map((x) => x.trim())]
  return { family: stack.join(', '), size: current.termSize }
}

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
  primeFonts()
}

/** The symbols fallback and a saved catalog font: load them now and
 * re-apply once they land, so open terminals re-measure with the real
 * faces instead of keeping the fallback's metrics. */
function primeFonts(): void {
  if (typeof document === 'undefined' || document.fonts === undefined) return
  void document.fonts.load(`12px '${NERD_SYMBOLS}'`).then(
    () => {
      fontEpoch += 1
      apply()
    },
    () => {},
  )
  if (current.termFont.trim() !== '') void ensureTermFont(current.termFont.trim()).then(() => apply())
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
    if (current.termFont.trim() !== '') void ensureTermFont(current.termFont.trim()).then(() => apply())
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
  // A catalog font arrives later: apply again so terminals re-measure.
  void ensureTermFont(family.trim()).then(() => apply())
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

/** Use a scheme outside the curated list (a catalog pick, a pasted
 * file): it takes the one "yours" slot and becomes the active scheme. */
export function adoptScheme(scheme: Colorscheme): void {
  current = { ...current, custom: scheme, schemeId: scheme.id }
  persist()
  apply()
}

/** Import a pasted colorscheme file; returns its name, or null on failure. */
export function importScheme(text: string): string | null {
  const scheme = parseColorscheme(text)
  if (scheme === null) return null
  adoptScheme(scheme)
  return scheme.name
}

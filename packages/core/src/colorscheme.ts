/**
 * Terminal-colorscheme-derived theming (docs/brainstorm/023 design pass):
 * every color in hodor is calculated from a 16-color ANSI scheme. Surfaces
 * and borders are background→foreground mixes; the semantic colors are the
 * ANSI slots (needs-you = yellow, running = green, review-ready = blue,
 * errors = red, accent = magenta), preferring whichever of normal/bright
 * clears WCAG contrast against the background, then nudged toward the
 * foreground until it does. Import parsers map the config formats real
 * terminals already use onto the same 16 slots.
 *
 * Pure functions, no DOM — the UI applies the derived tokens as CSS
 * variables and hands the raw ANSI table to xterm, so the app chrome and
 * the TUIs inside it share one palette.
 */

export interface Colorscheme {
  id: string
  name: string
  /** Background / foreground, 6-digit hex WITHOUT '#'. */
  bg: string
  fg: string
  /** ANSI 0–15 (normal 0–7, bright 8–15), 6-digit hex WITHOUT '#'. */
  ansi: string[]
}

/** Derived UI tokens, keyed by token name (no CSS prefix). */
export type ThemeTokens = Record<string, string>

const hx = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]

const toHex = (r: number, g: number, b: number): string =>
  '#' +
  [r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

export function mixHex(a: string, b: string, t: number): string {
  const A = hx(a)
  const B = hx(b)
  return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t)
}

function luminance(c: string): number {
  const v = hx(c).map((x) => {
    const s = x / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!
}

export function contrastRatio(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * Nudge a color toward the foreground until it clears 4.5:1 on bg. Some
 * schemes (Solarized) have a deliberately dim foreground that itself sits
 * near 4.5 — mixing toward it converges below target, so escalate toward
 * the pure contrast pole for the last stretch.
 */
function ensureContrast(c: string, bg: string, fg: string): string {
  let out = c
  for (let i = 0; i < 14 && contrastRatio(out, bg) < 4.5; i++) {
    out = mixHex(out, fg, 0.14)
  }
  const pole = luminance(bg) < 0.5 ? '#ffffff' : '#000000'
  for (let i = 0; i < 14 && contrastRatio(out, bg) < 4.5; i++) {
    out = mixHex(out, pole, 0.1)
  }
  return out
}

/**
 * Derive the full token set from a scheme. Token names (the UI prefixes
 * them as CSS vars): bg, s1–s8 (surfaces), b1–b6 (borders), fg, t1–t6
 * (text tones), ac/acH/acB/ink (accent family), ask/run/rev/err (status).
 */
export function deriveTheme(scheme: Colorscheme): ThemeTokens {
  const bg = '#' + scheme.bg
  const fg = '#' + scheme.fg
  const A = scheme.ansi.map((x) => '#' + x)
  const mx = (t: number) => mixHex(bg, fg, t)
  const sat = (c: string) => {
    const v = hx(c)
    return Math.max(...v) - Math.min(...v)
  }
  // Prefer the normal slot when it already clears contrast, else bright,
  // else whichever is more saturated (ensureContrast fixes it after).
  const pick = (ni: number, bi: number): string => {
    const n = A[ni]!
    const b = A[bi]!
    if (contrastRatio(n, bg) >= 4.5) return n
    if (contrastRatio(b, bg) >= 4.5) return b
    return sat(b) > sat(n) ? b : n
  }
  const en = (c: string) => ensureContrast(c, bg, fg)
  const ac = en(pick(5, 13))
  return {
    bg,
    s1: mx(0.028),
    s2: mx(0.014),
    s3: mx(0.05),
    s4: mx(0.062),
    s5: mx(0.075),
    s6: mx(0.04),
    s7: mx(0.095),
    s8: mx(0.008),
    b1: mx(0.1),
    b2: mx(0.07),
    b3: mx(0.12),
    b4: mx(0.15),
    b5: mx(0.18),
    b6: mx(0.24),
    fg,
    t1: mixHex(fg, bg, 0.1),
    t2: mixHex(fg, bg, 0.26),
    t3: mixHex(fg, bg, 0.36),
    t4: mixHex(fg, bg, 0.5),
    t5: mixHex(fg, bg, 0.57),
    t6: mixHex(fg, bg, 0.64),
    ac,
    acH: mixHex(ac, fg, 0.3),
    acB: mixHex(ac, fg, 0.45),
    ink: luminance(ac) > 0.5 ? '#16141c' : '#ffffff',
    ask: en(pick(3, 11)),
    run: en(pick(2, 10)),
    rev: en(pick(4, 12)),
    err: en(pick(1, 9)),
  }
}

const S16 = (x: string): string[] => x.split(' ')

/** The shipped schemes — 20 common terminal colorschemes plus the default. */
export const COLORSCHEMES: Colorscheme[] = [
  { id: 'hodor', name: 'hodor (default)', bg: '0b0a10', fg: 'e8e4f2', ansi: S16('17141f e07a76 7ec98b e5a83b 82a9ef b78af7 8fd0cc a49cbd 524b66 e07a76 7ec98b e5a83b 82a9ef c9a8f9 a8e4e0 e8e4f2') },
  { id: 'dracula', name: 'Dracula', bg: '282a36', fg: 'f8f8f2', ansi: S16('21222c ff5555 50fa7b f1fa8c bd93f9 ff79c6 8be9fd f8f8f2 6272a4 ff6e6e 69ff94 ffffa5 d6acff ff92df a4ffff ffffff') },
  { id: 'nord', name: 'Nord', bg: '2e3440', fg: 'd8dee9', ansi: S16('3b4252 bf616a a3be8c ebcb8b 81a1c1 b48ead 88c0d0 e5e9f0 4c566a bf616a a3be8c ebcb8b 81a1c1 b48ead 8fbcbb eceff4') },
  { id: 'gruvbox', name: 'Gruvbox Dark', bg: '282828', fg: 'ebdbb2', ansi: S16('282828 cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2') },
  { id: 'soldark', name: 'Solarized Dark', bg: '002b36', fg: '839496', ansi: S16('073642 dc322f 859900 b58900 268bd2 d33682 2aa198 eee8d5 002b36 cb4b16 586e75 657b83 839496 6c71c4 93a1a1 fdf6e3') },
  { id: 'sollight', name: 'Solarized Light', bg: 'fdf6e3', fg: '657b83', ansi: S16('073642 dc322f 859900 b58900 268bd2 d33682 2aa198 eee8d5 002b36 cb4b16 586e75 657b83 839496 6c71c4 93a1a1 fdf6e3') },
  { id: 'monokai', name: 'Monokai', bg: '272822', fg: 'f8f8f2', ansi: S16('272822 f92672 a6e22e f4bf75 66d9ef ae81ff a1efe4 f8f8f2 75715e f92672 a6e22e f4bf75 66d9ef ae81ff a1efe4 f9f8f5') },
  { id: 'onedark', name: 'One Dark', bg: '282c34', fg: 'abb2bf', ansi: S16('282c34 e06c75 98c379 e5c07b 61afef c678dd 56b6c2 abb2bf 545862 e06c75 98c379 e5c07b 61afef c678dd 56b6c2 c8ccd4') },
  { id: 'tokyo', name: 'Tokyo Night', bg: '1a1b26', fg: 'c0caf5', ansi: S16('15161e f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff a9b1d6 414868 f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff c0caf5') },
  { id: 'mocha', name: 'Catppuccin Mocha', bg: '1e1e2e', fg: 'cdd6f4', ansi: S16('45475a f38ba8 a6e3a1 f9e2af 89b4fa f5c2e7 94e2d5 bac2de 585b70 f38ba8 a6e3a1 f9e2af 89b4fa f5c2e7 94e2d5 a6adc8') },
  { id: 'everforest', name: 'Everforest Dark', bg: '2d353b', fg: 'd3c6aa', ansi: S16('475258 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa 475258 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa') },
  { id: 'rosepine', name: 'Rosé Pine', bg: '191724', fg: 'e0def4', ansi: S16('26233a eb6f92 31748f f6c177 9ccfd8 c4a7e7 ebbcba e0def4 6e6a86 eb6f92 31748f f6c177 9ccfd8 c4a7e7 ebbcba e0def4') },
  { id: 'kanagawa', name: 'Kanagawa', bg: '1f1f28', fg: 'dcd7ba', ansi: S16('090618 c34043 76946a c0a36e 7e9cd8 957fb8 6a9589 c8c093 727169 e82424 98bb6c e6c384 7fb4ca 938aa9 7aa89f dcd7ba') },
  { id: 'ghdark', name: 'GitHub Dark', bg: '0d1117', fg: 'c9d1d9', ansi: S16('484f58 ff7b72 3fb950 d29922 58a6ff bc8cff 39c5cf b1bac4 6e7681 ffa198 56d364 e3b341 79c0ff d2a8ff 56d4dd f0f6fc') },
  { id: 'palenight', name: 'Palenight', bg: '292d3e', fg: 'a6accd', ansi: S16('292d3e f07178 c3e88d ffcb6b 82aaff c792ea 89ddff d0d0d0 434758 ff8b92 ddffa7 ffe585 9cc4ff e1acff a3f7ff ffffff') },
  { id: 'nightowl', name: 'Night Owl', bg: '011627', fg: 'd6deeb', ansi: S16('011627 ef5350 22da6e addb67 82aaff c792ea 21c7a8 ffffff 575656 ef5350 22da6e ffeb95 82aaff c792ea 7fdbca ffffff') },
  { id: 'snazzy', name: 'Snazzy', bg: '282a36', fg: 'eff0eb', ansi: S16('000000 ff5c57 5af78e f3f99d 57c7ff ff6ac1 9aedfe f1f1f0 686868 ff5c57 5af78e f3f99d 57c7ff ff6ac1 9aedfe ffffff') },
  { id: 'zenburn', name: 'Zenburn', bg: '3f3f3f', fg: 'dcdccc', ansi: S16('4d4d4d 705050 60b48a f0dfaf 506070 dc8cc3 8cd0d3 dcdccc 709080 dca3a3 c3bf9f e0cf9f 94bff3 ec93d3 93e0e3 ffffff') },
  { id: 'tomorrow', name: 'Tomorrow Night', bg: '1d1f21', fg: 'c5c8c6', ansi: S16('1d1f21 cc6666 b5bd68 f0c674 81a2be b294bb 8abeb7 c5c8c6 969896 cc6666 b5bd68 f0c674 81a2be b294bb 8abeb7 ffffff') },
  { id: 'horizon', name: 'Horizon', bg: '1c1e26', fg: 'e0e0e0', ansi: S16('16161c e95678 29d398 fab795 26bbd9 ee64ac 59e1e3 d5d8da 5b5858 ec6a88 3fdaa4 fbc3a7 3fc4de f075b5 6be4e6 d5d8da') },
  { id: 'iceberg', name: 'Iceberg', bg: '161821', fg: 'c6c8d1', ansi: S16('1e2132 e27878 b4be82 e2a478 84a0c6 a093c7 89b8c2 c6c8d1 6b7089 e98989 c0ca8e e9b189 91acd1 ada0d3 95c4ce d2d4de') },
]

const cleanHex = (x: unknown): string | null => {
  const m = String(x ?? '')
    .trim()
    .replace(/^#|^0x/i, '')
    .toLowerCase()
  return /^[0-9a-f]{6}$/.test(m) ? m : null
}

const WT_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white'] as const

function parseWindowsTerminal(txt: string): Colorscheme | null {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(txt) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null) return null
  const bg = cleanHex(j['background'])
  if (bg === null || (j['black'] === undefined && j['brightBlack'] === undefined)) return null
  const ansi = [
    ...WT_KEYS.map((k) => cleanHex(j[k]) ?? '888888'),
    ...WT_KEYS.map(
      (k) => cleanHex(j['bright' + k[0]!.toUpperCase() + k.slice(1)]) ?? cleanHex(j[k]) ?? '888888',
    ),
  ]
  return {
    id: 'custom',
    name: (typeof j['name'] === 'string' ? j['name'] : 'Windows Terminal') + ' · imported',
    bg,
    fg: cleanHex(j['foreground']) ?? 'ffffff',
    ansi,
  }
}

function parseITerm(txt: string): Colorscheme | null {
  const component = (seg: string, c: string): number | null => {
    const m = seg.match(new RegExp('<key>' + c + ' Component</key>\\s*<real>([0-9.eE+-]+)</real>'))
    return m ? Math.round(parseFloat(m[1]!) * 255) : null
  }
  const grab = (key: string): string | null => {
    const i = txt.indexOf('<key>' + key + '</key>')
    if (i < 0) return null
    const seg = txt.slice(i, i + 800)
    const r = component(seg, 'Red')
    const g = component(seg, 'Green')
    const b = component(seg, 'Blue')
    return r === null || g === null || b === null ? null : toHex(r, g, b).slice(1)
  }
  const ansi: Array<string | null> = []
  for (let i = 0; i < 16; i++) ansi.push(grab('Ansi ' + i + ' Color'))
  const bg = grab('Background Color')
  const fg = grab('Foreground Color')
  if (bg === null || ansi.filter(Boolean).length < 8) return null
  return {
    id: 'custom',
    name: 'iTerm2 · imported',
    bg,
    fg: fg ?? 'ffffff',
    ansi: ansi.map((x) => x ?? '888888'),
  }
}

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

/**
 * Line-based formats: Alacritty TOML/YAML ([colors.normal] sections),
 * kitty (`color0 #hex`, `background #hex`), Ghostty (`palette = N=#hex`),
 * Xresources (`*.color0: #hex`). Section headers steer named colors into
 * the normal vs bright banks; without sections, the first occurrence is
 * normal and the second bright.
 */
function parseLineBased(txt: string): Colorscheme | null {
  const ansi: Array<string | null> = Array(16).fill(null)
  let bg: string | null = null
  let fg: string | null = null
  let bank: 0 | 8 | null = null
  for (const line of txt.split(/\r?\n/)) {
    const section = line.match(/^\s*\[?\s*colors?\.(normal|bright|primary)\s*\]?/i)
    if (section) {
      bank = section[1]!.toLowerCase() === 'bright' ? 8 : section[1]!.toLowerCase() === 'normal' ? 0 : null
      continue
    }
    let m: RegExpMatchArray | null
    if ((m = line.match(/palette\s*=\s*(\d{1,2})=#?([0-9a-fA-F]{6})/))) {
      const i = Number(m[1])
      if (i < 16) ansi[i] = m[2]!.toLowerCase()
    } else if ((m = line.match(/color(\d{1,2})\s*[:= ]\s*['"]?(?:#|0x)?([0-9a-fA-F]{6})/i))) {
      const i = Number(m[1])
      if (i < 16) ansi[i] = m[2]!.toLowerCase()
    } else if ((m = line.match(/(?:^|[*.\s])background\s*[:= ]+\s*['"]?(?:#|0x)?([0-9a-fA-F]{6})/i))) {
      bg ??= m[1]!.toLowerCase()
    } else if ((m = line.match(/(?:^|[*.\s])foreground\s*[:= ]+\s*['"]?(?:#|0x)?([0-9a-fA-F]{6})/i))) {
      fg ??= m[1]!.toLowerCase()
    } else if (
      (m = line.match(/^\s*(black|red|green|yellow|blue|magenta|cyan|white)\s*[:=]\s*['"]?(?:#|0x)([0-9a-fA-F]{6})/i))
    ) {
      const idx = ANSI_NAMES.indexOf(m[1]!.toLowerCase())
      const slot = bank !== null ? bank + idx : ansi[idx] === null ? idx : idx + 8
      if (slot < 16 && ansi[slot] === null) ansi[slot] = m[2]!.toLowerCase()
    }
  }
  if (bg === null || ansi.filter(Boolean).length < 6) return null
  for (let i = 0; i < 16; i++) {
    ansi[i] ??= (i > 7 ? ansi[i - 8] : null) ?? fg ?? '888888'
  }
  return {
    id: 'custom',
    name: 'imported scheme',
    bg,
    fg: fg ?? 'ffffff',
    ansi: ansi as string[],
  }
}

/**
 * Sniff a pasted colorscheme file. Formats: Windows Terminal scheme JSON,
 * iTerm2 .itermcolors plist, and the line-based family (Alacritty, kitty,
 * Ghostty, Xresources). Returns null when nothing usable was found.
 */
export function parseColorscheme(text: string): Colorscheme | null {
  const txt = (text ?? '').trim()
  if (txt.length === 0) return null
  if (txt.startsWith('{')) return parseWindowsTerminal(txt)
  if (/<plist|<\?xml/i.test(txt)) return parseITerm(txt)
  return parseLineBased(txt)
}

/** The xterm.js theme for the same scheme — the TUIs share the palette. */
export function terminalThemeOf(scheme: Colorscheme): Record<string, string> {
  const a = scheme.ansi
  const bg = '#' + scheme.bg
  const fg = '#' + scheme.fg
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: mixHex('#' + scheme.ansi[5]!, bg, 0.68),
    black: '#' + a[0]!,
    red: '#' + a[1]!,
    green: '#' + a[2]!,
    yellow: '#' + a[3]!,
    blue: '#' + a[4]!,
    magenta: '#' + a[5]!,
    cyan: '#' + a[6]!,
    white: '#' + a[7]!,
    brightBlack: '#' + a[8]!,
    brightRed: '#' + a[9]!,
    brightGreen: '#' + a[10]!,
    brightBlue: '#' + a[12]!,
    brightYellow: '#' + a[11]!,
    brightMagenta: '#' + a[13]!,
    brightCyan: '#' + a[14]!,
    brightWhite: '#' + a[15]!,
  }
}

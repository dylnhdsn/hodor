import { useState } from 'react'
import { deriveTheme, mixHex, type Colorscheme } from '@hodor/core/colorscheme'
import {
  FONT_PACKS,
  allSchemes,
  importScheme,
  setFont,
  setScheme,
  themeState,
} from './theme.js'

/**
 * Appearance: every color in hodor derives from a terminal colorscheme —
 * pick one of the shipped ones or paste the file your terminal already
 * uses. The scheme also themes the embedded terminals (same 16 ANSI
 * slots), so the app chrome and the TUIs inside it match.
 */

const SAMPLE_WT = JSON.stringify(
  {
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
  },
  null,
  2,
)

const SAMPLE_ALACRITTY = `[colors.primary]
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
white = "#d8dee9"`

function SchemeCard({ scheme, active, onPick }: { scheme: Colorscheme; active: boolean; onPick: () => void }) {
  const t = deriveTheme(scheme)
  return (
    <button
      onClick={onPick}
      className="flex flex-col gap-2 rounded border p-2.5 text-left hover:brightness-115"
      style={{
        background: t['bg'],
        borderColor: active ? t['ac'] : mixHex(t['bg']!, t['fg']!, 0.16),
        boxShadow: active ? `0 0 0 3px color-mix(in srgb, ${t['ac']} 22%, transparent)` : undefined,
      }}
    >
      <span className="flex items-center gap-1.5">
        <span className="flex-1 truncate text-[11.5px] font-semibold" style={{ color: t['fg'] }}>
          {scheme.name}
        </span>
        {active && <span style={{ color: t['ac'] }}>●</span>}
      </span>
      <span className="truncate font-mono text-[10px]" style={{ color: t['ac'] }}>
        ❯ claude --resume
      </span>
      <span className="flex gap-1">
        {[9, 10, 11, 12, 13, 14].map((i) => (
          <span
            key={i}
            className="inline-block h-2.5 w-2.5 rounded-[3px]"
            style={{ background: '#' + scheme.ansi[i] }}
          />
        ))}
      </span>
    </button>
  )
}

export function Appearance() {
  const [, force] = useState(0)
  const [impText, setImpText] = useState('')
  const [impErr, setImpErr] = useState<string | undefined>(undefined)
  const state = themeState()
  const rerender = () => force((x) => x + 1)

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      <div className="flex max-w-4xl flex-col gap-4">
        <div>
          <h2 className="text-[15px] font-bold text-fg">Appearance</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-t3">
            every color in hodor is calculated from a terminal colorscheme — surfaces and borders
            are background→foreground mixes; needs-you is ANSI yellow, running is green,
            review-ready is blue, errors are red, the accent is magenta; picks that fail contrast
            are auto-corrected. The embedded terminals share the same palette.
          </p>
        </div>

        <div className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          COLORSCHEMES{state.custom !== undefined ? ' + YOURS' : ''}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {allSchemes().map((scheme) => (
            <SchemeCard
              key={scheme.id}
              scheme={scheme}
              active={scheme.id === state.schemeId}
              onPick={() => {
                setScheme(scheme.id)
                rerender()
              }}
            />
          ))}
        </div>

        <div className="mt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          FONT PACKS
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-2">
          {FONT_PACKS.map((pack) => (
            <button
              key={pack.id}
              onClick={() => {
                setFont(pack.id)
                rerender()
              }}
              className={`flex items-center gap-2 rounded border bg-s1 px-3 py-2.5 text-left ${
                pack.id === state.fontId ? 'border-ac' : 'border-b3 hover:border-ac'
              }`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-semibold" style={{ fontFamily: pack.ui }}>
                  {pack.name}
                </span>
                <span
                  className="truncate text-[10.5px] text-t3"
                  style={{ fontFamily: pack.mono }}
                >
                  ❯ {pack.monoName} · 0O1lI
                </span>
              </span>
              {pack.id === state.fontId && <span className="font-bold text-ac">✓</span>}
            </button>
          ))}
        </div>

        <div className="mt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          IMPORT — FROM THE FILES YOUR TERMINAL ALREADY USES
        </div>
        <div className="flex flex-col gap-2.5 rounded-lg border border-b3 bg-s1 p-3">
          <p className="text-[11px] leading-relaxed text-t3">
            paste an iTerm2 <span className="font-mono">.itermcolors</span>, a Windows Terminal
            scheme JSON, Alacritty toml, <span className="font-mono">kitty.conf</span>, Ghostty
            config, or Xresources — hodor sniffs the format, maps the 16 ANSI colors, and
            re-derives the whole UI
          </p>
          <textarea
            rows={6}
            placeholder="paste a colorscheme file…"
            value={impText}
            onChange={(e) => {
              setImpText(e.target.value)
              setImpErr(undefined)
            }}
            className="min-h-[86px] resize-y rounded border border-b4 bg-app px-2.5 py-2 font-mono text-[11px] leading-normal text-fg outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                const name = importScheme(impText)
                if (name === null) {
                  setImpErr('could not sniff it — need background + most of the 16 ANSI colors')
                } else {
                  setImpErr(undefined)
                  rerender()
                }
              }}
              className="rounded bg-ac px-3.5 py-1.5 text-[11.5px] font-semibold text-ink hover:brightness-110"
            >
              import & apply
            </button>
            <button
              onClick={() => setImpText(SAMPLE_WT)}
              className="rounded border border-b4 px-3 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
            >
              sample: Windows Terminal JSON
            </button>
            <button
              onClick={() => setImpText(SAMPLE_ALACRITTY)}
              className="rounded border border-b4 px-3 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
            >
              sample: Alacritty TOML
            </button>
            {impErr !== undefined && (
              <span className="font-mono text-[11px] text-err">{impErr}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

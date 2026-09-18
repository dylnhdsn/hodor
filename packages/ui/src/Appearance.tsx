import { useEffect, useState } from 'react'
import { deriveTheme, mixHex, type Colorscheme } from '@hodor/core/colorscheme'
import { CATALOG_SOURCE, loadCatalog, type CatalogEntry } from './catalog.js'
import { desktop } from './desktop.js'
import { ContextMenu, useContextMenu } from './menu.js'
import { DEFAULT_PRESETS, getPresets, onPresetsChange, setPresets } from './presets.js'
import { HooksToggle } from './HooksToggle.js'
import { notifyEnabled, setNotifyEnabled } from './notify.js'
import { fetchPrefs, savePref } from './prefs.js'
import {
  FONT_PACKS,
  TERM_FONTS,
  adoptScheme,
  allSchemes,
  importScheme,
  setAccent,
  setFont,
  setScheme,
  setTermFont,
  setTermSize,
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
        {[9, 10, 11, 12, 13, 14].map((i) => {
          const hex = scheme.ansi[i]!.toLowerCase()
          const chosen = active && themeState().accent === hex
          return (
            <span
              key={i}
              role="button"
              title="use as the accent"
              onClick={(e) => {
                e.stopPropagation()
                if (!active) onPick()
                setAccent(hex)
              }}
              className={`inline-block h-2.5 w-2.5 cursor-pointer rounded-[3px] hover:scale-125 ${
                chosen ? 'ring-1 ring-fg ring-offset-1 ring-offset-s1' : ''
              }`}
              style={{ background: '#' + hex }}
            />
          )
        })}
        {active && themeState().accent !== undefined && (
          <span
            role="button"
            title="back to the scheme's own accent"
            onClick={(e) => {
              e.stopPropagation()
              setAccent(undefined)
            }}
            className="ml-1 cursor-pointer font-mono text-[9px] text-t6 hover:text-fg"
          >
            reset
          </span>
        )}
      </span>
    </button>
  )
}

/** The bundled catalog: search by name, dark/light, pick to adopt. */
function SchemeCatalog({ activeId, onPick }: { activeId: string; onPick: (s: Colorscheme) => void }) {
  const [entries, setEntries] = useState<CatalogEntry[] | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [tone, setTone] = useState<'all' | 'dark' | 'light'>('all')
  useEffect(() => {
    let live = true
    void loadCatalog().then((e) => {
      if (live) setEntries(e)
    })
    return () => {
      live = false
    }
  }, [])
  const q = query.trim().toLowerCase()
  const hits = (entries ?? []).filter(
    (e) =>
      (tone === 'all' || (tone === 'dark') === e.dark) &&
      (q === '' || e.scheme.name.toLowerCase().includes(q)),
  )
  const shown = hits.slice(0, 48)
  const chip = (on: boolean): string =>
    `rounded border px-2 py-0.5 font-mono text-[10px] ${on ? 'border-ac text-fg' : 'border-b3 text-t4 hover:border-b6 hover:text-fg'}`
  return (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">CATALOG</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="find a scheme…"
          className="w-52 rounded border border-b1 bg-s1 px-2.5 py-1 text-[11px] outline-none placeholder:text-t6 focus:border-b6"
        />
        {(['all', 'dark', 'light'] as const).map((t) => (
          <button key={t} onClick={() => setTone(t)} className={chip(tone === t)}>
            {t}
          </button>
        ))}
        <span className="font-mono text-[10px] text-t5">
          {entries === undefined ? 'loading…' : `${hits.length} of ${entries.length}`}
        </span>
        <a
          href={CATALOG_SOURCE.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto font-mono text-[9.5px] text-t6 hover:text-fg"
        >
          {CATALOG_SOURCE.name} · {CATALOG_SOURCE.license}
        </a>
      </div>
      {shown.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {shown.map((e) => (
            <SchemeCard
              key={e.scheme.id}
              scheme={e.scheme}
              active={e.scheme.id === activeId}
              onPick={() => onPick(e.scheme)}
            />
          ))}
        </div>
      )}
      {hits.length > shown.length && (
        <div className="font-mono text-[10px] text-t5">
          {hits.length - shown.length} more — narrow the search
        </div>
      )}
      {entries !== undefined && hits.length === 0 && (
        <div className="font-mono text-[10px] text-t5">no scheme by that name</div>
      )}
    </>
  )
}

/** The turn stack's one-click replies: right-click a chip to remove it. */
function PresetControls() {
  const [, force] = useState(0)
  const [draft, setDraft] = useState('')
  const { menu, openMenu, closeMenu } = useContextMenu()
  useEffect(() => onPresetsChange(() => force((x) => x + 1)), [])
  const presets = getPresets()
  const add = (): void => {
    if (draft.trim() === '') return
    setPresets([...presets, draft])
    setDraft('')
  }
  return (
    <>
      <div className="mt-1 flex items-baseline gap-3 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
        TURN STACK PRESETS
        {presets.join('\n') !== DEFAULT_PRESETS.join('\n') && (
          <button
            onClick={() => setPresets(DEFAULT_PRESETS)}
            className="font-normal tracking-normal text-t6 hover:text-fg"
          >
            reset
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((chip) => (
          <span
            key={chip}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: chip, heading: true },
                { label: 'remove', onClick: () => setPresets(presets.filter((x) => x !== chip)) },
              ])
            }
            className="rounded border border-ac/55 px-3 py-1 text-[11.5px] text-ach"
          >
            {chip}
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          onBlur={add}
          placeholder="add a preset…"
          className="w-56 rounded border border-b1 bg-s1 px-2.5 py-1 text-[11px] outline-none placeholder:text-t6 focus:border-b6"
        />
      </div>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </>
  )
}

export function Appearance() {
  const [, force] = useState(0)
  const [winShell, setWinShell] = useState<'powershell' | 'cmd'>('powershell')
  const [detachOnQuit, setDetachOnQuit] = useState(false)
  useEffect(() => {
    void fetchPrefs().then((p) => {
      if (p['windowsShell'] === 'cmd') setWinShell('cmd')
      if (p['detachOnQuit'] === true) setDetachOnQuit(true)
    })
  }, [])
  const [impText, setImpText] = useState('')
  const [impErr, setImpErr] = useState<string | undefined>(undefined)
  const state = themeState()
  const rerender = () => force((x) => x + 1)

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      <div className="flex max-w-4xl flex-col gap-4">
        <div>
          <h2 className="font-ui text-[15px] font-semibold text-fg">Settings</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-t3">
            every color derives from a terminal colorscheme; the embedded terminals share it.
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

        <SchemeCatalog
          activeId={state.schemeId}
          onPick={(scheme) => {
            adoptScheme(scheme)
            rerender()
          }}
        />

        <PresetControls />

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

        <div className="mt-1 flex items-baseline gap-3 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          TERMINAL FONT
          <span className="font-normal tracking-normal text-t6">
            every face gets Nerd Font symbols — statuslines and powerline glyphs render in all of them
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
          <button
            onClick={() => {
              setTermFont('')
              rerender()
            }}
            className={`flex flex-col gap-0.5 rounded border bg-s1 px-3 py-2 text-left ${
              state.termFont === '' ? 'border-ac' : 'border-b3 hover:border-ac'
            }`}
          >
            <span className="text-[12px] font-semibold">follow the font pack</span>
            <span className="font-mono text-[10.5px] text-t4">❯ claude --resume · 0O1lI</span>
          </button>
          {TERM_FONTS.map((f) => {
            const installed =
              f.bundled === true ||
              f.source !== undefined ||
              (typeof document.fonts?.check === 'function' &&
                document.fonts.check(`12px "${f.name}"`))
            return (
              <button
                key={f.name}
                onClick={() => {
                  setTermFont(f.name)
                  rerender()
                }}
                className={`flex flex-col gap-0.5 rounded border bg-s1 px-3 py-2 text-left ${
                  state.termFont === f.name ? 'border-ac' : 'border-b3 hover:border-ac'
                } ${installed ? '' : 'opacity-45'}`}
                title={installed ? undefined : 'not installed on this machine'}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                  {f.name}
                  {f.bundled === true && (
                    <span className="rounded border border-b4 px-1 text-[8.5px] font-normal text-t5">
                      ships with hodor
                    </span>
                  )}
                  {f.source !== undefined && (
                    <span
                      className="rounded border border-b4 px-1 text-[8.5px] font-normal text-t5"
                      title="downloaded the first time you pick it"
                    >
                      fetched
                    </span>
                  )}
                </span>
                <span
                  className="font-mono text-[10.5px] text-t4"
                  style={{ fontFamily: `'${f.name}', monospace` }}
                >
                  ❯ claude --resume · 0O1lI
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            defaultValue={
              TERM_FONTS.some((f) => f.name === state.termFont) ? '' : state.termFont
            }
            placeholder="any installed family…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setTermFont((e.target as HTMLInputElement).value)
                rerender()
              }
            }}
            onBlur={(e) => {
              if (e.target.value.trim() !== '') {
                setTermFont(e.target.value)
                rerender()
              }
            }}
            className="w-56 rounded border border-b1 bg-s1 px-2.5 py-1 text-[11px] outline-none placeholder:text-t6 focus:border-b6"
          />
          <span className="flex items-center gap-1.5 text-[11px] text-t3">
            size
            <button
              onClick={() => {
                setTermSize(state.termSize - 1)
                rerender()
              }}
              className="rounded border border-b4 px-2 py-0.5 hover:border-b6 hover:text-fg"
            >
              −
            </button>
            <span className="w-6 text-center font-mono">{state.termSize}</span>
            <button
              onClick={() => {
                setTermSize(state.termSize + 1)
                rerender()
              }}
              className="rounded border border-b4 px-2 py-0.5 hover:border-b6 hover:text-fg"
            >
              +
            </button>
          </span>
        </div>

        <div className="mt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          WINDOWS SHELL
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ['powershell', 'PowerShell'],
              ['cmd', 'Command Prompt'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => {
                setWinShell(id)
                savePref({ windowsShell: id })
              }}
              className={`rounded border px-3 py-1.5 text-[11.5px] ${
                winShell === id ? 'border-ac bg-ac/8 text-fg' : 'border-b3 text-t3 hover:border-ac'
              }`}
            >
              {label}
            </button>
          ))}
          <span className="text-[11px] text-t5">
            hosts Windows-side sessions; WSL sessions always use their distro's shell
          </span>
        </div>

        <div className="mt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          NOTIFICATIONS
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2.5 rounded border border-b3 bg-s1 px-3 py-2">
          <input
            type="checkbox"
            checked={notifyEnabled()}
            onChange={(e) => {
              setNotifyEnabled(e.target.checked)
              rerender()
            }}
            className="h-3.5 w-3.5 accent-ac"
          />
          <span className="text-[12px]">
            notify me when a session flips to <span className="font-semibold text-ask">needs you</span>{' '}
            while the window is in the background
          </span>
        </label>

        {desktop?.setDetachOnQuit !== undefined && (
          <>
            <div className="mt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
              WHEN HODOR CLOSES
            </div>
            <label className="flex w-fit cursor-pointer items-center gap-2.5 rounded border border-b3 bg-s1 px-3 py-2">
              <input
                type="checkbox"
                checked={detachOnQuit}
                onChange={(e) => {
                  const on = e.target.checked
                  setDetachOnQuit(on)
                  savePref({ detachOnQuit: on })
                  desktop?.setDetachOnQuit?.(on)
                }}
                className="h-3.5 w-3.5 accent-ac"
              />
              <span className="text-[12px]">
                keep sessions running — each tile gets <span className="font-mono">/background</span>;
                restoring it attaches
              </span>
            </label>
          </>
        )}

        <div className="mt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          CLAUDE HOOKS
        </div>
        <HooksToggle />

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

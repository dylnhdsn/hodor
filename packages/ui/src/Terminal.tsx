import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { desktop } from './desktop.js'
import { activeTermFont, activeTerminalTheme, onThemeChange } from './theme.js'

/**
 * One attached PTY view. The PTY lives in the desktop main process; this
 * component replays the backlog on mount, then streams — so a terminal can
 * move between the dock and a pop-out window without losing its scrollback.
 *
 * Input rules (Windows-Terminal manners): ctrl+V / ctrl+shift+V /
 * shift+insert paste; ctrl+shift+C copies; plain ctrl+C copies when there
 * IS a selection and interrupts when there isn't; right-click copies a
 * selection or pastes without one. Everything else goes to the PTY
 * untouched — the app never steals keys from a focused terminal.
 */

/**
 * Live terminals by pty id, so anything holding a pty id can put the
 * keyboard in it — clicking a tab focuses its terminal even when that tab
 * was already the active one (no activation event fires then).
 */
const focusers = new Map<string, () => void>()
export function focusTerminal(ptyId: string | undefined): void {
  if (ptyId === undefined) return
  const focus = focusers.get(ptyId)
  // after dockview's own click handling, which focuses the tab element
  if (focus !== undefined) setTimeout(focus, 60)
}

async function readClipboard(): Promise<string> {
  if (desktop?.clipboardText !== undefined) return desktop.clipboardText()
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

function writeClipboard(text: string): void {
  if (text.length === 0) return
  if (desktop?.clipboardWrite !== undefined) desktop.clipboardWrite(text)
  else void navigator.clipboard.writeText(text).catch(() => {})
}

export function TerminalView({
  ptyId,
  visible,
  autoFocus = false,
}: {
  ptyId: string
  visible: boolean
  /** Take the keyboard: set while this tile is the active one, so
   * clicking a tab leaves you typing in that terminal rather than on the
   * tab element itself. */
  autoFocus?: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Xterm | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null || desktop === undefined) return
    const bridge = desktop

    // The terminal shares the app's colorscheme: the same 16 ANSI slots
    // the UI derives its tokens from ARE the terminal palette.
    const font = activeTermFont()
    const term = new Xterm({
      fontSize: font.size,
      fontFamily: font.family,
      cursorBlink: true,
      scrollback: 8000,
      theme: activeTerminalTheme(),
      // Scroll like a real terminal. xterm moves ONE line per wheel notch
      // by default, which is what made this feel sluggish next to Windows
      // Terminal; three is the platform convention, and any smoothing
      // just adds latency to that.
      scrollSensitivity: 3,
      fastScrollSensitivity: 10,
      smoothScrollDuration: 0,
    })
    const offTheme = onThemeChange(() => {
      const next = activeTermFont()
      term.options.theme = activeTerminalTheme()
      term.options.fontFamily = next.family
      term.options.fontSize = next.size
      fitRef.current?.fit()
    })
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(host)
    // e2e hook: the GPU renderer leaves no DOM text, so tests read the
    // buffer through this handle.
    ;(host as { _xterm?: Xterm })._xterm = term
    termRef.current = term
    focusers.set(ptyId, () => term.focus())
    // GPU renderer: the DOM renderer chokes on fast output and feels
    // sluggish to scroll; fall back silently where WebGL isn't there.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer it is
    }
    // ctrl/cmd+click opens a URL in the real browser. Plain clicks stay
    // with the terminal so selecting text over a link still works.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!(event.ctrlKey || event.metaKey)) return
        if (!/^https?:\/\//i.test(uri)) return
        window.open(uri, '_blank', 'noreferrer')
      }),
    )

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      // Enter submits; SHIFT+Enter inserts a newline. xterm sends plain
      // \r for both, which is why shift+enter (and ctrl+shift+enter) were
      // submitting the prompt. Claude Code takes ctrl+J (\n) as its
      // universal "newline" key, so send that.
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        bridge.write(ptyId, '\n')
        return false
      }
      if ((mod && key === 'v') || (e.shiftKey && e.key === 'Insert')) {
        // preventDefault, or the browser's own paste fires too (doubled)
        e.preventDefault()
        void readClipboard().then((text) => {
          if (text.length > 0) term.paste(text)
        })
        return false
      }
      if (mod && key === 'c' && (e.shiftKey || term.hasSelection())) {
        e.preventDefault()
        writeClipboard(term.getSelection())
        term.clearSelection()
        return false
      }
      return true
    })
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (term.hasSelection()) {
        writeClipboard(term.getSelection())
        term.clearSelection()
      } else {
        void readClipboard().then((text) => {
          if (text.length > 0) term.paste(text)
        })
      }
    }
    host.addEventListener('contextmenu', onContextMenu)
    // While a terminal owns the keyboard, app-level key handling (zoom)
    // steps aside — the PTY gets every key, like any normal terminal.
    const onFocusIn = (): void => bridge.setTermFocus?.(true)
    const onFocusOut = (): void => bridge.setTermFocus?.(false)
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', onFocusOut)

    let disposed = false
    const offData = bridge.onData(({ id, data }) => {
      if (id === ptyId && !disposed) term.write(data)
    })
    void bridge.attach(ptyId).then((attached) => {
      if (disposed) return
      if (attached.error !== undefined) {
        term.writeln(`\x1b[31m${attached.error}\x1b[0m`)
        return
      }
      if (attached.backlog !== undefined && attached.backlog.length > 0) {
        term.write(attached.backlog)
      }
      if (attached.exited !== undefined) {
        term.writeln(`\r\n\x1b[2m[exited ${attached.exited}]\x1b[0m`)
      }
    })
    const onInput = term.onData((data) => bridge.write(ptyId, data))

    const doFit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      bridge.resize(ptyId, term.cols, term.rows)
    }
    doFit()
    if (autoFocus) term.focus()
    const observer = new ResizeObserver(doFit)
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', onFocusOut)
      bridge.setTermFocus?.(false)
      offTheme()
      offData()
      onInput.dispose()
      bridge.detach(ptyId)
      focusers.delete(ptyId)
      termRef.current = null
      term.dispose()
    }
  }, [ptyId])

  // Becoming the visible/active tab refits AND takes the keyboard:
  // clicking a tab should leave you typing in that terminal, not on the
  // tab. The timeout lets dockview finish its own focus handling first,
  // otherwise it hands focus back to the tab element.
  useEffect(() => {
    if (!visible) return
    fitRef.current?.fit()
    if (!autoFocus) return
    const t = setTimeout(() => termRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [visible, autoFocus])

  return (
    <div className={visible ? 'term-shell' : 'hidden'}>
      <div ref={hostRef} className="h-full w-full" />
    </div>
  )
}

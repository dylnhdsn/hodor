import { FitAddon } from '@xterm/addon-fit'
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
  autoFocus?: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

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
    // GPU renderer: the DOM renderer chokes on fast output and feels
    // sluggish to scroll; fall back silently where WebGL isn't there.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer it is
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
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
      term.dispose()
    }
  }, [ptyId])

  // Refit when a hidden tab becomes the active one.
  useEffect(() => {
    if (visible) fitRef.current?.fit()
  }, [visible])

  return (
    <div className={visible ? 'term-shell' : 'hidden'}>
      <div ref={hostRef} className="h-full w-full" />
    </div>
  )
}

import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { desktop } from './desktop.js'

/**
 * One attached PTY view. The PTY lives in the desktop main process; this
 * component replays the backlog on mount, then streams — so a terminal can
 * move between the dock and a pop-out window without losing its scrollback.
 */
export function TerminalView({ ptyId, visible }: { ptyId: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null || desktop === undefined) return
    const bridge = desktop

    const term = new Xterm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 8000,
      theme: {
        background: '#0a0a0b',
        foreground: '#d4d4d8',
        cursor: '#a1a1aa',
        selectionBackground: '#3f3f46',
      },
    })
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(host)

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
    const observer = new ResizeObserver(doFit)
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
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

  return <div ref={hostRef} className={visible ? 'h-full w-full' : 'hidden'} />
}

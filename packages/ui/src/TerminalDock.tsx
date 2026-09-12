import { useCallback, useEffect, useRef, useState } from 'react'
import { desktop, type TermInfo } from './desktop.js'
import { TerminalView } from './Terminal.js'

/**
 * The desktop app's terminal dock: a tmux-ish tab strip over the session
 * list. PTYs live in the main process, so tabs here and pop-out windows
 * are just views — moving a terminal never restarts it.
 */
export function TerminalDock() {
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [active, setActive] = useState<string | undefined>(undefined)
  const [height, setHeight] = useState(320)
  const dragging = useRef(false)

  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop
    // Seed from main: terminals survive a renderer reload.
    void bridge.list().then((list) => {
      setTerms(list)
      setActive((current) => current ?? list[list.length - 1]?.id)
    })
    return bridge.onEvent((event) => {
      if (event.type === 'opened' || event.type === 'returned') {
        setTerms((prev) =>
          prev.some((t) => t.id === event.id)
            ? prev
            : [...prev, { id: event.id, title: event.title ?? event.id }],
        )
        setActive(event.id)
      } else if (event.type === 'exit') {
        setTerms((prev) =>
          prev.map((t) => (t.id === event.id ? { ...t, exited: event.code ?? 0 } : t)),
        )
      } else if (event.type === 'closed' || event.type === 'popped') {
        setTerms((prev) => {
          const next = prev.filter((t) => t.id !== event.id)
          setActive((cur) => (cur === event.id ? next[next.length - 1]?.id : cur))
          return next
        })
      }
    })
  }, [])

  const onDividerDown = useCallback((down: React.MouseEvent) => {
    down.preventDefault()
    dragging.current = true
    const move = (e: MouseEvent): void => {
      if (!dragging.current) return
      setHeight(Math.min(Math.max(window.innerHeight - e.clientY, 120), window.innerHeight - 160))
    }
    const up = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  if (desktop === undefined || terms.length === 0) return null
  const bridge = desktop

  return (
    <div className="flex shrink-0 flex-col border-t border-zinc-800" style={{ height }}>
      <div
        onMouseDown={onDividerDown}
        className="h-1 shrink-0 cursor-row-resize bg-zinc-900 hover:bg-zinc-700"
        title="drag to resize"
      />
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-2 py-1">
        {terms.map((t) => (
          <div
            key={t.id}
            className={`group flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs ${
              active === t.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
            }`}
          >
            <button onClick={() => setActive(t.id)} className="max-w-56 truncate" title={t.title}>
              {t.exited !== undefined ? <span className="text-zinc-500">✓ </span> : null}
              {t.title}
            </button>
            <button
              onClick={() => void bridge.popOut(t.id)}
              className="hidden text-zinc-500 group-hover:inline hover:text-zinc-200"
              title="open in its own window"
            >
              ⧉
            </button>
            <button
              onClick={() => void bridge.close(t.id)}
              className="hidden text-zinc-500 group-hover:inline hover:text-red-400"
              title={t.exited !== undefined ? 'remove' : 'kill and remove'}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 bg-[#0a0a0b] p-1">
        {terms.map((t) => (
          <TerminalView key={t.id} ptyId={t.id} visible={active === t.id} />
        ))}
      </div>
    </div>
  )
}

/** A pop-out window's whole content: one terminal, edge to edge. */
export function PopoutTerminal({ ptyId }: { ptyId: string }) {
  return (
    <div className="flex h-full flex-col bg-[#0a0a0b]">
      <div className="min-h-0 flex-1 p-1">
        <TerminalView ptyId={ptyId} visible />
      </div>
    </div>
  )
}

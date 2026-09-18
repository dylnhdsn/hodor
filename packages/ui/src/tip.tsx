import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A small tooltip after a short hover. The native `title` is the wrong
 * tool for an icon that needs explaining: its delay is the OS's (often a
 * full second), its look is the OS's, and dockview's tab chrome clips
 * anything positioned inside it. So: our delay, our styling, rendered
 * through a portal on <body> like the context menu.
 */

const DELAY_MS = 450

export function Tip(props: { text: string; children: ReactNode; className?: string }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | undefined>(undefined)

  useEffect(() => {
    const el = anchor.current
    if (el === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (): void => {
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect()
        setPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
      }, DELAY_MS)
    }
    const hide = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      setPos(undefined)
    }
    // Native listeners: enter/leave don't bubble, so nothing upstream
    // (dockview stops propagation on its tabs) can swallow them.
    el.addEventListener('mouseenter', show)
    el.addEventListener('mouseleave', hide)
    el.addEventListener('mousedown', hide)
    return () => {
      hide()
      el.removeEventListener('mouseenter', show)
      el.removeEventListener('mouseleave', hide)
      el.removeEventListener('mousedown', hide)
    }
  }, [])

  return (
    <>
      <span ref={anchor} className={props.className}>
        {props.children}
      </span>
      {pos !== undefined &&
        createPortal(
          <div
            role="tooltip"
            style={{ left: pos.x, top: pos.y }}
            className="pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap rounded border border-b5 bg-s5 px-1.5 py-0.5 font-ui text-[10.5px] text-t2 shadow-xl"
          >
            {props.text}
          </div>,
          document.body,
        )}
    </>
  )
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The app's context menu: right-click verbs on rows and tabs, so hover
 * buttons stop being the only affordance. One fixed-position layer; any
 * click, escape-free (no app hotkeys), or scroll dismisses it.
 */

export interface MenuItem {
  label: string
  onClick?: () => void
  /** Render in the danger color (kill/close). */
  danger?: boolean
  /** Non-interactive heading row. */
  heading?: boolean
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

export function useContextMenu(): {
  menu: MenuState | undefined
  openMenu: (e: React.MouseEvent, items: MenuItem[]) => void
  closeMenu: () => void
} {
  const [menu, setMenu] = useState<MenuState | undefined>(undefined)
  return {
    menu,
    openMenu: (e, items) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    closeMenu: () => setMenu(undefined),
  }
}

export function ContextMenu(props: { menu: MenuState; close: () => void }) {
  const { menu, close } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  // Keep the menu on screen: flip up/left when it would overflow.
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    setPos({
      x: menu.x + r.width > window.innerWidth ? Math.max(4, menu.x - r.width) : menu.x,
      y: menu.y + r.height > window.innerHeight ? Math.max(4, menu.y - r.height) : menu.y,
    })
  }, [menu])

  // Portal to <body>: a fixed-position menu inside a dockview tab (or any
  // transformed/overflow-clipped ancestor) renders clipped and invisible.
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
        onWheel={close}
      />
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 flex min-w-44 flex-col rounded border border-b5 bg-s5 py-1 shadow-xl"
      >
        {menu.items.map((item, i) =>
          item.heading === true ? (
            <div
              key={i}
              className="truncate px-3 pt-1 pb-0.5 font-mono text-[9.5px] font-semibold tracking-[.12em] text-t5 uppercase"
            >
              {item.label}
            </div>
          ) : (
            <button
              key={i}
              onClick={() => {
                close()
                item.onClick?.()
              }}
              className={`px-3 py-1.5 text-left font-ui text-[12px] hover:bg-ac/12 ${
                item.danger === true ? 'text-err' : 'text-t2 hover:text-fg'
              }`}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  )
}

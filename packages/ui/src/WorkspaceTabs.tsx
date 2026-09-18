import { useEffect, useState } from 'react'
import { deskState, getDeskOps, subscribeDesk } from './Desk.js'
import { desktop } from './desktop.js'
import { confirmAction, promptText } from './dialog.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'

/**
 * Workspaces as a tier of tabs in the title bar (docs/brainstorm/027).
 * Each is a named set of tiles with its own turn stack and skips; one is
 * active. Click switches (terminals in the one you leave keep running);
 * right-click for rename / new / close.
 */

export function WorkspaceTabs(props: { onSwitch?: () => void }) {
  const [, force] = useState(0)
  const { menu, openMenu, closeMenu } = useContextMenu()
  useEffect(() => subscribeDesk(() => force((t) => t + 1)), [])
  if (desktop === undefined || deskState.workspaces.length === 0) return null

  const ops = getDeskOps()
  const create = (): void => {
    void promptText('New workspace', { placeholder: 'name', okLabel: 'create' }).then((name) => {
      if (name === undefined || name.trim() === '') return
      void ops?.newWorkspace(name.trim())
      props.onSwitch?.()
    })
  }
  const rename = (id: string, current: string): void => {
    void promptText('Rename workspace', { initial: current }).then((name) => {
      if (name === undefined || name.trim() === '') return
      ops?.renameWorkspace(id, name.trim())
    })
  }
  const close = (id: string, name: string): void => {
    const n = deskState.terminalCountOf(id)
    void confirmAction(`Close workspace "${name}"?`, {
      detail: n > 0 ? `${n} terminal${n === 1 ? '' : 's'} will end` : 'it has no terminals',
      okLabel: 'close',
      danger: true,
    }).then((ok) => {
      if (ok) void ops?.closeWorkspace(id)
    })
  }

  return (
    <span className="no-drag flex items-center gap-0.5">
      {deskState.workspaces.map((w) => {
        const active = w.id === deskState.active
        const items: MenuItem[] = [
          { label: w.name, heading: true },
          { label: 'rename', onClick: () => rename(w.id, w.name) },
          { label: 'new workspace', onClick: create },
          { label: 'close workspace', onClick: () => close(w.id, w.name), danger: true },
        ]
        return (
          <button
            key={w.id}
            onClick={() => {
              if (!active) void ops?.switchWorkspace(w.id)
              props.onSwitch?.()
            }}
            onContextMenu={(e) => openMenu(e, items)}
            className={`rounded px-2 py-0.5 font-ui text-[11.5px] ${
              active ? 'bg-s3 font-semibold text-fg' : 'text-t4 hover:bg-s1 hover:text-t1'
            }`}
            title={active ? 'this workspace' : 'switch workspace'}
          >
            {w.name}
          </button>
        )
      })}
      <button
        onClick={create}
        className="rounded px-1.5 py-0.5 text-[12px] text-t6 hover:bg-s1 hover:text-fg"
        title="new workspace"
      >
        +
      </button>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </span>
  )
}

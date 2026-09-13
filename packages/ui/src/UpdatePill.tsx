import { useEffect, useState } from 'react'
import { desktop, type UpdateState } from './desktop.js'

/**
 * Desktop-only update indicator: a quiet pill in the sidebar footer.
 * "restart to update" installs a downloaded update in place (win/linux);
 * on unsigned macOS it links the fresh dmg instead.
 */
export function UpdatePill() {
  const [update, setUpdate] = useState<UpdateState | undefined>(undefined)

  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop
    void bridge.updateState().then((state) => {
      if (state !== undefined) setUpdate(state)
    })
    return bridge.onUpdateEvent(setUpdate)
  }, [])

  if (desktop === undefined || update === undefined) return null
  const bridge = desktop

  if (update.state === 'ready') {
    return (
      <button
        onClick={() => void bridge.installUpdate()}
        className="mx-3 mb-2 rounded border border-b6 px-2 py-1.5 text-center text-[11px] text-t2 hover:border-fg/50 hover:text-fg"
        title={`version ${update.version} downloaded — restarts the app`}
      >
        ↻ restart to update
      </button>
    )
  }
  return (
    <a
      href={update.url}
      target="_blank"
      rel="noreferrer"
      className="mx-3 mb-2 rounded border border-rev/40 bg-rev/10 px-2 py-1.5 text-center text-[11px] text-rev hover:border-rev"
      title="unsigned macOS builds can't self-install — grab the fresh dmg"
    >
      update available ↗
    </a>
  )
}

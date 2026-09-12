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
        className="mx-3 mb-2 rounded border border-emerald-800 bg-emerald-950/50 px-2 py-1 text-left text-xs text-emerald-300 hover:border-emerald-600"
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
      className="mx-3 mb-2 rounded border border-sky-900 bg-sky-950/50 px-2 py-1 text-xs text-sky-300 hover:border-sky-600"
      title="unsigned macOS builds can't self-install — grab the fresh dmg"
    >
      update available ↗
    </a>
  )
}

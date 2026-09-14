import { useEffect, useState } from 'react'
import { desktop, type UpdateState } from './desktop.js'

/**
 * Desktop update surfaces. A downloaded update must be UN-missable — the
 * rail pill alone failed that (collapsed rail hid it behind the ☰ menu),
 * so the title bar carries its own pill whenever an update is ready.
 * UpdateCheckRow adds a manual "check for updates" with the last check's
 * honest outcome (checking / up to date / failed and why).
 */

function useUpdateState(): UpdateState | undefined {
  const [update, setUpdate] = useState<UpdateState | undefined>(undefined)
  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop
    void bridge.updateState().then((state) => {
      if (state !== undefined) setUpdate(state)
    })
    return bridge.onUpdateEvent((state) =>
      setUpdate((prev) => {
        const next = state as UpdateState
        // same guard as the main process: a found update never gets
        // buried under a later quiet state
        const found = prev?.state === 'ready' || prev?.state === 'available-manual'
        const quiet = next.state === 'checking' || next.state === 'none' || next.state === 'error'
        return found && quiet ? prev : next
      }),
    )
  }, [])
  return update
}

/** Rail-footer pill: install affordance only, quiet otherwise. */
export function UpdatePill() {
  const update = useUpdateState()
  if (desktop === undefined || update === undefined) return null
  const bridge = desktop

  if (update.state === 'ready') {
    return (
      <button
        onClick={() => void bridge.installUpdate()}
        className="mx-3 mb-2 rounded border border-b6 px-2 py-1.5 text-center font-ui text-[11px] text-t2 hover:border-fg/50 hover:text-fg"
        title={`version ${update.version} downloaded — restarts the app`}
      >
        ↻ restart to update
      </button>
    )
  }
  if (update.state === 'available-manual') {
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
  return null
}

/** Title-bar pill: shows ONLY when an update is actionable, in every view. */
export function TitleUpdatePill() {
  const update = useUpdateState()
  if (desktop === undefined || update === undefined) return null
  const bridge = desktop

  if (update.state === 'ready') {
    return (
      <button
        onClick={() => void bridge.installUpdate()}
        className="rounded border border-rev/50 bg-rev/10 px-2.5 py-1 font-ui text-[11px] font-semibold text-rev hover:bg-rev/20"
        title={`version ${update.version} downloaded — restarts the app`}
      >
        ↻ update ready
      </button>
    )
  }
  if (update.state === 'available-manual') {
    return (
      <a
        href={update.url}
        target="_blank"
        rel="noreferrer"
        className="rounded border border-rev/50 bg-rev/10 px-2.5 py-1 font-ui text-[11px] font-semibold text-rev hover:bg-rev/20"
        title="unsigned macOS builds can't self-install — grab the fresh dmg"
      >
        update ↗
      </a>
    )
  }
  return null
}

/** "check for updates" + the last check's outcome, for the rail footer/menu. */
export function UpdateCheckRow() {
  const update = useUpdateState()
  const [kicked, setKicked] = useState(false)
  if (desktop?.updateCheck === undefined) return null
  const bridge = desktop

  const status =
    update?.state === 'checking'
      ? 'checking…'
      : update?.state === 'none'
        ? 'up to date'
        : update?.state === 'error'
          ? 'check failed'
          : kicked
            ? '…'
            : undefined

  return (
    <button
      onClick={() => {
        setKicked(true)
        void bridge.updateCheck!()
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-ui text-[11px] text-t4 hover:text-t2"
      title={update?.state === 'error' ? update.message : 'ask the release feed right now'}
    >
      check for updates
      {status !== undefined && (
        <span className={update?.state === 'error' ? 'text-ask' : 'text-t6'}>{status}</span>
      )}
    </button>
  )
}

import { useEffect, useState } from 'react'
import { desktop } from './desktop.js'
import { GearIcon } from './icons.js'
import { Wordmark } from './Wordmark.js'
import { WorkspaceTabs, type WorkspaceCounts } from './WorkspaceTabs.js'

/**
 * The 30px title bar (v3 mock): projects menu, wordmark, workspace tabs
 * with their badges, the active workspace's intent, then the your-turn
 * button, settings and the window controls. It doubles as the frameless
 * window's drag region.
 */
export function TopBar(props: {
  platform: string | undefined
  panelOn: boolean
  onMenu: () => void
  counts: Map<string, WorkspaceCounts>
  projects: Array<{ id: string; name: string }>
  onSwitch: () => void
  intent: string | undefined
  stackN: number
  stackOpen: boolean
  onStack: () => void
  settingsOpen: boolean
  onSettings: () => void
  /** This window is one popped-out workspace. */
  locked?: boolean | undefined
}) {
  return (
    <div
      className={`drag flex h-[30px] shrink-0 items-center gap-1 border-b border-b1 bg-s1 px-1.5 ${
        props.platform === 'darwin' ? 'pl-[78px]' : ''
      }`}
    >
      {desktop !== undefined && (
        <button
          onClick={props.onMenu}
          title="projects"
          className={`no-drag flex h-[22px] w-[26px] items-center justify-center rounded text-[13px] hover:bg-s3 hover:text-fg ${
            props.panelOn ? 'text-fg' : 'text-t3'
          }`}
        >
          ☰
        </button>
      )}
      <span className="ml-1 flex items-center text-t2">
        <Wordmark height={10} />
      </span>
      <span className="ml-2.5 flex min-w-0 items-center">
        <WorkspaceTabs
          counts={props.counts}
          projects={props.projects}
          onSwitch={props.onSwitch}
          locked={props.locked}
        />
      </span>
      {props.intent !== undefined && props.intent !== '' && (
        <span className="ml-1.5 min-w-0 truncate text-[10.5px] text-t5">— {props.intent}</span>
      )}
      <span className="no-drag ml-auto flex shrink-0 items-center gap-1">
        {desktop !== undefined && (
          <button
            onClick={props.onStack}
            title="turn stack"
            className={`flex h-[22px] items-center gap-1.5 rounded border px-2.5 font-ui text-[11px] font-bold hover:brightness-115 ${
              props.stackN > 0
                ? 'border-ask/50 bg-ask/10 text-ask'
                : props.stackOpen
                  ? 'border-ac/60 text-fg'
                  : 'border-b3 text-t4'
            }`}
          >
            ▲ {props.stackN}
          </button>
        )}
        <button
          onClick={props.onSettings}
          title="settings"
          className={`flex h-[22px] items-center px-1.5 hover:text-fg ${
            props.settingsOpen ? 'text-ach' : 'text-t4'
          }`}
        >
          <GearIcon size={12} />
        </button>
        {props.platform !== undefined && props.platform !== 'darwin' && <WindowControls />}
      </span>
    </div>
  )
}

/** Frameless-window controls (win/linux — macOS keeps its traffic lights). */
function WindowControls() {
  const [max, setMax] = useState(false)
  useEffect(() => {
    if (desktop?.winIsMaximized !== undefined) {
      void desktop.winIsMaximized().then(setMax)
    }
    return desktop?.onWinState?.(({ maximized }) => setMax(maximized))
  }, [])
  const bridge = desktop
  if (bridge?.winMinimize === undefined) return null
  return (
    <span className="ml-1 flex items-center border-l border-b2 pl-1 text-[11px] text-t4">
      <button
        onClick={() => bridge.winMinimize!()}
        className="rounded px-[9px] py-0.5 hover:bg-s3 hover:text-fg"
        title="minimize"
      >
        —
      </button>
      <button
        onClick={() => bridge.winMaximize!()}
        className="rounded px-[9px] py-0.5 hover:bg-s3 hover:text-fg"
        title={max ? 'restore' : 'maximize'}
      >
        {max ? '❐' : '□'}
      </button>
      <button
        onClick={() => bridge.winClose!()}
        className="rounded px-[9px] py-0.5 hover:bg-err/70 hover:text-fg"
        title="close"
      >
        ✕
      </button>
    </span>
  )
}

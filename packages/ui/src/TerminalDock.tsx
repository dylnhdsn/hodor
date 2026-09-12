import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react'
import 'dockview/dist/styles/dockview.css'
import { desktop, type OpenTarget } from './desktop.js'
import { TerminalView } from './Terminal.js'

/**
 * The desktop app's workspace region (docs/brainstorm/022 v1): a dockview
 * area of tab groups and splits over the session list. PTYs live in the
 * main process, so panels here and pop-out windows are just views — moving
 * a terminal never restarts it.
 *
 * Each panel's params are a workspace SLOT: the live ptyId (stale after an
 * app restart) plus the target it was opened with (the rule). The layout
 * autosaves to ~/.hodor/workspaces.json through /api/workspace; reopening
 * the app restores the frame, and a dead slot degrades to a "resume"
 * affordance instead of failing the restore — `claude --resume` is the
 * lossless restore tmux-resurrect can only approximate.
 */

interface SlotParams {
  ptyId?: string
  target?: OpenTarget
}

interface WorkspaceDoc {
  v: 1
  dockHeight?: number
  workspaces: Array<{ id: string; name: string; windows: Array<{ layout?: unknown }> }>
}

/** A slot panel waiting for the next 'opened' event to claim as its own. */
const pendingClaim: { panelId: string | undefined } = { panelId: undefined }

const paramsOf = (panel: { params?: object | undefined }): SlotParams =>
  (panel.params ?? {}) as SlotParams

const findPanelByPty = (api: DockviewApi, ptyId: string) =>
  api.panels.find((p) => paramsOf(p).ptyId === ptyId)

async function fetchWorkspace(): Promise<WorkspaceDoc | undefined> {
  try {
    const res = await fetch('/api/workspace')
    if (!res.ok) return undefined
    return (await res.json()) as WorkspaceDoc
  } catch {
    return undefined
  }
}

function describeTarget(target: OpenTarget | undefined): string {
  if (target === undefined) return 'this terminal is gone'
  const short = target.sessionId !== undefined ? target.sessionId.slice(0, 8) : ''
  switch (target.kind) {
    case 'resume':
      return `session ${short} isn't running`
    case 'fork':
      return `a fork of ${short}`
    case 'new':
      return `a new session in ${target.root ?? '?'}`
    case 'teleport':
      return `cloud session ${short}`
  }
}

const verbOf = (target: OpenTarget): string =>
  target.kind === 'resume'
    ? 'resume'
    : target.kind === 'fork'
      ? 'fork again'
      : target.kind === 'new'
        ? 'start new session'
        : 'teleport'

/** One workspace tile: a live terminal, or the slot's re-open affordance. */
function TerminalPanel(props: IDockviewPanelProps<SlotParams>) {
  const ptyId = props.params.ptyId
  const target = props.params.target
  const [status, setStatus] = useState<'checking' | 'live' | 'dead'>('checking')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (desktop === undefined || ptyId === undefined) {
      setStatus('dead')
      return
    }
    let cancelled = false
    void desktop.list().then((list) => {
      if (!cancelled) setStatus(list.some((t) => t.id === ptyId) ? 'live' : 'dead')
    })
    return () => {
      cancelled = true
    }
  }, [ptyId])

  if (desktop === undefined) return null
  if (status === 'checking') return <div className="h-full w-full bg-[#0a0a0b]" />
  if (status === 'live' && ptyId !== undefined) {
    return (
      <div className="h-full w-full bg-[#0a0a0b] p-1">
        <TerminalView ptyId={ptyId} visible />
      </div>
    )
  }

  const bridge = desktop
  const relaunch = async (): Promise<void> => {
    if (target === undefined) return
    setError(undefined)
    pendingClaim.panelId = props.api.id
    const result = await bridge.openTerminal(target)
    if (result.id === undefined) {
      pendingClaim.panelId = undefined
      setError(result.error ?? 'could not open a terminal')
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0a0a0b] text-sm text-zinc-400">
      <p className="max-w-md truncate px-4">{describeTarget(target)}</p>
      {error !== undefined && <p className="max-w-md px-4 text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        {target !== undefined && (
          <button
            onClick={() => void relaunch()}
            className="rounded border border-zinc-600 px-3 py-1 text-zinc-200 hover:border-zinc-400"
          >
            {verbOf(target)}
          </button>
        )}
        <button
          onClick={() => props.api.close()}
          className="rounded border border-zinc-800 px-3 py-1 text-zinc-500 hover:text-zinc-300"
        >
          remove
        </button>
      </div>
    </div>
  )
}

/** Group header: pop the active terminal out into its own window. */
function GroupActions(props: IDockviewHeaderActionsProps) {
  const ptyId =
    props.activePanel !== undefined ? paramsOf(props.activePanel).ptyId : undefined
  if (ptyId === undefined || desktop === undefined) return null
  const bridge = desktop
  return (
    <div className="flex h-full items-center px-1">
      <button
        onClick={() => void bridge.popOut(ptyId)}
        className="px-1 text-zinc-500 hover:text-zinc-200"
        title="open in its own window"
      >
        ⧉
      </button>
    </div>
  )
}

const panelComponents = { terminal: TerminalPanel }

export function TerminalDock() {
  const [height, setHeight] = useState(320)
  const [panelCount, setPanelCount] = useState(0)
  const apiRef = useRef<DockviewApi | null>(null)
  const heightRef = useRef(height)
  const saveTimer = useRef<number | undefined>(undefined)
  /** PTYs whose panel removal is a move (pop-out), not a kill. */
  const movingOut = useRef(new Set<string>())
  const dragging = useRef(false)
  heightRef.current = height

  const save = useCallback(() => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const api = apiRef.current
      if (api === null) return
      const doc: WorkspaceDoc = {
        v: 1,
        dockHeight: heightRef.current,
        workspaces: [{ id: 'default', name: 'Workspace', windows: [{ layout: api.toJSON() }] }],
      }
      void fetch('/api/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      }).catch(() => {})
    }, 500)
  }, [])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      api.onDidAddPanel(() => setPanelCount(api.panels.length))
      api.onDidRemovePanel((panel) => {
        setPanelCount(api.panels.length)
        // Closing a tab closes its terminal — unless the panel is only
        // moving (pop-out) or the PTY is already gone (stale slot).
        const ptyId = paramsOf(panel).ptyId
        if (ptyId !== undefined && desktop !== undefined && !movingOut.current.delete(ptyId)) {
          void desktop.close(ptyId)
        }
      })
      api.onDidLayoutChange(() => save())

      void fetchWorkspace().then((doc) => {
        if (doc?.dockHeight !== undefined) {
          setHeight(Math.min(Math.max(doc.dockHeight, 120), window.innerHeight - 160))
        }
        const layout = doc?.workspaces[0]?.windows[0]?.layout
        // Restore only into an untouched region: if a terminal already
        // opened (fast user, renderer reload), keep reality over history.
        if (layout !== undefined && api.panels.length === 0) {
          try {
            api.fromJSON(layout as SerializedDockview)
          } catch {
            // a corrupt or incompatible layout starts empty instead of crashing
          }
        }
        setPanelCount(api.panels.length)
      })
    },
    [save],
  )

  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop

    // Terminals opened before this component mounted (renderer reload).
    void bridge.list().then((list) => {
      const api = apiRef.current
      if (api === null) return
      for (const t of list) {
        if (findPanelByPty(api, t.id) === undefined) {
          api.addPanel({
            id: `pty-${t.id}`,
            component: 'terminal',
            title: t.title,
            params: { ptyId: t.id, ...(t.target !== undefined ? { target: t.target } : {}) },
          })
        }
      }
    })

    return bridge.onEvent((event) => {
      const api = apiRef.current
      if (api === null) return
      if (event.type === 'opened' || event.type === 'returned') {
        // A slot panel re-opening its terminal claims the pty in place.
        if (event.type === 'opened' && pendingClaim.panelId !== undefined) {
          const panel = api.getPanel(pendingClaim.panelId)
          pendingClaim.panelId = undefined
          if (panel !== undefined) {
            panel.api.updateParameters({
              ptyId: event.id,
              ...(event.target !== undefined ? { target: event.target } : {}),
            })
            if (event.title !== undefined) panel.api.setTitle(event.title)
            save()
            return
          }
        }
        if (findPanelByPty(api, event.id) === undefined) {
          api.addPanel({
            id: `pty-${event.id}`,
            component: 'terminal',
            title: event.title ?? event.id,
            params: {
              ptyId: event.id,
              ...(event.target !== undefined ? { target: event.target } : {}),
            },
          })
        }
      } else if (event.type === 'popped' || event.type === 'closed') {
        const panel = findPanelByPty(api, event.id)
        if (panel !== undefined) {
          movingOut.current.add(event.id)
          api.removePanel(panel)
        }
      }
    })
  }, [save])

  const onDividerDown = useCallback(
    (down: React.MouseEvent) => {
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
        save()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [save],
  )

  if (desktop === undefined) return null
  const open = panelCount > 0

  return (
    <div
      className={`flex shrink-0 flex-col overflow-hidden ${open ? 'border-t border-zinc-800' : ''}`}
      style={{ height: open ? height : 0 }}
    >
      <div
        onMouseDown={onDividerDown}
        className="h-1 shrink-0 cursor-row-resize bg-zinc-900 hover:bg-zinc-700"
        title="drag to resize"
      />
      <div className="min-h-0 flex-1">
        <DockviewReact
          onReady={onReady}
          components={panelComponents}
          rightHeaderActionsComponent={GroupActions}
          theme={themeDark}
          defaultRenderer="always"
        />
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

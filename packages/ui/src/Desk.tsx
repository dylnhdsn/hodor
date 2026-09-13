import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewDidDropEvent,
  type DockviewDndOverlayEvent,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from 'dockview-react'
import 'dockview/dist/styles/dockview.css'
import { desktop, type OpenTarget } from './desktop.js'
import { TerminalView } from './Terminal.js'

/**
 * The desk (docs/brainstorm/022 v2, 023): hodor's main surface on desktop.
 * Named zones are dockview groups with identity — "ACTIVE", "PR REVIEWS",
 * "MISC" — the user's categories, persisted with the layout; one zone is
 * the default target new terminals land in. PTYs live in the main process,
 * so tiles and pop-out windows are just views.
 *
 * The whole point is durability: every tile knows WHICH SESSION it holds
 * (its slot target), so after a crash or restart one banner restores the
 * entire desk — each slot resumes `claude --resume` into its place.
 */

export interface SlotParams {
  ptyId?: string
  target?: OpenTarget
}

interface ZoneMeta {
  name?: string | undefined
  def?: boolean | undefined
}

interface WorkspaceDoc {
  v: 1
  workspaces: Array<{
    id: string
    name: string
    windows: Array<{ layout?: unknown; zones?: Record<string, ZoneMeta> }>
    defer?: Record<string, DeferState>
  }>
}

export interface DeferState {
  until?: string
  untilMoves?: string
  phone?: boolean
}

/** External drag payload: a session row dropped onto the desk. */
export const SESSION_DRAG_MIME = 'application/x-hodor-session'

/** One panel at a time re-binds to the next 'opened' PTY (restore, slots). */
const claim: { panelId: string | undefined; resolve: (() => void) | undefined } = {
  panelId: undefined,
  resolve: undefined,
}
/** The zone the next 'opened' PTY should land in (drop-to-open). */
const pendingOpen: { groupId: string | undefined } = { groupId: undefined }

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
    ? '⟳ resume into place'
    : target.kind === 'fork'
      ? 'fork again'
      : target.kind === 'new'
        ? 'start new session'
        : 'teleport'

interface DeskContextValue {
  zones: Record<string, ZoneMeta>
  renameZone: (groupId: string) => void
  toggleDefault: (groupId: string) => void
  resumePanel: (panelId: string) => void
  busy: ReadonlySet<string>
  inspect?: ((sessionId: string) => void) | undefined
}

const DeskContext = createContext<DeskContextValue>({
  zones: {},
  renameZone: () => {},
  toggleDefault: () => {},
  resumePanel: () => {},
  busy: new Set(),
})

/** One tile: a live terminal, or the slot's resume affordance. */
function TerminalPanel(props: IDockviewPanelProps<SlotParams>) {
  const { resumePanel, busy } = useContext(DeskContext)
  const ptyId = props.params.ptyId
  const target = props.params.target
  const [status, setStatus] = useState<'checking' | 'live' | 'dead'>('checking')

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
  if (status === 'checking') return <div className="h-full w-full bg-app" />
  if (status === 'live' && ptyId !== undefined) {
    return (
      <div className="h-full w-full bg-app p-1">
        <TerminalView ptyId={ptyId} visible />
      </div>
    )
  }

  const isBusy = busy.has(props.api.id)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2.5 bg-app px-4 text-center text-sm text-t3">
      <span className="font-mono text-xs text-t6">▢ dead slot</span>
      <p className="max-w-md truncate font-semibold text-t2">{describeTarget(target)}</p>
      {target?.sessionId !== undefined && (
        <p className="font-mono text-[10.5px] text-t6">
          claude --resume {target.sessionId.slice(0, 8)}… — restores losslessly from the transcript
        </p>
      )}
      {isBusy ? (
        <span className="animate-pulse font-mono text-xs text-ac">resuming into place…</span>
      ) : (
        <div className="flex gap-2">
          {target !== undefined && (
            <button
              onClick={() => resumePanel(props.api.id)}
              className="rounded border border-ac/55 px-3 py-1 text-[11.5px] font-semibold text-ach hover:bg-ac/10"
            >
              {verbOf(target)}
            </button>
          )}
          <button
            onClick={() => props.api.close()}
            className="rounded border border-b3 px-3 py-1 text-t4 hover:text-t2"
          >
            remove
          </button>
        </div>
      )}
    </div>
  )
}

/** Zone chrome on the group header: name, default-target mark, rename. */
function ZoneHeader(props: IDockviewHeaderActionsProps) {
  const { zones, renameZone, toggleDefault } = useContext(DeskContext)
  const meta = zones[props.group.id]
  return (
    <div className="flex h-full items-center gap-1.5 pl-2 pr-1">
      <button
        onClick={() => renameZone(props.group.id)}
        title="rename this zone"
        className={`font-mono text-[10px] font-semibold tracking-[.12em] ${
          meta?.name !== undefined ? 'text-t3 hover:text-fg' : 'text-t6 hover:text-t3'
        }`}
      >
        {meta?.name ?? 'name zone…'}
      </button>
      <button
        onClick={() => toggleDefault(props.group.id)}
        title="new terminals open here"
        className={`font-mono text-[9.5px] ${
          meta?.def === true
            ? 'rounded border border-dashed border-b4 px-1.5 text-t5'
            : 'px-1 text-t6 opacity-40 hover:opacity-100'
        }`}
      >
        {meta?.def === true ? 'default target' : '◎'}
      </button>
    </div>
  )
}

/** Pop the active terminal out into its own window. */
function GroupActions(props: IDockviewHeaderActionsProps) {
  const { inspect } = useContext(DeskContext)
  const active = props.activePanel
  const ptyId = active !== undefined ? paramsOf(active).ptyId : undefined
  const sessionId = active !== undefined ? paramsOf(active).target?.sessionId : undefined
  if (desktop === undefined) return null
  const bridge = desktop
  return (
    <div className="flex h-full items-center px-1">
      {sessionId !== undefined && inspect !== undefined && (
        <button
          onClick={() => inspect(sessionId)}
          className="px-1 font-mono text-[10px] text-t4 hover:text-fg"
          title="session detail"
        >
          ⓘ
        </button>
      )}
      {ptyId !== undefined && (
        <button
          onClick={() => void bridge.popOut(ptyId)}
          className="px-1 text-t4 hover:text-t1"
          title="open in its own window"
        >
          ⧉
        </button>
      )}
    </div>
  )
}

function Watermark(_props: IWatermarkPanelProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-app font-mono text-[11px] text-t6">
      no tabs — open a session from the library, or drag one here
    </div>
  )
}

const panelComponents = { terminal: TerminalPanel }

export function Desk({ inspect }: { inspect?: (sessionId: string) => void }) {
  const [zones, setZones] = useState<Record<string, ZoneMeta>>({})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [restore, setRestore] = useState<{ dead: number; zones: number } | undefined>(undefined)
  const apiRef = useRef<DockviewApi | null>(null)
  const zonesRef = useRef(zones)
  const saveTimer = useRef<number | undefined>(undefined)
  const deferRef = useRef<Record<string, DeferState>>({})
  /** PTYs whose panel removal is a move (pop-out), not a kill. */
  const movingOut = useRef(new Set<string>())
  zonesRef.current = zones

  const save = useCallback(() => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const api = apiRef.current
      if (api === null) return
      // prune zone meta for groups that no longer exist
      const live = new Set(api.groups.map((g) => g.id))
      const zoneOut: Record<string, ZoneMeta> = {}
      for (const [id, meta] of Object.entries(zonesRef.current)) {
        if (live.has(id)) zoneOut[id] = meta
      }
      const doc: WorkspaceDoc = {
        v: 1,
        workspaces: [
          {
            id: 'default',
            name: 'the desk',
            windows: [{ layout: api.toJSON(), zones: zoneOut }],
            defer: deferRef.current,
          },
        ],
      }
      void fetch('/api/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      }).catch(() => {})
    }, 500)
  }, [])

  const renameZone = useCallback(
    (groupId: string) => {
      const current = zonesRef.current[groupId]?.name ?? ''
      const name = window.prompt('Zone name (e.g. ACTIVE, PR REVIEWS, MISC)', current)
      if (name === null) return
      setZones((z) => ({
        ...z,
        [groupId]: { ...z[groupId], name: name.trim().toUpperCase() || undefined },
      }))
      save()
    },
    [save],
  )

  const toggleDefault = useCallback(
    (groupId: string) => {
      setZones((z) => {
        const next: Record<string, ZoneMeta> = {}
        for (const [id, meta] of Object.entries(z)) {
          next[id] = { ...meta, def: undefined }
        }
        next[groupId] = { ...next[groupId], def: z[groupId]?.def === true ? undefined : true }
        return next
      })
      save()
    },
    [save],
  )

  /** Resume a dead slot's session back into its own tile. */
  const resumePanel = useCallback((panelId: string): Promise<void> => {
    const api = apiRef.current
    const bridge = desktop
    if (api === null || bridge === undefined) return Promise.resolve()
    const panel = api.getPanel(panelId)
    const target = panel !== undefined ? paramsOf(panel).target : undefined
    if (panel === undefined || target === undefined) return Promise.resolve()
    setBusy((b) => new Set(b).add(panelId))
    const done = new Promise<void>((resolve) => {
      claim.panelId = panelId
      claim.resolve = resolve
    })
    return bridge
      .openTerminal(target)
      .then((res) => {
        if (res.id === undefined) {
          claim.panelId = undefined
          claim.resolve = undefined
          return
        }
        return Promise.race([done, new Promise<void>((r) => setTimeout(r, 15_000))])
      })
      .finally(() => {
        setBusy((b) => {
          const next = new Set(b)
          next.delete(panelId)
          return next
        })
      })
  }, [])

  const deadPanels = useCallback((): string[] => {
    const api = apiRef.current
    if (api === null) return []
    return api.panels
      .filter((p) => busy.has(p.id) === false)
      .filter((p) => {
        const params = paramsOf(p)
        return params.target !== undefined && params.ptyId === undefined
      })
      .map((p) => p.id)
  }, [busy])

  const restoreAll = useCallback(async () => {
    setRestore(undefined)
    // Sequential on purpose: one claim slot, and the stagger reads well.
    for (const id of deadPanels()) {
      await resumePanel(id)
    }
  }, [deadPanels, resumePanel])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      api.onDidRemovePanel((panel) => {
        const ptyId = paramsOf(panel).ptyId
        if (ptyId !== undefined && desktop !== undefined && !movingOut.current.delete(ptyId)) {
          void desktop.close(ptyId)
        }
      })
      api.onDidLayoutChange(() => save())
      // Accept session-row drags from the library as drop targets.
      api.onUnhandledDragOver((e) => {
        const native = e.nativeEvent
        if (
          native instanceof DragEvent &&
          (native.dataTransfer?.types.includes(SESSION_DRAG_MIME) ?? false)
        ) {
          e.accept()
        }
      })

      void Promise.all([fetchWorkspace(), desktop?.list() ?? Promise.resolve([])]).then(
        ([doc, live]) => {
          const window0 = doc?.workspaces[0]?.windows[0]
          if (window0?.layout !== undefined && api.panels.length === 0) {
            try {
              api.fromJSON(window0.layout as SerializedDockview)
            } catch {
              // a corrupt layout starts empty instead of crashing the desk
            }
          }
          if (window0?.zones !== undefined) setZones(window0.zones)
          deferRef.current = doc?.workspaces[0]?.defer ?? {}
          // mark stale ptyIds dead by CLEARING them — the slot (target)
          // stays, which is exactly what restore-all resumes.
          const liveIds = new Set(live.map((t) => t.id))
          let dead = 0
          const deadGroups = new Set<string>()
          for (const panel of api.panels) {
            const params = paramsOf(panel)
            if (params.ptyId !== undefined && !liveIds.has(params.ptyId)) {
              panel.api.updateParameters({ ptyId: undefined })
            }
            if (params.target !== undefined && (params.ptyId === undefined || !liveIds.has(params.ptyId))) {
              dead += 1
              deadGroups.add(panel.group.id)
            }
          }
          if (dead > 0) setRestore({ dead, zones: deadGroups.size })
        },
      )
    },
    [save],
  )

  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop

    // Terminals opened before this view mounted (renderer reload).
    void bridge.list().then((list) => {
      const api = apiRef.current
      if (api === null) return
      for (const t of list) {
        if (findPanelByPty(api, t.id) === undefined) {
          addPtyPanel(api, t.id, t.title, t.target)
        }
      }
    })

    function defaultGroup(api: DockviewApi): string | undefined {
      const id = Object.entries(zonesRef.current).find(([, meta]) => meta.def === true)?.[0]
      return id !== undefined && api.groups.some((g) => g.id === id) ? id : undefined
    }

    function addPtyPanel(api: DockviewApi, ptyId: string, title?: string, target?: OpenTarget) {
      const dropped =
        pendingOpen.groupId !== undefined && api.groups.some((g) => g.id === pendingOpen.groupId)
          ? pendingOpen.groupId
          : undefined
      pendingOpen.groupId = undefined
      const group = dropped ?? defaultGroup(api)
      api.addPanel({
        id: `pty-${ptyId}`,
        component: 'terminal',
        title: title ?? ptyId,
        params: { ptyId, ...(target !== undefined ? { target } : {}) },
        ...(group !== undefined ? { position: { referenceGroup: group } } : {}),
      })
    }

    return bridge.onEvent((event) => {
      const api = apiRef.current
      if (api === null) return
      if (event.type === 'opened' || event.type === 'returned') {
        if (event.type === 'opened' && claim.panelId !== undefined) {
          const panel = api.getPanel(claim.panelId)
          const resolve = claim.resolve
          claim.panelId = undefined
          claim.resolve = undefined
          if (panel !== undefined) {
            panel.api.updateParameters({
              ptyId: event.id,
              ...(event.target !== undefined ? { target: event.target } : {}),
            })
            if (event.title !== undefined) panel.api.setTitle(event.title)
            save()
            resolve?.()
            return
          }
          resolve?.()
        }
        if (findPanelByPty(api, event.id) === undefined) {
          addPtyPanel(api, event.id, event.title, event.target)
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

  // A session row dragged from the library opens IN the zone it lands on.
  const onDidDrop = useCallback((event: DockviewDidDropEvent) => {
    const native = event.nativeEvent
    if (!(native instanceof DragEvent) || native.dataTransfer === null) return
    const raw = native.dataTransfer.getData(SESSION_DRAG_MIME)
    if (raw.length === 0 || desktop === undefined) return
    let target: OpenTarget
    try {
      target = JSON.parse(raw) as OpenTarget
    } catch {
      return
    }
    pendingOpen.groupId = event.group?.id
    void desktop.openTerminal(target)
  }, [])


  if (desktop === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-t5">
        the desk needs the desktop app — terminals live there
      </div>
    )
  }

  return (
    <DeskContext.Provider value={{ zones, renameZone, toggleDefault, resumePanel, busy, inspect }}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {restore !== undefined && (
          <div className="mx-3 mt-2.5 flex flex-none items-center gap-2.5 rounded border border-ac/50 bg-ac/8 px-3.5 py-2 text-[12.5px]">
            <span className="text-[15px]">⚡</span>
            <span className="font-bold">Restore your desk?</span>
            <span className="text-xs text-t3">
              {restore.dead} session{restore.dead === 1 ? '' : 's'} across {restore.zones} zone
              {restore.zones === 1 ? '' : 's'} — every tile resumes claude --resume into its place
            </span>
            <button
              onClick={() => void restoreAll()}
              className="ml-auto whitespace-nowrap rounded bg-ac px-3 py-1 text-[11.5px] font-semibold text-ink hover:brightness-110"
            >
              ⟳ restore all
            </button>
            <button
              onClick={() => setRestore(undefined)}
              className="whitespace-nowrap rounded border border-b6 px-3 py-1 text-[11.5px] font-semibold text-t1 hover:border-ac"
            >
              pick by hand
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 p-1.5">
          <DockviewReact
            onReady={onReady}
            components={panelComponents}
            watermarkComponent={Watermark}
            leftHeaderActionsComponent={ZoneHeader}
            rightHeaderActionsComponent={GroupActions}
            onDidDrop={onDidDrop}
            theme={themeDark}
            defaultRenderer="always"
          />
        </div>
      </div>
    </DeskContext.Provider>
  )
}

/** A pop-out window's whole content: one terminal, edge to edge. */
export function PopoutTerminal({ ptyId }: { ptyId: string }) {
  return (
    <div className="flex h-full flex-col bg-app">
      <div className="min-h-0 flex-1 p-1">
        <TerminalView ptyId={ptyId} visible />
      </div>
    </div>
  )
}

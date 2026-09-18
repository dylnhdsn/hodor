import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewDidDropEvent,
  type DockviewDndOverlayEvent,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from 'dockview-react'
import 'dockview/dist/styles/dockview.css'
import { postMutation } from './data.js'
import { desktop, type OpenTarget } from './desktop.js'
import { promptText } from './dialog.js'
import { ShellIcon } from './icons.js'
import { Tip } from './tip.js'
import { ContextMenu, useContextMenu } from './menu.js'
import { focusTerminal, TerminalView } from './Terminal.js'

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
  /** Where the shell runs ("wsl · Ubuntu", "cmd") — the tab shows it. */
  env?: string
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
  /** Timed snooze: quiet until this instant. */
  until?: string
  /** Legacy "until it moves": quiet while lastActivity <= this timestamp.
   * Replaced by `sig` — timestamps churn on background noise (task
   * notifications, cloud listing refreshes) and un-skipped things nobody
   * touched. Kept so old saved defers keep working. */
  untilMoves?: string
  /** "Until it moves", done right: a snapshot of WHAT the session was
   * asking when skipped (its waiting signature). It stays quiet while the
   * ask reads the same and wakes when the ask actually changes. */
  sig?: string
  /** No wake condition at all — quiet until the user unskips. */
  hold?: boolean
  /** "Until the PR moves": quiet while the PR's fingerprint (state, head,
   * review, last update) still reads the same as when skipped. */
  pr?: { number: number; fingerprint: string }
  /** Why you skipped it — shown on the row so future-you reorients. */
  note?: string
  phone?: boolean
}

/** External drag payload: a session row dropped onto the desk. */
export const SESSION_DRAG_MIME = 'application/x-hodor-session'

/**
 * The desk's shared face (module store): the Turn Stack and the library
 * read which sessions live on the desk without owning the dockview. The
 * Desk component stays MOUNTED (hidden, not unmounted) while other views
 * show, so terminals keep their buffers and this store stays live.
 */
export interface DeskEntry {
  panelId: string
  title: string
  /** How the tile was opened (resume / new / fork / teleport / shell). */
  kind?: OpenTarget['kind']
  /** Where its shell runs ("wsl · Ubuntu", "cmd") — shells show it. */
  env?: string
  /** Shell tiles: the directory they opened in. */
  root?: string
  sessionId?: string
  ptyId?: string
  /** The named zone this tile lives in ("ACTIVE", "PR REVIEWS"…). */
  zone?: string
  /** Teleport tiles: the CLOUD session id this tile was opened from.
   * That membership is what puts a cloud session in the turn stack. */
  cloudId?: string
}

export const deskState: { entries: DeskEntry[]; defer: Record<string, DeferState> } = {
  entries: [],
  defer: {},
}

interface DeskOps {
  closePanel: (panelId: string) => void
  /** Put the keyboard in this tile's terminal, looking its pty up live:
   * a tab component's params are captured at render and the pty binds
   * afterwards, so the tab's own copy is stale. */
  focusPanel: (panelId: string) => void
  /** Make a tile the active panel of its zone (no focus steal). */
  revealPanel: (panelId: string) => void
  resumePanel: (panelId: string) => Promise<void>
  setDefer: (sessionId: string, state: DeferState | undefined) => void
}

let deskOps: DeskOps | undefined
export const getDeskOps = (): DeskOps | undefined => deskOps

const deskListeners = new Set<() => void>()
export function subscribeDesk(fn: () => void): () => void {
  deskListeners.add(fn)
  return () => deskListeners.delete(fn)
}
function notifyDesk(): void {
  for (const fn of deskListeners) fn()
}

/** Is this session's needs-you currently silenced by a deferral?
 * (skip / snooze / hold / sent-to-phone). Pure — expiry cleanup stays in
 * stackQueue. `currentSig` is the session's waiting signature right now
 * (what it's asking); a sig deferral lifts when the ask changes.
 * `lastMoveIso` only serves legacy timestamp deferrals. */
export function isDeferred(
  sessionId: string,
  currentSig: string | undefined,
  lastMoveIso: string | undefined,
  nowMs: number,
  defers: Record<string, DeferState> = deskState.defer,
  /** The session's PR fingerprint right now; unknown keeps a PR skip quiet. */
  prFingerprint?: string,
): boolean {
  const defer = defers[sessionId]
  if (defer === undefined) return false
  if (defer.until !== undefined) return Date.parse(defer.until) > nowMs
  if (defer.pr !== undefined) {
    return prFingerprint === undefined || prFingerprint === defer.pr.fingerprint
  }
  if (defer.hold === true) return true
  if (defer.sig !== undefined) return defer.sig === (currentSig ?? '')
  if (defer.untilMoves !== undefined || defer.phone === true) {
    return (lastMoveIso ?? '') <= (defer.untilMoves ?? '')
  }
  return true
}

/** The note attached to a deferral, if any. */
export const deferNoteOf = (sessionId: string): string | undefined =>
  deskState.defer[sessionId]?.note

/** A group's tab strip: dockview scrolls it (overflow: auto); these
 * helpers give it the wheel, the arrow buttons and a right-button drag,
 * because a strip full of tabs is otherwise reachable only by the
 * overflow menu. */
const tabStripOf = (el: HTMLElement | undefined): HTMLElement | null =>
  el?.querySelector<HTMLElement>('.dv-tabs-container') ?? null
const scrollStrip = (el: HTMLElement | undefined, dx: number): void => {
  tabStripOf(el)?.scrollBy({ left: dx, behavior: 'smooth' })
}
if (typeof document !== 'undefined') {
  // vertical wheel over a strip scrolls it sideways (it has no vertical axis)
  document.addEventListener(
    'wheel',
    (e) => {
      const strip = (e.target as HTMLElement | null)?.closest<HTMLElement>('.dv-tabs-container')
      if (strip === null || strip === undefined || strip.scrollWidth <= strip.clientWidth) return
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      strip.scrollLeft += e.deltaY
      e.preventDefault()
    },
    { passive: false },
  )
  // right-button drag scrubs the strip; a plain right-click still opens
  // the tab's menu (the drag swallows the contextmenu only if it moved)
  let drag: { strip: HTMLElement; x: number; left: number; moved: boolean } | undefined
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return
    const strip = (e.target as HTMLElement | null)?.closest<HTMLElement>('.dv-tabs-container')
    if (strip === null || strip === undefined) return
    drag = { strip, x: e.clientX, left: strip.scrollLeft, moved: false }
  })
  document.addEventListener('pointermove', (e) => {
    if (drag === undefined) return
    const dx = e.clientX - drag.x
    if (Math.abs(dx) > 4) drag.moved = true
    if (drag.moved) drag.strip.scrollLeft = drag.left - dx
  })
  document.addEventListener('pointerup', () => {
    if (drag?.moved === true) {
      const swallow = (e: Event): void => {
        e.preventDefault()
        e.stopPropagation()
      }
      document.addEventListener('contextmenu', swallow, { capture: true, once: true })
      setTimeout(() => document.removeEventListener('contextmenu', swallow, { capture: true }), 150)
    }
    drag = undefined
  })
}

/** Zone metas mirrored at module scope so entries can carry zone names. */
let zoneMetas: Record<string, ZoneMeta> = {}

/** Window teardown: dockview disposes panel by panel, and a debounced
 * save mid-dispose would persist a half-emptied desk — after restart the
 * missing tiles read as "the app forgot my sessions". Killing PTYs from
 * the removal handler is equally wrong then: the removal is the app
 * closing, not the user closing a tile. */
let unloading = false
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    unloading = true
  })
  window.addEventListener('pagehide', () => {
    unloading = true
  })
}

/** Turn states + display titles by session id, pushed in by the App from
 * each snapshot so the desk's tabs (separate React roots) can color their
 * status dots and carry the session's actual name. */
export const deskTurnStates: Record<string, 'working' | 'waiting' | 'idle'> = {}
export const deskSessionTitles: Record<string, string> = {}
export function setDeskSessions(
  states: Record<string, 'working' | 'waiting' | 'idle'>,
  titles: Record<string, string>,
): void {
  const changed =
    Object.keys(states).length !== Object.keys(deskTurnStates).length ||
    Object.entries(states).some(([id, state]) => deskTurnStates[id] !== state) ||
    Object.keys(titles).length !== Object.keys(deskSessionTitles).length ||
    Object.entries(titles).some(([id, title]) => deskSessionTitles[id] !== title)
  if (!changed) return
  for (const id of Object.keys(deskTurnStates)) delete deskTurnStates[id]
  Object.assign(deskTurnStates, states)
  for (const id of Object.keys(deskSessionTitles)) delete deskSessionTitles[id]
  Object.assign(deskSessionTitles, titles)
  notifyDesk()
}

function refreshEntries(api: DockviewApi): void {
  deskState.entries = api.panels.map((p) => {
    const params = paramsOf(p)
    const zone = p.group !== undefined ? zoneMetas[p.group.id]?.name : undefined
    return {
      panelId: p.id,
      title: p.title ?? p.id,
      ...(params.target?.kind !== undefined ? { kind: params.target.kind } : {}),
      ...(params.env !== undefined ? { env: params.env } : {}),
      ...(params.target?.kind === 'shell' && params.target.root !== undefined
        ? { root: params.target.root }
        : {}),
      // A tile knows its session when opened via resume, or when hodor
      // minted the id at spawn (kind 'new'). Teleport ids are CLOUD ids
      // and fork targets carry the PARENT id — neither binds here.
      ...(params.target?.sessionId !== undefined &&
      (params.target.kind === 'resume' || params.target.kind === 'new')
        ? { sessionId: params.target.sessionId }
        : {}),
      ...(params.target?.kind === 'teleport' && params.target.sessionId !== undefined
        ? { cloudId: params.target.sessionId }
        : {}),
      ...(params.ptyId !== undefined ? { ptyId: params.ptyId } : {}),
      ...(zone !== undefined ? { zone } : {}),
    }
  })
  notifyDesk()
}

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
    case 'shell':
      return `a shell in ${target.root ?? '?'}`
  }
}

const verbOf = (target: OpenTarget): string =>
  target.kind === 'resume'
    ? '⟳ resume into place'
    : target.kind === 'fork'
      ? 'fork again'
      : target.kind === 'new'
        ? 'start new session'
        : target.kind === 'shell'
          ? 'open shell again'
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
  // Clicking a tab activates its panel; that is when its terminal should
  // take the keyboard.
  const [active, setActive] = useState(props.api.isActive)
  useEffect(() => {
    const d = props.api.onDidActiveChange((e) => setActive(e.isActive))
    // Dockview focuses the TAB element on click; when it tells us the
    // panel took focus, hand that focus down to the terminal so the
    // click leaves you typing in it.
    const f = props.api.onDidFocusChange((e) => {
      if (e.isFocused) focusTerminal(paramsOf({ params: props.params }).ptyId)
    })
    return () => {
      d.dispose()
      f.dispose()
    }
  }, [props.api, props.params])

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

  // A clean exit — /bg sent it to the background, /exit ended it — turns
  // the tile back into its slot, whose resume verb attaches when the
  // session is still running (028). A crash keeps its output on screen.
  useEffect(() => {
    if (desktop === undefined || ptyId === undefined) return
    return desktop.onEvent((e) => {
      if (e.type === 'exit' && e.id === ptyId && (e.code ?? 0) === 0) setStatus('dead')
    })
  }, [ptyId])

  if (desktop === undefined) return null
  if (status === 'checking') return <div className="h-full w-full bg-app" />
  if (status === 'live' && ptyId !== undefined) {
    return (
      <div className="h-full w-full bg-app p-1">
        <TerminalView ptyId={ptyId} visible autoFocus={active} />
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
          claude --resume {target.sessionId.slice(0, 8)}… (attaches if it still runs in the background)
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

/** Zone chrome on the group header: NAME + tab count (mock: "ACTIVE 3 tabs"). */
function ZoneHeader(props: IDockviewHeaderActionsProps) {
  const { zones, renameZone } = useContext(DeskContext)
  const meta = zones[props.group.id]
  const n = props.panels.length
  return (
    <div className="flex h-full items-center gap-2 pl-2.5 pr-1">
      <button
        onClick={() => scrollStrip(props.group.element, -240)}
        title="scroll tabs left"
        className="px-1 font-mono text-[11px] text-t6 hover:text-fg"
      >
        ‹
      </button>
      <button
        onClick={() => renameZone(props.group.id)}
        title="rename this zone"
        className={`font-mono text-[10px] font-bold tracking-[.14em] ${
          meta?.name !== undefined ? 'text-t1 hover:text-fg' : 'text-t6 hover:text-t3'
        }`}
      >
        {meta?.name ?? 'NAME ZONE…'}
      </button>
      <span className="font-mono text-[9.5px] text-t6">
        {n} tab{n === 1 ? '' : 's'}
      </span>
    </div>
  )
}

/** Right chrome: default-target chip, detail, pop-out. */
function GroupActions(props: IDockviewHeaderActionsProps) {
  const { zones, toggleDefault, inspect } = useContext(DeskContext)
  const meta = zones[props.group.id]
  const active = props.activePanel
  const ptyId = active !== undefined ? paramsOf(active).ptyId : undefined
  const sessionId = active !== undefined ? paramsOf(active).target?.sessionId : undefined
  if (desktop === undefined) return null
  const bridge = desktop
  return (
    <div className="flex h-full items-center gap-0.5 px-1.5">
      <button
        onClick={() => scrollStrip(props.group.element, 240)}
        title="scroll tabs right"
        className="px-1 font-mono text-[11px] text-t6 hover:text-fg"
      >
        ›
      </button>
      <button
        onClick={() => toggleDefault(props.group.id)}
        title="new terminals open here"
        className={`font-mono text-[9.5px] ${
          meta?.def === true
            ? 'rounded border border-dashed border-b5 px-1.5 py-px text-t4'
            : 'px-1 text-t6 opacity-40 hover:opacity-100'
        }`}
      >
        {meta?.def === true ? 'default target' : '◎'}
      </button>
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

/** What the shell icon means, for its tooltip. */
const shellLabel = (env: string | undefined): string => {
  if (env === undefined) return 'runs in your shell'
  if (env.startsWith('wsl')) {
    const distro = env.split('·')[1]?.trim()
    return distro !== undefined && distro !== '' ? `runs in WSL (${distro})` : 'runs in WSL'
  }
  if (env === 'powershell') return 'runs in PowerShell'
  if (env === 'cmd') return 'runs in cmd'
  return `runs in ${env}`
}

/** Tab anatomy: a shell icon (wsl/powershell/cmd, name on hover), the
 * SESSION's name (live from the snapshot once the tile knows its
 * session), and a status dot that means ONLY whose turn it is. Visible
 * vs focused is carried by the underline, not the dot, so the two
 * signals never fight over one pixel. Right-click for the tab's verbs. */
function SlotTab(props: IDockviewPanelHeaderProps<SlotParams>) {
  const [active, setActive] = useState(props.api.isActive)
  const [panelTitle, setPanelTitle] = useState(props.api.title ?? props.api.id)
  const [, force] = useState(0)
  const { menu, openMenu, closeMenu } = useContextMenu()
  const [focused, setFocused] = useState(props.api.isActive && props.api.isGroupActive)
  useEffect(() => {
    const sync = (): void => setFocused(props.api.isActive && props.api.isGroupActive)
    const d1 = props.api.onDidActiveChange((e) => {
      setActive(e.isActive)
      sync()
    })
    const d2 = props.api.onDidTitleChange((e) => setPanelTitle(e.title))
    // Group focus is what separates accent from muted: the visible tab of
    // an unfocused split is still visible, just not the one taking your
    // keystrokes.
    const d3 = props.api.onDidActiveGroupChange(sync)
    const off = subscribeDesk(() => force((t) => t + 1))
    return () => {
      d1.dispose()
      d2.dispose()
      d3.dispose()
      off()
    }
  }, [props.api])
  const target = props.params.target
  const sessionId =
    target !== undefined && (target.kind === 'resume' || target.kind === 'new')
      ? target.sessionId
      : undefined
  // The session's own name wins over the launch-time panel title.
  const title = (sessionId !== undefined ? deskSessionTitles[sessionId] : undefined) ?? panelTitle
  const turn = sessionId !== undefined ? deskTurnStates[sessionId] : undefined
  const dead = props.params.ptyId === undefined
  // The dot means ONE thing: whose turn it is. Your turn (amber) and
  // working (green) are mutually exclusive; a dead slot is grey. Which
  // tab is visible/focused is said by the underline instead, so the two
  // signals never fight over the same pixel.
  const dot =
    turn === 'waiting'
      ? 'text-ask'
      : turn === 'working'
        ? 'text-run'
        : dead
          ? 'text-b6'
          : 'text-t6'
  const env = props.params.env

  const rename = (): void => {
    void promptText('Rename session', {
      initial: title,
      detail:
        sessionId !== undefined
          ? 'renames the session everywhere in hodor'
          : 'renames this tab only — it has no session bound yet',
    }).then((name) => {
      if (name === undefined || name.trim().length === 0) return
      if (sessionId !== undefined) {
        // the durable name — every view shows it, not just this tab
        void postMutation('/api/session', {
          op: 'rename-session',
          sessionId,
          name: name.trim(),
        })
      } else {
        props.api.setTitle(name.trim())
      }
    })
  }

  return (
    <div
      // Clicking a tab puts the keyboard in ITS terminal — including when
      // the tab was already active, which fires no activation event.
      onContextMenu={(e) =>
        openMenu(e, [
          { label: title, heading: true },
          { label: 'rename', onClick: rename },
          ...(props.params.ptyId !== undefined && desktop !== undefined
            ? [
                {
                  label: 'open in its own window',
                  onClick: () => void desktop!.popOut(props.params.ptyId!),
                },
                ...(props.params.target?.kind !== 'shell' && props.params.target?.kind !== 'teleport'
                  ? [
                      {
                        label: 'detach (keep running)',
                        onClick: () => desktop!.write(props.params.ptyId!, '/bg\r'),
                      },
                    ]
                  : []),
              ]
            : []),
          { label: 'close tab', onClick: () => props.api.close(), danger: true },
        ])
      }
      className={`group flex h-full items-center gap-1.5 px-2.5 font-mono text-[11px] ${
        active
          ? focused
            ? 'text-fg shadow-[inset_0_-2px_0_0_var(--h-ac)]'
            : 'text-fg shadow-[inset_0_-2px_0_0_var(--h-b6)]'
          : 'text-t4 hover:text-t2'
      }`}
    >
      <span className={`text-[8px] ${dot}`}>●</span>
      <Tip text={shellLabel(env)} className="flex items-center text-t5">
        <ShellIcon env={env} />
      </Tip>
      <span className="max-w-[160px] truncate font-ui text-[11.5px] font-semibold">{title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          props.api.close()
        }}
        className="pl-0.5 text-t6 opacity-0 hover:text-err group-hover:opacity-100"
        title="close"
      >
        ×
      </button>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
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
  /** Live-terminal adoption must WAIT for the saved layout: if it wins
   * the race, panels.length !== 0 skips fromJSON and the next autosave
   * overwrites the doc with just the adopted panel — the desk "forgets"
   * every dead tile (seen live: a saved two-tile desk reloaded as one). */
  const restoreLatch = useRef<{ p: Promise<void>; done: () => void } | undefined>(undefined)
  if (restoreLatch.current === undefined) {
    let done!: () => void
    const p = new Promise<void>((resolve) => {
      done = resolve
    })
    restoreLatch.current = { p, done }
  }
  zonesRef.current = zones
  zoneMetas = zones
  useEffect(() => {
    // zone names changed → entries carry them → library zone chips update
    if (apiRef.current !== null) refreshEntries(apiRef.current)
  }, [zones])

  // Keep panel titles converged on the session's LIVE name: the tab
  // renders deskSessionTitles itself, but syncing the panel title too
  // covers every other consumer (saved layouts, dead-slot restores).
  useEffect(
    () =>
      subscribeDesk(() => {
        const api = apiRef.current
        if (api === null) return
        for (const panel of api.panels) {
          const target = paramsOf(panel).target
          const sessionId =
            target !== undefined && (target.kind === 'resume' || target.kind === 'new')
              ? target.sessionId
              : undefined
          if (sessionId === undefined) continue
          const live = deskSessionTitles[sessionId]
          if (live !== undefined && live !== panel.title) panel.api.setTitle(live)
        }
      }),
    [],
  )

  const save = useCallback(() => {
    if (unloading) return
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const api = apiRef.current
      if (api === null || unloading) return
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
      void promptText('Zone name', {
        initial: current,
        placeholder: 'ACTIVE, PR REVIEWS, MISC…',
      }).then((name) => {
        if (name === undefined) return
        setZones((z) => ({
          ...z,
          [groupId]: { ...z[groupId], name: name.trim().toUpperCase() || undefined },
        }))
        save()
      })
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

  /** Resume a dead slot's session back into its own tile. A slot that
   * knows its session id (opened via resume, or a 'new' tile whose id
   * hodor minted at spawn) resumes THAT conversation; only if the
   * session never materialized (died before the first prompt) does the
   * slot fall back to its original rule and start over. */
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
    const preferResume =
      target.sessionId !== undefined && (target.kind === 'resume' || target.kind === 'new')
    const attempt: OpenTarget = preferResume
      ? { kind: 'resume', sessionId: target.sessionId! }
      : target
    return bridge
      .openTerminal(attempt)
      .then((res) => {
        if (res.id === undefined && preferResume && target.kind === 'new') {
          // unused tile: no transcript to resume — re-run the slot rule
          return bridge.openTerminal(target)
        }
        return res
      })
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

  // Publish the desk's operations for the Turn Stack and the library.
  useEffect(() => {
    deskOps = {
      closePanel: (panelId) => {
        const api = apiRef.current
        const panel = api?.getPanel(panelId)
        if (api !== undefined && api !== null && panel !== undefined) api.removePanel(panel)
      },
      focusPanel: (panelId) => {
        const panel = apiRef.current?.getPanel(panelId)
        if (panel !== undefined) focusTerminal(paramsOf(panel).ptyId)
      },
      revealPanel: (panelId) => {
        // Bring the tile forward in its zone, so the desk behind the
        // stack (and after esc) shows the session being dealt with.
        apiRef.current?.getPanel(panelId)?.api.setActive()
      },
      resumePanel,
      setDefer: (sessionId, state) => {
        if (state === undefined) delete deskState.defer[sessionId]
        else deskState.defer[sessionId] = state
        save()
        notifyDesk()
      },
    }
    return () => {
      deskOps = undefined
    }
  }, [resumePanel, save])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      api.onDidRemovePanel((panel) => {
        if (unloading) return
        const ptyId = paramsOf(panel).ptyId
        if (ptyId !== undefined && desktop !== undefined && !movingOut.current.delete(ptyId)) {
          void desktop.close(ptyId)
        }
        refreshEntries(api)
      })
      api.onDidAddPanel(() => refreshEntries(api))
      api.onDidLayoutChange(() => {
        save()
        refreshEntries(api)
      })
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
          deskState.defer = deferRef.current
          refreshEntries(api)
        },
      )
        .catch(() => {})
        .finally(() => restoreLatch.current?.done())
    },
    [save],
  )

  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop

    // Terminals opened before this view mounted (renderer reload) —
    // adopted only AFTER the saved layout restores (see restoreLatch).
    void (restoreLatch.current?.p ?? Promise.resolve())
      .then(() => bridge.list())
      .then((list) => {
        const api = apiRef.current
        if (api === null) return
        for (const t of list) {
          if (findPanelByPty(api, t.id) === undefined) {
            addPtyPanel(api, t.id, t.title, t.target, t.env)
          }
        }
      })

    function defaultGroup(api: DockviewApi): string | undefined {
      const id = Object.entries(zonesRef.current).find(([, meta]) => meta.def === true)?.[0]
      return id !== undefined && api.groups.some((g) => g.id === id) ? id : undefined
    }

    function addPtyPanel(
      api: DockviewApi,
      ptyId: string,
      title?: string,
      target?: OpenTarget,
      env?: string,
    ) {
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
        params: {
          ptyId,
          ...(target !== undefined ? { target } : {}),
          ...(env !== undefined ? { env } : {}),
        },
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
              ...(event.env !== undefined ? { env: event.env } : {}),
            })
            if (event.title !== undefined) panel.api.setTitle(event.title)
            save()
            refreshEntries(api)
            resolve?.()
            return
          }
          resolve?.()
        }
        if (findPanelByPty(api, event.id) === undefined) {
          addPtyPanel(api, event.id, event.title, event.target, event.env)
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

  // Clicking a tab makes dockview focus the TAB ELEMENT itself, which
  // leaves the keyboard nowhere useful. Catch that focus and hand it down
  // to the active tile's terminal — one document-level listener, so it
  // does not depend on dockview's internal event plumbing.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const el = event.target as HTMLElement | null
      if (el === null || el.closest('.dv-tab') === null) return
      const panel = apiRef.current?.activePanel
      if (panel !== undefined) focusTerminal(paramsOf(panel).ptyId)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

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
            <span className="font-bold">Restore your desk?</span>
            <span className="text-xs text-t3">
              {restore.dead} session{restore.dead === 1 ? '' : 's'} across {restore.zones} zone
              {restore.zones === 1 ? '' : 's'}
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
            defaultTabComponent={SlotTab}
            watermarkComponent={Watermark}
            prefixHeaderActionsComponent={ZoneHeader}
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

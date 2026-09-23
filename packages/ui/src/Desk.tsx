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
import { desktop, setLaunchWorkspace, type OpenTarget } from './desktop.js'
import { confirmAction, promptText } from './dialog.js'
import { Glyph, type GlyphKind } from './glyphs.js'
import { ShellIcon } from './icons.js'
import { Tip } from './tip.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'
import { focusTerminal, TerminalView } from './Terminal.js'
import { onWorkspaceDoc } from './useSnapshot.js'

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
  /** Open in its own window (030 phase 4): the tile shows a placeholder
   * here and the zone window owns the terminals. */
  popped?: boolean | undefined
}

interface WorkspaceEntry {
  id: string
  name: string
  /** What you are doing here, in your words (the title bar shows it). */
  intent?: string
  /** Open in its own window: the main window shows a placeholder. */
  popped?: boolean
  scope?: { projectId: string }
  windows: Array<{ layout?: unknown; zones?: Record<string, ZoneMeta> }>
  defer?: Record<string, DeferState>
}

interface WorkspaceDoc {
  v: 1 | 2
  active?: string
  workspaces: WorkspaceEntry[]
}

/** The ptys a saved layout references — its panels' params. */
function ptyIdsOfLayout(layout: unknown): string[] {
  const panels = (layout as { panels?: Record<string, { params?: { ptyId?: unknown } }> } | undefined)
    ?.panels
  if (panels === undefined || typeof panels !== 'object') return []
  return Object.values(panels)
    .map((p) => p?.params?.ptyId)
    .filter((id): id is string => typeof id === 'string')
}

/** Every pty referenced by any workspace OTHER than `except`. A live pty
 * in that set belongs to a workspace that is not showing; it must not be
 * adopted into the one that is. */
function ptyIdsElsewhere(doc: WorkspaceDoc, except: string | undefined): Set<string> {
  const ids = new Set<string>()
  for (const w of doc.workspaces) {
    if (w.id === except) continue
    for (const id of ptyIdsOfLayout(w.windows[0]?.layout)) ids.add(id)
  }
  return ids
}

const randomId = (): string => Math.random().toString(36).slice(2, 8)

/** PTYs alive in the main process right now, from the bridge's list and
 * its opened/closed events — so a workspace that is not showing can still
 * say which of its tiles has a running terminal. */
const livePtys = new Set<string>()

/** A saved layout's tiles as desk entries: what the all-turns view reads
 * for workspaces that are not showing. No zone (the grid would have to
 * be walked); a pty only when it is known alive. */
function entriesOfLayout(layout: unknown): DeskEntry[] {
  const panels = (
    layout as { panels?: Record<string, { id?: string; title?: string; params?: SlotParams }> } | undefined
  )?.panels
  if (panels === undefined || typeof panels !== 'object') return []
  return Object.entries(panels).map(([id, p]) => {
    const params = p?.params ?? {}
    const target = params.target
    return {
      panelId: p?.id ?? id,
      title: p?.title ?? id,
      ...(target?.sessionId !== undefined && (target.kind === 'resume' || target.kind === 'new')
        ? { sessionId: target.sessionId }
        : {}),
      ...(target?.kind === 'teleport' && target.sessionId !== undefined
        ? { cloudId: target.sessionId }
        : {}),
      ...(params.ptyId !== undefined && livePtys.has(params.ptyId) ? { ptyId: params.ptyId } : {}),
    }
  })
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

export const deskState: {
  entries: DeskEntry[]
  defer: Record<string, DeferState>
  /** Every workspace, for the title bar; `active` is the one showing. */
  workspaces: Array<{
    id: string
    name: string
    intent?: string
    popped?: boolean
    scope?: { projectId: string }
  }>
  active: string | undefined
  /** The tile that owns the keyboard (dockview's active panel) — the
   * status bar describes it. */
  focusPanelId: string | undefined
  /** Zone names in layout order, for menus that offer "open in…". */
  zoneList: Array<{ id: string; name: string | undefined; def: boolean; popped: boolean }>
  /** Terminals a workspace holds — live ones for the active, saved ones
   * for the rest — so "close workspace" can say what it costs. */
  terminalCountOf: (id: string) => number
  /** A workspace's tiles and skips: live for the active one, from the
   * saved document for the rest (the all-turns view). */
  entriesOf: (id: string) => DeskEntry[]
  deferOf: (id: string) => Record<string, DeferState>
} = {
  entries: [],
  defer: {},
  workspaces: [],
  active: undefined,
  focusPanelId: undefined,
  zoneList: [],
  terminalCountOf: () => 0,
  entriesOf: () => [],
  deferOf: () => ({}),
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
  /** Workspaces (docs/brainstorm/027). Switching detaches the leaving
   * workspace's terminals — they keep running — and re-attaches the
   * target's. Closing is the one place terminals end. */
  switchWorkspace: (id: string) => Promise<void>
  newWorkspace: (name: string) => Promise<void>
  renameWorkspace: (id: string, name: string) => void
  closeWorkspace: (id: string) => Promise<void>
  /** A skip/snooze in a workspace that may not be showing. */
  setDeferIn: (workspaceId: string, sessionId: string, state: DeferState | undefined) => void
  scopeWorkspace: (id: string, projectId: string | undefined) => void
  setIntent: (id: string, intent: string | undefined) => void
  /** The next terminal to open lands in this zone (a zone's "+"). */
  openInZone: (groupId: string | undefined) => void
  renameZone: (groupId: string) => void
  setDefaultZone: (groupId: string) => void
  closeZoneTabs: (groupId: string) => void
  /** Pop-outs (030 phase 4): a zone of the active workspace, or a whole
   * workspace, in its own window; the same verb brings it back. */
  togglePoppedZone: (groupId: string) => void
  popOutWorkspace: (id: string) => void
  popInWorkspace: (id: string) => void
}

let deskOps: DeskOps | undefined
export const getDeskOps = (): DeskOps | undefined => deskOps

/** The tile holding a session (local id or cloud id), in whichever
 * workspace: the active one's live entries first, then the saved ones. */
export function tileOf(
  id: string,
): { workspace: { id: string; name: string }; entry: DeskEntry; active: boolean } | undefined {
  const order = [...deskState.workspaces].sort(
    (a, b) => Number(b.id === deskState.active) - Number(a.id === deskState.active),
  )
  for (const w of order) {
    const active = w.id === deskState.active
    const entry = (active ? deskState.entries : deskState.entriesOf(w.id)).find(
      (e) => e.sessionId === id || e.cloudId === id,
    )
    if (entry !== undefined) return { workspace: { id: w.id, name: w.name }, entry, active }
  }
  return undefined
}

// Debug handles: the desk's store and verbs, reachable from the devtools
// console (and the e2e harness) without going through the UI.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __deskState: typeof deskState }).__deskState = deskState
}

const deskListeners = new Set<() => void>()
export function subscribeDesk(fn: () => void): () => void {
  deskListeners.add(fn)
  return () => deskListeners.delete(fn)
}

/** A terminal the user just launched got its tile: the app lands on it
 * (closing whatever it was launched from). `panelId` is undefined when
 * the tile went to this workspace's own window instead of here — the
 * launch still closes what it came from. Not fired for tiles adopted at
 * boot or restored in place. */
const tileListeners = new Set<(panelId: string | undefined) => void>()
export function onTileOpened(fn: (panelId: string | undefined) => void): () => void {
  tileListeners.add(fn)
  return () => tileListeners.delete(fn)
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
/** A workspace switch removes every panel to show another set. Those
 * removals are not the user closing tiles: their PTYs must live on,
 * detached, until their workspace shows again (or is closed). */
let switching = false
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
/** Waiting signatures (what each session is asking) — a skip from a tab
 * snapshots this, exactly like a skip from a row does. */
export const deskTurnSigs: Record<string, string> = {}
export function setDeskSessions(
  states: Record<string, 'working' | 'waiting' | 'idle'>,
  titles: Record<string, string>,
  sigs: Record<string, string> = {},
): void {
  const changed =
    Object.keys(states).length !== Object.keys(deskTurnStates).length ||
    Object.entries(states).some(([id, state]) => deskTurnStates[id] !== state) ||
    Object.keys(titles).length !== Object.keys(deskSessionTitles).length ||
    Object.entries(titles).some(([id, title]) => deskSessionTitles[id] !== title) ||
    Object.entries(sigs).some(([id, sig]) => deskTurnSigs[id] !== sig)
  if (!changed) return
  for (const id of Object.keys(deskTurnStates)) delete deskTurnStates[id]
  Object.assign(deskTurnStates, states)
  for (const id of Object.keys(deskSessionTitles)) delete deskSessionTitles[id]
  Object.assign(deskSessionTitles, titles)
  for (const id of Object.keys(deskTurnSigs)) delete deskTurnSigs[id]
  Object.assign(deskTurnSigs, sigs)
  notifyDesk()
}

function refreshEntries(api: DockviewApi): void {
  deskState.focusPanelId = api.activePanel?.id
  deskState.zoneList = api.groups.map((g) => ({
    id: g.id,
    name: zoneMetas[g.id]?.name,
    def: zoneMetas[g.id]?.def === true,
    popped: zoneMetas[g.id]?.popped === true,
  }))
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
  closeZoneTabs: (groupId: string) => void
  togglePoppedZone: (groupId: string) => void
  resumePanel: (panelId: string) => void
  busy: ReadonlySet<string>
  inspect?: ((sessionId: string) => void) | undefined
  /** The active workspace's project scope, when it has one (027). */
  scopeName?: string | undefined
  /** Start a session that lands in this zone (the header's "+"). */
  newSessionIn?: ((groupId: string) => void) | undefined
}

const DeskContext = createContext<DeskContextValue>({
  zones: {},
  renameZone: () => {},
  toggleDefault: () => {},
  closeZoneTabs: () => {},
  togglePoppedZone: () => {},
  resumePanel: () => {},
  busy: new Set(),
})

/** One tile: a live terminal, or the slot's resume affordance. */
function TerminalPanel(props: IDockviewPanelProps<SlotParams>) {
  const { resumePanel, busy, zones, togglePoppedZone } = useContext(DeskContext)
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
  // The zone lives in its own window: its terminals render there, and a
  // second attachment here would fight it over the PTY's size.
  if (zones[props.api.group.id]?.popped === true) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-app text-[11px] text-t5">
        <span className="text-[20px] text-rev">⧉</span>
        <span>open in its own window</span>
        <button
          onClick={() => togglePoppedZone(props.api.group.id)}
          className="rounded border border-b4 px-2.5 py-[3px] text-[10.5px] text-t3 hover:text-fg"
        >
          bring it back
        </button>
      </div>
    )
  }
  if (status === 'checking') return <div className="h-full w-full bg-app" />
  if (status === 'live' && ptyId !== undefined) {
    return (
      <div className="h-full w-full bg-app">
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

/** Zone chrome on the group header (the v3 mock): the zone's NAME as a
 * label, its verbs behind a right-click. */
function ZoneHeader(props: IDockviewHeaderActionsProps) {
  const { zones, renameZone, toggleDefault, closeZoneTabs, newSessionIn, togglePoppedZone } =
    useContext(DeskContext)
  const { menu, openMenu, closeMenu } = useContextMenu()
  const meta = zones[props.group.id]
  const name = meta?.name
  const items: MenuItem[] = [
    { label: name ?? 'zone', heading: true },
    ...(newSessionIn !== undefined
      ? [{ label: 'new session here…', onClick: () => newSessionIn(props.group.id) }]
      : []),
    { label: name === undefined ? 'name this zone…' : 'rename zone…', onClick: () => renameZone(props.group.id) },
    {
      label: meta?.def === true ? 'new terminals land here — unset' : 'new terminals land here',
      onClick: () => toggleDefault(props.group.id),
    },
    ...(desktop?.popOutZone !== undefined
      ? [
          {
            label:
              meta?.popped === true
                ? `bring ${name ?? 'the zone'} back`
                : `pop ${name ?? 'the zone'} out to its own window`,
            onClick: () => togglePoppedZone(props.group.id),
          },
        ]
      : []),
    ...(props.panels.length > 0
      ? [{ label: 'close every tab', onClick: () => closeZoneTabs(props.group.id), danger: true }]
      : []),
  ]
  return (
    <div
      onContextMenu={(e) => openMenu(e, items)}
      onDoubleClick={() => renameZone(props.group.id)}
      title={meta?.def === true ? 'new terminals open here' : undefined}
      className={`flex h-full select-none items-center whitespace-nowrap border-r border-b1 px-2.5 font-ui text-[9.5px] font-bold tracking-[.1em] uppercase ${
        name !== undefined ? 'text-t4' : 'text-t6'
      }`}
    >
      {name ?? 'zone'}
      {meta?.def === true && <span className="ml-1.5 font-mono text-[8px] text-t6">◎</span>}
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </div>
  )
}

/** Right chrome: the "+" that starts a session in this zone. */
function GroupActions(props: IDockviewHeaderActionsProps) {
  const { newSessionIn } = useContext(DeskContext)
  if (desktop === undefined || newSessionIn === undefined) return null
  return (
    <div className="flex h-full items-center">
      <button
        onClick={() => newSessionIn(props.group.id)}
        title="new session here"
        className="px-2.5 font-mono text-[12px] text-t5 hover:text-fg"
      >
        +
      </button>
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
  const kind = props.params.target?.kind
  // The glyph means ONE thing: whose turn it is (▲ yours, ● its, ○ idle);
  // shells are ❯ and teleported cloud sessions the cloud. Which tab is
  // visible/focused is said by the tab's background instead, so the two
  // signals never fight over the same pixel.
  const glyph: GlyphKind =
    kind === 'shell'
      ? 'shell'
      : kind === 'teleport'
        ? 'cloud'
        : turn === 'waiting'
          ? 'ask'
          : turn === 'working'
            ? 'run'
            : dead
              ? 'dead'
              : 'idle'
  const env = props.params.env
  // Windows shells differ in kind (WSL, PowerShell, cmd); the mark shows
  // only when that distinction exists — never on a plain shell.
  const shellMark = env !== undefined && (env.startsWith('wsl') || env === 'powershell' || env === 'cmd')
  const { inspect } = useContext(DeskContext)

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
                ...(kind !== 'shell' && kind !== 'teleport'
                  ? [
                      {
                        label: 'detach (keep running)',
                        onClick: () => desktop!.write(props.params.ptyId!, '/bg\r'),
                      },
                    ]
                  : []),
              ]
            : []),
          ...(sessionId !== undefined && turn === 'waiting' && deskOps !== undefined
            ? deskState.defer[sessionId] !== undefined
              ? [{ label: 'unskip', onClick: () => deskOps?.setDefer(sessionId, undefined) }]
              : [
                  {
                    label: 'skip',
                    onClick: () => deskOps?.setDefer(sessionId, { sig: deskTurnSigs[sessionId] ?? '' }),
                  },
                  {
                    label: 'skip with a note…',
                    onClick: () =>
                      void promptText('skip with a note', { okLabel: 'skip' }).then((note) => {
                        if (note === undefined) return
                        deskOps?.setDefer(sessionId, {
                          sig: deskTurnSigs[sessionId] ?? '',
                          ...(note.trim() !== '' ? { note: note.trim() } : {}),
                        })
                      }),
                  },
                ]
            : []),
          ...(sessionId !== undefined && inspect !== undefined
            ? [{ label: 'session detail', onClick: () => inspect(sessionId) }]
            : []),
          { label: 'close tab', onClick: () => props.api.close(), danger: true },
        ])
      }
      // middle-click closes, the one mouse convention every tab strip has
      onAuxClick={(e) => {
        if (e.button === 1) props.api.close()
      }}
      className={`group flex h-full items-center gap-1.5 border-r border-b1 px-2.5 ${
        active ? 'bg-app text-fg' : 'text-t3 hover:text-fg'
      } ${active && focused ? 'shadow-[inset_0_2px_0_0_var(--h-ac)]' : ''}`}
    >
      <Glyph kind={glyph} size={9} />
      {shellMark && (
        <Tip text={shellLabel(env)} className="flex items-center text-t6">
          <ShellIcon env={env} size={10} />
        </Tip>
      )}
      <span className="max-w-[180px] truncate font-ui text-[11px]">{title}</span>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </div>
  )
}

function Watermark(_props: IWatermarkPanelProps) {
  const { scopeName, newSessionIn } = useContext(DeskContext)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-app font-mono text-[11px] text-t6">
      <span>no tabs — drag a session here, or</span>
      {newSessionIn !== undefined && (
        <button
          onClick={() => newSessionIn('')}
          className="rounded border border-ac/55 px-3.5 py-1.5 font-ui text-[11.5px] font-semibold text-ach hover:bg-ac/10"
        >
          {scopeName !== undefined ? `new session in ${scopeName}` : 'new session…'}
        </button>
      )}
    </div>
  )
}

const panelComponents = { terminal: TerminalPanel }

export function Desk({
  inspect,
  scopeName,
  newSessionIn,
  lockedWorkspace,
}: {
  inspect?: (sessionId: string) => void
  scopeName?: string | undefined
  /** Start a session landing in a zone ('' = the default zone). */
  newSessionIn?: ((groupId: string) => void) | undefined
  /** A popped-out workspace's window: this desk shows that workspace
   * and nothing else, never switches, and never reopens pop-outs. */
  lockedWorkspace?: string | undefined
}) {
  const locked = lockedWorkspace
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

  // The whole document, held here; save() writes the ACTIVE workspace's
  // layout/zones/defer into it and posts it. Inactive workspaces ride
  // along untouched.
  const docRef = useRef<WorkspaceDoc>({ v: 2, workspaces: [] })
  const activeRef = useRef<string | undefined>(undefined)

  /** Is the active workspace's layout mounted in THIS dockview? Not when
   * it is popped out to its own window (the main window shows a
   * placeholder and reads the layout from the document instead). */
  const mountedActive = useCallback((): boolean => {
    const id = activeRef.current
    if (id === undefined) return false
    if (locked !== undefined) return true
    return docRef.current.workspaces.find((w) => w.id === id)?.popped !== true
  }, [locked])

  const publishWorkspaces = useCallback(() => {
    deskState.workspaces = docRef.current.workspaces
      .filter((w) => locked === undefined || w.id === locked)
      .map((w) => ({
        id: w.id,
        name: w.name,
        ...(w.intent !== undefined ? { intent: w.intent } : {}),
        ...(w.popped === true ? { popped: true } : {}),
        ...(w.scope !== undefined ? { scope: w.scope } : {}),
      }))
    deskState.active = activeRef.current
    deskState.terminalCountOf = (id) => {
      const api = apiRef.current
      if (id === activeRef.current && api !== null && mountedActive()) {
        return api.panels.filter((p) => paramsOf(p).ptyId !== undefined).length
      }
      const w = docRef.current.workspaces.find((x) => x.id === id)
      return ptyIdsOfLayout(w?.windows[0]?.layout).length
    }
    deskState.entriesOf = (id) => {
      if (id === activeRef.current && mountedActive()) return deskState.entries
      const w = docRef.current.workspaces.find((x) => x.id === id)
      return entriesOfLayout(w?.windows[0]?.layout)
    }
    deskState.deferOf = (id) => {
      if (id === activeRef.current) return deskState.defer
      return docRef.current.workspaces.find((x) => x.id === id)?.defer ?? {}
    }
    notifyDesk()
  }, [locked, mountedActive])

  /** One workspace (or the active marker, or a removal) to the server —
   * never the whole document, so two windows editing two workspaces
   * cannot overwrite each other (030 phase 4). */
  const postDoc = useCallback(
    (patch: { workspace?: WorkspaceEntry; active?: string; remove?: string }): void => {
      void fetch('/api/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 2, ...patch }),
      }).catch(() => {})
    },
    [],
  )

  /** The active workspace as it stands in this dockview: its layout,
   * the zone metas of groups that still exist, its skips. */
  const captureActive = useCallback((): WorkspaceEntry | undefined => {
    const api = apiRef.current
    const activeId = activeRef.current
    const current = docRef.current.workspaces.find((w) => w.id === activeId)
    if (api === null || current === undefined) return undefined
    const live = new Set(api.groups.map((g) => g.id))
    const zoneOut: Record<string, ZoneMeta> = {}
    for (const [id, meta] of Object.entries(zonesRef.current)) {
      if (live.has(id)) zoneOut[id] = meta
    }
    return { ...current, windows: [{ layout: api.toJSON(), zones: zoneOut }], defer: deferRef.current }
  }, [])

  const writeDoc = useCallback((): void => {
    const api = apiRef.current
    if (api === null || unloading || switching) return
    const activeId = activeRef.current
    if (activeId === undefined) return
    // A popped-out active workspace is empty HERE — its window owns the
    // layout; only the active marker is ours to write.
    if (!mountedActive()) {
      docRef.current = { ...docRef.current, active: activeId }
      if (locked === undefined) postDoc({ active: activeId })
      return
    }
    const updated = captureActive()
    if (updated === undefined) return
    docRef.current = {
      ...docRef.current,
      ...(locked === undefined ? { active: activeId } : {}),
      workspaces: docRef.current.workspaces.map((w) => (w.id === activeId ? updated : w)),
    }
    postDoc({ workspace: updated, ...(locked === undefined ? { active: activeId } : {}) })
  }, [locked, mountedActive, postDoc, captureActive])

  const save = useCallback(() => {
    if (unloading || switching) return
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(writeDoc, 500)
  }, [writeDoc])

  /** Write now — the leaving workspace must be on disk before a switch. */
  const flushSave = useCallback(() => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = undefined
    }
    writeDoc()
  }, [writeDoc])

  /** Persist one workspace's non-layout edit (name, intent, scope, a
   * skip elsewhere): the active one rides the next save, any other goes
   * straight to the server. */
  const commit = useCallback(
    (id: string): void => {
      if (id === activeRef.current) {
        save()
        return
      }
      const ws = docRef.current.workspaces.find((w) => w.id === id)
      if (ws !== undefined) postDoc({ workspace: ws })
    },
    [save, postDoc],
  )

  const renameZone = useCallback(
    (groupId: string) => {
      const current = zonesRef.current[groupId]?.name ?? ''
      void promptText('zone name', {
        initial: current,
        placeholder: 'Active, PR reviews, Misc…',
        okLabel: 'rename',
      }).then((name) => {
        if (name === undefined) return
        setZones((z) => ({
          ...z,
          [groupId]: { ...z[groupId], name: name.trim() || undefined },
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

  /** Show one workspace in the (empty) dockview: its layout, zones and
   * skips; stale ptys marked dead; the tab list published. */
  const showWorkspace = useCallback(
    (api: DockviewApi, id: string, live: Array<{ id: string }>) => {
      const ws = docRef.current.workspaces.find((w) => w.id === id)
      if (ws === undefined) return
      activeRef.current = id
      setLaunchWorkspace(id)
      const window0 = ws.windows[0]
      // a workspace popped out to its own window stays empty here
      const mount = locked !== undefined || ws.popped !== true
      if (mount && window0?.layout !== undefined && api.panels.length === 0) {
        try {
          api.fromJSON(window0.layout as SerializedDockview)
        } catch {
          // a corrupt layout starts empty instead of crashing the desk
        }
      }
      const zones = window0?.zones ?? {}
      zonesRef.current = zones
      setZones(zones)
      deferRef.current = ws.defer ?? {}
      deskState.defer = deferRef.current
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
      setRestore(dead > 0 ? { dead, zones: deadGroups.size } : undefined)
      publishWorkspaces()
      refreshEntries(api)
    },
    [publishWorkspaces, locked],
  )

  const switchWorkspace = useCallback(
    async (id: string): Promise<void> => {
      const api = apiRef.current
      if (api === null || id === activeRef.current || locked !== undefined) return
      if (!docRef.current.workspaces.some((w) => w.id === id)) return
      flushSave()
      switching = true
      try {
        // every tile detaches (its terminal keeps running, unsubscribed);
        // the remove handler sees `switching` and closes nothing
        api.clear()
        const live = await (desktop?.list() ?? Promise.resolve([]))
        showWorkspace(api, id, live)
      } finally {
        switching = false
      }
      save()
    },
    [flushSave, showWorkspace, save, locked],
  )

  const newWorkspace = useCallback(
    async (name: string): Promise<void> => {
      let id = randomId()
      while (docRef.current.workspaces.some((w) => w.id === id)) id = randomId()
      docRef.current = {
        ...docRef.current,
        workspaces: [...docRef.current.workspaces, { id, name, windows: [] }],
      }
      publishWorkspaces()
      await switchWorkspace(id)
    },
    [publishWorkspaces, switchWorkspace],
  )

  const renameWorkspace = useCallback(
    (id: string, name: string): void => {
      docRef.current = {
        ...docRef.current,
        workspaces: docRef.current.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      }
      publishWorkspaces()
      commit(id)
    },
    [publishWorkspaces, commit],
  )

  const closeWorkspace = useCallback(
    async (id: string): Promise<void> => {
      const api = apiRef.current
      const bridge = desktop
      const ws = docRef.current.workspaces.find((w) => w.id === id)
      if (api === null || bridge === undefined || ws === undefined) return
      const ptys =
        id === activeRef.current
          ? api.panels.map((p) => paramsOf(p).ptyId).filter((x): x is string => x !== undefined)
          : ptyIdsOfLayout(ws.windows[0]?.layout)
      if (id === activeRef.current) {
        // leave first — to a neighbour, or a fresh "main" when this was the last
        let next = docRef.current.workspaces.find((w) => w.id !== id)?.id
        if (next === undefined) {
          next = id === 'main' ? randomId() : 'main'
          docRef.current = {
            ...docRef.current,
            workspaces: [...docRef.current.workspaces, { id: next, name: 'main', windows: [] }],
          }
        }
        await switchWorkspace(next)
      }
      for (const pty of ptys) void bridge.close(pty)
      docRef.current = {
        ...docRef.current,
        workspaces: docRef.current.workspaces.filter((w) => w.id !== id),
      }
      publishWorkspaces()
      postDoc({ remove: id, ...(activeRef.current !== undefined ? { active: activeRef.current } : {}) })
    },
    [publishWorkspaces, postDoc, switchWorkspace],
  )

  const setDeferIn = useCallback(
    (workspaceId: string, sessionId: string, state: DeferState | undefined): void => {
      if (workspaceId === activeRef.current) {
        if (state === undefined) delete deskState.defer[sessionId]
        else deskState.defer[sessionId] = state
        save()
        notifyDesk()
        return
      }
      docRef.current = {
        ...docRef.current,
        workspaces: docRef.current.workspaces.map((w) => {
          if (w.id !== workspaceId) return w
          const defer = { ...(w.defer ?? {}) }
          if (state === undefined) delete defer[sessionId]
          else defer[sessionId] = state
          return { ...w, defer }
        }),
      }
      publishWorkspaces()
      commit(workspaceId)
    },
    [publishWorkspaces, commit],
  )

  const setIntent = useCallback(
    (id: string, intent: string | undefined): void => {
      docRef.current = {
        ...docRef.current,
        workspaces: docRef.current.workspaces.map((w) => {
          if (w.id !== id) return w
          const { intent: _drop, ...rest } = w
          const text = intent?.trim() ?? ''
          return text !== '' ? { ...rest, intent: text } : rest
        }),
      }
      publishWorkspaces()
      commit(id)
    },
    [publishWorkspaces, commit],
  )

  const closeZoneTabs = useCallback((groupId: string): void => {
    const api = apiRef.current
    const group = api?.groups.find((g) => g.id === groupId)
    if (api === null || api === undefined || group === undefined) return
    const n = group.panels.length
    void confirmAction(`Close every tab in ${zonesRef.current[groupId]?.name ?? 'this zone'}?`, {
      detail: `${n} terminal${n === 1 ? '' : 's'} will end`,
      okLabel: 'close',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      for (const panel of [...group.panels]) api.removePanel(panel)
    })
  }, [])

  const scopeWorkspace = useCallback(
    (id: string, projectId: string | undefined): void => {
      docRef.current = {
        ...docRef.current,
        workspaces: docRef.current.workspaces.map((w) => {
          if (w.id !== id) return w
          const { scope: _drop, ...rest } = w
          return projectId !== undefined ? { ...rest, scope: { projectId } } : rest
        }),
      }
      publishWorkspaces()
      commit(id)
    },
    [publishWorkspaces, commit],
  )

  /** A zone of the active workspace, out to its own window or back. */
  const togglePoppedZone = useCallback(
    (groupId: string): void => {
      const bridge = desktop
      const wsId = activeRef.current
      if (bridge?.popOutZone === undefined || wsId === undefined) return
      const on = zonesRef.current[groupId]?.popped === true
      setZones((z) => ({ ...z, [groupId]: { ...z[groupId], popped: on ? undefined : true } }))
      save()
      if (on) bridge.popInZone?.(wsId, groupId)
      else {
        const name = zonesRef.current[groupId]?.name ?? 'zone'
        const wsName = docRef.current.workspaces.find((w) => w.id === wsId)?.name ?? ''
        void bridge.popOutZone(wsId, groupId, `${name} · ${wsName} — hodor`)
      }
    },
    [save],
  )

  /** A whole workspace out to its own window: its layout is saved here
   * first, its tiles unmount (the PTYs live on), and the new window
   * mounts it from the document. */
  const popOutWorkspace = useCallback(
    (id: string): void => {
      const api = apiRef.current
      const bridge = desktop
      if (api === null || bridge?.popOutWorkspace === undefined || locked !== undefined) return
      const isActive = id === activeRef.current
      // one write: the layout as it stands plus the flag — a separate
      // flush would echo back over SSE without the flag and race it
      const base = (isActive ? captureActive() : undefined) ?? docRef.current.workspaces.find((w) => w.id === id)
      if (base === undefined) return
      const ws: WorkspaceEntry = { ...base, popped: true }
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = undefined
      }
      docRef.current = {
        ...docRef.current,
        workspaces: docRef.current.workspaces.map((w) => (w.id === id ? ws : w)),
      }
      postDoc({ workspace: ws, ...(activeRef.current !== undefined ? { active: activeRef.current } : {}) })
      if (isActive) {
        switching = true
        try {
          api.clear()
        } finally {
          switching = false
        }
        void (bridge.list() as Promise<Array<{ id: string }>>).then((live) => showWorkspace(api, id, live))
      } else publishWorkspaces()
      void bridge.popOutWorkspace(id, ws.name)
    },
    [captureActive, postDoc, publishWorkspaces, showWorkspace, locked],
  )

  /** Back into the main window: closing its window is the whole verb —
   * the 'closed' event below re-mounts it. In that window itself this
   * closes the window you are in. */
  const popInWorkspace = useCallback((id: string): void => {
    desktop?.popInWorkspace?.(id)
  }, [])

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
      switchWorkspace,
      newWorkspace,
      renameWorkspace,
      closeWorkspace,
      setDeferIn,
      scopeWorkspace,
      setIntent,
      openInZone: (groupId) => {
        pendingOpen.groupId = groupId
      },
      renameZone,
      setDefaultZone: toggleDefault,
      closeZoneTabs,
      togglePoppedZone,
      popOutWorkspace,
      popInWorkspace,
    }
    ;(window as unknown as { __deskOps: DeskOps | undefined }).__deskOps = deskOps
    return () => {
      deskOps = undefined
      ;(window as unknown as { __deskOps: DeskOps | undefined }).__deskOps = undefined
    }
  }, [
    resumePanel,
    save,
    switchWorkspace,
    newWorkspace,
    renameWorkspace,
    closeWorkspace,
    setDeferIn,
    scopeWorkspace,
    setIntent,
    renameZone,
    toggleDefault,
    closeZoneTabs,
    togglePoppedZone,
    popOutWorkspace,
    popInWorkspace,
  ])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      api.onDidRemovePanel((panel) => {
        if (unloading) return
        const ptyId = paramsOf(panel).ptyId
        if (
          ptyId !== undefined &&
          desktop !== undefined &&
          !switching &&
          !movingOut.current.delete(ptyId)
        ) {
          void desktop.close(ptyId)
        }
        refreshEntries(api)
      })
      api.onDidAddPanel(() => refreshEntries(api))
      api.onDidLayoutChange(() => {
        save()
        refreshEntries(api)
      })
      // The focused tile drives the status bar's "where am I" segments.
      api.onDidActivePanelChange(() => {
        deskState.focusPanelId = api.activePanel?.id
        notifyDesk()
      })
      api.onDidActiveGroupChange(() => {
        deskState.focusPanelId = api.activePanel?.id
        notifyDesk()
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
          const base: WorkspaceDoc =
            doc !== undefined && doc.workspaces.length > 0
              ? doc
              : { v: 2, workspaces: [{ id: 'main', name: 'main', windows: [] }] }
          docRef.current = base
          const activeId =
            locked !== undefined && base.workspaces.some((w) => w.id === locked)
              ? locked
              : base.active !== undefined && base.workspaces.some((w) => w.id === base.active)
                ? base.active
                : base.workspaces[0]!.id
          showWorkspace(api, activeId, live)
          // The main window brings every pop-out back up: the windows the
          // document says are open (they died with the last run).
          if (locked === undefined && desktop !== undefined) {
            for (const w of base.workspaces) {
              if (w.popped === true) void desktop.popOutWorkspace?.(w.id, w.name)
              for (const [gid, meta] of Object.entries(w.windows[0]?.zones ?? {})) {
                if (meta.popped === true) {
                  void desktop.popOutZone?.(w.id, gid, `${meta.name ?? 'zone'} · ${w.name} — hodor`)
                }
              }
            }
          }
        },
      )
        .catch(() => {})
        .finally(() => restoreLatch.current?.done())
    },
    [save, showWorkspace, locked],
  )

  // Pop-out windows report back: a closed zone window brings its zone
  // back; a closed workspace window brings the workspace back (its last
  // layout read fresh from the document); a zone window's resume request
  // is answered by the desk that holds the workspace.
  useEffect(() => {
    const bridge = desktop
    if (bridge === undefined) return
    const offZone = bridge.onZoneEvent?.((e) => {
      if (e.type === 'closed') {
        if (e.wsId === activeRef.current) {
          if (zonesRef.current[e.groupId]?.popped !== true) return
          setZones((z) => ({ ...z, [e.groupId]: { ...z[e.groupId], popped: undefined } }))
          save()
        } else if (locked === undefined) {
          const ws = docRef.current.workspaces.find((w) => w.id === e.wsId)
          const zones = ws?.windows[0]?.zones
          if (ws === undefined || zones?.[e.groupId]?.popped !== true) return
          const next: WorkspaceEntry = {
            ...ws,
            windows: [{ ...ws.windows[0], zones: { ...zones, [e.groupId]: { ...zones[e.groupId], popped: undefined } } }],
          }
          docRef.current = {
            ...docRef.current,
            workspaces: docRef.current.workspaces.map((w) => (w.id === e.wsId ? next : w)),
          }
          postDoc({ workspace: next })
        }
      } else if (e.type === 'resume' && e.panelId !== undefined) {
        if (e.wsId === activeRef.current && mountedActive()) void resumePanel(e.panelId)
      }
    })
    const offWs = bridge.onWorkspaceEvent?.((e) => {
      if (e.type !== 'closed' || locked !== undefined) return
      void Promise.all([fetchWorkspace(), bridge.list()]).then(([doc, live]) => {
        const fresh = doc?.workspaces.find((w) => w.id === e.wsId)
        const ws = fresh ?? docRef.current.workspaces.find((w) => w.id === e.wsId)
        if (ws === undefined || ws.popped !== true) return
        const { popped: _was, ...next } = ws
        docRef.current = {
          ...docRef.current,
          workspaces: docRef.current.workspaces.map((w) => (w.id === e.wsId ? next : w)),
        }
        postDoc({ workspace: next })
        const api = apiRef.current
        if (api !== null && e.wsId === activeRef.current) showWorkspace(api, e.wsId, live)
        else publishWorkspaces()
      })
    })
    return () => {
      offZone?.()
      offWs?.()
    }
  }, [locked, save, postDoc, resumePanel, showWorkspace, publishWorkspaces, mountedActive])

  // Another window saved the document: take its word for every workspace
  // but the one mounted here, so badges and "where is it" stay honest.
  useEffect(
    () =>
      onWorkspaceDoc((raw) => {
        const doc = raw as WorkspaceDoc
        if (!Array.isArray(doc?.workspaces)) return
        // The workspace mounted here is ours to describe. A popped-out
        // active one is its window's — the server's copy wins for it —
        // except the popped flag itself, which only the 'closed' event
        // below may clear (a stale echo of our own save must not).
        const active = activeRef.current
        const mounted = mountedActive()
        const theirs = new Map(doc.workspaces.map((w) => [w.id, w]))
        docRef.current = {
          ...docRef.current,
          workspaces: [
            ...docRef.current.workspaces
              .filter((w) => w.id === active || theirs.has(w.id))
              .map((w) => {
                const server = theirs.get(w.id)
                if (w.id === active) {
                  return mounted ? w : { ...(server ?? w), popped: true }
                }
                return server ?? w
              }),
            ...doc.workspaces.filter((w) => !docRef.current.workspaces.some((x) => x.id === w.id)),
          ],
        }
        publishWorkspaces()
      }),
    [publishWorkspaces, mountedActive],
  )

  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop

    // Terminals opened before this view mounted (renderer reload) —
    // adopted only AFTER the saved layout restores (see restoreLatch).
    void (restoreLatch.current?.p ?? Promise.resolve())
      .then(() => bridge.list())
      .then((list) => {
        for (const t of list) livePtys.add(t.id)
        const api = apiRef.current
        if (api === null) return
        const elsewhere = ptyIdsElsewhere(docRef.current, activeRef.current)
        for (const t of list) {
          if (
            findPanelByPty(api, t.id) === undefined &&
            !elsewhere.has(t.id) &&
            forThisDesk(t.target)
          ) {
            addPtyPanel(api, t.id, t.title, t.target, t.env)
          }
        }
      })

    /** Does a terminal belong on THIS desk? One tagged for a workspace
     * goes to the window holding that workspace; an untagged one to
     * whichever desk is mounted (the main window, unless its workspace
     * is popped out). */
    function forThisDesk(target: OpenTarget | undefined): boolean {
      if (!mountedActive()) return false
      return target?.workspaceId === undefined || target.workspaceId === activeRef.current
    }

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
      if (event.type === 'opened') livePtys.add(event.id)
      else if (event.type === 'closed') livePtys.delete(event.id)
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
        if (
          findPanelByPty(api, event.id) === undefined &&
          !ptyIdsElsewhere(docRef.current, activeRef.current).has(event.id) &&
          forThisDesk(event.target)
        ) {
          addPtyPanel(api, event.id, event.title, event.target, event.env)
          // a fresh launch: take the user to it
          if (event.type === 'opened') for (const fn of tileListeners) fn(`pty-${event.id}`)
        } else if (
          event.type === 'opened' &&
          event.target?.workspaceId === activeRef.current &&
          !mountedActive()
        ) {
          // launched from here for a workspace living in its own window:
          // that window shows it; this one just closes what it came from
          for (const fn of tileListeners) fn(undefined)
        }
      } else if (event.type === 'popped' || event.type === 'closed') {
        const panel = findPanelByPty(api, event.id)
        if (panel !== undefined) {
          movingOut.current.add(event.id)
          api.removePanel(panel)
        }
      }
    })
  }, [save, mountedActive])

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
    <DeskContext.Provider
      value={{
        zones,
        renameZone,
        toggleDefault,
        closeZoneTabs,
        togglePoppedZone,
        resumePanel,
        busy,
        inspect,
        scopeName,
        newSessionIn,
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {restore !== undefined && (
          <div className="mx-1.5 mt-1.5 flex flex-none items-center gap-2.5 rounded border border-ac/50 bg-ac/8 px-3.5 py-2 text-[12.5px]">
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
        <div className="desk-grid min-h-0 flex-1">
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

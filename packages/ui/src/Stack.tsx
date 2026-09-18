import { useCallback, useEffect, useState } from 'react'
import type { CloudSession, Session, Snapshot } from '@hodor/core'
import { cloudNeedsYou } from './CloudSessions.js'
import {
  launchOrCopy,
  sendCloudMessage,
  sigOfCloud,
  sigOfSession,
  titleOf,
  type View,
} from './data.js'
import { desktop } from './desktop.js'
import { notice } from './dialog.js'
import { deskState, getDeskOps, isDeferred, subscribeDesk, type DeskEntry } from './Desk.js'
import { CloudIcon } from './icons.js'
import { TerminalView } from './Terminal.js'

/**
 * The Turn Stack (docs/brainstorm/023, settled): every session whose turn
 * is yours — local AND cloud — waiting-longest-first, one card at a time.
 * A local card IS the already-open terminal (the same PTY its desk tile
 * holds; views just attach), brought forward here and made the active tile
 * in its zone behind. A cloud card shows the session's ask with a reply
 * box — same triage verbs, no terminal to steal. Nothing resumes or spawns
 * on its own; a dead slot offers its resume button and waits for you.
 */

const PRESETS = ['go ahead', 'use your judgment', 'looks good — proceed']

const formatWait = (sinceIso: string | undefined, nowMs: number): string => {
  if (sinceIso === undefined) return ''
  const mins = Math.max(1, Math.round((nowMs - Date.parse(sinceIso)) / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

export type StackScope = 'workspace' | 'all'

/** Which workspace an item's tile lives in; `active` = the one showing. */
export interface ItemWorkspace {
  id: string
  name: string
  active: boolean
}

export type StackItem =
  | { kind: 'desk'; entry: DeskEntry; session: Session; workspace: ItemWorkspace }
  | { kind: 'cloud'; cloud: CloudSession; workspace: ItemWorkspace }

const itemId = (item: StackItem): string =>
  item.kind === 'desk' ? item.session.id : item.cloud.id

const itemSince = (item: StackItem): string =>
  item.kind === 'desk' ? (item.session.turn?.since ?? '') : (item.cloud.updatedAt ?? '')

/** Everything waiting on the human — desk terminals and cloud sessions in
 * ONE queue — deferred ones excluded (and expired deferrals cleaned). */
export function stackQueue(view: View, nowMs: number, scope: StackScope = 'workspace'): StackItem[] {
  const items: StackItem[] = []
  const seen = new Set<string>()
  const active = deskState.active
  // The workspaces to read: the active one alone, or every one — the
  // desk answers for the active from its live tiles and for the rest
  // from their saved layouts and skips (docs/brainstorm/027).
  const workspaces =
    scope === 'all'
      ? deskState.workspaces
      : deskState.workspaces.filter((w) => w.id === active)
  // Active first: a session open in two workspaces is attributed to the
  // one whose tile is mounted.
  const wsList: ItemWorkspace[] = (
    workspaces.length > 0
      ? workspaces.map((w) => ({ id: w.id, name: w.name, active: w.id === active }))
      : [{ id: active ?? 'main', name: 'main', active: true }]
  ).sort((a, b) => Number(b.active) - Number(a.active))
  for (const ws of wsList) {
    const entries = ws.active ? deskState.entries : deskState.entriesOf(ws.id)
    const defers = ws.active ? deskState.defer : deskState.deferOf(ws.id)
    for (const entry of entries) {
      if (entry.sessionId === undefined || seen.has(entry.sessionId)) continue
      const session = view.byId.get(entry.sessionId)
      if (session?.turn?.state !== 'waiting') continue
      if (defers[entry.sessionId] !== undefined) {
        // A skip is per workspace: skipped HERE hides it here only — the
        // same session open and unskipped in another workspace still
        // surfaces there. So it counts as seen only once it is queued.
        if (
          isDeferred(
            entry.sessionId,
            sigOfSession(session),
            session.lastActivityAt,
            nowMs,
            defers,
            session.pr?.fingerprint,
          )
        ) {
          continue
        }
        // lifted deferral: clean it up so the badge math stays honest
        getDeskOps()?.setDeferIn(ws.id, entry.sessionId, undefined)
      }
      seen.add(entry.sessionId)
      items.push({ kind: 'desk', entry, session, workspace: ws })
    }
    // Cloud sessions belong in the stack ONLY once they are part of a
    // workspace — i.e. you teleported one into a tile there. A cloud
    // session you have never opened is not something to triage in a queue
    // of open terminals; it lives in Home.
    const teleported = new Set(entries.map((e) => e.cloudId).filter((id): id is string => id !== undefined))
    for (const cloud of view.cloud) {
      if (!cloudNeedsYou(cloud) || seen.has(cloud.id)) continue
      if (!teleported.has(cloud.id)) continue
      if (defers[cloud.id] !== undefined) {
        if (isDeferred(cloud.id, sigOfCloud(cloud), cloud.updatedAt, nowMs, defers)) continue
        getDeskOps()?.setDeferIn(ws.id, cloud.id, undefined)
      }
      seen.add(cloud.id)
      items.push({ kind: 'cloud', cloud, workspace: ws })
    }
  }
  return items.sort((a, b) => itemSince(a).localeCompare(itemSince(b)))
}

export function Stack(props: {
  snapshot: Snapshot
  view: View
  nowMs: number
  scope: StackScope
  onScope: (scope: StackScope) => void
  onExit: () => void
  onInspect: (sessionId: string) => void
  onJumpDesk: () => void
}) {
  const { view, nowMs, scope, onScope, onExit, onInspect, onJumpDesk } = props
  const [, setTick] = useState(0)
  const [rot, setRot] = useState<string[]>([])
  const [pick, setPick] = useState<string | undefined>(undefined)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [snoozeNote, setSnoozeNote] = useState('')
  const [resuming, setResuming] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => subscribeDesk(() => setTick((t) => t + 1)), [])

  let queue = stackQueue(view, nowMs, scope)
  // later = rotate to the bottom; an explicit pick jumps the line
  queue = [
    ...queue.filter((q) => !rot.includes(itemId(q))),
    ...rot
      .map((id) => queue.find((q) => itemId(q) === id))
      .filter((q): q is StackItem => q !== undefined),
  ]
  if (pick !== undefined) {
    const picked = queue.find((q) => itemId(q) === pick)
    if (picked !== undefined) queue = [picked, ...queue.filter((q) => q !== picked)]
  }
  const top = queue[0]
  const topPanelId = top?.kind === 'desk' ? top.entry.panelId : undefined
  const topId = top !== undefined ? itemId(top) : undefined
  const topActive = top?.workspace.active ?? true

  // The desk mirrors the stack: a local top card's tile comes forward in
  // its zone, so leaving the stack lands on the session just dealt with.
  // (Only when its workspace is the one showing — the others' tiles are
  // not mounted; "tile" switches there on purpose.)
  useEffect(() => {
    setResuming(false)
    if (topPanelId !== undefined && topActive) getDeskOps()?.revealPanel(topPanelId)
  }, [topPanelId, topActive])

  /** Go to the top item's workspace (if not showing) and its tile. */
  const jumpToTop = useCallback(() => {
    if (top === undefined) return
    const go = top.workspace.active
      ? Promise.resolve()
      : (getDeskOps()?.switchWorkspace(top.workspace.id) ?? Promise.resolve())
    void go.then(() => {
      if (topPanelId !== undefined) getDeskOps()?.revealPanel(topPanelId)
      onJumpDesk()
    })
  }, [top, topPanelId, onJumpDesk])
  useEffect(() => {
    setReply('')
    setSnoozeOpen(false)
    setSnoozeNote('')
  }, [topId])

  const resumeTop = useCallback(() => {
    if (topPanelId === undefined) return
    setResuming(true)
    void getDeskOps()
      ?.resumePanel(topPanelId)
      .finally(() => setResuming(false))
  }, [topPanelId])

  const act = useCallback(
    (kind: 'later' | 'snz30' | 'snz2' | 'snzMove' | 'snzPr' | 'hold' | 'phone' | 'done' | 'kill') => {
      if (top === undefined) return
      const ops = getDeskOps()
      const id = itemId(top)
      const wsId = top.workspace.id
      const note = snoozeNote.trim() !== '' ? { note: snoozeNote.trim() } : {}
      const sig = top.kind === 'desk' ? sigOfSession(top.session) : sigOfCloud(top.cloud)
      setSnoozeOpen(false)
      setSnoozeNote('')
      setPick(undefined)
      switch (kind) {
        case 'later':
          setRot((r) => [...r.filter((x) => x !== id), id])
          break
        case 'snz30':
          ops?.setDeferIn(wsId, id, { until: new Date(nowMs + 30 * 60_000).toISOString(), ...note })
          break
        case 'snz2':
          ops?.setDeferIn(wsId, id, { until: new Date(nowMs + 2 * 3600_000).toISOString(), ...note })
          break
        case 'snzMove':
          ops?.setDeferIn(wsId, id, { sig, ...note })
          break
        case 'snzPr':
          if (top.kind === 'desk' && top.session.pr !== undefined) {
            const { number, fingerprint } = top.session.pr
            ops?.setDeferIn(wsId, id, { pr: { number, fingerprint }, ...note })
          }
          break
        case 'hold':
          ops?.setDeferIn(wsId, id, { hold: true, ...note })
          break
        case 'phone':
          if (top.kind === 'desk' && top.entry.ptyId !== undefined && desktop !== undefined) {
            desktop.write(top.entry.ptyId, '/remote-control\r')
            ops?.setDeferIn(wsId, id, { sig, phone: true, ...note })
          }
          break
        case 'done':
        case 'kill':
          if (top.kind === 'desk') {
            // its panel lives in its workspace's dockview — go there first
            const go = top.workspace.active
              ? Promise.resolve()
              : (ops?.switchWorkspace(wsId) ?? Promise.resolve())
            const panelId = top.entry.panelId
            void go.then(() => getDeskOps()?.closePanel(panelId))
          }
          break
      }
    },
    [top, nowMs, snoozeNote],
  )

  const sendReply = useCallback(() => {
    if (top?.kind !== 'cloud' || reply.trim() === '') return
    const text = reply.trim()
    const cloud = top.cloud
    setSending(true)
    void sendCloudMessage(cloud.id, text)
      .then((result) => {
        if (!result.ok) {
          void notice("couldn't send", result.error ?? result.output ?? 'unknown error')
          return
        }
        setReply('')
        // answered: quiet it until the session's ask actually changes
        getDeskOps()?.setDefer(cloud.id, { sig: sigOfCloud(cloud) })
      })
      .finally(() => setSending(false))
  }, [top, reply])

  const deferredN =
    scope === 'all'
      ? deskState.workspaces.reduce((n, w) => n + Object.keys(deskState.deferOf(w.id)).length, 0)
      : Object.keys(deskState.defer).length
  const wsChip = (ws: ItemWorkspace) =>
    !ws.active || scope === 'all' ? (
      <span
        className={`whitespace-nowrap rounded border px-2 font-mono text-[10px] ${
          ws.active ? 'border-b4 text-t4' : 'border-ac/50 text-ach'
        }`}
        title={ws.active ? 'this workspace' : 'another workspace — tile switches there'}
      >
        {ws.name}
      </span>
    ) : null
  const structured = top?.kind === 'desk' ? top.session.turn?.pending : undefined
  const projectName = (s: Session): string => {
    const claim = view.claimsBySession.get(s.id)?.[0]
    if (claim !== undefined) {
      const custom = props.snapshot.customProjects.find((p) => p.id === claim)
      if (custom !== undefined) return custom.name
    }
    return view.derivedOf.get(s.id)?.name ?? 'no project'
  }

  const snoozeMenu = (
    <span className="relative">
      <button
        onClick={() => setSnoozeOpen((o) => !o)}
        className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
      >
        snooze ▾
      </button>
      {snoozeOpen && (
        <span className="absolute bottom-full left-0 z-10 mb-1.5 flex w-56 flex-col gap-0.5 rounded border border-b5 bg-s5 p-1.5 shadow-xl">
          <input
            value={snoozeNote}
            onChange={(e) => setSnoozeNote(e.target.value)}
            placeholder="note to self (optional)"
            className="mb-1 rounded border border-b4 bg-app px-2 py-1 text-[11px] outline-none placeholder:text-t6 focus:border-b6"
          />
          {(
            [
              ['30 minutes', 'snz30'] as const,
              ['2 hours', 'snz2'] as const,
              ['until its ask changes', 'snzMove'] as const,
              ...(top?.kind === 'desk' && top.session.pr !== undefined
                ? [[`until PR #${top.session.pr.number} moves`, 'snzPr'] as const]
                : []),
              ['until I unskip it', 'hold'] as const,
            ]
          ).map(([label, kind]) => (
            <button
              key={kind}
              onClick={() => act(kind)}
              className="rounded px-2.5 py-1 text-left text-[11.5px] hover:bg-ac/12"
            >
              {label}
            </button>
          ))}
        </span>
      )}
    </span>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 px-6 pb-4 pt-3">
      <div className="flex shrink-0 items-center gap-2.5 text-[11px] text-t3">
        <span className="font-bold text-ask">▲ your turn</span>
        <span className="font-bold text-fg">
          {queue.length === 0 ? '0 waiting' : `1 of ${queue.length}`}
        </span>
        {deskState.workspaces.length > 1 && (
          <span className="flex items-center gap-0.5 rounded border border-b3 p-0.5">
            {(
              [
                ['workspace', deskState.workspaces.find((w) => w.id === deskState.active)?.name ?? 'this workspace'],
                ['all', 'all workspaces'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => onScope(value)}
                className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                  scope === value ? 'bg-s3 text-fg' : 'text-t5 hover:text-t2'
                }`}
              >
                {label}
              </button>
            ))}
          </span>
        )}
        <button
          onClick={onExit}
          className="ml-auto font-mono text-[10px] text-t4 hover:text-fg"
        >
          back to the desk
        </button>
      </div>

      {top === undefined && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="rounded border border-b4 bg-s3 px-8 py-10 text-center text-sm text-t3">
            nothing waiting on you
          </div>
        </div>
      )}

      {top !== undefined && top.kind === 'desk' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border-[1.5px] border-ask/55 bg-s8 shadow-2xl">
          <div className="flex shrink-0 items-center gap-2 border-b border-b1 bg-s3 px-3.5 py-2.5">
            <span className="text-[9px] text-ask">●</span>
            <span className="truncate font-ui text-sm font-bold">{titleOf(top.session)}</span>
            <span className="whitespace-nowrap rounded border border-b4 px-2 font-mono text-[10px] text-t3">
              {projectName(top.session)}
            </span>
            {top.entry.zone !== undefined && (
              <span className="whitespace-nowrap font-mono text-[10px] font-semibold text-rev">
                ⛶ {top.entry.zone}
              </span>
            )}
            {wsChip(top.workspace)}
            {top.session.gitBranch !== undefined && (
              <span className="truncate font-mono text-[10px] text-t4">
                ⎇ {top.session.gitBranch}
              </span>
            )}
            <span className="ml-auto whitespace-nowrap font-mono text-[10px] font-semibold text-ask">
              waiting {formatWait(top.session.turn?.since, nowMs)}
            </span>
            <button
              onClick={() => onInspect(top.session.id)}
              className="font-mono text-[10px] text-t3 hover:text-fg"
            >
              detail
            </button>
            <button
              onClick={jumpToTop}
              title={
                top.workspace.active
                  ? 'its tile is already front of its zone — jump to the desk'
                  : `switch to ${top.workspace.name} and jump to its tile`
              }
              className="font-mono text-[10px] text-t3 hover:text-fg"
            >
              ⛶ tile
            </button>
          </div>

          <div className="min-h-0 flex-1 bg-app p-1">
            {top.entry.ptyId !== undefined ? (
              // The SAME terminal the desk tile holds: PTYs live in the
              // main process, this view just attaches to it here.
              <TerminalView key={top.entry.ptyId} ptyId={top.entry.ptyId} visible autoFocus />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center font-mono">
                <span className="text-xs text-t5">▢ its terminal is closed</span>
                {resuming ? (
                  <span className="animate-pulse text-xs text-ac">resuming into its tile…</span>
                ) : (
                  <div className="flex gap-2">
                    {top.workspace.active ? (
                      <button
                        onClick={resumeTop}
                        className="rounded border border-ac/55 px-3.5 py-1.5 text-[11.5px] font-semibold text-ach hover:bg-ac/10"
                      >
                        ⟳ reopen — claude --resume into its tile
                      </button>
                    ) : (
                      <button
                        onClick={jumpToTop}
                        className="rounded border border-ac/55 px-3.5 py-1.5 text-[11.5px] font-semibold text-ach hover:bg-ac/10"
                      >
                        switch to {top.workspace.name}
                      </button>
                    )}
                    <button
                      onClick={() => act('later')}
                      className="rounded border border-b4 px-3.5 py-1.5 text-[11.5px] text-t3 hover:text-fg"
                    >
                      later
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col gap-2 border-t border-b1 bg-s1 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[9px] font-semibold tracking-[.1em] text-t6">
                {structured?.options !== undefined ? 'OPTIONS — PICK IN THE TERMINAL' : 'PRESETS'}
              </span>
              {(structured?.options ?? PRESETS).map((chip) => (
                <button
                  key={chip}
                  onClick={() => {
                    if (structured?.options !== undefined) return // the real dialog owns selection
                    if (top.entry.ptyId !== undefined && desktop !== undefined) {
                      desktop.write(top.entry.ptyId, chip)
                      desktop.write(top.entry.ptyId, '\r')
                    }
                  }}
                  className={`rounded border px-3 py-1 text-[11.5px] ${
                    structured?.options !== undefined
                      ? 'cursor-default border-b4 text-t3'
                      : 'border-ac/55 text-ach hover:bg-ac/14'
                  }`}
                >
                  {chip}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => act('later')}
                title="rotate to the bottom of the stack"
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
              >
                later
              </button>
              {snoozeMenu}
              <button
                onClick={() => act('phone')}
                title="injects /remote-control — answer from the Claude app"
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
              >
                send to phone
              </button>
              <button
                onClick={() => act('done')}
                title="closes the terminal — the transcript stays, resumable any time"
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-run hover:text-fg"
              >
                ✓ done
              </button>
              <button
                onClick={() => act('kill')}
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-err hover:text-fg"
              >
                ✕ kill
              </button>
            </div>
          </div>
        </div>
      )}

      {top !== undefined && top.kind === 'cloud' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border-[1.5px] border-ask/55 bg-s8 shadow-2xl">
          <div className="flex shrink-0 items-center gap-2 border-b border-b1 bg-s3 px-3.5 py-2.5">
            <span className="text-t6">
              <CloudIcon />
            </span>
            <span className="truncate font-ui text-sm font-bold">
              {top.cloud.title ?? top.cloud.id.slice(0, 12)}
            </span>
            {top.cloud.repo !== undefined && (
              <span className="whitespace-nowrap rounded border border-b4 px-2 font-mono text-[10px] text-t3">
                {top.cloud.repo}
              </span>
            )}
            {wsChip(top.workspace)}
            {top.cloud.branches[0] !== undefined && (
              <span className="truncate font-mono text-[10px] text-t4">
                ⎇ {top.cloud.branches[0]}
              </span>
            )}
            <span className="ml-auto whitespace-nowrap font-mono text-[10px] font-semibold text-ask">
              waiting {formatWait(top.cloud.updatedAt, nowMs)}
            </span>
            <a
              href={top.cloud.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-t3 hover:text-fg"
            >
              web ↗
            </a>
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-app px-8 py-6 text-center">
            {top.cloud.statusDetail !== undefined && (
              <p className="max-w-2xl text-xs text-t4">{top.cloud.statusDetail}</p>
            )}
            <p className="max-w-2xl font-ui text-[15px] font-semibold leading-relaxed text-fg">
              {top.cloud.needsAction !== undefined
                ? `"${top.cloud.needsAction}"`
                : 'this session reads as blocked on you'}
            </p>
            <div className="flex w-full max-w-2xl flex-col gap-2">
              <textarea
                rows={3}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="reply — queued into the cloud session"
                className="w-full resize-y rounded border border-b4 bg-s1 px-3 py-2 text-left text-[12px] leading-relaxed outline-none placeholder:text-t6 focus:border-b6"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={sendReply}
                  disabled={reply.trim() === '' || sending}
                  className="rounded bg-ac px-3.5 py-1.5 text-[11.5px] font-semibold text-ink hover:brightness-110 disabled:opacity-40"
                >
                  {sending ? 'sending…' : 'send reply'}
                </button>
                <button
                  onClick={() => void launchOrCopy({ kind: 'teleport', sessionId: top.cloud.id })}
                  className="rounded border border-run/40 px-3 py-1.5 text-[11.5px] text-run hover:bg-run/10"
                  title="pull this session into a local terminal (web copy goes read-only)"
                >
                  teleport
                </button>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-b1 bg-s1 px-3.5 py-2.5">
            <button
              onClick={() => act('later')}
              title="rotate to the bottom of the stack"
              className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
            >
              later
            </button>
            {snoozeMenu}
          </div>
        </div>
      )}

      {queue.length > 1 && (
        <div className="shrink-0">
          <div className="pb-1.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
            NEXT UP
          </div>
          <div className="flex flex-col gap-1.5">
            {queue.slice(1, 5).map((item) => (
              <button
                key={itemId(item)}
                onClick={() => setPick(itemId(item))}
                className="flex items-center gap-2.5 rounded border border-b1 bg-s1 px-3 py-1.5 text-left hover:border-b6"
              >
                <span className="text-[9px] text-ask">●</span>
                {item.kind === 'cloud' && (
                  <span className="text-t6">
                    <CloudIcon size={10} />
                  </span>
                )}
                <span className="flex-1 truncate font-ui text-[12.5px] font-semibold">
                  {item.kind === 'desk'
                    ? titleOf(item.session)
                    : (item.cloud.title ?? item.cloud.id.slice(0, 12))}
                </span>
                <span className="font-mono text-[10.5px] text-t4">
                  waiting {formatWait(itemSince(item), nowMs)} ·{' '}
                  {item.kind === 'desk'
                    ? projectName(item.session)
                    : (item.cloud.repo ?? 'cloud')}
                  {!item.workspace.active && (
                    <span className="text-ach"> · {item.workspace.name}</span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-t6">bring to top ↑</span>
              </button>
            ))}
            {queue.length > 5 && (
              <div className="px-3 font-mono text-[10px] text-t6">
                +{queue.length - 5} more waiting
              </div>
            )}
          </div>
        </div>
      )}

      {deferredN > 0 && (
        <div className="flex shrink-0 flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px] text-t6">
          <span>{deferredN} snoozed</span>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { Session, Snapshot } from '@hodor/core'
import { desktop } from './desktop.js'
import { deskState, getDeskOps, subscribeDesk, type DeskEntry } from './Desk.js'
import { TerminalView } from './Terminal.js'
import { titleOf, type View } from './data.js'

/**
 * The Turn Stack (docs/brainstorm/023, settled): a stack of ACTUAL waiting
 * Claude terminals — desk sessions whose turn is yours, waiting-longest-
 * first. It takes the whole window: the top card IS the already-open
 * terminal (the same PTY its desk tile holds — views just attach), brought
 * forward here AND made the active tile in its zone behind. Take the turn
 * by typing; triage with one verb. Nothing resumes or spawns on its own —
 * a dead slot offers its resume button and waits for you.
 *
 * Quick-reply chips are honest about their source: structured options
 * (AskUserQuestion) are display-only context — the REAL dialog is on
 * screen in the terminal, pick there; preset chips (report-style endings)
 * write straight into the PTY.
 */

const PRESETS = ['go ahead', 'use your judgment', 'looks good — proceed']

const formatWait = (sinceIso: string | undefined, nowMs: number): string => {
  if (sinceIso === undefined) return ''
  const mins = Math.max(1, Math.round((nowMs - Date.parse(sinceIso)) / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

interface QueueItem {
  entry: DeskEntry
  session: Session
}

/** Desk sessions waiting on the human, deferred ones excluded. */
export function stackQueue(byId: Map<string, Session>, nowMs: number): QueueItem[] {
  const items: QueueItem[] = []
  const seen = new Set<string>()
  for (const entry of deskState.entries) {
    if (entry.sessionId === undefined || seen.has(entry.sessionId)) continue
    const session = byId.get(entry.sessionId)
    if (session?.turn?.state !== 'waiting') continue
    seen.add(entry.sessionId)
    const defer = deskState.defer[entry.sessionId]
    if (defer !== undefined) {
      const moved =
        (defer.untilMoves !== undefined || defer.phone === true) &&
        (session.lastActivityAt ?? '') > (defer.untilMoves ?? '')
      const timedOut = defer.until !== undefined && Date.parse(defer.until) <= nowMs
      if (!moved && !timedOut && (defer.until !== undefined ? !timedOut : true)) continue
      // expired deferral: clean it up so the badge math stays honest
      getDeskOps()?.setDefer(entry.sessionId, undefined)
    }
    items.push({ entry, session })
  }
  return items.sort(
    (a, b) => (a.session.turn?.since ?? '').localeCompare(b.session.turn?.since ?? ''),
  )
}

export function Stack(props: {
  snapshot: Snapshot
  view: View
  nowMs: number
  onExit: () => void
  onInspect: (sessionId: string) => void
  onJumpDesk: () => void
}) {
  const { view, nowMs, onExit, onInspect, onJumpDesk } = props
  const [, setTick] = useState(0)
  const [rot, setRot] = useState<string[]>([])
  const [pick, setPick] = useState<string | undefined>(undefined)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [resuming, setResuming] = useState(false)

  useEffect(() => subscribeDesk(() => setTick((t) => t + 1)), [])

  let queue = stackQueue(view.byId, nowMs)
  // skip = rotate to the bottom; an explicit pick jumps the line
  queue = [
    ...queue.filter((q) => !rot.includes(q.session.id)),
    ...rot
      .map((id) => queue.find((q) => q.session.id === id))
      .filter((q): q is QueueItem => q !== undefined),
  ]
  if (pick !== undefined) {
    const picked = queue.find((q) => q.session.id === pick)
    if (picked !== undefined) queue = [picked, ...queue.filter((q) => q !== picked)]
  }
  const top = queue[0]
  const topPanelId = top?.entry.panelId

  // The desk mirrors the stack: the top card's tile comes forward in its
  // zone, so esc (or ⛶) lands on the session you were just dealing with.
  useEffect(() => {
    setResuming(false)
    if (topPanelId !== undefined) getDeskOps()?.revealPanel(topPanelId)
  }, [topPanelId])

  const resumeTop = useCallback(() => {
    if (topPanelId === undefined) return
    setResuming(true)
    void getDeskOps()
      ?.resumePanel(topPanelId)
      .finally(() => setResuming(false))
  }, [topPanelId])

  const act = useCallback(
    (kind: 'skip' | 'snz30' | 'snz2' | 'snzMove' | 'phone' | 'done' | 'kill') => {
      if (top === undefined) return
      const ops = getDeskOps()
      const id = top.session.id
      setSnoozeOpen(false)
      setPick(undefined)
      switch (kind) {
        case 'skip':
          setRot((r) => [...r.filter((x) => x !== id), id])
          break
        case 'snz30':
          ops?.setDefer(id, { until: new Date(nowMs + 30 * 60_000).toISOString() })
          break
        case 'snz2':
          ops?.setDefer(id, { until: new Date(nowMs + 2 * 3600_000).toISOString() })
          break
        case 'snzMove':
          ops?.setDefer(id, { untilMoves: top.session.lastActivityAt ?? new Date(nowMs).toISOString() })
          break
        case 'phone':
          if (top.entry.ptyId !== undefined && desktop !== undefined) {
            desktop.write(top.entry.ptyId, '/remote-control\r')
            ops?.setDefer(id, {
              untilMoves: top.session.lastActivityAt ?? new Date(nowMs).toISOString(),
              phone: true,
            })
          }
          break
        case 'done':
        case 'kill':
          ops?.closePanel(top.entry.panelId)
          break
      }
    },
    [top, nowMs],
  )

  // ⌘/Ctrl verbs — captured BEFORE xterm, or the focused terminal eats
  // them (and ctrl+D would reach the shell as EOF). Escape stays the
  // terminal's when it has focus: that's Claude's interrupt key; it only
  // exits the stack from outside the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const inTerm = el?.classList.contains('xterm-helper-textarea') ?? false
      if (e.key === 'Escape') {
        if (!inTerm) onExit()
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      if (!inTerm && (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      if (k === 's' || k === 'd' || k === 'z') {
        e.preventDefault()
        e.stopPropagation()
        if (k === 's') act('skip')
        else if (k === 'd') act('done')
        else setSnoozeOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [act, onExit])

  const deferredN = Object.keys(deskState.defer).length
  const structured = top?.session.turn?.pending
  const projectName = (s: Session): string => {
    const claim = view.claimsBySession.get(s.id)?.[0]
    if (claim !== undefined) {
      const custom = props.snapshot.customProjects.find((p) => p.id === claim)
      if (custom !== undefined) return custom.name
    }
    return view.derivedOf.get(s.id)?.name ?? 'no project'
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 px-6 pb-4 pt-3">
      <div className="flex shrink-0 items-center gap-2.5 text-[11px] text-t3">
        <span className="font-bold text-ask">▲ your turn</span>
        <span className="font-bold text-fg">
          {queue.length === 0 ? '0 waiting' : `1 of ${queue.length}`}
        </span>
        <span className="font-mono text-[10px] text-t6">
          waiting-longest-first · typing goes to the terminal · verbs are ⌘
        </span>
        <button
          onClick={onExit}
          className="ml-auto font-mono text-[10px] text-t4 hover:text-fg"
        >
          esc — back to the desk
        </button>
      </div>

      {top === undefined && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="rounded border border-b4 bg-s3 px-8 py-10 text-center text-sm text-t3">
            all agents working — go get coffee ☕
            <div className="mt-2 font-mono text-[11px] text-t6">
              the stack refills the moment a turn flips to you — “until it moves” snoozes wake on
              new transcript lines
            </div>
          </div>
        </div>
      )}

      {top !== undefined && (
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
              onClick={onJumpDesk}
              title="its tile is already front of its zone — jump to the desk"
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
                <span className="text-xs text-t5">
                  ▢ its terminal is closed — the app restarted, or the tile was killed
                </span>
                {resuming ? (
                  <span className="animate-pulse text-xs text-ac">resuming into its tile…</span>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={resumeTop}
                      className="rounded border border-ac/55 px-3.5 py-1.5 text-[11.5px] font-semibold text-ach hover:bg-ac/10"
                    >
                      ⟳ reopen — claude --resume into its tile
                    </button>
                    <button
                      onClick={() => act('skip')}
                      className="rounded border border-b4 px-3.5 py-1.5 text-[11.5px] text-t3 hover:text-fg"
                    >
                      ⇥ skip for now
                    </button>
                  </div>
                )}
                <span className="text-[10px] text-t6">
                  nothing reopens on its own — your call
                </span>
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col gap-2 border-t border-b1 bg-s1 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[9px] font-semibold tracking-[.1em] text-t6">
                {structured?.options !== undefined
                  ? 'FROM THE SESSION — PICK IN THE DIALOG ABOVE'
                  : 'YOUR PRESETS — SENT AS YOUR REPLY'}
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
                onClick={() => act('skip')}
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
              >
                ⇥ skip <span className="font-mono text-[9px] opacity-60">⌘S</span>
              </button>
              <span className="relative">
                <button
                  onClick={() => setSnoozeOpen((o) => !o)}
                  className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
                >
                  ⏾ snooze ▾ <span className="font-mono text-[9px] opacity-60">⌘Z</span>
                </button>
                {snoozeOpen && (
                  <span className="absolute bottom-full left-0 z-10 mb-1.5 flex flex-col gap-0.5 whitespace-nowrap rounded border border-b5 bg-s5 p-1 shadow-xl">
                    {(
                      [
                        ['30 minutes', 'snz30'],
                        ['2 hours', 'snz2'],
                        ['until it moves again', 'snzMove'],
                      ] as const
                    ).map(([label, kind]) => (
                      <button
                        key={kind}
                        onClick={() => act(kind)}
                        className="rounded px-3 py-1 text-left text-[11.5px] hover:bg-ac/12"
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                )}
              </span>
              <button
                onClick={() => act('phone')}
                title="injects /remote-control — answer from the Claude app"
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-ac hover:text-fg"
              >
                📱 send to phone
              </button>
              <button
                onClick={() => act('done')}
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-run hover:text-fg"
              >
                ✓ done <span className="font-mono text-[9px] opacity-60">⌘D</span>
              </button>
              <button
                onClick={() => act('kill')}
                className="rounded border border-b4 px-2.5 py-1 text-[11px] text-t2 hover:border-err hover:text-fg"
              >
                ✕ kill
              </button>
              <span className="ml-auto font-mono text-[10px] text-t6">
                done closes the PTY — the transcript stays, resumable forever
              </span>
            </div>
          </div>
        </div>
      )}

      {queue.length > 1 && (
        <div className="shrink-0">
          <div className="pb-1.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
            NEXT UP — WAITING-LONGEST-FIRST
          </div>
          <div className="flex flex-col gap-1.5">
            {queue.slice(1, 5).map(({ session }) => (
              <button
                key={session.id}
                onClick={() => setPick(session.id)}
                className="flex items-center gap-2.5 rounded border border-b1 bg-s1 px-3 py-1.5 text-left hover:border-b6"
              >
                <span className="text-[9px] text-ask">●</span>
                <span className="flex-1 truncate font-ui text-[12.5px] font-semibold">
                  {titleOf(session)}
                </span>
                <span className="font-mono text-[10.5px] text-t4">
                  waiting {formatWait(session.turn?.since, nowMs)} · {projectName(session)}
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

      <div className="flex shrink-0 flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px] text-t6">
        {deferredN > 0 && <span>⏾ {deferredN} deferred — out of the count, not abandoned</span>}
        <span>☁ cloud sessions stay out of the stack (v1) — answer by message from Home, or teleport</span>
      </div>
    </div>
  )
}

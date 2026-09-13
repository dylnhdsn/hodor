import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Snapshot } from '@hodor/core'
import { desktop } from './desktop.js'
import { deskState, getDeskOps, subscribeDesk, type DeskEntry } from './Desk.js'
import { TerminalView } from './Terminal.js'
import { titleOf, type View } from './data.js'

/**
 * The Turn Stack (docs/brainstorm/023, settled): a stack of ACTUAL waiting
 * Claude terminals — desk sessions whose turn is yours, waiting-longest-
 * first. Take the turn by typing (the real TUI has focus); triage with one
 * verb. No summarization anywhere: the terminal is the ground truth.
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
  const autoResumed = useRef(new Set<string>())

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

  // A dead slot that surfaces gets its PTY back automatically — the card
  // IS the terminal, so the terminal has to exist.
  useEffect(() => {
    if (top === undefined || top.entry.ptyId !== undefined) return
    if (autoResumed.current.has(top.entry.panelId)) return
    autoResumed.current.add(top.entry.panelId)
    void getDeskOps()?.resumePanel(top.entry.panelId)
  }, [top])

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

  // ⌘/Ctrl verbs; plain typing always belongs to the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.key === 'Escape') {
        onExit()
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      if (tag === 'INPUT' && !(e.target as HTMLElement).classList.contains('xterm-helper-textarea'))
        return
      const k = e.key.toLowerCase()
      if (k === 's') {
        e.preventDefault()
        act('skip')
      } else if (k === 'd') {
        e.preventDefault()
        act('done')
      } else if (k === 'z') {
        e.preventDefault()
        setSnoozeOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 pb-8 pt-5">
      <div className="flex w-[720px] max-w-full flex-col gap-3">
        <div className="flex items-center gap-2.5 text-[11px] text-t3">
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
          <div className="rounded border border-b4 bg-s3 px-5 py-8 text-center text-sm text-t3">
            all agents working — go get coffee ☕
            <div className="mt-2 font-mono text-[11px] text-t6">
              the stack refills the moment a turn flips to you — “until it moves” snoozes wake on
              new transcript lines
            </div>
          </div>
        )}

        {top !== undefined && (
          <div className="overflow-hidden rounded border-[1.5px] border-ask/55 bg-s8 shadow-2xl">
            <div className="flex items-center gap-2 border-b border-b1 bg-s3 px-3.5 py-2.5">
              <span className="text-[9px] text-ask">●</span>
              <span className="text-sm font-bold">{titleOf(top.session)}</span>
              <span className="rounded border border-b4 px-2 font-mono text-[10px] text-t3">
                {projectName(top.session)}
              </span>
              {top.session.gitBranch !== undefined && (
                <span className="font-mono text-[10px] text-t4">⎇ {top.session.gitBranch}</span>
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
                title="jump to its tile on the desk"
                className="font-mono text-[10px] text-t3 hover:text-fg"
              >
                ⛶ tile
              </button>
            </div>

            <div className="h-[340px] bg-app p-1">
              {top.entry.ptyId !== undefined ? (
                <TerminalView key={top.entry.ptyId} ptyId={top.entry.ptyId} visible autoFocus />
              ) : (
                <div className="flex h-full items-center justify-center font-mono text-xs text-ac">
                  <span className="animate-pulse">resuming into place…</span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t border-b1 bg-s1 px-3.5 py-2.5">
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
          <>
            <div className="pt-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
              NEXT UP — WAITING-LONGEST-FIRST
            </div>
            {queue.slice(1).map(({ session }) => (
              <button
                key={session.id}
                onClick={() => setPick(session.id)}
                className="flex items-center gap-2.5 rounded border border-b1 bg-s1 px-3 py-2 text-left hover:border-b6"
              >
                <span className="text-[9px] text-ask">●</span>
                <span className="flex-1 truncate text-sm font-semibold">{titleOf(session)}</span>
                <span className="font-mono text-[10.5px] text-t4">
                  waiting {formatWait(session.turn?.since, nowMs)} · {projectName(session)}
                </span>
                <span className="font-mono text-[10px] text-t6">bring to top ↑</span>
              </button>
            ))}
          </>
        )}

        {deferredN > 0 && (
          <div className="font-mono text-[10.5px] text-t6">
            ⏾ {deferredN} deferred — out of the count, not abandoned
          </div>
        )}
        <div className="font-mono text-[10.5px] text-t6">
          ☁ cloud sessions stay out of the stack (v1) — answer by message from the library, or
          teleport
        </div>
      </div>
    </div>
  )
}

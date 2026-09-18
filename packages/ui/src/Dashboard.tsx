import { useEffect, useState } from 'react'
import type { CloudSession, Session, Snapshot } from '@hodor/core'
import { cloudNeedsYou } from './CloudSessions.js'
import {
  formatAge,
  formatTokens,
  formatUsd,
  projectNameOf,
  sigOfCloud,
  sigOfSession,
  statusOfSession,
  titleOf,
  type RowStatus,
  type View,
} from './data.js'
import { desktop, type TermInfo } from './desktop.js'
import { deskState, getDeskOps, isDeferred, type DeferState, type DeskEntry } from './Desk.js'
import { CloudIcon } from './icons.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'

/**
 * The stack with nothing waiting: the desk at a glance. One row per tile
 * — sessions (whose turn, how long the tile has been up, last activity,
 * subagent runs, tool calls, context, spend, why it is skipped), shells
 * (where they run, uptime) and teleported cloud sessions. The numbers are
 * the library's; uptime is the desktop's PTY spawn time. Click a row to
 * land on its tile; right-click for the rest.
 */

export const formatDuration = (ms: number): string => {
  const mins = Math.floor(Math.max(0, ms) / 60_000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

const clockOf = (iso: string, nowMs: number): string => {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '?'
  const hhmm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return t.toDateString() === new Date(nowMs).toDateString()
    ? hhmm
    : `${t.toLocaleDateString([], { weekday: 'short' })} ${hhmm}`
}

/** A skip's wake condition, in the words the snooze menu used. */
export const describeDefer = (d: DeferState, nowMs: number): string => {
  const what =
    d.phone === true
      ? 'on your phone'
      : d.hold === true
        ? 'until you unskip it'
        : d.pr !== undefined
          ? `until PR #${d.pr.number} moves`
          : d.until !== undefined
            ? `until ${clockOf(d.until, nowMs)}`
            : d.sig !== undefined
              ? 'until its ask changes'
              : d.untilMoves !== undefined
                ? 'until it moves'
                : 'skipped'
  return d.note !== undefined && d.note.trim() !== '' ? `${what} — ${d.note.trim()}` : what
}

/** Subagent runs on a session: how many, and of what kind. */
export const agentRunsOf = (s: Session): { runs: number; kinds: string } => {
  const byType = new Map<string, number>()
  let runs = 0
  for (const t of s.threads) {
    if (t.kind !== 'sidechain') continue
    runs += 1
    const type = t.agentType ?? 'subagent'
    byType.set(type, (byType.get(type) ?? 0) + 1)
  }
  const kinds = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => (n > 1 ? `${type} ×${n}` : type))
    .join(', ')
  return { runs, kinds }
}

type Status = RowStatus | 'off'

interface SessionRow {
  entry: DeskEntry
  session: Session
  status: Status
  term: TermInfo | undefined
  /** The skip in force, when the row is quiet on purpose. */
  defer: DeferState | undefined
}

const STATUS_RANK: Record<Status, number> = { 'needs-you': 0, working: 1, skipped: 2, idle: 3, off: 4 }

const dotOf = (status: Status): { glyph: string; cls: string; title: string } =>
  status === 'needs-you'
    ? { glyph: '●', cls: 'text-ask', title: 'your turn' }
    : status === 'working'
      ? { glyph: '●', cls: 'text-run', title: 'working' }
      : status === 'skipped'
        ? { glyph: '◐', cls: 'text-rev/80', title: 'skipped' }
        : status === 'idle'
          ? { glyph: '●', cls: 'text-b6', title: 'idle' }
          : { glyph: '○', cls: 'text-b6', title: 'no terminal — resume it from the desk' }

const basename = (path: string): string =>
  path.split(/[\\/]/).filter((x) => x !== '').pop() ?? path

const isAlive = (entry: DeskEntry, term: TermInfo | undefined): boolean =>
  entry.ptyId !== undefined && term?.exited === undefined

const uptime = (term: TermInfo | undefined, nowMs: number): string | undefined =>
  term?.startedAt !== undefined ? formatDuration(nowMs - Date.parse(term.startedAt)) : undefined

export function StackDashboard(props: {
  snapshot: Snapshot
  view: View
  nowMs: number
  onInspect: (sessionId: string) => void
  onJumpDesk: () => void
}) {
  const { snapshot, view, nowMs } = props
  const { menu, openMenu, closeMenu } = useContextMenu()
  const [terms, setTerms] = useState<ReadonlyMap<string, TermInfo>>(new Map())
  // Uptime lives in the desktop's PTY table; refresh it every few ticks.
  const termTick = Math.floor(nowMs / 10_000)
  useEffect(() => {
    if (desktop === undefined) return
    let live = true
    void desktop.list().then((list) => {
      if (live) setTerms(new Map(list.map((t) => [t.id, t])))
    })
    return () => {
      live = false
    }
  }, [termTick])

  const bySession = new Map<string, SessionRow>()
  const shells: DeskEntry[] = []
  const clouds: Array<{ entry: DeskEntry; cloud: CloudSession | undefined }> = []
  for (const entry of deskState.entries) {
    const term = entry.ptyId !== undefined ? terms.get(entry.ptyId) : undefined
    if (entry.kind === 'shell') {
      shells.push(entry)
    } else if (entry.cloudId !== undefined) {
      clouds.push({ entry, cloud: view.cloud.find((c) => c.id === entry.cloudId) })
    } else if (entry.sessionId !== undefined) {
      const session = view.byId.get(entry.sessionId)
      if (session === undefined) continue
      // Two tiles for one session (a dead slot beside a live resume):
      // the live one speaks for it.
      const prior = bySession.get(session.id)
      if (prior !== undefined && (isAlive(prior.entry, prior.term) || !isAlive(entry, term))) continue
      const defer = deskState.defer[session.id]
      const skipped =
        defer !== undefined &&
        isDeferred(
          session.id,
          sigOfSession(session),
          session.lastActivityAt,
          nowMs,
          undefined,
          session.pr?.fingerprint,
        )
      bySession.set(session.id, {
        entry,
        session,
        status: isAlive(entry, term) ? statusOfSession(session, skipped) : 'off',
        term,
        defer: skipped ? defer : undefined,
      })
    }
  }
  const sessions = [...bySession.values()].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (b.session.lastActivityAt ?? '').localeCompare(a.session.lastActivityAt ?? ''),
  )

  const running = sessions.filter((r) => r.status === 'working').length
  const skippedN =
    sessions.filter((r) => r.status === 'skipped').length +
    clouds.filter(
      ({ cloud }) =>
        cloud !== undefined &&
        deskState.defer[cloud.id] !== undefined &&
        isDeferred(cloud.id, sigOfCloud(cloud), cloud.updatedAt, nowMs),
    ).length
  const agentRuns = sessions.reduce((n, r) => n + agentRunsOf(r.session).runs, 0)
  const spent = sessions.reduce((n, r) => n + (r.session.costUsd ?? 0), 0)
  const tiles = deskState.entries.length

  const jump = (entry: DeskEntry): void => {
    getDeskOps()?.revealPanel(entry.panelId)
    props.onJumpDesk()
  }
  const rowMenu = (e: React.MouseEvent, entry: DeskEntry, extra: MenuItem[], deferId?: string) =>
    openMenu(e, [
      { label: entry.title, heading: true },
      { label: 'jump to its tile', onClick: () => jump(entry) },
      ...extra,
      ...(deferId !== undefined && deskState.defer[deferId] !== undefined
        ? [{ label: 'unskip', onClick: () => getDeskOps()?.setDefer(deferId, undefined) }]
        : []),
      { label: 'close its tile', danger: true, onClick: () => getDeskOps()?.closePanel(entry.panelId) },
    ])

  const stat = (n: string, label: string, cls = 'text-fg') => (
    <span className="flex items-baseline gap-1.5">
      <span className={`font-mono text-[15px] font-semibold ${cls}`}>{n}</span>
      <span className="text-[10.5px] text-t4">{label}</span>
    </span>
  )
  const heading = (text: string) => (
    <div className="mb-1 mt-4 font-mono text-[9.5px] font-semibold tracking-wider text-t5">{text}</div>
  )
  const cell = 'whitespace-nowrap font-mono text-[10px] text-t4'
  const rowCls =
    'grid w-full grid-cols-[14px_minmax(0,1fr)_repeat(6,56px)] items-center gap-x-3 rounded px-2 py-1.5 text-left hover:bg-s1'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded border border-b4 bg-s3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="text-sm text-t3">nothing waiting on you</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1">
          {stat(String(sessions.length), sessions.length === 1 ? 'session' : 'sessions')}
          {stat(String(running), 'running', running > 0 ? 'text-run' : 'text-t3')}
          {shells.length > 0 && stat(String(shells.length), shells.length === 1 ? 'shell' : 'shells')}
          {skippedN > 0 && stat(String(skippedN), 'skipped', 'text-rev')}
          {agentRuns > 0 && stat(String(agentRuns), 'agent runs')}
          {spent > 0 && stat(formatUsd(spent), 'spent')}
        </span>
      </div>

      {tiles === 0 && (
        <div className="mt-8 text-center font-mono text-[11px] text-t6">
          nothing on the desk — open a session from the library, or drag one here
        </div>
      )}

      {sessions.length > 0 && (
        <>
          {heading('SESSIONS')}
          <div className={`${rowCls} py-0.5 hover:bg-transparent`}>
            <span />
            <span />
            {['up', 'active', 'agents', 'tools', 'context', 'spent'].map((h) => (
              <span key={h} className="text-right font-mono text-[9px] text-t6">
                {h}
              </span>
            ))}
          </div>
          {sessions.map((row) => {
            const { session: s, entry, status, term, defer } = row
            const dot = dotOf(status)
            const agents = agentRunsOf(s)
            const alive = isAlive(entry, term)
            const up = alive ? uptime(term, nowMs) : undefined
            const ran =
              s.createdAt !== undefined && s.lastActivityAt !== undefined
                ? formatDuration(Date.parse(s.lastActivityAt) - Date.parse(s.createdAt))
                : undefined
            return (
              <button
                key={entry.panelId}
                onClick={() => jump(entry)}
                onContextMenu={(e) =>
                  rowMenu(
                    e,
                    entry,
                    [{ label: 'detail', onClick: () => props.onInspect(s.id) }],
                    s.id,
                  )
                }
                className={rowCls}
                title={s.turn?.preview ?? s.cwd}
              >
                <span className={`text-[9px] ${dot.cls}`} title={dot.title}>
                  {dot.glyph}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-ui text-[12.5px] text-fg">{titleOf(s)}</span>
                    <span className="whitespace-nowrap rounded border border-b4 px-1.5 font-mono text-[9.5px] text-t4">
                      {projectNameOf(snapshot, view, s)}
                    </span>
                    {entry.zone !== undefined && (
                      <span className="whitespace-nowrap font-mono text-[9.5px] text-rev">⛶ {entry.zone}</span>
                    )}
                    {s.live?.kind === 'background' && (
                      <span className="whitespace-nowrap font-mono text-[9.5px] text-run">background</span>
                    )}
                  </span>
                  {defer !== undefined && (
                    <span className="truncate font-mono text-[10px] text-rev/80">
                      skipped {describeDefer(defer, nowMs)}
                    </span>
                  )}
                </span>
                <span className={`${cell} text-right ${alive ? 'text-fg' : ''}`} title={alive ? 'this tile has been up for' : ran !== undefined ? 'no terminal — the session ran for' : ''}>
                  {alive ? (up ?? 'up') : ran !== undefined ? `ran ${ran}` : 'off'}
                </span>
                <span className={`${cell} text-right`} title={s.lastActivityAt}>
                  {formatAge(nowMs, s.lastActivityAt)}
                </span>
                <span className={`${cell} text-right`} title={agents.kinds}>
                  {agents.runs > 0 ? agents.runs : '·'}
                </span>
                <span className={`${cell} text-right`}>{s.counts.toolCalls > 0 ? s.counts.toolCalls : '·'}</span>
                <span className={`${cell} text-right`}>
                  {s.contextTokens !== undefined ? formatTokens(s.contextTokens) : '·'}
                </span>
                <span className={`${cell} text-right`}>
                  {s.costUsd !== undefined && s.costUsd > 0 ? formatUsd(s.costUsd) : '·'}
                </span>
              </button>
            )
          })}
        </>
      )}

      {shells.length > 0 && (
        <>
          {heading('SHELLS')}
          {shells.map((entry) => {
            const term = entry.ptyId !== undefined ? terms.get(entry.ptyId) : undefined
            const alive = isAlive(entry, term)
            return (
              <button
                key={entry.panelId}
                onClick={() => jump(entry)}
                onContextMenu={(e) => rowMenu(e, entry, [])}
                className={rowCls}
                title={entry.root}
              >
                <span className={`text-[9px] ${alive ? 'text-run' : 'text-b6'}`}>{alive ? '●' : '○'}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-ui text-[12.5px] text-fg">
                    {entry.root !== undefined ? basename(entry.root) : entry.title}
                  </span>
                  {entry.env !== undefined && (
                    <span className="whitespace-nowrap rounded border border-b4 px-1.5 font-mono text-[9.5px] text-t4">
                      {entry.env}
                    </span>
                  )}
                  {entry.zone !== undefined && (
                    <span className="whitespace-nowrap font-mono text-[9.5px] text-rev">⛶ {entry.zone}</span>
                  )}
                  {entry.root !== undefined && (
                    <span className="truncate font-mono text-[10px] text-t5">{entry.root}</span>
                  )}
                </span>
                <span className={`${cell} text-right ${alive ? 'text-fg' : ''}`}>
                  {alive ? (uptime(term, nowMs) ?? 'up') : 'off'}
                </span>
                <span /><span /><span /><span /><span />
              </button>
            )
          })}
        </>
      )}

      {clouds.length > 0 && (
        <>
          {heading('CLOUD')}
          {clouds.map(({ entry, cloud }) => {
            const skipped =
              cloud !== undefined &&
              deskState.defer[cloud.id] !== undefined &&
              isDeferred(cloud.id, sigOfCloud(cloud), cloud.updatedAt, nowMs)
            const needs = cloud !== undefined && cloudNeedsYou(cloud)
            return (
              <button
                key={entry.panelId}
                onClick={() => jump(entry)}
                onContextMenu={(e) => rowMenu(e, entry, [], cloud?.id)}
                className={rowCls}
                title={cloud?.needsAction ?? cloud?.statusDetail}
              >
                <span className={`text-[9px] ${skipped ? 'text-rev/80' : needs ? 'text-ask' : 'text-b6'}`}>
                  {skipped ? '◐' : '●'}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-ui text-[12.5px] text-fg">
                      {cloud?.title ?? entry.title}
                    </span>
                    <span className="text-t6">
                      <CloudIcon size={9} />
                    </span>
                    {cloud?.statusDetail !== undefined && (
                      <span className="truncate font-mono text-[10px] text-t5">{cloud.statusDetail}</span>
                    )}
                  </span>
                  {skipped && cloud !== undefined && deskState.defer[cloud.id] !== undefined && (
                    <span className="truncate font-mono text-[10px] text-rev/80">
                      skipped {describeDefer(deskState.defer[cloud.id]!, nowMs)}
                    </span>
                  )}
                </span>
                <span className={`${cell} text-right`}>{cloud !== undefined ? formatAge(nowMs, cloud.updatedAt) : '·'}</span>
                <span /><span /><span /><span /><span />
              </button>
            )
          })}
        </>
      )}

      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </div>
  )
}

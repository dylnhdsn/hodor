import { useMemo, useState } from 'react'
import type { CloudSession, Session, Snapshot } from '@hodor/core'
import { prLabel } from '@hodor/core/pr'
import { cloudNeedsYou, cloudRunning, messageCloud } from './CloudSessions.js'
import {
  cwdsOf,
  formatAge,
  formatUsd,
  launchOrCopy,
  modelShortOf,
  postMutation,
  titleOf,
  type RailProject,
  type View,
} from './data.js'
import { tileOf } from './Desk.js'
import { promptText } from './dialog.js'
import { Glyph, type GlyphKind } from './glyphs.js'
import { GearIcon } from './icons.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'
import { chipClass, OverlayHeader } from './Overlay.js'
import { ProjectSettings } from './ProjectSettings.js'
import { SessionDetail } from './SessionDetail.js'
import {
  cloudSkipped,
  localSkipped,
  skipCloud,
  skipItemsOf,
  skipItemsOfCloud,
  skipLocal,
  skipNoteOf,
} from './skips.js'

/**
 * A project's overlay (v3 mock): every session it holds as one table —
 * local and cloud, live and archived — filtered by whose turn it is,
 * with bulk verbs on a selection; its settings page; a session's detail.
 */

export type ProjectPage = { kind: 'sessions' } | { kind: 'settings' } | { kind: 'detail'; sessionId: string }
type Mutate = (body: Record<string, unknown>) => Promise<boolean>

type Cat = 'ask' | 'run' | 'idle' | 'arch' | 'hidden'
const RANK: Record<Cat, number> = { ask: 0, run: 1, idle: 2, arch: 3, hidden: 3 }
const FILTERS: Array<{ id: Cat | 'all'; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'ask', label: '▲ needs you' },
  { id: 'run', label: '● running' },
  { id: 'idle', label: 'idle' },
  { id: 'arch', label: 'archived' },
  { id: 'hidden', label: 'hidden' },
]

interface Row {
  id: string
  local?: Session
  cloud?: CloudSession
  cat: Cat
  skipped: boolean
  glyph: GlyphKind
  title: string
  branch: string | undefined
  where: string | undefined
  model: string | undefined
  lastIso: string
  cost: number | undefined
}

/** Every session that belongs to the project: the rail's live ones plus
 * the hidden ones that its matchers (or its derived group) still claim. */
export function sessionsOfProject(view: View, project: RailProject): Session[] {
  const hidden = view.hidden.filter((s) =>
    project.kind === 'custom'
      ? (view.placementsBySession.get(s.id) ?? []).some((p) => p.customProjectId === project.id)
      : view.derivedOf.get(s.id)?.id === project.id,
  )
  return [...project.sessions, ...hidden]
}

const whereOf = (id: string): string | undefined => {
  const t = tileOf(id)
  if (t === undefined) return undefined
  return t.entry.zone !== undefined ? `${t.workspace.name} / ${t.entry.zone}` : t.workspace.name
}

export function ProjectOverlay(props: {
  project: RailProject
  view: View
  snapshot: Snapshot
  nowMs: number
  page: ProjectPage
  setPage: (page: ProjectPage) => void
  /** Absent in the browser build, where the overlay is the main area. */
  close?: (() => void) | undefined
  mutate: Mutate
  jumpToTile: (id: string) => void
}) {
  const { project, view, snapshot, nowMs, page, setPage, mutate } = props
  const [filter, setFilter] = useState<Cat | 'all'>('all')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const { menu, openMenu, closeMenu } = useContextMenu()

  const rows = useMemo<Row[]>(() => {
    // deskState is read for "where": callers re-render on desk ticks
    const out: Row[] = []
    for (const s of sessionsOfProject(view, project)) {
      const skipped = s.turn?.state === 'waiting' && localSkipped(s, nowMs)
      const cat: Cat =
        s.hiddenBy === 'archived'
          ? 'arch'
          : s.hiddenBy !== undefined
            ? 'hidden'
            : s.turn?.state === 'waiting'
              ? 'ask'
              : s.turn?.state === 'working' || (s.turn === undefined && s.runtime.kind !== 'idle')
                ? 'run'
                : 'idle'
      out.push({
        id: s.id,
        local: s,
        cat,
        skipped,
        glyph: skipped ? 'skipped' : cat === 'ask' ? 'ask' : cat === 'run' ? 'run' : cat === 'idle' ? 'idle' : 'arch',
        title: titleOf(s),
        branch: s.gitBranch,
        where: whereOf(s.id),
        model: modelShortOf(s),
        lastIso: s.lastActivityAt ?? '',
        cost: s.costUsd,
      })
    }
    for (const c of view.cloudByProject.get(project.id) ?? []) {
      const skipped = cloudNeedsYou(c) && cloudSkipped(c, nowMs)
      const cat: Cat = cloudNeedsYou(c) ? 'ask' : cloudRunning(c) ? 'run' : 'idle'
      out.push({
        id: c.id,
        cloud: c,
        cat,
        skipped,
        glyph: skipped ? 'skipped' : 'cloud',
        title: c.title ?? c.repo ?? c.id.slice(0, 12),
        branch: c.branches[0],
        where: whereOf(c.id),
        model: c.model?.replace(/^claude-/, ''),
        lastIso: c.updatedAt ?? c.createdAt ?? '',
        cost: c.costUsd,
      })
    }
    return out.sort((a, b) => RANK[a.cat] - RANK[b.cat] || b.lastIso.localeCompare(a.lastIso))
  }, [view, project, nowMs])

  const count = (f: Cat | 'all'): number =>
    rows.filter((r) => (f === 'all' ? r.cat !== 'arch' && r.cat !== 'hidden' : r.cat === f)).length
  const shown = rows.filter((r) =>
    filter === 'all' ? r.cat !== 'arch' && r.cat !== 'hidden' : r.cat === filter,
  )
  const selIds = shown.filter((r) => selected.has(r.id)).map((r) => r.id)
  const waitingSel = shown.filter((r) => selected.has(r.id) && r.cat === 'ask' && !r.skipped)
  const clear = (): void => setSelected(new Set())
  const roots = cwdsOf(project.sessions)
  const dirs =
    roots.length === 0
      ? project.kind === 'auto' && project.auto?.identity.kind === 'git-remote'
        ? project.auto.identity.url
        : ''
      : `${roots[0]}${roots.length > 1 ? ` · ${roots.length} directories` : ''}`

  const rename = (s: Session): void => {
    void promptText('rename session', { initial: titleOf(s), okLabel: 'rename' }).then((name) => {
      if (name === undefined || name.trim() === '') return
      void postMutation('/api/session', { op: 'rename-session', sessionId: s.id, name: name.trim() })
    })
  }
  const setArchived = (id: string, archived: boolean): Promise<unknown> =>
    postMutation('/api/session', { op: 'archive-session', sessionId: id, archived })

  const menuOf = (r: Row): MenuItem[] => {
    const onDesk = tileOf(r.id) !== undefined
    if (r.cloud !== undefined) {
      const c = r.cloud
      return [
        { label: r.title, heading: true },
        ...(onDesk ? [{ label: 'jump to its tile', onClick: () => props.jumpToTile(c.id) }] : []),
        { label: 'teleport into a terminal', onClick: () => void launchOrCopy({ kind: 'teleport', sessionId: c.id }) },
        { label: 'send a message…', onClick: () => void messageCloud(c) },
        { label: 'open on the web', onClick: () => window.open(c.url, '_blank') },
        ...skipItemsOfCloud(c, nowMs),
        { label: 'copy session id', onClick: () => void navigator.clipboard.writeText(c.id).catch(() => {}) },
      ]
    }
    const s = r.local!
    return [
      { label: r.title, heading: true },
      ...(onDesk ? [{ label: 'jump to its tile', onClick: () => props.jumpToTile(s.id) }] : []),
      { label: 'resume in a terminal', onClick: () => void launchOrCopy({ kind: 'resume', sessionId: s.id }) },
      { label: 'fork', onClick: () => void launchOrCopy({ kind: 'fork', sessionId: s.id }) },
      ...(s.cwd !== undefined
        ? [{ label: 'open a shell here', onClick: () => void launchOrCopy({ kind: 'shell', storeId: s.storeId, root: s.cwd! }) }]
        : []),
      { label: 'rename', onClick: () => rename(s) },
      ...skipItemsOf(s, nowMs),
      { label: 'session detail', onClick: () => setPage({ kind: 'detail', sessionId: s.id }) },
      { label: 'copy session id', onClick: () => void navigator.clipboard.writeText(s.id).catch(() => {}) },
      ...(s.hiddenBy !== undefined && s.hiddenBy !== 'archived'
        ? [{ label: 'unhide', onClick: () => void postMutation('/api/session', { op: 'unhide-session', sessionId: s.id, unhidden: true }) }]
        : []),
      s.hiddenBy === 'archived'
        ? { label: 'unarchive', onClick: () => void setArchived(s.id, false) }
        : { label: 'archive', onClick: () => void setArchived(s.id, true), danger: true },
    ]
  }

  const detail = page.kind === 'detail' ? view.byId.get(page.sessionId) : undefined

  return (
    <>
      <OverlayHeader>
        {page.kind !== 'sessions' && (
          <button
            onClick={() => setPage({ kind: 'sessions' })}
            title="back to sessions"
            className="flex h-[22px] items-center gap-1.5 rounded border border-b3 px-2 font-mono text-[10.5px] text-t3 hover:border-b6 hover:text-fg"
          >
            ‹ sessions
          </button>
        )}
        <span className="font-ui text-[14px] font-bold text-fg">{project.name}</span>
        <span className="min-w-0 truncate text-[10.5px] text-t5">
          {page.kind === 'settings' ? 'settings' : page.kind === 'detail' ? 'session' : dirs}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {page.kind === 'sessions' && (
            <>
              {FILTERS.filter((f) => f.id !== 'hidden' || count('hidden') > 0).map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setFilter(f.id)
                    clear()
                  }}
                  className={chipClass(filter === f.id)}
                >
                  {f.label} {count(f.id)}
                </button>
              ))}
              <button
                onClick={() => setPage({ kind: 'settings' })}
                title="project settings"
                className="ml-2 flex h-[22px] w-6 items-center justify-center rounded border border-b3 text-t3 hover:border-b6 hover:text-fg"
              >
                <GearIcon size={12} />
              </button>
            </>
          )}
          {props.close !== undefined && (
            <button
              onClick={props.close}
              className="pl-2 pr-0.5 text-[13px] text-t4 hover:text-fg"
              title="close"
            >
              ✕
            </button>
          )}
        </span>
      </OverlayHeader>

      {page.kind === 'settings' && (
        <ProjectSettings key={project.id} project={project} rail={view.rail} mutate={mutate} />
      )}

      {page.kind === 'detail' &&
        (detail !== undefined ? (
          <SessionDetail
            key={detail.id}
            session={detail}
            nowMs={nowMs}
            view={view}
            snapshot={snapshot}
            jump={(id) => setPage({ kind: 'detail', sessionId: id })}
          />
        ) : (
          <div className="p-8 text-center text-[11px] text-t5">that session is gone</div>
        ))}

      {page.kind === 'sessions' && (
        <>
          <div className="grid shrink-0 grid-cols-[28px_16px_minmax(0,1fr)_200px_80px_70px_70px] items-center gap-x-2.5 border-b border-b2 px-3.5 py-1.5 text-[9px] font-bold tracking-[.14em] text-t6">
            <span />
            <span />
            <span>SESSION</span>
            <span>ON THE DESK</span>
            <span>MODEL</span>
            <span className="text-right">LAST</span>
            <span className="text-right">SPENT</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
            {shown.map((r) => {
              const on = selected.has(r.id)
              const note = r.skipped ? skipNoteOf(r.id) : undefined
              return (
                <div
                  key={r.id}
                  onClick={() => {
                    const next = new Set(selected)
                    if (next.has(r.id)) next.delete(r.id)
                    else next.add(r.id)
                    setSelected(next)
                  }}
                  onDoubleClick={() => {
                    if (r.local !== undefined) setPage({ kind: 'detail', sessionId: r.id })
                  }}
                  onContextMenu={(e) => openMenu(e, menuOf(r))}
                  className={`grid cursor-pointer grid-cols-[28px_16px_minmax(0,1fr)_200px_80px_70px_70px] items-center gap-x-2.5 rounded px-1.5 py-[7px] select-none hover:bg-s4 ${
                    on ? 'bg-ac/8' : ''
                  }`}
                >
                  <span className={`text-center text-[12px] ${on ? 'text-ac' : 'text-t5'}`}>
                    {on ? '☑' : '☐'}
                  </span>
                  <Glyph kind={r.glyph} size={9} />
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-ui text-[12px] text-fg">{r.title}</span>
                      {r.branch !== undefined && (
                        <span className="text-[9.5px] whitespace-nowrap text-t5">⎇ {r.branch}</span>
                      )}
                      {r.local?.pr !== undefined && (
                        <a
                          href={r.local.pr.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className={`shrink-0 rounded border border-b4 px-1 text-[9.5px] whitespace-nowrap hover:border-b6 ${
                            r.local.pr.state === 'merged'
                              ? 'text-rev'
                              : r.local.pr.review === 'changes requested'
                                ? 'text-ask'
                                : 'text-t4'
                          }`}
                        >
                          {prLabel(r.local.pr)}
                        </a>
                      )}
                      {r.local?.forkedFrom !== undefined && (
                        <span className="shrink-0 rounded border border-b4 px-1 text-[9.5px] text-t5">fork</span>
                      )}
                      {r.local?.hiddenBy !== undefined && r.local.hiddenBy !== 'archived' && (
                        <span className="shrink-0 rounded bg-ask/15 px-1 text-[9.5px] text-ask">
                          {r.local.hiddenBy}
                        </span>
                      )}
                    </span>
                    {r.skipped && (
                      <span className="truncate text-[9.5px] text-rev">
                        skipped{note !== undefined ? ` — ${note}` : ''}
                      </span>
                    )}
                  </span>
                  <span className={`truncate text-[10px] ${r.where !== undefined ? 'text-t3' : 'text-t6'}`}>
                    {r.where !== undefined ? `⧉ ${r.where}` : '—'}
                  </span>
                  <span className="truncate text-[10px] text-t4">{r.model ?? ''}</span>
                  <span className="text-right text-[10px] text-t3">{formatAge(nowMs, r.lastIso || undefined)}</span>
                  <span className="text-right text-[10px] text-t3">
                    {r.cost !== undefined && r.cost >= 0.005 ? formatUsd(r.cost) : ''}
                  </span>
                </div>
              )
            })}
            {shown.length === 0 && <div className="p-8 text-center text-[11px] text-t5">none</div>}
          </div>
          {selIds.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5 border-t border-b2 bg-s1 px-3.5 py-2 text-[10.5px]">
              <span className="text-t2">{selIds.length} selected</span>
              {waitingSel.length > 0 && (
                <button
                  onClick={() => {
                    for (const r of waitingSel) {
                      if (r.local !== undefined) skipLocal(r.local)
                      else if (r.cloud !== undefined) skipCloud(r.cloud)
                    }
                    clear()
                  }}
                  className="ml-2 rounded border border-b4 px-2.5 py-[3px] text-t2 hover:border-rev hover:text-rev"
                >
                  skip
                </button>
              )}
              {filter === 'arch' ? (
                <button
                  onClick={() => {
                    void Promise.all(selIds.map((id) => setArchived(id, false))).then(clear)
                  }}
                  className="ml-2 rounded border border-b4 px-2.5 py-[3px] text-t2 hover:border-ac hover:text-fg"
                >
                  unarchive
                </button>
              ) : (
                <button
                  onClick={() => {
                    const locals = shown.filter((r) => selected.has(r.id) && r.local !== undefined)
                    void Promise.all(locals.map((r) => setArchived(r.id, true))).then(clear)
                  }}
                  className="ml-2 rounded border border-b4 px-2.5 py-[3px] text-t2 hover:border-ac hover:text-fg"
                >
                  archive
                </button>
              )}
              <span className="flex items-center gap-1 rounded border border-b4 px-2 py-[3px] text-t2">
                add to…
                {view.rail
                  .filter((p) => p.id !== project.id)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        void mutate({ op: 'include', id: p.id, sessionIds: selIds }).then((ok) => {
                          if (ok) clear()
                        })
                      }}
                      className="rounded-[3px] bg-s4 px-[7px] text-[10px] text-t3 hover:bg-s5 hover:text-fg"
                    >
                      {p.name}
                    </button>
                  ))}
              </span>
              <button
                onClick={() => {
                  void mutate({ op: 'exclude', id: project.id, sessionIds: selIds }).then((ok) => {
                    if (ok) clear()
                  })
                }}
                className="rounded border border-b4 px-2.5 py-[3px] text-t2 hover:border-err hover:text-err"
              >
                exclude from {project.name}
              </button>
              <button onClick={clear} className="ml-auto text-t5 hover:text-fg">
                clear
              </button>
            </div>
          )}
        </>
      )}
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </>
  )
}

/** The per-project counts the drawer shows: your turn (skips honored) and working. */
export function countsOfProject(
  view: View,
  project: RailProject,
  nowMs: number,
): { ask: number; run: number; total: number } {
  const cloud = view.cloudByProject.get(project.id) ?? []
  const ask =
    project.sessions.filter((s) => s.turn?.state === 'waiting' && !localSkipped(s, nowMs)).length +
    cloud.filter((c) => cloudNeedsYou(c) && !cloudSkipped(c, nowMs)).length
  const run =
    project.sessions.filter(
      (s) => s.turn?.state === 'working' || (s.turn === undefined && s.runtime.kind !== 'idle'),
    ).length + cloud.filter((c) => !cloudNeedsYou(c) && cloudRunning(c)).length
  return { ask, run, total: project.sessions.length + cloud.length }
}

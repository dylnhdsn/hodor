import { useMemo, useState } from 'react'
import type { CloudSession, Session, Snapshot } from '@hodor/core'
import { cloudNeedsYou, cloudRunning, messageCloud } from './CloudSessions.js'
import {
  launchOrCopy,
  matchesQuery,
  postMutation,
  statusOfSession,
  titleOf,
  formatAge,
  type RailProject,
  type View,
} from './data.js'
import { SESSION_DRAG_MIME, tileOf } from './Desk.js'
import { desktop } from './desktop.js'
import { promptText } from './dialog.js'
import { Glyph, glyphOfStatus, type GlyphKind } from './glyphs.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'
import { countsOfProject } from './ProjectOverlay.js'
import { cloudSkipped, localSkipped, skipItemsOf, skipItemsOfCloud } from './skips.js'

/**
 * The projects panel (v3 mock): a 264px drawer over the desk, or pinned
 * beside it. A search box over every session, then each project with its
 * your-turn and working counts; expanded, the sessions worth a glance —
 * your turn, working, or touched in the last two days. Click a session to
 * land on its tile (or its detail); right-click for the rest.
 */

const TWO_DAYS = 48 * 3600_000

interface GlanceRow {
  id: string
  local?: Session
  cloud?: CloudSession
  glyph: GlyphKind
  title: string
  age: string
  rank: number
  lastIso: string
  tip: string
}

export function ProjectsPanel(props: {
  view: View
  snapshot: Snapshot
  nowMs: number
  pinned: boolean
  onTogglePin: () => void
  expanded: ReadonlySet<string>
  toggleExpanded: (id: string) => void
  pinnedProjects: ReadonlySet<string>
  togglePinnedProject: (id: string) => void
  /** Open the project's overlay on a page. */
  openProject: (id: string, page: 'sessions' | 'settings') => void
  openSession: (projectId: string, sessionId: string) => void
  jumpToTile: (id: string) => void
  newSession: (project: RailProject) => void
  /** The browser build: which project the inline overlay shows. */
  selectedId?: string | undefined
}) {
  const { view, nowMs } = props
  const [query, setQuery] = useState('')
  const { menu, openMenu, closeMenu } = useContextMenu()
  const q = query.trim()

  const projects = useMemo(
    () =>
      [...view.rail].sort(
        (a, b) => Number(props.pinnedProjects.has(b.id)) - Number(props.pinnedProjects.has(a.id)),
      ),
    [view.rail, props.pinnedProjects],
  )

  const rowOf = (s: Session): GlanceRow => {
    const status = statusOfSession(s, localSkipped(s, nowMs))
    const t = tileOf(s.id)
    return {
      id: s.id,
      local: s,
      glyph: glyphOfStatus(status),
      title: titleOf(s),
      age: formatAge(nowMs, s.lastActivityAt) + (t !== undefined ? ` · ${t.workspace.name}` : ''),
      rank: status === 'needs-you' ? 0 : status === 'working' ? 1 : status === 'skipped' ? 2 : 3,
      lastIso: s.lastActivityAt ?? '',
      tip: `${s.cwd ?? ''}${s.gitBranch !== undefined ? `  ⎇ ${s.gitBranch}` : ''}`,
    }
  }
  const cloudRowOf = (c: CloudSession): GlanceRow => {
    const wants = cloudNeedsYou(c) && !cloudSkipped(c, nowMs)
    const t = tileOf(c.id)
    return {
      id: c.id,
      cloud: c,
      glyph: cloudNeedsYou(c) && cloudSkipped(c, nowMs) ? 'skipped' : 'cloud',
      title: c.title ?? c.repo ?? c.id.slice(0, 12),
      age: formatAge(nowMs, c.updatedAt) + (t !== undefined ? ` · ${t.workspace.name}` : ''),
      rank: wants ? 0 : cloudRunning(c) ? 1 : 3,
      lastIso: c.updatedAt ?? '',
      tip: c.needsAction ?? c.statusDetail ?? c.repo ?? '',
    }
  }
  const sortRows = (rows: GlanceRow[]): GlanceRow[] =>
    rows.sort((a, b) => a.rank - b.rank || b.lastIso.localeCompare(a.lastIso))

  /** Expanded: the sessions that matter now. Searching: every match. */
  const glanceOf = (p: RailProject): GlanceRow[] => {
    const cloud = view.cloudByProject.get(p.id) ?? []
    if (q !== '') {
      const ql = q.toLowerCase()
      return sortRows([
        ...p.sessions.filter((s) => matchesQuery(s, q)).map(rowOf),
        ...cloud
          .filter((c) => `${c.title ?? ''} ${c.repo ?? ''} ${c.branches.join(' ')} ${c.id}`.toLowerCase().includes(ql))
          .map(cloudRowOf),
      ])
    }
    return sortRows([
      ...p.sessions
        .filter(
          (s) =>
            s.turn?.state === 'waiting' ||
            s.turn?.state === 'working' ||
            (s.lastActivityAt !== undefined && nowMs - Date.parse(s.lastActivityAt) < TWO_DAYS),
        )
        .map(rowOf),
      ...cloud.filter((c) => cloudNeedsYou(c) || cloudRunning(c)).map(cloudRowOf),
    ])
  }

  const projectMenu = (p: RailProject): MenuItem[] => [
    { label: p.name, heading: true },
    { label: 'all sessions…', onClick: () => props.openProject(p.id, 'sessions') },
    { label: 'settings…', onClick: () => props.openProject(p.id, 'settings') },
    { label: `new session in ${p.name}…`, onClick: () => props.newSession(p) },
    ...(projectRootOf(p) !== undefined
      ? [
          {
            label: 'open a shell here',
            onClick: () => {
              const root = projectRootOf(p)!
              void launchOrCopy({ kind: 'shell', storeId: root.storeId, root: root.path })
            },
          },
        ]
      : []),
    { label: props.expanded.has(p.id) ? 'collapse' : 'expand', onClick: () => props.toggleExpanded(p.id) },
    { label: props.pinnedProjects.has(p.id) ? 'unpin' : 'pin to the top', onClick: () => props.togglePinnedProject(p.id) },
    {
      label: 'rename…',
      onClick: () =>
        void promptText('rename project', { initial: p.name, okLabel: 'rename' }).then((name) => {
          if (name !== undefined && name.trim() !== '') {
            void postMutation('/api/project', { op: 'rename-project', id: p.id, name: name.trim() })
          }
        }),
    },
    {
      label: 'archive project',
      danger: true,
      onClick: () => void postMutation('/api/project', { op: 'archive-project', id: p.id, archived: true }),
    },
  ]

  const rowMenu = (p: RailProject, r: GlanceRow): MenuItem[] => {
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
      {
        label: 'rename',
        onClick: () =>
          void promptText('rename session', { initial: titleOf(s), okLabel: 'rename' }).then((name) => {
            if (name !== undefined && name.trim() !== '') {
              void postMutation('/api/session', { op: 'rename-session', sessionId: s.id, name: name.trim() })
            }
          }),
      },
      ...skipItemsOf(s, nowMs),
      { label: 'session detail', onClick: () => props.openSession(p.id, s.id) },
      { label: 'copy session id', onClick: () => void navigator.clipboard.writeText(s.id).catch(() => {}) },
      {
        label: 'archive',
        danger: true,
        onClick: () => void postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived: true }),
      },
    ]
  }

  return (
    <div
      className={`flex w-[264px] shrink-0 flex-col border-r bg-s1 ${
        props.pinned ? 'relative border-b4' : 'absolute inset-y-0 left-0 z-[5] border-b4 shadow-[30px_0_60px_-20px_rgba(0,0,0,.8)]'
      }`}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-b1 px-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-b3 px-2 py-[3px] text-[10.5px] text-t5 focus-within:border-b6">
          <span>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="find a session…"
            className="min-w-0 flex-1 bg-transparent text-t1 outline-none placeholder:text-t5"
          />
          {q !== '' && (
            <button onClick={() => setQuery('')} className="text-t5 hover:text-fg" title="clear">
              ✕
            </button>
          )}
        </span>
        {desktop !== undefined && (
          <button
            onClick={props.onTogglePin}
            className="font-mono text-[10px] text-t5 hover:text-fg"
            title={props.pinned ? 'let it slide away' : 'keep it open beside the desk'}
          >
            {props.pinned ? 'unpin' : 'pin'}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <div className="px-3.5 pt-3 pb-1 text-[9px] font-bold tracking-[.16em] text-t6">PROJECTS</div>
        {projects.map((p) => {
          const c = countsOfProject(view, p, nowMs)
          const open = q !== '' || props.expanded.has(p.id)
          const rows = open ? glanceOf(p) : []
          if (q !== '' && rows.length === 0 && !p.name.toLowerCase().includes(q.toLowerCase())) return null
          const shown = rows.slice(0, q !== '' ? 30 : 12)
          return (
            <div key={p.id}>
              <div
                onClick={() => props.toggleExpanded(p.id)}
                onContextMenu={(e) => openMenu(e, projectMenu(p))}
                className={`flex cursor-pointer items-center gap-1.5 py-1.5 pr-3.5 pl-2.5 font-ui text-[12.5px] font-semibold select-none hover:bg-s3 ${
                  props.selectedId === p.id ? 'bg-s3' : ''
                } ${c.ask > 0 ? 'text-fg' : 'text-t2'} ${
                  props.pinnedProjects.has(p.id) ? 'border-l-2 border-ac/60 pl-[8px]' : ''
                }`}
              >
                <span className="w-2.5 font-mono text-[9px] text-t5">{open ? '▾' : '▸'}</span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {c.ask > 0 && <span className="font-mono text-[10px] font-bold text-ask">▲{c.ask}</span>}
                {c.run > 0 && <span className="font-mono text-[10px] text-run">●{c.run}</span>}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    props.openProject(p.id, 'sessions')
                  }}
                  className="font-mono text-[10px] font-normal text-t5 hover:text-fg"
                  title="all sessions"
                >
                  {c.total}
                </button>
              </div>
              {shown.map((r) => (
                <div
                  key={r.id}
                  title={r.tip}
                  draggable={r.local !== undefined}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      SESSION_DRAG_MIME,
                      JSON.stringify(
                        r.local !== undefined
                          ? { kind: 'resume', sessionId: r.id }
                          : { kind: 'teleport', sessionId: r.id },
                      ),
                    )
                  }}
                  onClick={() => {
                    if (tileOf(r.id) !== undefined) props.jumpToTile(r.id)
                    else if (r.local !== undefined) props.openSession(p.id, r.id)
                    else props.openProject(p.id, 'sessions')
                  }}
                  onContextMenu={(e) => openMenu(e, rowMenu(p, r))}
                  className="flex cursor-pointer items-center gap-2 py-1 pr-3.5 pl-[30px] text-[11px] text-t2 hover:bg-s3"
                >
                  <Glyph kind={r.glyph} size={8} />
                  <span className="min-w-0 flex-1 truncate font-ui">{r.title}</span>
                  <span className="text-[9.5px] whitespace-nowrap text-t5">{r.age}</span>
                </div>
              ))}
              {open && rows.length > shown.length && (
                <button
                  onClick={() => props.openProject(p.id, 'sessions')}
                  className="py-1 pl-[30px] text-left font-mono text-[10px] text-t6 hover:text-fg"
                >
                  +{rows.length - shown.length} more…
                </button>
              )}
              {open && q === '' && rows.length === 0 && (
                <div className="py-1 pl-[30px] font-mono text-[10px] text-t6">nothing recent</div>
              )}
            </div>
          )
        })}
        {projects.length === 0 && <p className="px-3.5 py-1 text-[11px] text-t5">no projects yet</p>}
      </div>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </div>
  )
}

/** The directory a project's shell opens in: a derived project's first
 * root; for a custom project the working directory of its newest session. */
export function projectRootOf(p: RailProject): { storeId: string; path: string } | undefined {
  const auto = p.auto?.roots[0]
  if (auto !== undefined) return { storeId: auto.storeId, path: auto.path }
  const recent = [...p.sessions]
    .filter((s) => s.cwd !== undefined)
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))[0]
  return recent?.cwd !== undefined ? { storeId: recent.storeId, path: recent.cwd } : undefined
}

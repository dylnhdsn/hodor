import { useEffect, useMemo, useState } from 'react'
import type { CustomProject, Matcher, Session, Snapshot } from '@hodor/core'
import {
  byRecency,
  cwdsOf,
  deriveView,
  fetchTranscript,
  formatAge,
  formatBytes,
  formatTokens,
  formatUsd,
  launchOrCopy,
  matchesQuery,
  postMutation,
  titleOf,
  type RailProject,
  type TranscriptEntry,
  type View,
} from './data.js'
import { Appearance } from './Appearance.js'
import { CloudSessionList } from './CloudSessions.js'
import { Desk, SESSION_DRAG_MIME } from './Desk.js'
import { desktop } from './desktop.js'
import { UpdatePill } from './UpdatePill.js'
import { useSnapshot } from './useSnapshot.js'
import { BootSplash, Wordmark } from './Wordmark.js'

type Filter =
  | { kind: 'all' }
  | { kind: 'project'; id: string }
  | { kind: 'archived' }
  | { kind: 'hidden' }
  | { kind: 'appearance' }
  | { kind: 'desk' }

export function App() {
  const { snapshot, connected } = useSnapshot()
  if (snapshot === undefined) {
    return <BootSplash desk={desktop !== undefined} />
  }
  return <Main snapshot={snapshot} connected={connected} />
}

function Main(props: { snapshot: Snapshot; connected: boolean }) {
  const { snapshot, connected } = props
  // Desktop opens onto the desk (the workspace IS the app there); the web
  // build has no PTYs, so the library is the app.
  const [filter, setFilter] = useState<Filter>(
    desktop !== undefined ? { kind: 'desk' } : { kind: 'all' },
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | undefined>(undefined)

  const view = useMemo(() => deriveView(snapshot), [snapshot])
  const nowMs = Date.parse(snapshot.generatedAt)

  const project = filter.kind === 'project' ? view.rail.find((p) => p.id === filter.id) : undefined

  const sessions = useMemo(() => {
    let list: Session[]
    switch (filter.kind) {
      case 'all':
        list = view.visible
        break
      case 'project':
        list = project?.sessions ?? []
        break
      case 'hidden':
        list = view.hidden
        break
      case 'archived':
      case 'appearance':
      case 'desk':
        list = []
        break
    }
    if (query.trim().length > 0) list = list.filter((s) => matchesQuery(s, query.trim()))
    return byRecency(list)
  }, [view, filter, project, query])

  // Cloud sessions shown alongside the local list — counted with it, so the
  // rail and header numbers match what's actually on the page.
  const cloudShown = useMemo(() => {
    if (filter.kind !== 'all' && filter.kind !== 'project') return []
    const base = filter.kind === 'all' ? view.cloud : (view.cloudByProject.get(filter.id) ?? [])
    const q = query.trim().toLowerCase()
    if (q.length === 0) return base
    return base.filter((c) =>
      `${c.title ?? ''} ${c.repo ?? ''} ${c.branches.join(' ')} ${c.id}`.toLowerCase().includes(q),
    )
  }, [view, filter, query])

  const customNames = new Map(
    snapshot.customProjects.filter((p) => p.archived !== true).map((p) => [p.id, p.name]),
  )

  // Where "+ new session" launches: the project's first known root.
  const newSessionTarget = useMemo(() => {
    if (project === undefined) return undefined
    const root = project.auto?.roots[0]
    if (root !== undefined) return { storeId: root.storeId, root: root.path }
    for (const s of project.sessions) {
      const derivedRoot = view.derivedOf.get(s.id)?.roots[0]
      if (derivedRoot !== undefined) return { storeId: derivedRoot.storeId, root: derivedRoot.path }
      if (s.cwd !== undefined) return { storeId: s.storeId, root: s.cwd }
    }
    return undefined
  }, [project, view])

  // Mutations that target a project follow the id the server answers with —
  // editing an auto project materializes it under a new (custom) id.
  async function mutateProject(body: Record<string, unknown>): Promise<boolean> {
    const result = await postMutation('/api/project', body)
    if (!result.ok) {
      window.alert(result.error ?? 'failed')
      return false
    }
    if (typeof result.id === 'string' && filter.kind === 'project' && result.id !== filter.id) {
      setFilter({ kind: 'project', id: result.id })
    }
    return true
  }

  async function createProject() {
    const name = window.prompt('New project name')
    if (name === null || name.trim().length === 0) return
    const result = await postMutation('/api/project', { op: 'create-project', name: name.trim() })
    if (!result.ok) window.alert(result.error ?? 'failed')
    else if (typeof result.id === 'string') setFilter({ kind: 'project', id: result.id })
  }

  function toggleSelected(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <div className="flex h-full flex-col bg-app font-ui text-sm text-t1">
      {(snapshot.organize?.errors.length ?? 0) > 0 && (
        <div className="border-b border-ask/45 bg-ask/10 px-4 py-1 text-xs text-ask">
          organize logic: {snapshot.organize!.errors[0]}
          {snapshot.organize!.errors.length > 1
            ? ` (+${snapshot.organize!.errors.length - 1} more)`
            : ''}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-b1">
        <div className="flex items-center gap-2 px-4 py-3 text-fg">
          <Wordmark height={15} />
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'bg-run' : 'bg-b6'}`}
            title={connected ? 'live' : 'reconnecting'}
          />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          <RailItem
            label="All sessions"
            count={view.visible.length + view.cloud.length}
            active={filter.kind === 'all'}
            onClick={() => setFilter({ kind: 'all' })}
          />

          <RailHeading>
            projects
            <button
              onClick={() => void createProject()}
              className="rounded px-1.5 text-t3 hover:bg-s5 hover:text-fg"
              title="New project"
            >
              +
            </button>
          </RailHeading>
          {view.rail.map((p) => (
            <RailItem
              key={p.id}
              label={p.name}
              count={p.sessions.length + (view.cloudByProject.get(p.id)?.length ?? 0)}
              active={filter.kind === 'project' && filter.id === p.id}
              onClick={() => {
                setFilter({ kind: 'project', id: p.id })
                setSelected(new Set())
              }}
            />
          ))}
          {view.rail.length === 0 && (
            <p className="px-3 py-1 text-xs text-t5">none yet — press +</p>
          )}

          {desktop !== undefined && (
            <>
              <RailHeading>workspace</RailHeading>
              <button
                onClick={() => setFilter({ kind: 'desk' })}
                className={`flex w-full items-center justify-between rounded px-3 py-1.5 text-left ${
                  filter.kind === 'desk' ? 'bg-ac/12 text-fg' : 'text-t1 hover:bg-s3'
                }`}
              >
                <span>the desk</span>
                <span className="font-mono text-[10px] text-t4">autosaved</span>
              </button>
            </>
          )}
        </nav>

        <UpdatePill />
        <div className="border-t border-b1 text-xs">
          {view.archivedProjects.length > 0 && (
            <button
              onClick={() => setFilter({ kind: 'archived' })}
              className={`block w-full px-4 py-2 text-left ${
                filter.kind === 'archived' ? 'text-ask' : 'text-t4 hover:text-t2'
              }`}
            >
              {view.archivedProjects.length} archived project
              {view.archivedProjects.length === 1 ? '' : 's'}
            </button>
          )}
          <button
            onClick={() => setFilter({ kind: 'hidden' })}
            className={`block w-full px-4 pb-2 text-left ${
              view.archivedProjects.length === 0 ? 'pt-2' : ''
            } ${filter.kind === 'hidden' ? 'text-ask' : 'text-t4 hover:text-t2'}`}
          >
            {view.hidden.length} hidden sessions
          </button>
          <button
            onClick={() => setFilter({ kind: 'appearance' })}
            className={`block w-full px-4 pb-2 text-left ${
              filter.kind === 'appearance' ? 'text-ach' : 'text-t4 hover:text-t2'
            }`}
          >
            ⚙ appearance
          </button>
          {snapshot.hodorVersion !== undefined && (
            <p
              className="px-4 pb-2 font-mono text-[10px] text-t6"
              title="the build serving this UI"
            >
              {snapshot.hodorVersion}
            </p>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {filter.kind === 'desk' ? (
          <div className="flex min-h-0 flex-1">
            <Desk inspect={(id) => setDetailId(id)} />
            {detailId !== undefined && view.byId.has(detailId) && (
              <DetailPane
                key={detailId}
                session={view.byId.get(detailId)!}
                nowMs={nowMs}
                view={view}
                snapshot={snapshot}
                jump={(id) => setDetailId(id)}
                close={() => setDetailId(undefined)}
              />
            )}
          </div>
        ) : filter.kind === 'appearance' ? (
          <Appearance />
        ) : filter.kind === 'archived' ? (
          <ArchivedList view={view} mutateProject={mutateProject} />
        ) : (
          <>
            <header className="border-b border-b1 px-4 py-2">
              <div className="flex items-center gap-3">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search titles, prompts, paths, ids… (has:agents, is:fork)"
                  className="w-full max-w-md rounded border border-b1 bg-s3 px-3 py-1.5 text-sm outline-none placeholder:text-t5 focus:border-b6"
                />
                <span className="ml-auto whitespace-nowrap text-xs text-t4">
                  {sessions.length + cloudShown.length} session
                  {sessions.length + cloudShown.length === 1 ? '' : 's'}
                </span>
                {project !== undefined && (
                  <button
                    onClick={() => {
                      setSettingsOpen(!settingsOpen)
                      setDetailId(undefined)
                    }}
                    className={`whitespace-nowrap rounded border px-2 py-1 text-xs ${
                      settingsOpen
                        ? 'border-acb text-fg'
                        : 'border-b4 text-t3 hover:text-fg'
                    }`}
                  >
                    settings
                  </button>
                )}
              </div>
              {project !== undefined && (
                <ProjectStats project={project} nowMs={nowMs} newSession={newSessionTarget} />
              )}
            </header>

            {selected.size > 0 && (
              <BulkBar
                selected={selected}
                clear={() => setSelected(new Set())}
                rail={view.rail}
                currentProject={project}
                mutateProject={mutateProject}
              />
            )}

            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              {filter.kind === 'all' || filter.kind === 'project' ? (
                <CloudSessionList
                  sessions={cloudShown}
                  nowMs={nowMs}
                  projectOf={filter.kind === 'all' ? view.cloudProjectOf : undefined}
                  openProject={(id) => {
                    setFilter({ kind: 'project', id })
                    setSelected(new Set())
                  }}
                />
              ) : null}
              <ul className="min-w-0 flex-1 divide-y divide-b2">
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    nowMs={nowMs}
                    view={view}
                    customNames={customNames}
                    rail={view.rail}
                    showHiddenBy={filter.kind === 'hidden'}
                    checked={selected.has(s.id)}
                    anySelected={selected.size > 0}
                    inspecting={detailId === s.id}
                    toggle={() => toggleSelected(s.id)}
                    open={() => {
                      setDetailId(detailId === s.id ? undefined : s.id)
                      setSettingsOpen(false)
                    }}
                    mutateProject={mutateProject}
                  />
                ))}
                {sessions.length === 0 && cloudShown.length === 0 && (
                  <li className="px-4 py-8 text-center text-t5">nothing here</li>
                )}
              </ul>
              </div>
              {detailId !== undefined && view.byId.has(detailId) ? (
                <DetailPane
                  key={detailId}
                  session={view.byId.get(detailId)!}
                  nowMs={nowMs}
                  view={view}
                  snapshot={snapshot}
                  jump={(id) => setDetailId(id)}
                  close={() => setDetailId(undefined)}
                />
              ) : settingsOpen && project !== undefined ? (
                <SettingsPanel
                  key={project.id}
                  project={project}
                  rail={view.rail}
                  mutateProject={mutateProject}
                />
              ) : undefined}
            </div>
          </>
        )}
      </main>
      </div>
    </div>
  )
}

function RailHeading(props: { children: React.ReactNode }) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-3 text-[11px] font-medium tracking-wider text-t4 uppercase">
      {props.children}
    </div>
  )
}

function RailItem(props: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex w-full items-center justify-between rounded px-3 py-1.5 text-left ${
        props.active ? 'bg-s5 text-fg' : 'text-t1 hover:bg-s3'
      }`}
    >
      <span className="truncate">{props.label}</span>
      <span className="ml-2 shrink-0 text-xs text-t4">{props.count}</span>
    </button>
  )
}

function ProjectStats(props: {
  project: RailProject
  nowMs: number
  newSession?: { storeId: string; root: string } | undefined
}) {
  const { project, nowMs, newSession } = props
  const active = project.sessions.filter((s) => s.runtime.kind !== 'idle').length
  const latest = project.sessions
    .map((s) => s.lastActivityAt ?? '')
    .reduce((a, b) => (a > b ? a : b), '')
  const cost = project.sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
  const roots = cwdsOf(project.sessions)
  return (
    <div className="mt-1.5 flex items-center gap-3 text-xs text-t4">
      <span className="font-medium text-t2">{project.name}</span>
      {newSession !== undefined && (
        <button
          onClick={() => void launchOrCopy({ kind: 'new', ...newSession })}
          className="text-run hover:text-run"
          title={`open a terminal running claude in ${newSession.root}`}
        >
          + new session
        </button>
      )}
      {active > 0 && <span className="text-run">{active} active</span>}
      {latest !== '' && <span>last {formatAge(nowMs, latest)}</span>}
      {cost >= 0.005 && <span className="text-t3">~{formatUsd(cost)}</span>}
      {roots.length > 0 && (
        <span className="truncate text-t5">
          {roots[0]}
          {roots.length > 1 ? ` +${roots.length - 1} more` : ''}
        </span>
      )}
    </div>
  )
}

function BulkBar(props: {
  selected: ReadonlySet<string>
  clear: () => void
  rail: RailProject[]
  currentProject: RailProject | undefined
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { selected, clear, rail, currentProject, mutateProject } = props
  const ids = [...selected]

  async function archiveAll() {
    for (const sessionId of ids) {
      await postMutation('/api/session', { op: 'archive-session', sessionId, archived: true })
    }
    clear()
  }

  async function addTo(projectId: string) {
    if (projectId === '') return
    if (await mutateProject({ op: 'include', id: projectId, sessionIds: ids })) clear()
  }

  async function excludeHere() {
    if (currentProject === undefined) return
    if (await mutateProject({ op: 'exclude', id: currentProject.id, sessionIds: ids })) clear()
  }

  return (
    <div className="flex items-center gap-3 border-b border-b1 bg-s3/60 px-4 py-1.5 text-xs">
      <span className="text-t2">{ids.length} selected</span>
      <button onClick={() => void archiveAll()} className="text-t3 hover:text-fg">
        archive
      </button>
      <select
        defaultValue=""
        onChange={(e) => {
          void addTo(e.target.value)
          e.target.value = ''
        }}
        className="rounded border border-b4 bg-s3 px-1 py-0.5 text-t3"
      >
        <option value="">add to…</option>
        {rail.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {currentProject !== undefined && (
        <button onClick={() => void excludeHere()} className="text-t3 hover:text-fg">
          exclude from {currentProject.name}
        </button>
      )}
      <button onClick={clear} className="ml-auto text-t4 hover:text-t2">
        clear
      </button>
    </div>
  )
}

function ArchivedList(props: {
  view: View
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { view, mutateProject } = props
  return (
    <ul className="flex-1 divide-y divide-b2 overflow-y-auto">
      {view.archivedProjects.map((p) => {
        const count = (view.sessionsOfArchived.get(p.id) ?? []).length
        return (
          <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="font-medium text-t2">{p.name}</span>
            <span className="text-xs text-t4">
              {count} session{count === 1 ? '' : 's'} hidden with it
            </span>
            <span className="ml-auto flex gap-3 text-xs">
              <button
                onClick={() => void mutateProject({ op: 'archive-project', id: p.id, archived: false })}
                className="text-t3 hover:text-fg"
              >
                unarchive
              </button>
              {p.derivedFrom !== undefined && (
                <button
                  onClick={() => {
                    if (window.confirm(`Revert "${p.name}" to automatic grouping?`)) {
                      void mutateProject({ op: 'delete-project', id: p.id })
                    }
                  }}
                  className="text-t4 hover:text-t2"
                >
                  revert to auto
                </button>
              )}
            </span>
          </li>
        )
      })}
      {view.archivedProjects.length === 0 && (
        <li className="px-4 py-8 text-center text-t5">no archived projects</li>
      )}
    </ul>
  )
}

function SessionRow(props: {
  session: Session
  nowMs: number
  view: View
  customNames: Map<string, string>
  rail: RailProject[]
  showHiddenBy: boolean
  checked: boolean
  anySelected: boolean
  inspecting: boolean
  toggle: () => void
  open: () => void
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { session: s, nowMs, view, customNames, rail, showHiddenBy } = props
  const { checked, anySelected, inspecting, toggle, open, mutateProject } = props
  const active = s.runtime.kind !== 'idle'
  const claims = view.claimsBySession.get(s.id) ?? []
  const derived = view.derivedOf.get(s.id)

  async function addTo(projectId: string) {
    if (projectId === '') return
    await mutateProject({ op: 'include', id: projectId, sessionIds: [s.id] })
  }

  async function rename() {
    const name = window.prompt('Rename session', titleOf(s))
    if (name === null || name.trim().length === 0) return
    await postMutation('/api/session', { op: 'rename-session', sessionId: s.id, name: name.trim() })
  }

  async function setArchived(archived: boolean) {
    await postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived })
  }

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <li
      onClick={open}
      draggable={desktop !== undefined}
      onDragStart={(e) => {
        // Drop onto a desk zone to open the session there.
        e.dataTransfer.setData(
          SESSION_DRAG_MIME,
          JSON.stringify({ kind: 'resume', sessionId: s.id }),
        )
      }}
      className={`group cursor-pointer px-4 py-2 ${inspecting ? 'bg-s3' : 'hover:bg-s3/60'}`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={toggle}
          onClick={stop}
          className={`h-3 w-3 shrink-0 accent-ac ${
            anySelected ? '' : 'opacity-0 transition group-hover:opacity-100'
          }`}
        />
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-run' : 'bg-b4'}`} />
        <span className="truncate font-medium text-fg">{titleOf(s)}</span>
        {claims.map((id) => (
          <span
            key={id}
            className="shrink-0 rounded-full bg-ac/15 px-2 py-0.5 text-[11px] text-acb"
          >
            {customNames.get(id) ?? id}
          </span>
        ))}
        <span
          onClick={stop}
          className="ml-auto flex shrink-0 items-center gap-2 opacity-0 transition group-hover:opacity-100"
        >
          <select
            defaultValue=""
            onChange={(e) => {
              void addTo(e.target.value)
              e.target.value = ''
            }}
            className="rounded border border-b4 bg-s3 px-1 py-0.5 text-[11px] text-t3"
          >
            <option value="">add to…</option>
            {rail
              .filter((p) => !claims.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button
            onClick={() => void launchOrCopy({ kind: 'resume', sessionId: s.id })}
            className="text-[11px] text-run hover:text-run"
            title="open a terminal resuming this session"
          >
            resume
          </button>
          <button
            onClick={() => void launchOrCopy({ kind: 'fork', sessionId: s.id })}
            className="text-[11px] text-t4 hover:text-t1"
            title="resume as a new forked session"
          >
            fork
          </button>
          <button onClick={() => void rename()} className="text-[11px] text-t4 hover:text-t1">
            rename
          </button>
          {s.hiddenBy === 'archived' ? (
            <button onClick={() => void setArchived(false)} className="text-[11px] text-t4 hover:text-t1">
              unarchive
            </button>
          ) : (
            <button onClick={() => void setArchived(true)} className="text-[11px] text-t4 hover:text-t1">
              archive
            </button>
          )}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-7 text-xs text-t4">
        <span className="font-mono">{s.id.slice(0, 8)}</span>
        <span>{formatAge(nowMs, s.lastActivityAt)}</span>
        {s.costUsd !== undefined && s.costUsd >= 0.01 && (
          <span className="text-t3" title="estimated cost">
            {formatUsd(s.costUsd)}
          </span>
        )}
        {s.counts.sidechains > 0 && (
          <span className="rounded bg-s5 px-1.5 text-[11px] text-t3" title="subagent runs">
            ⑂ {s.counts.sidechains}
          </span>
        )}
        {s.forkedFrom !== undefined && (
          <span className="rounded bg-s5 px-1.5 text-[11px] text-t3" title="forked session">
            fork
          </span>
        )}
        {derived !== undefined && <span className="truncate text-t5">{derived.name}</span>}
        <span className="truncate">{s.cwd}</span>
        {showHiddenBy && s.hiddenBy !== undefined && (
          <span className="rounded bg-ask/15 px-1.5 text-[11px] text-ask">{s.hiddenBy}</span>
        )}
      </div>
    </li>
  )
}

// ---------- session detail pane ----------

function DetailPane(props: {
  session: Session
  nowMs: number
  view: View
  snapshot: Snapshot
  jump: (id: string) => void
  close: () => void
}) {
  const { session: s, nowMs, view, snapshot, jump, close } = props
  const [tail, setTail] = useState<TranscriptEntry[] | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setTail(undefined)
    void fetchTranscript(s.id, 12).then((messages) => {
      if (!cancelled) setTail(messages)
    })
    return () => {
      cancelled = true
    }
    // refetch when activity moves, so an open pane follows a live session
  }, [s.id, s.lastActivityAt])

  const sidechains = s.threads.filter((t) => t.kind === 'sidechain')
  const placements = view.placementsBySession.get(s.id) ?? []
  const derived = view.derivedOf.get(s.id)
  const memoryRoots = new Set([...(derived?.roots.map((r) => r.path) ?? []), ...s.cwds])
  const memoryFiles = snapshot.memoryFiles.filter((f) => !f.userLevel && memoryRoots.has(f.root))
  const ancestor = s.forkedFrom !== undefined ? view.byId.get(s.forkedFrom) : undefined
  const forks = view.forksOf.get(s.id) ?? []
  const projectName = (id: string) => snapshot.customProjects.find((p) => p.id === id)?.name ?? id
  const isArchivedProject = (id: string) =>
    snapshot.customProjects.find((p) => p.id === id)?.archived === true

  async function rename() {
    const name = window.prompt('Rename session', titleOf(s))
    if (name === null || name.trim().length === 0) return
    await postMutation('/api/session', { op: 'rename-session', sessionId: s.id, name: name.trim() })
  }

  return (
    <div className="w-96 shrink-0 overflow-y-auto border-l border-b1 px-4 py-3 text-xs">
      <div className="mb-1 flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold break-words text-fg">
          {titleOf(s)}
        </h2>
        <button onClick={close} className="shrink-0 px-1 text-t4 hover:text-t1">
          ✕
        </button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-t4">
        <span className="font-mono">{s.id.slice(0, 8)}</span>
        <button
          onClick={() => void launchOrCopy({ kind: 'resume', sessionId: s.id })}
          className="text-run hover:text-run"
          title="open a terminal resuming this session"
        >
          resume
        </button>
        <button
          onClick={() => void launchOrCopy({ kind: 'fork', sessionId: s.id })}
          className="text-t4 hover:text-t1"
          title="resume as a new forked session"
        >
          fork
        </button>
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(`cd ${JSON.stringify(s.cwds[0] ?? s.cwd ?? '.')} && claude --resume ${s.id}`)
              .catch(() => {})
          }
          className="text-t5 hover:text-t2"
          title="copy the resume command"
        >
          copy cmd
        </button>
        <button
          onClick={() => void navigator.clipboard.writeText(s.id).catch(() => {})}
          className="text-t5 hover:text-t2"
        >
          copy id
        </button>
        <button onClick={() => void rename()} className="text-t5 hover:text-t2">
          rename
        </button>
        {s.hiddenBy === 'archived' ? (
          <button
            onClick={() =>
              void postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived: false })
            }
            className="text-t5 hover:text-t2"
          >
            unarchive
          </button>
        ) : (
          <button
            onClick={() =>
              void postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived: true })
            }
            className="text-t5 hover:text-t2"
          >
            archive
          </button>
        )}
      </div>

      {s.hiddenBy !== undefined && (
        <p className="mb-3 rounded bg-ask/10 px-2 py-1 text-ask">
          hidden — {s.hiddenBy}
        </p>
      )}

      <Section title="facts">
        <Fact label="last activity" value={formatAge(nowMs, s.lastActivityAt)} />
        <Fact label="created" value={formatAge(nowMs, s.createdAt)} />
        <Fact label="messages" value={`${s.counts.user} you · ${s.counts.assistant} claude`} />
        {s.counts.toolCalls > 0 && <Fact label="tool calls" value={String(s.counts.toolCalls)} />}
        {s.gitBranch !== undefined && <Fact label="branch" value={s.gitBranch} />}
        <Fact label="entrypoint" value={s.entrypoints.join(', ') || '-'} />
        {s.slug !== undefined && <Fact label="slug" value={s.slug} mono />}
        {s.effort !== undefined && <Fact label="effort" value={s.effort} />}
        {s.fastMode === true && <Fact label="speed" value="fast mode used" />}
        {s.serviceTier !== undefined && s.serviceTier !== 'standard' && (
          <Fact label="tier" value={s.serviceTier} />
        )}
        {s.inferenceGeo !== undefined && <Fact label="inference geo" value={s.inferenceGeo} />}
        {s.contextTokens !== undefined && (
          <Fact label="context" value={`${formatTokens(s.contextTokens)} tokens`} />
        )}
        {s.compactions !== undefined && (
          <Fact
            label="compactions"
            value={
              s.lastCompaction?.preTokens !== undefined && s.lastCompaction.postTokens !== undefined
                ? `${s.compactions}× (last ${formatTokens(s.lastCompaction.preTokens)} → ${formatTokens(s.lastCompaction.postTokens)})`
                : `${s.compactions}×`
            }
          />
        )}
        {s.checkpoints !== undefined && (
          <Fact
            label="checkpoints"
            value={`${s.checkpoints.count} · ${s.checkpoints.files.length} files${
              s.checkpoints.backupFiles === undefined
                ? ''
                : s.checkpoints.backupFiles > 0
                  ? ' · restorable'
                  : ' · backups gone'
            }`}
          />
        )}
        {s.cliVersion !== undefined && <Fact label="cli" value={s.cliVersion} />}
        {memoryFiles.length > 0 && (
          <Fact
            label="memory"
            value={memoryFiles.map((f) => `${f.name} ${formatBytes(f.bytes)}`).join(' · ')}
          />
        )}
        <Fact label="cwd" value={s.cwd ?? '-'} mono />
        {s.apiErrors !== undefined && (
          <div className="flex justify-between gap-3 py-0.5">
            <span className="shrink-0 text-t5">api errors</span>
            <span className="text-ask">{s.apiErrors}</span>
          </div>
        )}
      </Section>

      {s.toolCounts !== undefined && <ToolsSection toolCounts={s.toolCounts} />}

      {s.hooks !== undefined && (
        <Section title="hooks">
          {Object.entries(s.hooks).map(([command, h]) => (
            <div key={command} className="flex items-center justify-between gap-2 py-0.5">
              <span className="min-w-0 truncate font-mono text-t3" title={command}>
                {command.split('/').pop()}
              </span>
              <span className="shrink-0 text-t5">
                {h.runs}× · {h.totalMs >= 1000 ? `${(h.totalMs / 1000).toFixed(1)}s` : `${h.totalMs}ms`}
              </span>
            </div>
          ))}
          {(s.hookErrors !== undefined || s.hookBlocks !== undefined) && (
            <p className="mt-1 text-ask">
              {s.hookErrors !== undefined ? `${s.hookErrors} error${s.hookErrors === 1 ? '' : 's'}` : ''}
              {s.hookErrors !== undefined && s.hookBlocks !== undefined ? ' · ' : ''}
              {s.hookBlocks !== undefined ? `blocked continuation ${s.hookBlocks}×` : ''}
            </p>
          )}
        </Section>
      )}

      {s.usage !== undefined && (
        <Section title="usage">
          {Object.entries(s.usage).map(([model, u]) => (
            <div key={model} className="py-0.5">
              <div className="text-t2">{model.replace(/^claude-/, '')}</div>
              <div className="pl-2 text-t4">
                in {formatTokens(u.input)} · out {formatTokens(u.output)}
                {u.thinking > 0 && <> (think {formatTokens(u.thinking)})</>} · cache read{' '}
                {formatTokens(u.cacheRead)} · cache write {formatTokens(u.cacheWrite5m + u.cacheWrite1h)}
              </div>
            </div>
          ))}
          {s.costUsd !== undefined && (
            <div className="mt-1 border-t border-b1 pt-1 text-t2">
              est. cost {formatUsd(s.costUsd)}
              {(s.costUnpriced ?? []).length > 0 && (
                <span className="text-ask"> + unpriced: {s.costUnpriced!.join(', ')}</span>
              )}
            </div>
          )}
        </Section>
      )}

      {(ancestor !== undefined || s.forkedFrom !== undefined || forks.length > 0) && (
        <Section title="lineage">
          {s.forkedFrom !== undefined && (
            <div className="py-0.5">
              forked from{' '}
              {ancestor !== undefined ? (
                <button onClick={() => jump(ancestor.id)} className="text-acb hover:underline">
                  {titleOf(ancestor)}
                </button>
              ) : (
                <span className="font-mono text-t4">{s.forkedFrom.slice(0, 8)} (gone)</span>
              )}
            </div>
          )}
          {forks.map((fork) => (
            <div key={fork.id} className="py-0.5">
              fork:{' '}
              <button onClick={() => jump(fork.id)} className="text-acb hover:underline">
                {titleOf(fork)}
              </button>
            </div>
          ))}
        </Section>
      )}

      {sidechains.length > 0 && (
        <Section title={`subagents (${sidechains.length})`}>
          {sidechains.map((t) => (
            <div key={t.id} className="py-0.5">
              <div className="flex items-center justify-between text-t3">
                <span>
                  ⑂ {t.agentType ?? 'agent'} · {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                  {t.costUsd !== undefined && t.costUsd >= 0.005 && (
                    <span className="text-t4"> · {formatUsd(t.costUsd)}</span>
                  )}
                </span>
                <span className="text-t5">{formatAge(nowMs, t.lastTs)}</span>
              </div>
              {t.description !== undefined && (
                <div className="truncate pl-4 text-t5">{t.description}</div>
              )}
            </div>
          ))}
        </Section>
      )}

      <Section title="projects">
        {placements.map((p) => (
          <div key={p.customProjectId} className="py-0.5">
            <span className="text-t2">{projectName(p.customProjectId)}</span>
            {isArchivedProject(p.customProjectId) && <span className="text-ask"> (archived)</span>}
            <span className="text-t5">
              {' — '}
              {p.via === 'include'
                ? 'pinned by you'
                : p.via === 'organize'
                  ? 'your organize logic'
                  : `${p.via.kind}=${matcherValue(p.via)}`}
            </span>
          </div>
        ))}
        {derived !== undefined && (
          <div className="py-0.5 text-t4">
            auto: {derived.name}
            <span className="text-t5">
              {' — '}
              {derived.identity.kind === 'git-remote'
                ? `remote ${derived.identity.url}`
                : `path ${derived.identity.root}`}
            </span>
          </div>
        )}
        {placements.length === 0 && derived === undefined && (
          <p className="text-t5">not grouped anywhere</p>
        )}
      </Section>

      <Section title="conversation">
        {tail === undefined && <p className="text-t5">loading…</p>}
        {tail !== undefined && tail.length === 0 && (
          <p className="text-t5">nothing readable in the transcript</p>
        )}
        {tail?.map((entry, i) => (
          <div key={i} className={`py-1 ${entry.isSidechain ? 'opacity-60' : ''}`}>
            <span
              className={`mr-1.5 font-medium ${
                entry.type === 'user' ? 'text-acb' : 'text-run'
              }`}
            >
              {entry.isSidechain ? '⑂ ' : ''}
              {entry.type === 'user' ? 'you' : 'claude'}
            </span>
            <span className="text-t3">{entry.text}</span>
          </div>
        ))}
      </Section>
    </div>
  )
}

function ToolsSection(props: { toolCounts: Record<string, number> }) {
  const entries = Object.entries(props.toolCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = entries.slice(0, 10)
  const rest = entries.length - shown.length
  const max = shown[0]?.[1] ?? 1
  return (
    <Section title="tools">
      {shown.map(([name, n]) => (
        <div key={name} className="flex items-center gap-2 py-0.5">
          <span className="w-36 shrink-0 truncate text-t3">{name}</span>
          <div className="h-1.5 min-w-0 flex-1 rounded bg-s3">
            <div
              className="h-1.5 rounded bg-ac/40"
              style={{ width: `${Math.max(3, Math.round((n / max) * 100))}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-t4">{n}</span>
        </div>
      ))}
      {rest > 0 && <p className="text-t5">+{rest} more</p>}
    </Section>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="shrink-0 text-t5">{props.label}</span>
      <span className={`truncate text-t2 ${props.mono === true ? 'font-mono' : ''}`}>
        {props.value}
      </span>
    </div>
  )
}

// ---------- settings panel ----------

// Mirrors core describeMatcher (the core barrel can't load in a browser).
const matcherValue = (m: Matcher): string => {
  switch (m.kind) {
    case 'remote':
      return m.url
    case 'root':
    case 'dir':
      return m.path
    case 'cwd':
      return m.prefix
    case 'session':
      return m.id
    case 'branch':
      return m.glob
    case 'title':
    case 'model':
      return m.match
    case 'entrypoint':
      return m.value
    case 'all':
    case 'any':
      return m.of.map((x) => `${x.kind}=${matcherValue(x)}`).join(', ')
    case 'not':
      return `${m.of.kind}=${matcherValue(m.of)}`
  }
}

function statusOf(project: RailProject): string {
  if (project.kind === 'auto') return 'Derived automatically. Any edit makes it yours.'
  const custom = project.custom as CustomProject
  if (custom.derivedFrom !== undefined) return `Customized — materialized from ${custom.derivedFrom}.`
  return 'Created by you.'
}

function SettingsPanel(props: {
  project: RailProject
  rail: RailProject[]
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { project, rail, mutateProject } = props
  const custom = project.custom
  const [name, setName] = useState(project.name)

  return (
    <div className="w-80 shrink-0 overflow-y-auto border-l border-b1 px-4 py-3 text-xs">
      <p className="mb-3 text-t4">{statusOf(project)}</p>

      <Section title="name">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-b1 bg-s3 px-2 py-1 outline-none focus:border-b6"
          />
          <button
            onClick={() => {
              if (name.trim().length > 0 && name.trim() !== project.name) {
                void mutateProject({ op: 'rename-project', id: project.id, name: name.trim() })
              }
            }}
            className="rounded border border-b4 px-2 text-t3 hover:text-fg"
          >
            save
          </button>
        </div>
      </Section>

      <Section title="matchers">
        {custom !== undefined &&
          custom.matchers.map((m, i) => (
            <MatcherRow
              key={i}
              matcher={m}
              onRemove={() => void mutateProject({ op: 'remove-matcher', id: project.id, matcher: m })}
            />
          ))}
        {custom !== undefined && custom.matchers.length === 0 && (
          <p className="text-t5">none — only pinned sessions</p>
        )}
        {project.kind === 'auto' && project.auto !== undefined && (
          <p className="text-t5">
            grouped by{' '}
            {project.auto.identity.kind === 'git-remote'
              ? `remote ${project.auto.identity.url}`
              : `path ${project.auto.identity.root}`}
          </p>
        )}
        <AddMatcher projectId={project.id} mutateProject={mutateProject} />
      </Section>

      {custom !== undefined && custom.excludeMatchers.length > 0 && (
        <Section title="excluded by matcher">
          {custom.excludeMatchers.map((m, i) => (
            <MatcherRow
              key={i}
              matcher={m}
              onRemove={() =>
                void mutateProject({ op: 'remove-exclude-matcher', id: project.id, matcher: m })
              }
            />
          ))}
        </Section>
      )}

      {custom !== undefined && custom.include.length > 0 && (
        <Section title="pinned sessions">
          {custom.include.map((id) => (
            <div key={id} className="flex items-center justify-between py-0.5">
              <span className="font-mono text-t3">{id.slice(0, 8)}</span>
              <button
                onClick={() =>
                  void mutateProject({ op: 'remove-include', id: project.id, sessionIds: [id] })
                }
                className="text-t5 hover:text-t2"
              >
                unpin
              </button>
            </div>
          ))}
        </Section>
      )}

      {custom !== undefined && custom.exclude.length > 0 && (
        <Section title="excluded sessions">
          {custom.exclude.map((id) => (
            <div key={id} className="flex items-center justify-between py-0.5">
              <span className="font-mono text-t3">{id.slice(0, 8)}</span>
              <button
                onClick={() =>
                  void mutateProject({ op: 'remove-exclude', id: project.id, sessionIds: [id] })
                }
                className="text-t5 hover:text-t2"
              >
                allow back
              </button>
            </div>
          ))}
        </Section>
      )}

      <MergeSplit project={project} rail={rail} mutateProject={mutateProject} />

      <Section title="lifecycle">
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void mutateProject({ op: 'archive-project', id: project.id, archived: true })}
            className="text-t3 hover:text-ask"
          >
            archive project
          </button>
          {custom?.derivedFrom !== undefined && (
            <button
              onClick={() => {
                if (window.confirm(`Revert "${project.name}" to automatic grouping?`)) {
                  void mutateProject({ op: 'delete-project', id: project.id })
                }
              }}
              className="text-t4 hover:text-t2"
            >
              revert to auto
            </button>
          )}
        </div>
        <p className="mt-1 text-t5">
          Archiving hides its sessions unless another project claims them. Nothing is deleted.
        </p>
      </Section>
    </div>
  )
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] font-medium tracking-wider text-t4 uppercase">
        {props.title}
      </div>
      {props.children}
    </div>
  )
}

function MatcherRow(props: { matcher: Matcher; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="truncate text-t2">
        <span className="text-t4">{props.matcher.kind}=</span>
        {matcherValue(props.matcher)}
      </span>
      <button onClick={props.onRemove} className="ml-2 shrink-0 text-t5 hover:text-t2">
        remove
      </button>
    </div>
  )
}

function AddMatcher(props: {
  projectId: string
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { projectId, mutateProject } = props
  const [kind, setKind] = useState<'remote' | 'root' | 'cwd' | 'dir' | 'session'>('remote')
  const [value, setValue] = useState('')
  const [preview, setPreview] = useState<string[] | undefined>(undefined)

  const matcher = (): Matcher | undefined => {
    const v = value.trim()
    if (v.length === 0) return undefined
    switch (kind) {
      case 'remote':
        return { kind, url: v }
      case 'root':
      case 'dir':
        return { kind, path: v }
      case 'cwd':
        return { kind, prefix: v }
      case 'session':
        return { kind, id: v }
    }
  }

  async function runPreview() {
    const m = matcher()
    if (m === undefined) return
    const result = await postMutation('/api/preview', { matcher: m })
    setPreview(result.ok ? (result.sessionIds ?? []) : undefined)
  }

  async function save() {
    const m = matcher()
    if (m === undefined) return
    if (await mutateProject({ op: 'add-matcher', id: projectId, matcher: m })) {
      setValue('')
      setPreview(undefined)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex gap-1">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind)
            setPreview(undefined)
          }}
          className="rounded border border-b4 bg-s3 px-1 py-1 text-t3"
        >
          <option value="remote">remote</option>
          <option value="root">root</option>
          <option value="cwd">cwd</option>
          <option value="dir">dir</option>
          <option value="session">session</option>
        </select>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setPreview(undefined)
          }}
          placeholder={kind === 'remote' ? 'github.com/org/repo' : '/path'}
          className="w-full rounded border border-b1 bg-s3 px-2 py-1 outline-none focus:border-b6"
        />
      </div>
      <div className="mt-1 flex items-center gap-3">
        <button
          onClick={() => void runPreview()}
          disabled={value.trim().length === 0}
          className="text-t3 hover:text-fg disabled:text-t6"
        >
          preview
        </button>
        <button
          onClick={() => void save()}
          disabled={value.trim().length === 0}
          className="text-t3 hover:text-run disabled:text-t6"
        >
          add matcher
        </button>
        {preview !== undefined && (
          <span className={preview.length > 0 ? 'text-run' : 'text-ask'}>
            would claim {preview.length} session{preview.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </div>
  )
}

function MergeSplit(props: {
  project: RailProject
  rail: RailProject[]
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { project, rail, mutateProject } = props
  const [splitRoot, setSplitRoot] = useState('')
  const [splitName, setSplitName] = useState('')
  const roots = cwdsOf(project.sessions)

  return (
    <Section title="merge / split">
      <div className="flex items-center gap-2">
        <span className="text-t5">absorb another project:</span>
        <MergeSelect project={project} rail={rail} mutateProject={mutateProject} />
      </div>
      <div className="mt-2 text-t5">carve a folder into its own project:</div>
      <input
        list={`roots-${project.id}`}
        value={splitRoot}
        onChange={(e) => setSplitRoot(e.target.value)}
        placeholder="/path/to/carve/out"
        className="mt-1 w-full rounded border border-b1 bg-s3 px-2 py-1 outline-none focus:border-b6"
      />
      <datalist id={`roots-${project.id}`}>
        {roots.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="mt-1 flex gap-2">
        <input
          value={splitName}
          onChange={(e) => setSplitName(e.target.value)}
          placeholder="new project name"
          className="w-full rounded border border-b1 bg-s3 px-2 py-1 outline-none focus:border-b6"
        />
        <button
          onClick={() => {
            if (splitRoot.trim().length === 0 || splitName.trim().length === 0) return
            void mutateProject({
              op: 'split-project',
              id: project.id,
              path: splitRoot.trim(),
              name: splitName.trim(),
            }).then((ok) => {
              if (ok) {
                setSplitRoot('')
                setSplitName('')
              }
            })
          }}
          className="rounded border border-b4 px-2 text-t3 hover:text-fg"
        >
          split
        </button>
      </div>
    </Section>
  )
}

function MergeSelect(props: {
  project: RailProject
  rail: RailProject[]
  mutateProject: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const { project, rail, mutateProject } = props
  const others = rail.filter((p) => p.id !== project.id)

  return (
    <select
      defaultValue=""
      onChange={(e) => {
        const from = e.target.value
        e.target.value = ''
        if (from === '') return
        const other = others.find((p) => p.id === from)
        if (
          other !== undefined &&
          window.confirm(`Merge "${other.name}" into "${project.name}"? Its record goes away.`)
        ) {
          void mutateProject({ op: 'merge-projects', id: project.id, from })
        }
      }}
      className="rounded border border-b4 bg-s3 px-1 py-0.5 text-t3"
    >
      <option value="">choose…</option>
      {others.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

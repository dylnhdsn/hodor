import { useMemo, useState } from 'react'
import type { Session, Snapshot } from '@hodor/core'
import { byRecency, deriveView, formatAge, matchesQuery, postMutation, titleOf, type View } from './data.js'
import { useSnapshot } from './useSnapshot.js'

type Filter =
  | { kind: 'all' }
  | { kind: 'custom'; id: string }
  | { kind: 'auto'; id: string }
  | { kind: 'hidden' }

export function App() {
  const { snapshot, connected } = useSnapshot()
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [query, setQuery] = useState('')

  if (snapshot === undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-500">
        connecting to hodor…
      </div>
    )
  }
  return (
    <Main
      snapshot={snapshot}
      connected={connected}
      filter={filter}
      setFilter={setFilter}
      query={query}
      setQuery={setQuery}
    />
  )
}

function Main(props: {
  snapshot: Snapshot
  connected: boolean
  filter: Filter
  setFilter: (f: Filter) => void
  query: string
  setQuery: (q: string) => void
}) {
  const { snapshot, connected, filter, setFilter, query, setQuery } = props
  const view = useMemo(() => deriveView(snapshot), [snapshot])
  const nowMs = Date.parse(snapshot.generatedAt)

  const sessions = useMemo(() => {
    let list: Session[]
    switch (filter.kind) {
      case 'all':
        list = view.visible
        break
      case 'custom':
        list = view.sessionsByCustom.get(filter.id) ?? []
        break
      case 'auto':
        list = view.sessionsByAuto.get(filter.id) ?? []
        break
      case 'hidden':
        list = view.hidden
        break
    }
    if (query.trim().length > 0) list = list.filter((s) => matchesQuery(s, query.trim()))
    return byRecency(list)
  }, [view, filter, query])

  const customNames = new Map(snapshot.customProjects.map((p) => [p.id, p.name]))

  async function createProject() {
    const name = window.prompt('New project name')
    if (name === null || name.trim().length === 0) return
    const result = await postMutation('/api/project', { op: 'create-project', name: name.trim() })
    if (!result.ok) window.alert(result.error ?? 'failed')
  }

  return (
    <div className="flex h-full bg-zinc-950 font-sans text-sm text-zinc-200">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="text-base font-semibold tracking-tight text-zinc-50">hodor</span>
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-600'}`}
            title={connected ? 'live' : 'reconnecting'}
          />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          <RailItem
            label="All sessions"
            count={view.visible.length}
            active={filter.kind === 'all'}
            onClick={() => setFilter({ kind: 'all' })}
          />

          <RailHeading>
            projects
            <button
              onClick={() => void createProject()}
              className="rounded px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="New project"
            >
              +
            </button>
          </RailHeading>
          {snapshot.customProjects.map((p) => (
            <RailItem
              key={p.id}
              label={p.name}
              count={(view.sessionsByCustom.get(p.id) ?? []).length}
              active={filter.kind === 'custom' && filter.id === p.id}
              onClick={() => setFilter({ kind: 'custom', id: p.id })}
            />
          ))}
          {snapshot.customProjects.length === 0 && (
            <p className="px-3 py-1 text-xs text-zinc-600">none yet — press +</p>
          )}

          <RailHeading>auto</RailHeading>
          {view.autoProjects.map((p) => (
            <RailItem
              key={p.id}
              label={p.name}
              count={(view.sessionsByAuto.get(p.id) ?? []).length}
              dim
              active={filter.kind === 'auto' && filter.id === p.id}
              onClick={() => setFilter({ kind: 'auto', id: p.id })}
            />
          ))}
        </nav>

        <button
          onClick={() => setFilter({ kind: 'hidden' })}
          className={`border-t border-zinc-800 px-4 py-2 text-left text-xs ${
            filter.kind === 'hidden' ? 'text-amber-300' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {view.hidden.length} hidden sessions
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search titles, prompts, paths, ids…"
            className="w-full max-w-md rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          <span className="ml-auto whitespace-nowrap text-xs text-zinc-500">
            {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </span>
        </header>

        <ul className="flex-1 divide-y divide-zinc-900 overflow-y-auto">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              nowMs={nowMs}
              view={view}
              customNames={customNames}
              customProjects={snapshot.customProjects}
              showHiddenBy={filter.kind === 'hidden'}
            />
          ))}
          {sessions.length === 0 && (
            <li className="px-4 py-8 text-center text-zinc-600">nothing here</li>
          )}
        </ul>
      </main>
    </div>
  )
}

function RailHeading(props: { children: React.ReactNode }) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-3 text-[11px] font-medium tracking-wider text-zinc-500 uppercase">
      {props.children}
    </div>
  )
}

function RailItem(props: {
  label: string
  count: number
  active: boolean
  dim?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={props.onClick}
      className={`flex w-full items-center justify-between rounded px-3 py-1.5 text-left ${
        props.active
          ? 'bg-zinc-800 text-zinc-50'
          : `hover:bg-zinc-900 ${props.dim ? 'text-zinc-400' : 'text-zinc-200'}`
      }`}
    >
      <span className="truncate">{props.label}</span>
      <span className="ml-2 shrink-0 text-xs text-zinc-500">{props.count}</span>
    </button>
  )
}

function SessionRow(props: {
  session: Session
  nowMs: number
  view: View
  customNames: Map<string, string>
  customProjects: Array<{ id: string; name: string }>
  showHiddenBy: boolean
}) {
  const { session: s, nowMs, view, customNames, customProjects, showHiddenBy } = props
  const active = s.runtime.kind !== 'idle'
  const claims = view.claimsBySession.get(s.id) ?? []
  const derived = view.derivedOf.get(s.id)

  async function addTo(projectId: string) {
    if (projectId === '') return
    const result = await postMutation('/api/project', {
      op: 'include',
      id: projectId,
      sessionIds: [s.id],
    })
    if (!result.ok) window.alert(result.error ?? 'failed')
  }

  async function rename() {
    const name = window.prompt('Rename session', titleOf(s))
    if (name === null || name.trim().length === 0) return
    await postMutation('/api/session', { op: 'rename-session', sessionId: s.id, name: name.trim() })
  }

  async function setArchived(archived: boolean) {
    await postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived })
  }

  return (
    <li className="group px-4 py-2 hover:bg-zinc-900/60">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
        <span className="truncate font-medium text-zinc-100">{titleOf(s)}</span>
        {claims.map((id) => (
          <span
            key={id}
            className="shrink-0 rounded-full bg-indigo-950 px-2 py-0.5 text-[11px] text-indigo-300"
          >
            {customNames.get(id) ?? id}
          </span>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-2 opacity-0 transition group-hover:opacity-100">
          <select
            defaultValue=""
            onChange={(e) => {
              void addTo(e.target.value)
              e.target.value = ''
            }}
            className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-400"
          >
            <option value="">add to…</option>
            {customProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => void rename()} className="text-[11px] text-zinc-500 hover:text-zinc-200">
            rename
          </button>
          {s.hiddenBy === 'archived' ? (
            <button onClick={() => void setArchived(false)} className="text-[11px] text-zinc-500 hover:text-zinc-200">
              unarchive
            </button>
          ) : (
            <button onClick={() => void setArchived(true)} className="text-[11px] text-zinc-500 hover:text-zinc-200">
              archive
            </button>
          )}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-xs text-zinc-500">
        <span className="font-mono">{s.id.slice(0, 8)}</span>
        <span>{formatAge(nowMs, s.lastActivityAt)}</span>
        {derived !== undefined && <span className="truncate text-zinc-600">{derived.name}</span>}
        <span className="truncate">{s.cwd}</span>
        {showHiddenBy && s.hiddenBy !== undefined && (
          <span className="rounded bg-amber-950 px-1.5 text-[11px] text-amber-300">{s.hiddenBy}</span>
        )}
      </div>
    </li>
  )
}

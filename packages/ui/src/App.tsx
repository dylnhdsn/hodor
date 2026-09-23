import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '@hodor/core'
import { cloudNeedsYou, cloudRunning } from './CloudSessions.js'
import { deriveView, postMutation, sigOfSession, titleOf, type RailProject } from './data.js'
import { Desk, deskState, getDeskOps, setDeskSessions, subscribeDesk, tileOf } from './Desk.js'
import { desktop } from './desktop.js'
import { DialogHost, notice, pickOne } from './dialog.js'
import { refreshHooks } from './hooksStatus.js'
import { NewSessionDialog } from './NewSession.js'
import { notifyNeedsYou } from './notify.js'
import { Overlay } from './Overlay.js'
import { fetchPrefs, savePref } from './prefs.js'
import { hydratePresets } from './presets.js'
import { ProjectOverlay, type ProjectPage } from './ProjectOverlay.js'
import { ProjectsPanel } from './ProjectsPanel.js'
import { SettingsOverlay, type SettingsPage } from './SettingsOverlay.js'
import { cloudSkipped, localSkipped } from './skips.js'
import { Stack, stackQueue, type StackScope } from './Stack.js'
import { StatusBar } from './StatusBar.js'
import { onThemeChange } from './theme.js'
import { TopBar } from './TopBar.js'
import { useSnapshot } from './useSnapshot.js'
import { BootSplash } from './Wordmark.js'
import { countsOfWorkspaces } from './WorkspaceTabs.js'

/**
 * The v3 shell (the Claude Design mock): a 30px title bar, the desk (or the
 * turn stack) in the middle with the projects drawer over it, a 24px
 * status bar; a project's sessions, its settings and a session's detail
 * live on an overlay, as do the app settings. The browser build has no
 * desk, so there the projects panel is pinned and the overlay IS the page.
 */

type OverlayState =
  | { kind: 'project'; id: string; page: ProjectPage }
  | { kind: 'settings'; page: SettingsPage }

export function App() {
  const { snapshot, connected } = useSnapshot()
  if (snapshot === undefined) {
    return <BootSplash desk={desktop !== undefined} />
  }
  return <Main snapshot={snapshot} connected={connected} />
}

function Main(props: { snapshot: Snapshot; connected: boolean }) {
  const { snapshot, connected } = props
  const web = desktop === undefined
  const [panel, setPanel] = useState<'closed' | 'open' | 'pinned'>(web ? 'pinned' : 'closed')
  const [viewMode, setViewMode] = useState<'desk' | 'stack'>('desk')
  const [overlay, setOverlay] = useState<OverlayState | undefined>(undefined)
  /** Browser build: the project whose overlay is the page. */
  const [selectedProject, setSelectedProject] = useState<string | undefined>(undefined)
  const [pinnedProjects, setPinnedProjects] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [stackScope, setStackScopeState] = useState<StackScope>('workspace')
  const [newSessionFor, setNewSessionFor] = useState<RailProject | undefined>(undefined)

  // Durable prefs live server-side (~/.hodor/ui.json): the desktop's origin
  // is a random port, so browser storage forgets.
  useEffect(() => {
    void fetchPrefs().then((prefs) => {
      if (prefs['panel'] === 'pinned') setPanel('pinned')
      if (prefs['stackScope'] === 'all') setStackScopeState('all')
      hydratePresets(prefs['stackPresets'])
      if (prefs['detachOnQuit'] === true) desktop?.setDetachOnQuit?.(true)
      if (Array.isArray(prefs['pinnedProjects'])) {
        setPinnedProjects(new Set(prefs['pinnedProjects'].filter((x): x is string => typeof x === 'string')))
      }
      if (Array.isArray(prefs['expandedProjects'])) {
        setExpanded(new Set(prefs['expandedProjects'].filter((x): x is string => typeof x === 'string')))
      }
    })
    void refreshHooks()
  }, [])
  const setStackScope = (scope: StackScope): void => {
    setStackScopeState(scope)
    savePref({ stackScope: scope })
  }
  const togglePinnedProject = (id: string): void => {
    const next = new Set(pinnedProjects)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPinnedProjects(next)
    savePref({ pinnedProjects: [...next] })
  }
  const toggleExpanded = (id: string): void => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
    savePref({ expandedProjects: [...next] })
  }
  const togglePin = (): void => {
    if (web) return
    const next = panel === 'pinned' ? 'closed' : 'pinned'
    setPanel(next)
    savePref({ panel: next })
  }
  const onMenu = (): void => {
    if (web) return
    if (panel === 'pinned') {
      setPanel('closed')
      savePref({ panel: 'closed' })
    } else setPanel(panel === 'open' ? 'closed' : 'open')
  }

  const view = useMemo(() => deriveView(snapshot), [snapshot])
  const nowMs = Date.parse(snapshot.generatedAt)

  // Desk membership drives the badges and "where"; re-render on any change.
  const [deskTick, setDeskTick] = useState(0)
  useEffect(() => subscribeDesk(() => setDeskTick((t) => t + 1)), [])
  const [platform, setPlatform] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (desktop !== undefined) void desktop.info().then((i) => setPlatform(i.platform))
  }, [])
  const [, setThemeTick] = useState(0)
  useEffect(() => onThemeChange(() => setThemeTick((t) => t + 1)), [])

  // deskTick: skips and workspaces live in the desk store, not the snapshot
  const counts = useMemo(() => countsOfWorkspaces(view, nowMs), [view, nowMs, deskTick])
  const stackN = useMemo(
    () => (web ? 0 : stackQueue(view, nowMs, 'workspace').length),
    [view, nowMs, deskTick, web],
  )
  // The status bar's counts: every workspace on the desktop; the whole
  // library in the browser, which has no desk to count over.
  const waitingAll = useMemo(
    () =>
      web
        ? view.visible.filter((s) => s.turn?.state === 'waiting' && !localSkipped(s, nowMs)).length +
          view.cloud.filter((c) => cloudNeedsYou(c) && !cloudSkipped(c, nowMs)).length
        : stackQueue(view, nowMs, 'all').length,
    [view, nowMs, deskTick, web],
  )
  const runningAll = web
    ? view.visible.filter((s) => s.turn?.state === 'working').length +
      view.cloud.filter((c) => !cloudNeedsYou(c) && cloudRunning(c)).length
    : [...counts.values()].reduce((sum, c) => sum + c.run, 0)
  const activeWs = (() => {
    void deskTick
    return deskState.workspaces.find((w) => w.id === deskState.active)
  })()
  const scopedProject =
    activeWs?.scope !== undefined ? view.rail.find((p) => p.id === activeWs.scope!.projectId) : undefined

  // Feed turn states, names and asks to the desk's tabs (separate React
  // roots) — EVERY session, not just the visible ones: a tab is open on
  // purpose, so a hide rule catching its session must not blank it.
  useEffect(() => {
    if (desktop === undefined) return
    const states: Record<string, 'working' | 'waiting' | 'idle'> = {}
    const titles: Record<string, string> = {}
    const sigs: Record<string, string> = {}
    for (const s of view.byId.values()) {
      if (s.turn !== undefined) states[s.id] = s.turn.state
      titles[s.id] = titleOf(s)
      sigs[s.id] = sigOfSession(s)
    }
    setDeskSessions(states, titles, sigs)
  }, [view])

  const projectOfSession = useCallback(
    (id: string): string | undefined =>
      view.claimsBySession.get(id)?.[0] ?? view.derivedOf.get(id)?.id ?? view.cloudProjectOf.get(id)?.id,
    [view],
  )
  const openProject = useCallback(
    (id: string, page: ProjectPage = { kind: 'sessions' }): void => {
      if (!view.rail.some((p) => p.id === id)) return
      setSelectedProject(id)
      setOverlay({ kind: 'project', id, page })
      if (!web) setPanel((p) => (p === 'open' ? 'closed' : p))
    },
    [view, web],
  )
  const openSession = useCallback(
    (sessionId: string): void => {
      const id = projectOfSession(sessionId)
      if (id === undefined) {
        void notice('not in a project', 'this session is grouped nowhere hodor can show')
        return
      }
      openProject(id, { kind: 'detail', sessionId })
    },
    [projectOfSession, openProject],
  )

  /** Land on a session's tile: switch to its workspace if it lives in
   * another, come back to the desk, bring the tile forward, focus it. */
  const jumpToTile = useCallback((id: string): void => {
    const t = tileOf(id)
    const ops = getDeskOps()
    if (t === undefined || ops === undefined) return
    setOverlay(undefined)
    setViewMode('desk')
    setPanel((p) => (p === 'open' ? 'closed' : p))
    const land = (): void => {
      ops.revealPanel(t.entry.panelId)
      ops.focusPanel(t.entry.panelId)
    }
    if (t.active) land()
    else void ops.switchWorkspace(t.workspace.id).then(land)
  }, [])

  // A session flipping to "needs you" while the window is elsewhere pings
  // the OS. First snapshot stays silent — booting isn't news.
  const needsYouSeen = useRef<Set<string> | undefined>(undefined)
  useEffect(() => {
    const current = new Map<string, { title: string; body: string }>()
    for (const s of view.visible) {
      if (s.turn?.state === 'waiting' && !localSkipped(s, nowMs)) {
        current.set(s.id, { title: titleOf(s), body: s.turn.preview ?? 'your turn' })
      }
    }
    for (const c of view.cloud) {
      if (cloudNeedsYou(c) && !cloudSkipped(c, nowMs)) {
        current.set(c.id, {
          title: c.title ?? c.repo ?? c.id.slice(0, 12),
          body: c.needsAction ?? 'needs you',
        })
      }
    }
    const seen = needsYouSeen.current
    needsYouSeen.current = new Set(current.keys())
    if (seen === undefined || document.hasFocus()) return
    // Clicking the notification lands you ON the session: its tile when it
    // has one, else its project's overlay. Desk state is read at click time.
    const openFor = (id: string) => (): void => {
      if (tileOf(id) !== undefined) jumpToTile(id)
      else if (view.byId.has(id)) openSession(id)
      else {
        const pid = projectOfSession(id)
        if (pid !== undefined) openProject(pid)
      }
    }
    for (const [id, n] of current) {
      if (!seen.has(id)) notifyNeedsYou(n.title, n.body, openFor(id))
    }
  }, [view, nowMs, jumpToTile, openSession, openProject, projectOfSession])

  // Mutations that target a project follow the id the server answers with —
  // editing an auto project materializes it under a new (custom) id.
  const mutateProject = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      const result = await postMutation('/api/project', body)
      if (!result.ok) {
        await notice('that change failed', result.error)
        return false
      }
      if (typeof result.id === 'string' && typeof body['id'] === 'string' && result.id !== body['id']) {
        const from = body['id']
        const to = result.id
        setOverlay((o) => (o?.kind === 'project' && o.id === from ? { ...o, id: to } : o))
        setSelectedProject((s) => (s === from ? to : s))
      }
      return true
    },
    [],
  )

  /** A zone's "+": the workspace's scoped project, else pick one. */
  const newSessionIn = useCallback(
    (groupId: string): void => {
      getDeskOps()?.openInZone(groupId !== '' ? groupId : undefined)
      if (scopedProject !== undefined) {
        setNewSessionFor(scopedProject)
        return
      }
      if (view.rail.length === 1) {
        setNewSessionFor(view.rail[0])
        return
      }
      void pickOne(
        'new session in…',
        view.rail.map((p) => ({ id: p.id, label: p.name })),
      ).then((id) => {
        const p = view.rail.find((x) => x.id === id)
        if (p !== undefined) setNewSessionFor(p)
      })
    },
    [scopedProject, view],
  )

  const overlayProject =
    overlay?.kind === 'project' ? view.rail.find((p) => p.id === overlay.id) : undefined
  const webProject = web
    ? (view.rail.find((p) => p.id === selectedProject) ?? view.rail[0])
    : undefined
  const projectsForMenus = view.rail.map((p) => ({ id: p.id, name: p.name }))
  const panelOn = panel !== 'closed'

  return (
    <div className="flex h-full flex-col bg-app font-mono text-[12px] text-t1">
      {/* prompt/confirm/notice host — Electron has no window.prompt */}
      <DialogHost />
      {newSessionFor !== undefined && (
        <NewSessionDialog
          project={newSessionFor}
          view={view}
          nowMs={nowMs}
          close={() => setNewSessionFor(undefined)}
        />
      )}
      <TopBar
        platform={platform}
        panelOn={panelOn}
        onMenu={onMenu}
        counts={counts}
        projects={projectsForMenus}
        onSwitch={() => setViewMode('desk')}
        intent={activeWs?.intent}
        stackN={stackN}
        stackOpen={viewMode === 'stack'}
        onStack={() => setViewMode(viewMode === 'stack' ? 'desk' : 'stack')}
        settingsOpen={overlay?.kind === 'settings'}
        onSettings={() =>
          setOverlay(overlay?.kind === 'settings' ? undefined : { kind: 'settings', page: 'appearance' })
        }
      />
      {(snapshot.organize?.errors.length ?? 0) > 0 && (
        <div className="flex items-center gap-2 border-b border-ask/40 bg-ask/8 px-3.5 py-1 text-[11px] text-ask">
          <span className="font-bold">!</span>
          <span className="truncate">
            organize.js: {snapshot.organize!.errors[0]}
            {snapshot.organize!.errors.length > 1
              ? ` (+${snapshot.organize!.errors.length - 1} more)`
              : ''}
          </span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {panel === 'open' && (
          <div onClick={() => setPanel('closed')} className="absolute inset-0 z-[4] bg-app/35" />
        )}
        {panelOn && (
          <ProjectsPanel
            view={view}
            snapshot={snapshot}
            nowMs={nowMs}
            pinned={panel === 'pinned'}
            onTogglePin={togglePin}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            pinnedProjects={pinnedProjects}
            togglePinnedProject={togglePinnedProject}
            openProject={(id, page) => openProject(id, { kind: page })}
            openSession={(_projectId, sessionId) => openSession(sessionId)}
            jumpToTile={jumpToTile}
            newSession={(p) => setNewSessionFor(p)}
            selectedId={webProject?.id}
          />
        )}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* The desk stays mounted whatever is up: its PTYs, dockview
              state, and the desk store the turn stack reads live here. */}
          {!web && (
            <div className={viewMode === 'desk' ? 'flex min-h-0 flex-1' : 'hidden'}>
              <Desk
                inspect={openSession}
                scopeName={scopedProject?.name}
                newSessionIn={newSessionIn}
              />
            </div>
          )}
          {!web && viewMode === 'stack' && (
            <div className="flex min-h-0 flex-1">
              <Stack
                snapshot={snapshot}
                view={view}
                nowMs={nowMs}
                scope={stackScope}
                onScope={setStackScope}
                onExit={() => setViewMode('desk')}
                onInspect={openSession}
                onJumpDesk={() => setViewMode('desk')}
              />
            </div>
          )}
          {web &&
            (webProject !== undefined ? (
              <Overlay inline onClose={() => {}}>
                <ProjectOverlay
                  key={webProject.id}
                  project={webProject}
                  view={view}
                  snapshot={snapshot}
                  nowMs={nowMs}
                  page={overlay?.kind === 'project' && overlay.id === webProject.id ? overlay.page : { kind: 'sessions' }}
                  setPage={(page) => setOverlay({ kind: 'project', id: webProject.id, page })}
                  mutate={mutateProject}
                  jumpToTile={jumpToTile}
                />
              </Overlay>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[11px] text-t5">
                no sessions found yet
              </div>
            ))}
        </main>
        {!web && overlay?.kind === 'project' && overlayProject !== undefined && (
          <Overlay onClose={() => setOverlay(undefined)}>
            <ProjectOverlay
              key={overlayProject.id}
              project={overlayProject}
              view={view}
              snapshot={snapshot}
              nowMs={nowMs}
              page={overlay.page}
              setPage={(page) => setOverlay({ ...overlay, page })}
              close={() => setOverlay(undefined)}
              mutate={mutateProject}
              jumpToTile={jumpToTile}
            />
          </Overlay>
        )}
        {overlay?.kind === 'settings' && (
          <Overlay onClose={() => setOverlay(undefined)}>
            <SettingsOverlay
              page={overlay.page}
              setPage={(page) => setOverlay({ kind: 'settings', page })}
              close={() => setOverlay(undefined)}
              view={view}
              snapshot={snapshot}
              nowMs={nowMs}
              mutate={mutateProject}
            />
          </Overlay>
        )}
      </div>
      <StatusBar
        view={view}
        snapshot={snapshot}
        nowMs={nowMs}
        connected={connected}
        waiting={waitingAll}
        running={runningAll}
        projects={projectsForMenus}
        onSwitch={() => setViewMode('desk')}
      />
    </div>
  )
}

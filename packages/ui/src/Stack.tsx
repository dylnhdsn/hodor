import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudSession, Session, SkillInfo, Snapshot } from '@hodor/core'
import { cloudNeedsYou } from './CloudSessions.js'
import {
  launchOrCopy,
  projectNameOf,
  sendCloudMessage,
  sigOfCloud,
  sigOfSession,
  titleOf,
  type View,
} from './data.js'
import { StackDashboard } from './Dashboard.js'
import { desktop } from './desktop.js'
import { notice, pickOne, promptText } from './dialog.js'
import { Glyph } from './glyphs.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'
import { DEFAULT_PRESETS, getPresets, onPresetsChange, setPresets } from './presets.js'
import { deskState, getDeskOps, isDeferred, subscribeDesk, tileOf, type DeskEntry } from './Desk.js'
import { TerminalView } from './Terminal.js'

/**
 * The Turn Stack (docs/brainstorm/023, the v3 mock): every session whose
 * turn is yours — local AND cloud — as a list on the left, waiting-longest
 * first, and the one you are dealing with in the pane on the right. The
 * pane IS the already-open terminal (the same PTY its desk tile holds;
 * views just attach), brought forward in its zone behind. Answering from
 * the pane keeps you on that session — it moves down the list as
 * "working · you said …" and the pane follows it — until you pick another
 * row. A cloud row shows the session's ask with the same composer.
 * Nothing resumes or spawns on its own; a dead slot offers its resume
 * button and waits for you.
 */

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
  const [follow, setFollow] = useState<string | undefined>(undefined)
  /** Sessions answered from this pane, with what you said (empty when you
   * typed in the terminal itself) and when: they stay listed as
   * "working". For a moment after a send the session still reads as
   * waiting (the transcript has not caught up), so a fresh answer counts
   * as working on its own for a few seconds. */
  const [answered, setAnswered] = useState<Record<string, { text: string; at: number }>>({})
  const FRESH_MS = 8_000
  const [resuming, setResuming] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => subscribeDesk(() => setTick((t) => t + 1)), [])
  useEffect(() => onPresetsChange(() => setTick((t) => t + 1)), [])
  const { menu, openMenu, closeMenu } = useContextMenu()

  const wall = Date.now()
  const fresh = (id: string): boolean => {
    const a = answered[id]
    return a !== undefined && wall - a.at < FRESH_MS
  }
  const queue = stackQueue(view, nowMs, scope)
  const queued = new Set(queue.filter((q) => !fresh(itemId(q))).map(itemId))
  // a fresh answer's session stays in the list as working, not waiting
  const waitingRows = queue.filter((q) => queued.has(itemId(q)))
  // re-check once the freshness window closes
  useEffect(() => {
    const soonest = Math.min(...Object.values(answered).map((a) => a.at + FRESH_MS - wall), Infinity)
    if (!Number.isFinite(soonest) || soonest < 0) return
    const t = setTimeout(() => setTick((x) => x + 1), soonest + 50)
    return () => clearTimeout(t)
  })

  // Answered rows: the same shape, looked up live; gone once the tile is
  // closed. Back in the queue (asking again) means no longer "answered".
  const answeredRows: StackItem[] = []
  for (const id of Object.keys(answered)) {
    if (queued.has(id)) continue
    const t = tileOf(id)
    if (t === undefined) continue
    if (scope === 'workspace' && t.workspace.id !== deskState.active) continue
    const ws: ItemWorkspace = { id: t.workspace.id, name: t.workspace.name, active: t.active }
    const session = view.byId.get(id)
    if (session !== undefined) answeredRows.push({ kind: 'desk', entry: t.entry, session, workspace: ws })
    else {
      const cloud = view.cloud.find((c) => c.id === id)
      if (cloud !== undefined) answeredRows.push({ kind: 'cloud', cloud, workspace: ws })
    }
  }
  const rows = [...waitingRows, ...answeredRows]
  const upNext = waitingRows[0]
  const followed = rows.find((r) => itemId(r) === follow) ?? upNext ?? rows[0]
  const followedId = followed !== undefined ? itemId(followed) : undefined
  const isAnswered = followedId !== undefined && !queued.has(followedId)

  // Answering in the terminal itself: the followed session flips from
  // waiting to working under you — keep following it, like a sent reply.
  const prevState = useRef<{ id: string; waiting: boolean } | undefined>(undefined)
  useEffect(() => {
    const now =
      followed?.kind === 'desk'
        ? { id: followed.session.id, waiting: followed.session.turn?.state === 'waiting' }
        : undefined
    const prev = prevState.current
    if (
      now !== undefined &&
      prev !== undefined &&
      prev.id === now.id &&
      prev.waiting &&
      !now.waiting &&
      followed?.kind === 'desk' &&
      followed.session.turn?.state === 'working'
    ) {
      setAnswered((a) => (a[now.id] !== undefined ? a : { ...a, [now.id]: { text: '', at: Date.now() } }))
      setFollow(now.id)
    }
    prevState.current = now
  })

  // The desk mirrors the pane: a local row's tile comes forward in its
  // zone, so leaving the stack lands on the session just dealt with (only
  // when its workspace is the one showing — the others' tiles are not
  // mounted; "jump to its tile" switches there on purpose).
  const followedPanel = followed?.kind === 'desk' ? followed.entry.panelId : undefined
  const followedActive = followed?.workspace.active ?? true
  useEffect(() => {
    setResuming(false)
    if (followedPanel !== undefined && followedActive) getDeskOps()?.revealPanel(followedPanel)
  }, [followedPanel, followedActive])
  useEffect(() => setReply(''), [followedId])

  const jumpTo = useCallback(
    (item: StackItem) => {
      const go = item.workspace.active
        ? Promise.resolve()
        : (getDeskOps()?.switchWorkspace(item.workspace.id) ?? Promise.resolve())
      void go.then(() => {
        if (item.kind === 'desk') {
          getDeskOps()?.revealPanel(item.entry.panelId)
          getDeskOps()?.focusPanel(item.entry.panelId)
        }
        onJumpDesk()
      })
    },
    [onJumpDesk],
  )

  const resumeFollowed = useCallback(() => {
    if (followedPanel === undefined) return
    setResuming(true)
    void getDeskOps()
      ?.resumePanel(followedPanel)
      .finally(() => setResuming(false))
  }, [followedPanel])

  /** Type text plus Enter into the followed session — or queue it into
   * the cloud session — and follow it while it works. */
  const say = useCallback(
    (text: string): void => {
      if (followed === undefined || text.trim() === '') return
      const id = itemId(followed)
      if (followed.kind === 'desk') {
        if (followed.entry.ptyId === undefined || desktop === undefined) return
        desktop.write(followed.entry.ptyId, text)
        desktop.write(followed.entry.ptyId, '\r')
        setAnswered((a) => ({ ...a, [id]: { text, at: Date.now() } }))
        setFollow(id)
        return
      }
      const cloud = followed.cloud
      setSending(true)
      void sendCloudMessage(cloud.id, text)
        .then((result) => {
          if (!result.ok) {
            void notice("couldn't send", result.error ?? result.output ?? 'unknown error')
            return
          }
          // answered: quiet it until the session's ask actually changes
          getDeskOps()?.setDeferIn(followed.workspace.id, cloud.id, { sig: sigOfCloud(cloud) })
          setAnswered((a) => ({ ...a, [id]: { text, at: Date.now() } }))
          setFollow(id)
        })
        .finally(() => setSending(false))
    },
    [followed],
  )
  const sendReply = (): void => {
    const text = reply.trim()
    if (text === '') return
    setReply('')
    say(text)
  }
  const addPreset = async (): Promise<void> => {
    const text = await promptText('new preset', { placeholder: 'what to answer with', okLabel: 'add' })
    if (text !== undefined && text.trim() !== '') setPresets([...getPresets(), text])
  }
  const runSkill = async (): Promise<void> => {
    if (followed?.kind !== 'desk') return
    const res = await fetch(`/api/skills?sessionId=${encodeURIComponent(followed.session.id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ skills: SkillInfo[] }>) : { skills: [] }))
      .catch(() => ({ skills: [] as SkillInfo[] }))
    if (res.skills.length === 0) {
      void notice('no skills here', "nothing under the project's .claude or the store's ~/.claude")
      return
    }
    const picked = await pickOne(
      'run a skill',
      res.skills.map((sk) => ({
        id: sk.name,
        label: '/' + sk.name,
        detail: sk.description ?? (sk.scope === 'project' ? 'project skill' : 'user skill'),
      })),
    )
    if (picked !== undefined) say('/' + picked)
  }

  const rowMenu = (item: StackItem): MenuItem[] => {
    const ops = getDeskOps()
    const id = itemId(item)
    const wsId = item.workspace.id
    const sig = item.kind === 'desk' ? sigOfSession(item.session) : sigOfCloud(item.cloud)
    const waiting = queued.has(id)
    const defer = (state: Parameters<NonNullable<typeof ops>['setDeferIn']>[2]): void => {
      ops?.setDeferIn(wsId, id, state)
      if (follow === id) setFollow(undefined)
    }
    const items: MenuItem[] = [
      { label: item.kind === 'desk' ? titleOf(item.session) : (item.cloud.title ?? item.cloud.id.slice(0, 12)), heading: true },
      { label: 'jump to its tile', onClick: () => jumpTo(item) },
      ...(item.kind === 'desk'
        ? [{ label: 'session detail', onClick: () => onInspect(item.session.id) }]
        : [
            { label: 'open on the web', onClick: () => window.open(item.cloud.url, '_blank') },
            { label: 'teleport into a terminal', onClick: () => void launchOrCopy({ kind: 'teleport', sessionId: item.cloud.id }) },
          ]),
    ]
    if (waiting) {
      items.push(
        { label: 'skip', onClick: () => defer({ sig }) },
        {
          label: 'skip with a note…',
          onClick: () =>
            void promptText('skip with a note', { placeholder: 'waiting on the design review…', okLabel: 'skip' }).then((note) => {
              if (note !== undefined) defer({ sig, ...(note.trim() !== '' ? { note: note.trim() } : {}) })
            }),
        },
      )
      if (item.kind === 'desk' && item.session.pr !== undefined) {
        const { number, fingerprint } = item.session.pr
        items.push({ label: `skip until PR #${number} moves`, onClick: () => defer({ pr: { number, fingerprint } }) })
      }
      items.push(
        { label: 'snooze 30 minutes', onClick: () => defer({ until: new Date(nowMs + 30 * 60_000).toISOString() }) },
        { label: 'snooze 2 hours', onClick: () => defer({ until: new Date(nowMs + 2 * 3600_000).toISOString() }) },
        { label: 'hold until I unskip it', onClick: () => defer({ hold: true }) },
      )
      if (item.kind === 'desk' && item.entry.ptyId !== undefined && desktop !== undefined) {
        const ptyId = item.entry.ptyId
        items.push({
          label: 'send to phone',
          onClick: () => {
            desktop!.write(ptyId, '/remote-control\r')
            defer({ sig, phone: true })
          },
        })
      }
    }
    if (item.kind === 'desk') {
      items.push({
        label: 'close its tile',
        danger: true,
        onClick: () => {
          // its panel lives in its workspace's dockview — go there first
          const go = item.workspace.active ? Promise.resolve() : (ops?.switchWorkspace(wsId) ?? Promise.resolve())
          const panelId = item.entry.panelId
          void go.then(() => getDeskOps()?.closePanel(panelId))
          setAnswered((a) => {
            const { [id]: _drop, ...rest } = a
            return rest
          })
          if (follow === id) setFollow(undefined)
        },
      })
    }
    return items
  }

  const structured = followed?.kind === 'desk' && !isAnswered ? followed.session.turn?.pending : undefined
  const projectName = (s: Session): string => projectNameOf(props.snapshot, view, s)
  const activeWs = deskState.workspaces.find((w) => w.id === deskState.active)
  const waitingN = waitingRows.length
  const rowMeta = (item: StackItem): string => {
    const id = itemId(item)
    const where =
      scope === 'all'
        ? `⧉ ${item.workspace.name}`
        : item.kind === 'desk' && item.entry.zone !== undefined
          ? item.entry.zone
          : ''
    const said = answered[id]?.text
    const state = queued.has(id)
      ? `waiting ${formatWait(itemSince(item), nowMs)}`
      : said !== undefined && said !== ''
        ? `working · you said “${said}”`
        : item.kind === 'desk' && item.session.turn?.state !== 'working' && !fresh(id)
          ? 'stopped — back to you'
          : 'working'
    return where !== '' ? `${state} · ${where}` : state
  }
  const paneLabel = (item: StackItem): { text: string; cls: string } => {
    if (queued.has(itemId(item))) {
      return {
        text: `${item.kind === 'desk' ? 'your turn' : 'needs you'} · waiting ${formatWait(itemSince(item), nowMs)}`,
        cls: 'text-ask',
      }
    }
    if (item.kind === 'desk' && item.session.turn?.state !== 'working' && !fresh(itemId(item))) {
      return { text: 'stopped — back to you', cls: 'text-t4' }
    }
    return { text: 'working — you are following it', cls: 'text-run' }
  }
  const chip = (on: boolean): string =>
    `rounded border px-2 py-px font-mono text-[10px] hover:text-fg ${on ? 'border-ac text-fg' : 'border-b3 text-t4'}`

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-[30px] shrink-0 items-center gap-2.5 border-b border-b1 px-3 text-[11px]">
        <span className="font-ui font-bold text-fg">Turn Stack</span>
        <span className="text-t4">
          {waitingN} waiting {scope === 'all' ? 'everywhere' : `in ${activeWs?.name ?? 'this workspace'}`}
        </span>
        <span className="ml-1 flex gap-0.5">
          <button onClick={() => onScope('workspace')} className={chip(scope === 'workspace')}>
            ⧉ {activeWs?.name ?? 'workspace'}
          </button>
          <button onClick={() => onScope('all')} className={chip(scope === 'all')}>
            everywhere
          </button>
        </span>
        <button
          onClick={onExit}
          className="ml-auto rounded border border-b3 px-2 py-px text-[10.5px] text-t3 hover:text-fg"
        >
          desk
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[320px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-b1 p-2">
          {rows.map((item) => {
            const id = itemId(item)
            const on = id === followedId
            const isUp = upNext !== undefined && id === itemId(upNext)
            const glyph = queued.has(id) ? (item.kind === 'cloud' ? 'cloud' : 'ask') : 'run'
            return (
              <button
                key={id}
                onClick={() => setFollow(id)}
                onContextMenu={(e) => openMenu(e, rowMenu(item))}
                className={`flex flex-col gap-[3px] rounded-r border-l-2 px-2.5 py-2 text-left hover:bg-s3 ${
                  isUp ? 'border-ask' : 'border-transparent'
                } ${on ? 'bg-s5' : ''}`}
              >
                <span className="flex w-full items-center gap-2 font-ui text-[12px] font-semibold text-fg">
                  <Glyph kind={glyph} size={9} />
                  <span className="min-w-0 flex-1 truncate">
                    {item.kind === 'desk' ? titleOf(item.session) : (item.cloud.title ?? item.cloud.id.slice(0, 12))}
                  </span>
                  {on && <span className="font-mono text-[9px] font-normal text-ach">◂ pane</span>}
                </span>
                <span className="truncate text-[10px] text-t4">{rowMeta(item)}</span>
              </button>
            )
          })}
          {rows.length === 0 && (
            <div className="px-2.5 py-6 text-center text-[11px] text-t5">nothing waiting</div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-s8">
          {followed === undefined && (
            <div className="flex min-h-0 flex-1 flex-col px-4 pt-3">
              <StackDashboard
                snapshot={props.snapshot}
                view={view}
                nowMs={nowMs}
                onInspect={onInspect}
                onJumpDesk={onJumpDesk}
              />
            </div>
          )}
          {followed !== undefined && (
            <>
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-b1 bg-s3 px-3">
                <Glyph kind={queued.has(followedId!) ? (followed.kind === 'cloud' ? 'cloud' : 'ask') : 'run'} size={10} />
                <span className="truncate font-ui text-[13px] font-bold text-fg">
                  {followed.kind === 'desk'
                    ? titleOf(followed.session)
                    : (followed.cloud.title ?? followed.cloud.id.slice(0, 12))}
                </span>
                <span className="rounded border border-b4 px-1.5 text-[10px] whitespace-nowrap text-t4">
                  {followed.kind === 'desk' ? projectName(followed.session) : (followed.cloud.repo ?? 'cloud')}
                </span>
                {(followed.kind === 'desk' ? followed.session.gitBranch : followed.cloud.branches[0]) !== undefined && (
                  <span className="truncate text-[10px] text-t4">
                    ⎇ {followed.kind === 'desk' ? followed.session.gitBranch : followed.cloud.branches[0]}
                  </span>
                )}
                {!followed.workspace.active && (
                  <span className="rounded border border-ac/50 px-1.5 text-[10px] whitespace-nowrap text-ach" title="another workspace">
                    ⧉ {followed.workspace.name}
                  </span>
                )}
                <span className={`ml-auto text-[10.5px] whitespace-nowrap ${paneLabel(followed).cls}`}>
                  {paneLabel(followed).text}
                </span>
              </div>

              {followed.kind === 'desk' ? (
                <div className="min-h-0 flex-1">
                  {followed.entry.ptyId !== undefined ? (
                    // The SAME terminal the desk tile holds: PTYs live in the
                    // main process, this view just attaches to it here.
                    <TerminalView key={followed.entry.ptyId} ptyId={followed.entry.ptyId} visible autoFocus />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center font-mono">
                      <span className="text-xs text-t5">its terminal is closed</span>
                      {resuming ? (
                        <span className="animate-pulse text-xs text-ac">resuming into its tile…</span>
                      ) : (
                        <button
                          onClick={resumeFollowed}
                          className="rounded border border-ac/55 px-3.5 py-1.5 text-[11.5px] font-semibold text-ach hover:bg-ac/10"
                        >
                          resume into its tile
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-6 text-center">
                  {followed.cloud.statusDetail !== undefined && (
                    <p className="max-w-2xl text-[11px] text-t4">{followed.cloud.statusDetail}</p>
                  )}
                  <p className="max-w-2xl font-ui text-[14px] font-semibold leading-relaxed text-fg">
                    {followed.cloud.needsAction !== undefined
                      ? `“${followed.cloud.needsAction}”`
                      : isAnswered
                        ? 'your reply is queued into the cloud session'
                        : 'this session reads as blocked on you'}
                  </p>
                  <a href={followed.cloud.url} target="_blank" rel="noreferrer" className="text-[10.5px] text-t4 hover:text-fg">
                    open on the web ↗
                  </a>
                </div>
              )}

              {isAnswered ? (
                <div className="flex shrink-0 items-center gap-2 border-t border-b1 bg-s1 px-3 py-2.5 text-[10.5px] text-t4">
                  <span className="text-run" style={{ animation: 'hpulse 1.4s ease-in-out infinite' }}>
                    ●
                  </span>
                  {followed.kind === 'desk' && followed.session.turn?.state !== 'working' && !fresh(followedId!)
                    ? 'stopped'
                    : 'working'}
                </div>
              ) : (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-b1 bg-s1 px-3 py-2.5">
                  {structured?.options !== undefined ? (
                    structured.options.map((o) => (
                      <span
                        key={o}
                        title="the dialog in the terminal owns this choice"
                        className="cursor-default rounded border border-b4 px-[11px] py-1 font-ui text-[11.5px] text-t3"
                      >
                        {o}
                      </span>
                    ))
                  ) : (
                    <>
                      {getPresets().map((preset) => (
                        <button
                          key={preset}
                          onClick={() => say(preset)}
                          onContextMenu={(e) =>
                            openMenu(e, [
                              { label: preset, heading: true },
                              { label: 'remove preset', onClick: () => setPresets(getPresets().filter((x) => x !== preset)) },
                              { label: 'add a preset…', onClick: () => void addPreset() },
                              { label: 'reset presets', onClick: () => setPresets(DEFAULT_PRESETS) },
                            ])
                          }
                          className="rounded border border-ac/55 px-[11px] py-1 font-ui text-[11.5px] text-ach hover:bg-ac/14"
                        >
                          {preset}
                        </button>
                      ))}
                      {followed.kind === 'desk' && (
                        <button
                          onClick={() => void runSkill()}
                          onContextMenu={(e) =>
                            openMenu(e, [
                              { label: 'add a preset…', onClick: () => void addPreset() },
                              { label: 'reset presets', onClick: () => setPresets(DEFAULT_PRESETS) },
                            ])
                          }
                          title="run one of this session's skills or commands"
                          className="rounded border border-dashed border-b5 px-[11px] py-1 text-[11px] text-t3 hover:border-ac hover:text-fg"
                        >
                          / skill…
                        </button>
                      )}
                    </>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <input
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          sendReply()
                        }
                      }}
                      placeholder="type a reply"
                      disabled={sending}
                      className="min-w-[180px] rounded border border-b3 bg-transparent px-2 py-1 text-[10.5px] text-t1 outline-none placeholder:text-t5 focus:border-b6"
                    />
                    <button
                      onClick={sendReply}
                      disabled={reply.trim() === '' || sending}
                      className="rounded bg-ac px-[11px] py-[5px] font-ui text-[11.5px] font-bold text-ink hover:brightness-110 disabled:opacity-40"
                    >
                      {sending ? 'sending…' : 'send'}
                    </button>
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </div>
  )
}

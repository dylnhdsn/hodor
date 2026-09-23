import { useEffect, useState } from 'react'
import type { Snapshot } from '@hodor/core'
import { formatUsd, modelShortOf, type View } from './data.js'
import { deskState, subscribeDesk } from './Desk.js'
import { desktop, type UpdateState } from './desktop.js'
import { hooksOn, useHooks } from './hooksStatus.js'
import { ContextMenu, useContextMenu } from './menu.js'
import { workspaceMenuItems } from './WorkspaceTabs.js'

/**
 * The 24px status bar (v3 mock). Left: where the keyboard is — workspace
 * and zone, then the focused tile's directory, branch and model, and how
 * much context it has left. Right: what the whole desk is doing — waiting
 * and running counts across every workspace, today's spend, whether the
 * hooks are in and the server is up — then the build and its update state.
 */

/** Context window by model id: 1M for the [1m] variants, 200k otherwise. */
const contextWindowOf = (model: string | undefined): number =>
  model !== undefined && /1m/i.test(model) ? 1_000_000 : 200_000

function useUpdate(): UpdateState | undefined {
  const [update, setUpdate] = useState<UpdateState | undefined>(undefined)
  useEffect(() => {
    if (desktop === undefined) return
    const bridge = desktop
    void bridge.updateState().then((s) => {
      if (s !== undefined) setUpdate(s)
    })
    return bridge.onUpdateEvent((state) =>
      setUpdate((prev) => {
        const found = prev?.state === 'ready' || prev?.state === 'available-manual'
        const quiet = state.state === 'checking' || state.state === 'none' || state.state === 'error'
        return found && quiet ? prev : state
      }),
    )
  }, [])
  return update
}

function Seg(props: {
  children: React.ReactNode
  glyph?: string
  glyphClass?: string
  className?: string
  title?: string | undefined
  side: 'left' | 'right'
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined
  onClick?: (() => void) | undefined
}) {
  return (
    <span
      title={props.title}
      onContextMenu={props.onContextMenu}
      onClick={props.onClick}
      className={`flex items-center gap-[5px] px-2.5 whitespace-nowrap ${
        props.side === 'left' ? 'border-r border-b2' : 'border-l border-b2'
      } ${props.onClick !== undefined ? 'cursor-pointer hover:text-fg' : ''} ${props.className ?? ''}`}
    >
      {props.glyph !== undefined && (
        <span className={`text-[8.5px] ${props.glyphClass ?? ''}`}>{props.glyph}</span>
      )}
      {props.children}
    </span>
  )
}

export function StatusBar(props: {
  view: View
  snapshot: Snapshot
  nowMs: number
  connected: boolean
  waiting: number
  running: number
  projects: Array<{ id: string; name: string }>
  onSwitch: () => void
}) {
  const { view, snapshot } = props
  const [, force] = useState(0)
  useEffect(() => subscribeDesk(() => force((t) => t + 1)), [])
  useHooks()
  const update = useUpdate()
  const { menu, openMenu, closeMenu } = useContextMenu()

  const ws = deskState.workspaces.find((w) => w.id === deskState.active)
  const focus = deskState.entries.find((e) => e.panelId === deskState.focusPanelId)
  const zone = focus?.zone ?? deskState.zoneList.find((z) => z.name !== undefined)?.name
  const session = focus?.sessionId !== undefined ? view.byId.get(focus.sessionId) : undefined
  const cloud = focus?.cloudId !== undefined ? view.cloud.find((c) => c.id === focus.cloudId) : undefined

  // The focused tile, in the mock's words: "~/code/hodor  ⎇ main  ·  opus".
  let where: string | undefined
  let ctx: { text: string; low: boolean } | undefined
  if (session !== undefined) {
    const model = modelShortOf(session)
    where = [session.cwd, session.gitBranch !== undefined ? `⎇ ${session.gitBranch}` : undefined, model]
      .filter((x): x is string => x !== undefined && x !== '')
      .join('  ·  ')
    if (session.contextTokens !== undefined) {
      const left = Math.max(0, 100 - Math.round((session.contextTokens / contextWindowOf(model)) * 100))
      ctx = { text: `ctx ${left}% left`, low: left < 30 }
    }
  } else if (cloud !== undefined) {
    where = ['cloud', cloud.repo, cloud.branches[0] !== undefined ? `⎇ ${cloud.branches[0]}` : undefined]
      .filter((x): x is string => x !== undefined && x !== '')
      .join('  ·  ')
  } else if (focus?.kind === 'shell') {
    where = [focus.root, focus.env].filter((x): x is string => x !== undefined && x !== '').join('  ·  ')
    ctx = { text: 'shell — no model', low: false }
  }

  const spentToday = snapshot.sessions.reduce((sum, s) => sum + (s.costTodayUsd ?? 0), 0)
  const hooks = hooksOn()
  const build =
    snapshot.hodorVersion !== undefined
      ? `${snapshot.hodorChannel !== undefined ? `${snapshot.hodorChannel} · ` : ''}${snapshot.hodorVersion}`
      : undefined

  return (
    <div className="flex h-[24px] shrink-0 items-stretch border-t border-b1 bg-s1 text-[10.5px]">
      {ws !== undefined && (
        <span
          onContextMenu={(e) => openMenu(e, workspaceMenuItems(ws.id, props.projects, props.onSwitch))}
          className="flex items-center gap-1.5 bg-s5 px-2.5 text-t1 whitespace-nowrap"
          title="this workspace and the zone you are in — right-click for its verbs"
        >
          <span className="text-ac">⧉</span>
          {ws.name}
          {zone !== undefined && ` · ${zone}`}
        </span>
      )}
      {where !== undefined && where !== '' && (
        <Seg side="left" className="min-w-0 text-t3" title="the focused tile">
          <span className="truncate">{where}</span>
        </Seg>
      )}
      {ctx !== undefined && (
        <Seg side="left" className={ctx.low ? 'text-ask' : 'text-t3'}>
          {ctx.text}
        </Seg>
      )}
      <span className="ml-auto flex items-stretch">
        <Seg
          side="right"
          glyph="▲"
          glyphClass="text-ask"
          className={props.waiting > 0 ? 'text-ask' : 'text-t4'}
          title="your turn, across every workspace"
        >
          {props.waiting} waiting
        </Seg>
        <Seg side="right" glyph="●" glyphClass="text-run" className="text-t3" title="working, across every workspace">
          {props.running} running
        </Seg>
        <Seg side="right" className="text-t3" title="estimated spend across every session today">
          {formatUsd(spentToday)} today
        </Seg>
        <Seg
          side="right"
          glyph="●"
          glyphClass={hooks === true ? 'text-run' : hooks === false ? 'text-t6' : 'text-ask'}
          className="text-t3"
          title={
            hooks === true
              ? "Claude's hooks report the turn state exactly"
              : hooks === false
                ? 'hooks are off — turn state is inferred (settings › behavior)'
                : 'hooks: partly installed, or unknown'
          }
        >
          hooks
        </Seg>
        <Seg
          side="right"
          glyph="●"
          glyphClass={props.connected ? 'text-run' : 'text-err'}
          className={props.connected ? 'text-t3' : 'text-err'}
          title={props.connected ? 'the local server is up' : 'connection to the local server lost'}
        >
          {props.connected ? 'server' : 'reconnecting'}
        </Seg>
        {update?.state === 'ready' && desktop !== undefined ? (
          <Seg
            side="right"
            glyph="↻"
            glyphClass="text-rev"
            className="text-rev"
            title={`version ${update.version} downloaded — restarts the app`}
            onClick={() => void desktop!.installUpdate()}
          >
            update ready
          </Seg>
        ) : update?.state === 'available-manual' ? (
          <Seg
            side="right"
            className="text-rev"
            title="unsigned macOS builds can't self-install — grab the fresh dmg"
            onClick={() => window.open(update.url, '_blank')}
          >
            update ↗
          </Seg>
        ) : (
          build !== undefined && (
            <Seg side="right" className="text-t6" title="the build serving this UI">
              {build}
            </Seg>
          )
        )}
      </span>
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </div>
  )
}

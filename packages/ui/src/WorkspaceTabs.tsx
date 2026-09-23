import { useEffect, useState } from 'react'
import { cloudNeedsYou, cloudRunning } from './CloudSessions.js'
import type { View } from './data.js'
import { deskState, getDeskOps, subscribeDesk } from './Desk.js'
import { desktop } from './desktop.js'
import { confirmAction, pickOne, promptText } from './dialog.js'
import { CloudIcon } from './icons.js'
import { ContextMenu, useContextMenu, type MenuItem } from './menu.js'
import { stackQueue } from './Stack.js'

/**
 * Workspaces as a tier of tabs in the title bar (docs/brainstorm/027, the
 * v3 mock). Each is a named set of tiles with its own turn stack and
 * skips; one is active. A tab carries one badge — your-turn count first,
 * else working, else cloud — and right-click holds its verbs.
 */

export interface WorkspaceCounts {
  ask: number
  run: number
  cloud: number
}

/** Per-workspace badge counts: your turn (skips honored), working, cloud. */
export function countsOfWorkspaces(view: View, nowMs: number): Map<string, WorkspaceCounts> {
  const out = new Map<string, WorkspaceCounts>()
  for (const w of deskState.workspaces) out.set(w.id, { ask: 0, run: 0, cloud: 0 })
  for (const item of stackQueue(view, nowMs, 'all')) {
    const c = out.get(item.workspace.id)
    if (c !== undefined) c.ask += 1
  }
  for (const w of deskState.workspaces) {
    const c = out.get(w.id)!
    for (const e of deskState.entriesOf(w.id)) {
      if (e.sessionId !== undefined) {
        if (view.byId.get(e.sessionId)?.turn?.state === 'working') c.run += 1
      } else if (e.cloudId !== undefined) {
        const cloud = view.cloud.find((x) => x.id === e.cloudId)
        if (cloud !== undefined && !cloudNeedsYou(cloud) && cloudRunning(cloud)) c.run += 1
        c.cloud += 1
      }
    }
  }
  return out
}

/** The workspace's verbs: shared by its tab and the status bar's segment. */
export function workspaceMenuItems(
  id: string,
  projects: Array<{ id: string; name: string }>,
  onSwitch?: () => void,
  /** This window IS the popped-out workspace: no switching, no closing. */
  locked = false,
): MenuItem[] {
  const w = deskState.workspaces.find((x) => x.id === id)
  const ops = getDeskOps()
  if (w === undefined || ops === undefined) return []
  const scopeName = projects.find((p) => p.id === w.scope?.projectId)?.name
  const create = (): void => {
    void promptText('new workspace', { placeholder: 'name', okLabel: 'create' }).then((name) => {
      if (name === undefined || name.trim() === '') return
      void ops.newWorkspace(name.trim())
      onSwitch?.()
    })
  }
  return [
    { label: w.name, heading: true },
    {
      label: 'rename…',
      onClick: () =>
        void promptText('rename workspace', { initial: w.name, okLabel: 'rename' }).then((name) => {
          if (name !== undefined && name.trim() !== '') ops.renameWorkspace(w.id, name.trim())
        }),
    },
    {
      label: 'set intent…',
      onClick: () =>
        void promptText('intent — what are you doing here', {
          initial: w.intent ?? '',
          placeholder: 'ship the electron bump',
          okLabel: 'save',
        }).then((text) => {
          if (text !== undefined) ops.setIntent(w.id, text)
        }),
    },
    {
      label: scopeName !== undefined ? `scope: ${scopeName} — change…` : 'scope to a project…',
      onClick: () =>
        void pickOne(
          'scope to a project',
          projects.map((p) => ({ id: p.id, label: p.name })),
          { detail: 'new sessions in this workspace start there' },
        ).then((projectId) => {
          if (projectId !== undefined) ops.scopeWorkspace(w.id, projectId)
        }),
    },
    ...(w.scope !== undefined
      ? [{ label: 'clear the project scope', onClick: () => ops.scopeWorkspace(w.id, undefined) }]
      : []),
    ...(locked
      ? [{ label: 'bring the workspace back into the main window', onClick: () => ops.popInWorkspace(w.id) }]
      : desktop?.popOutWorkspace !== undefined
        ? [
            w.popped === true
              ? { label: 'bring the workspace back into this window', onClick: () => ops.popInWorkspace(w.id) }
              : { label: 'pop the workspace out to its own window', onClick: () => ops.popOutWorkspace(w.id) },
            ...(w.popped !== true && w.id === deskState.active
              ? deskState.zoneList.map((z) => ({
                  label: z.popped
                    ? `bring ${z.name ?? 'the zone'} back`
                    : `pop ${z.name ?? 'the zone'} out to its own window`,
                  onClick: () => ops.togglePoppedZone(z.id),
                }))
              : []),
          ]
        : []),
    ...(locked ? [] : [{ label: 'new workspace…', onClick: create }]),
    ...(locked
      ? []
      : [
          {
            label: 'close workspace',
            danger: true,
            onClick: () => {
              const n = deskState.terminalCountOf(w.id)
              void confirmAction(`Close workspace "${w.name}"?`, {
                detail: n > 0 ? `${n} terminal${n === 1 ? '' : 's'} will end` : 'it has no terminals',
                okLabel: 'close',
                danger: true,
              }).then((ok) => {
                if (ok) void ops.closeWorkspace(w.id)
              })
            },
          },
        ]),
  ]
}

export function WorkspaceTabs(props: {
  counts: Map<string, WorkspaceCounts>
  projects: Array<{ id: string; name: string }>
  onSwitch?: (() => void) | undefined
  locked?: boolean | undefined
}) {
  const [, force] = useState(0)
  const { menu, openMenu, closeMenu } = useContextMenu()
  useEffect(() => subscribeDesk(() => force((t) => t + 1)), [])
  if (desktop === undefined || deskState.workspaces.length === 0) return null

  const ops = getDeskOps()
  const create = (): void => {
    void promptText('new workspace', { placeholder: 'name', okLabel: 'create' }).then((name) => {
      if (name === undefined || name.trim() === '') return
      void ops?.newWorkspace(name.trim())
      props.onSwitch?.()
    })
  }

  return (
    <span className="no-drag flex min-w-0 items-center gap-0.5 overflow-hidden">
      {deskState.workspaces.map((w) => {
        const active = w.id === deskState.active
        const c = props.counts.get(w.id) ?? { ask: 0, run: 0, cloud: 0 }
        return (
          <button
            key={w.id}
            onClick={() => {
              if (!active) void ops?.switchWorkspace(w.id)
              props.onSwitch?.()
            }}
            onContextMenu={(e) =>
              openMenu(e, workspaceMenuItems(w.id, props.projects, props.onSwitch, props.locked === true))
            }
            className={`flex h-[22px] shrink-0 items-center gap-1.5 rounded px-2.5 font-ui text-[11.5px] font-semibold whitespace-nowrap hover:text-fg ${
              active ? 'bg-s5 text-fg' : 'text-t3'
            }`}
            title={
              (active ? 'this workspace' : 'switch workspace') +
              (w.scope !== undefined
                ? ` — scoped to ${props.projects.find((p) => p.id === w.scope?.projectId)?.name ?? 'a project'}`
                : '')
            }
          >
            {w.name}
            {w.popped === true && props.locked !== true && (
              <span title="open in its own window" className="text-[10px] font-normal text-rev">
                ⧉
              </span>
            )}
            {c.ask > 0 ? (
              <span className="text-[9.5px] font-bold text-ask">▲{c.ask}</span>
            ) : c.run > 0 ? (
              <span className="text-[9.5px] font-bold text-run">●{c.run}</span>
            ) : c.cloud > 0 ? (
              <span className="flex items-center gap-0.5 text-[9.5px] font-bold text-t5">
                <CloudIcon size={9} />
                {c.cloud}
              </span>
            ) : null}
          </button>
        )
      })}
      {props.locked !== true && (
        <button
          onClick={create}
          className="h-[22px] shrink-0 px-2 text-[12px] text-t5 hover:text-fg"
          title="new workspace"
        >
          +
        </button>
      )}
      {menu !== undefined && <ContextMenu menu={menu} close={closeMenu} />}
    </span>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { deriveView, titleOf } from './data.js'
import { desktop, type OpenTarget } from './desktop.js'
import { Glyph, type GlyphKind } from './glyphs.js'
import { TerminalView } from './Terminal.js'
import { onWorkspaceDoc, useSnapshot } from './useSnapshot.js'

/**
 * A zone in its own window (030 phase 4): the zone's tabs, read from the
 * workspace document the desk keeps saving, over the same PTYs the desk's
 * tiles would show — the main process holds the terminals, this renderer
 * just attaches. A dead slot asks the desk that owns the workspace to
 * resume it; the document update that follows lights the tab up here.
 */

interface ZonePanel {
  id: string
  title: string
  ptyId?: string
  target?: OpenTarget
}

interface ZoneView {
  name: string | undefined
  wsName: string
  panels: ZonePanel[]
  activeView: string | undefined
}

function findLeaf(node: unknown, groupId: string): { views?: string[]; activeView?: string } | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as { type?: string; data?: unknown }
  if (n.type === 'leaf') {
    const data = n.data as { id?: string; views?: string[]; activeView?: string } | undefined
    return data?.id === groupId ? data : undefined
  }
  if (Array.isArray(n.data)) {
    for (const child of n.data) {
      const hit = findLeaf(child, groupId)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

function zoneOf(doc: unknown, wsId: string, groupId: string): ZoneView | undefined {
  const workspaces = (doc as { workspaces?: unknown[] } | undefined)?.workspaces
  if (!Array.isArray(workspaces)) return undefined
  const ws = workspaces.find((w) => (w as { id?: string }).id === wsId) as
    | { name: string; windows?: Array<{ layout?: unknown; zones?: Record<string, { name?: string }> }> }
    | undefined
  const window0 = ws?.windows?.[0]
  if (ws === undefined || window0?.layout === undefined) return undefined
  const layout = window0.layout as {
    grid?: { root?: unknown }
    panels?: Record<string, { id?: string; title?: string; params?: { ptyId?: string; target?: OpenTarget } }>
  }
  const leaf = findLeaf(layout.grid?.root, groupId)
  if (leaf === undefined) return undefined
  const panels: ZonePanel[] = []
  for (const id of leaf.views ?? []) {
    const p = layout.panels?.[id]
    if (p === undefined) continue
    const panel: ZonePanel = { id, title: p.title ?? id }
    if (p.params?.ptyId !== undefined) panel.ptyId = p.params.ptyId
    if (p.params?.target !== undefined) panel.target = p.params.target
    panels.push(panel)
  }
  return { name: window0.zones?.[groupId]?.name, wsName: ws.name, panels, activeView: leaf.activeView }
}

export function ZoneWindow({ wsId, groupId }: { wsId: string; groupId: string }) {
  const { snapshot } = useSnapshot()
  const [doc, setDoc] = useState<unknown>(undefined)
  const [live, setLive] = useState<ReadonlySet<string>>(new Set())
  const [pick, setPick] = useState<string | undefined>(undefined)

  useEffect(() => {
    void fetch('/api/workspace')
      .then((r) => r.json())
      .then(setDoc)
      .catch(() => {})
    return onWorkspaceDoc(setDoc)
  }, [])
  useEffect(() => {
    const bridge = desktop
    if (bridge === undefined) return
    void bridge.list().then((list) => setLive(new Set(list.filter((t) => t.exited === undefined).map((t) => t.id))))
    return bridge.onEvent((e) => {
      if (e.type === 'opened' || e.type === 'returned') setLive((s) => new Set(s).add(e.id))
      else if (e.type === 'closed' || e.type === 'exit') {
        setLive((s) => {
          const next = new Set(s)
          next.delete(e.id)
          return next
        })
      }
    })
  }, [])

  const zone = useMemo(() => zoneOf(doc, wsId, groupId), [doc, wsId, groupId])
  const view = useMemo(() => (snapshot !== undefined ? deriveView(snapshot) : undefined), [snapshot])
  const active =
    zone?.panels.find((p) => p.id === pick) ??
    zone?.panels.find((p) => p.id === zone.activeView) ??
    zone?.panels[0]

  const describe = (p: ZonePanel): { glyph: GlyphKind; title: string } => {
    const kind = p.target?.kind
    const sessionId =
      p.target?.sessionId !== undefined && (kind === 'resume' || kind === 'new') ? p.target.sessionId : undefined
    const session = sessionId !== undefined ? view?.byId.get(sessionId) : undefined
    const alive = p.ptyId !== undefined && live.has(p.ptyId)
    const glyph: GlyphKind =
      kind === 'shell'
        ? 'shell'
        : kind === 'teleport'
          ? 'cloud'
          : session?.turn?.state === 'waiting'
            ? 'ask'
            : session?.turn?.state === 'working'
              ? 'run'
              : alive
                ? 'idle'
                : 'dead'
    return { glyph, title: session !== undefined ? titleOf(session) : p.title }
  }

  if (desktop === undefined) return null
  const bridge = desktop
  return (
    <div className="flex h-full flex-col bg-app font-mono text-[12px] text-t1">
      <div className="flex h-[26px] shrink-0 items-stretch overflow-hidden border-b border-b1 bg-s1">
        <span className="flex items-center border-r border-b1 px-2.5 font-ui text-[9.5px] font-bold tracking-[.1em] whitespace-nowrap text-t4 uppercase">
          {zone?.name ?? 'zone'}
        </span>
        {zone?.panels.map((p) => {
          const d = describe(p)
          const on = p.id === active?.id
          return (
            <button
              key={p.id}
              onClick={() => setPick(p.id)}
              className={`flex items-center gap-1.5 border-r border-b1 px-2.5 font-ui text-[11px] whitespace-nowrap hover:text-fg ${
                on ? 'bg-app text-fg' : 'text-t3'
              }`}
            >
              <Glyph kind={d.glyph} size={9} />
              <span className="max-w-[220px] truncate">{d.title}</span>
            </button>
          )
        })}
        {zone !== undefined && (
          <span className="ml-auto flex items-center px-2.5 text-[10px] text-t5">⧉ {zone.wsName}</span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {zone === undefined ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-t5">
            <span>this zone is gone</span>
            <button
              onClick={() => bridge.winClose?.()}
              className="rounded border border-b4 px-2.5 py-[3px] text-[10.5px] text-t3 hover:text-fg"
            >
              close
            </button>
          </div>
        ) : active === undefined ? (
          <div className="flex h-full items-center justify-center text-[11px] text-t5">no tabs</div>
        ) : active.ptyId !== undefined && live.has(active.ptyId) ? (
          <TerminalView key={active.ptyId} ptyId={active.ptyId} visible autoFocus />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center text-[11px] text-t5">
            <span>
              {active.target?.kind === 'shell'
                ? 'the shell is closed'
                : `session ${active.target?.sessionId?.slice(0, 8) ?? ''} isn't running`}
            </span>
            {bridge.zoneResume !== undefined && active.target !== undefined && (
              <button
                onClick={() => bridge.zoneResume!(wsId, groupId, active.id)}
                className="rounded border border-ac/55 px-3 py-1 text-[11.5px] font-semibold text-ach hover:bg-ac/10"
              >
                resume into place
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

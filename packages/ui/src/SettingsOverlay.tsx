import type { Snapshot } from '@hodor/core'
import { AppearancePage, BehaviorPage } from './Appearance.js'
import { formatAge, postMutation, projectNameOf, titleOf, type View } from './data.js'
import { confirmAction } from './dialog.js'
import { OverlayHeader } from './Overlay.js'
import { Section } from './ProjectSettings.js'

/**
 * The gear's overlay: appearance (schemes, fonts, presets), behavior
 * (shells, notifications, quitting, hooks, updates) and the archive —
 * every archived or hidden session and every archived project, each with
 * the verb that brings it back.
 */
export type SettingsPage = 'appearance' | 'behavior' | 'archive'
type Mutate = (body: Record<string, unknown>) => Promise<boolean>

export function SettingsOverlay(props: {
  page: SettingsPage
  setPage: (page: SettingsPage) => void
  close: () => void
  view: View
  snapshot: Snapshot
  nowMs: number
  mutate: Mutate
}) {
  const { view } = props
  const archivedN =
    view.hidden.length + view.archivedProjects.length
  const pages: Array<{ id: SettingsPage; label: string; n?: number }> = [
    { id: 'appearance', label: 'appearance' },
    { id: 'behavior', label: 'behavior' },
    { id: 'archive', label: 'archive', n: archivedN },
  ]
  return (
    <>
      <OverlayHeader>
        <span className="font-ui text-[14px] font-bold text-fg">settings</span>
        <span className="text-[10.5px] text-t5">{props.page}</span>
        <button
          onClick={props.close}
          className="ml-auto pl-2 pr-0.5 text-[13px] text-t4 hover:text-fg"
          title="close"
        >
          ✕
        </button>
      </OverlayHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[150px] shrink-0 flex-col gap-0.5 border-r border-b2 p-2">
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => props.setPage(p.id)}
              className={`flex items-center justify-between rounded px-2.5 py-1.5 text-left font-ui text-[12px] hover:text-fg ${
                props.page === p.id ? 'bg-s5 text-fg' : 'text-t3'
              }`}
            >
              {p.label}
              {p.n !== undefined && p.n > 0 && (
                <span className="font-mono text-[10px] text-t5">{p.n}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {props.page === 'appearance' && <AppearancePage />}
          {props.page === 'behavior' && <BehaviorPage />}
          {props.page === 'archive' && (
            <ArchivePage view={view} snapshot={props.snapshot} nowMs={props.nowMs} mutate={props.mutate} />
          )}
        </div>
      </div>
    </>
  )
}

const rowClass = 'flex items-center gap-2.5 py-[3px] text-[11.5px]'
const verb = 'shrink-0 text-[10.5px] text-t5 hover:text-fg'

function ArchivePage(props: { view: View; snapshot: Snapshot; nowMs: number; mutate: Mutate }) {
  const { view, snapshot, nowMs, mutate } = props
  const archived = view.hidden.filter((s) => s.hiddenBy === 'archived')
  const hidden = view.hidden.filter((s) => s.hiddenBy !== 'archived')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <Section title={`archived sessions · ${archived.length}`}>
        {archived.map((s) => (
          <div key={s.id} className={rowClass}>
            <span className="min-w-0 flex-1 truncate font-ui text-t2">{titleOf(s)}</span>
            <span className="shrink-0 text-[10px] text-t5">{projectNameOf(snapshot, view, s)}</span>
            <span className="w-12 shrink-0 text-right text-[10px] text-t5">
              {formatAge(nowMs, s.lastActivityAt)}
            </span>
            <button
              onClick={() =>
                void postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived: false })
              }
              className={verb}
            >
              unarchive
            </button>
          </div>
        ))}
        {archived.length === 0 && <p className="py-[3px] text-[11px] text-t5">none</p>}
      </Section>
      <Section title={`hidden sessions · ${hidden.length}`}>
        {hidden.map((s) => (
          <div key={s.id} className={rowClass}>
            <span className="min-w-0 flex-1 truncate font-ui text-t2">{titleOf(s)}</span>
            <span className="shrink-0 rounded bg-ask/15 px-1 text-[9.5px] text-ask" title="the rule that hid it">
              {s.hiddenBy}
            </span>
            <span className="w-12 shrink-0 text-right text-[10px] text-t5">
              {formatAge(nowMs, s.lastActivityAt)}
            </span>
            <button
              onClick={() =>
                void postMutation('/api/session', { op: 'unhide-session', sessionId: s.id, unhidden: true })
              }
              className={verb}
            >
              unhide
            </button>
          </div>
        ))}
        {hidden.length === 0 && <p className="py-[3px] text-[11px] text-t5">none</p>}
      </Section>
      <Section title={`archived projects · ${view.archivedProjects.length}`}>
        {view.archivedProjects.map((p) => {
          const n = (view.sessionsOfArchived.get(p.id) ?? []).length
          return (
            <div key={p.id} className={rowClass}>
              <span className="min-w-0 flex-1 truncate font-ui text-t2">{p.name}</span>
              <span className="shrink-0 text-[10px] text-t5">
                {n} session{n === 1 ? '' : 's'} hidden with it
              </span>
              <button
                onClick={() => void mutate({ op: 'archive-project', id: p.id, archived: false })}
                className={verb}
              >
                unarchive
              </button>
              {p.derivedFrom !== undefined && (
                <button
                  onClick={() =>
                    void confirmAction(`Revert "${p.name}" to automatic grouping?`, {
                      detail: 'its custom record goes away; sessions regroup by repo',
                      okLabel: 'revert',
                    }).then((ok) => {
                      if (ok) void mutate({ op: 'delete-project', id: p.id })
                    })
                  }
                  className={verb}
                >
                  revert to auto
                </button>
              )}
            </div>
          )
        })}
        {view.archivedProjects.length === 0 && <p className="py-[3px] text-[11px] text-t5">none</p>}
      </Section>
    </div>
  )
}

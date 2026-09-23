import { useEffect, useState } from 'react'
import type { Matcher } from '@hodor/core'
import { cwdsOf, postMutation, titleOf, type RailProject } from './data.js'
import { confirmAction } from './dialog.js'

/**
 * A project's settings page (docs/brainstorm/010, the v3 overlay): name,
 * matchers with what each one claims, pinned and excluded sessions on the
 * left; merge, split and lifecycle on the right. Every edit is one plane
 * op; editing an auto project materializes it first (the server answers
 * with the new id and the caller follows it).
 */

export const matcherValue = (m: Matcher): string => {
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

export function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[9px] font-bold tracking-[.16em] text-t6 uppercase">{props.title}</div>
      {props.children}
    </div>
  )
}

export function statusOf(project: RailProject): string {
  if (project.kind === 'auto') return 'grouped automatically — editing makes it yours'
  if (project.custom?.derivedFrom !== undefined) return 'yours, started from an automatic group'
  return 'yours'
}

type Mutate = (body: Record<string, unknown>) => Promise<boolean>

const KINDS = ['root', 'dir', 'cwd', 'remote', 'session'] as const
type Kind = (typeof KINDS)[number]
const PLACEHOLDER: Record<Kind, string> = {
  root: '~/code/project',
  dir: '~/code/project.worktrees',
  cwd: '~/code/project/packages/ui',
  remote: 'github.com/you/project',
  session: 'session id',
}

const matcherOf = (kind: Kind, value: string): Matcher | undefined => {
  const v = value.trim()
  if (v === '') return undefined
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

/** How many sessions each matcher claims, via the preview endpoint. */
function useMatcherCounts(matchers: Matcher[]): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const key = JSON.stringify(matchers)
  useEffect(() => {
    let live = true
    void Promise.all(
      matchers.map(async (m) => {
        const r = await postMutation('/api/preview', { matcher: m })
        return [JSON.stringify(m), r.ok ? (r.sessionIds ?? []).length : -1] as const
      }),
    ).then((pairs) => {
      if (live) setCounts(new Map(pairs))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return counts
}

const input =
  'min-w-0 rounded border border-b3 bg-s1 px-2 py-1 text-t1 outline-none placeholder:text-t6 focus:border-b6'
const ghost = 'rounded border border-b4 px-2.5 py-0.5 text-[10.5px] text-t2 hover:border-b6 hover:text-fg'

export function ProjectSettings(props: { project: RailProject; rail: RailProject[]; mutate: Mutate }) {
  const { project, rail, mutate } = props
  const custom = project.custom
  const [name, setName] = useState(project.name)
  const [kind, setKind] = useState<Kind>('root')
  const [value, setValue] = useState('')
  const [preview, setPreview] = useState<number | undefined>(undefined)
  const [splitRoot, setSplitRoot] = useState('')
  const [splitName, setSplitName] = useState('')
  const matchers = custom?.matchers ?? []
  const counts = useMatcherCounts(matchers)
  const others = rail.filter((p) => p.id !== project.id)
  const roots = cwdsOf(project.sessions)

  const runPreview = async (): Promise<void> => {
    const m = matcherOf(kind, value)
    if (m === undefined) return
    const r = await postMutation('/api/preview', { matcher: m })
    setPreview(r.ok ? (r.sessionIds ?? []).length : undefined)
  }
  const add = async (): Promise<void> => {
    const m = matcherOf(kind, value)
    if (m === undefined) return
    if (await mutate({ op: 'add-matcher', id: project.id, matcher: m })) {
      setValue('')
      setPreview(undefined)
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 overflow-y-auto text-[11.5px]">
      <div className="flex flex-col border-r border-b2 p-4">
        <p className="mb-4 -mt-1 text-[10.5px] text-t5">{statusOf(project)}</p>
        <Section title="name">
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${input} flex-1 font-ui text-[12px]`}
            />
            <button
              onClick={() => {
                if (name.trim() !== '' && name.trim() !== project.name) {
                  void mutate({ op: 'rename-project', id: project.id, name: name.trim() })
                }
              }}
              className={`${ghost} hover:border-ac`}
            >
              save
            </button>
          </div>
        </Section>

        <Section title="matchers">
          {matchers.map((m, i) => {
            const n = counts.get(JSON.stringify(m))
            return (
              <div key={i} className="flex items-center gap-2 py-[3px]">
                <span className="w-[52px] shrink-0 text-t5">{m.kind}</span>
                <span className="min-w-0 flex-1 truncate text-t2" title={matcherValue(m)}>
                  {matcherValue(m)}
                </span>
                <span className="text-[10px] whitespace-nowrap text-t5">
                  {n === undefined ? '…' : n < 0 ? '?' : `${n} session${n === 1 ? '' : 's'}`}
                </span>
                <button
                  onClick={() => void mutate({ op: 'remove-matcher', id: project.id, matcher: m })}
                  className="text-[10.5px] text-t5 hover:text-err"
                >
                  remove
                </button>
              </div>
            )
          })}
          {custom !== undefined && matchers.length === 0 && (
            <p className="py-[3px] text-t5">none — only pinned sessions</p>
          )}
          {project.kind === 'auto' && project.auto !== undefined && (
            <p className="py-[3px] text-t5">
              grouped by{' '}
              {project.auto.identity.kind === 'git-remote'
                ? `remote ${project.auto.identity.url}`
                : `path ${project.auto.identity.root}`}
            </p>
          )}
          <div className="mt-2 flex gap-1.5">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind)
                setPreview(undefined)
              }}
              className="rounded border border-b3 bg-s1 p-1 font-mono text-[11px] text-t2"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setPreview(undefined)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
              placeholder={PLACEHOLDER[kind]}
              className={`${input} flex-1 font-mono text-[11px]`}
            />
            <button onClick={() => void runPreview()} className={ghost}>
              preview
            </button>
            <button
              onClick={() => void add()}
              className="rounded border border-ac/55 px-2.5 py-0.5 text-[10.5px] text-ach hover:bg-ac/14"
            >
              add
            </button>
          </div>
          {preview !== undefined && (
            <p className={`mt-1.5 text-[10.5px] ${preview > 0 ? 'text-run' : 'text-t4'}`}>
              {preview} session{preview === 1 ? '' : 's'} match
            </p>
          )}
        </Section>

        {custom !== undefined && custom.excludeMatchers.length > 0 && (
          <Section title="excluded by matcher">
            {custom.excludeMatchers.map((m, i) => (
              <div key={i} className="flex items-center gap-2 py-[3px]">
                <span className="w-[52px] shrink-0 text-t5">{m.kind}</span>
                <span className="min-w-0 flex-1 truncate text-t2">{matcherValue(m)}</span>
                <button
                  onClick={() =>
                    void mutate({ op: 'remove-exclude-matcher', id: project.id, matcher: m })
                  }
                  className="text-[10.5px] text-t5 hover:text-err"
                >
                  remove
                </button>
              </div>
            ))}
          </Section>
        )}

        {custom !== undefined && custom.include.length > 0 && (
          <Section title="pinned sessions">
            {custom.include.map((id) => (
              <div key={id} className="flex items-center gap-2 py-[3px]">
                <span className="text-t5">{id.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 truncate font-ui text-t2">
                  {(() => {
                    const s = project.sessions.find((x) => x.id === id)
                    return s !== undefined ? titleOf(s) : ''
                  })()}
                </span>
                <button
                  onClick={() =>
                    void mutate({ op: 'remove-include', id: project.id, sessionIds: [id] })
                  }
                  className="text-[10.5px] text-t5 hover:text-fg"
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
              <div key={id} className="flex items-center gap-2 py-[3px]">
                <span className="min-w-0 flex-1 truncate text-t2">{id.slice(0, 8)}</span>
                <button
                  onClick={() =>
                    void mutate({ op: 'remove-exclude', id: project.id, sessionIds: [id] })
                  }
                  className="text-[10.5px] text-t5 hover:text-fg"
                >
                  include
                </button>
              </div>
            ))}
          </Section>
        )}
      </div>

      <div className="flex flex-col p-4">
        {others.length > 0 && (
          <Section title="merge">
            <div className="flex flex-wrap gap-1.5">
              {others.map((o) => (
                <button
                  key={o.id}
                  onClick={() =>
                    void confirmAction(`Merge "${o.name}" into "${project.name}"?`, {
                      detail: `"${o.name}" goes away; its sessions land in "${project.name}"`,
                      okLabel: 'merge',
                    }).then((ok) => {
                      if (ok) void mutate({ op: 'merge-projects', id: project.id, from: o.id })
                    })
                  }
                  className={`${ghost} py-[3px]`}
                >
                  absorb {o.name}
                </button>
              ))}
            </div>
          </Section>
        )}

        <Section title="split">
          <input
            list={`roots-${project.id}`}
            value={splitRoot}
            onChange={(e) => setSplitRoot(e.target.value)}
            placeholder="folder to carve out"
            className={`${input} w-full font-mono text-[11px]`}
          />
          <datalist id={`roots-${project.id}`}>
            {roots.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <div className="mt-1.5 flex gap-1.5">
            <input
              value={splitName}
              onChange={(e) => setSplitName(e.target.value)}
              placeholder="new project name"
              className={`${input} flex-1 font-ui text-[11.5px]`}
            />
            <button
              onClick={() => {
                if (splitRoot.trim() === '' || splitName.trim() === '') return
                void mutate({
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
              className={ghost}
            >
              split
            </button>
          </div>
        </Section>

        <Section title="lifecycle">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                void mutate({ op: 'archive-project', id: project.id, archived: true })
              }
              className="rounded border border-err/45 px-2.5 py-[3px] text-[10.5px] text-err hover:bg-err/12"
            >
              archive project
            </button>
            {custom?.derivedFrom !== undefined && (
              <button
                onClick={() =>
                  void confirmAction(`Revert "${project.name}" to automatic grouping?`, {
                    detail: 'its custom record goes away; sessions regroup by repo',
                    okLabel: 'revert',
                  }).then((ok) => {
                    if (ok) void mutate({ op: 'delete-project', id: project.id })
                  })
                }
                className={`${ghost} py-[3px]`}
              >
                revert to auto
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[10.5px] text-t5">
            archiving hides its sessions unless another project claims them; nothing is deleted
          </p>
        </Section>
      </div>
    </div>
  )
}

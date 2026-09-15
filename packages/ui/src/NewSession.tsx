import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@hodor/core'
import { formatAge, launchOrCopy, type RailProject, type View } from './data.js'

/**
 * Starting a session is a decision, not a button: WHERE it runs (a repo
 * root, a worktree, a folder kept somewhere else entirely), what it's
 * called, which model, how much rope it gets.
 *
 * The old "+ new session" guessed the directory and guessed wrong: for a
 * custom project it took the first session's AUTO project's first root,
 * which for a project spanning repos is an unrelated folder — that's how
 * a WindowsApp session opened in a peri directory.
 */

export interface LaunchDir {
  storeId: string
  path: string
  /** Why it's on the list — shown so the choice is informed. */
  kind: 'root' | 'worktree' | 'cwd'
  /** Most recent session activity in this directory, if any. */
  lastActivityAt?: string
  sessions: number
}

const leaf = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() ?? p

const sepOf = (p: string): string => (p.includes('\\') && !p.startsWith('/') ? '\\' : '/')

/** A path that reads like a worktree checkout. Only ever a LABEL — never
 * a gate; worktrees live wherever the user keeps them, and the custom
 * path below is confirmed against the filesystem instead. */
const looksLikeWorktree = (p: string): boolean => /[/\\]\.?worktrees?[/\\]/i.test(p)

/**
 * Every directory it makes sense to start this project's next session in,
 * best first. Only this project's OWN evidence is used: the roots it
 * declares and the cwds its own sessions actually ran in.
 */
export function launchDirsOf(project: RailProject, view: View): LaunchDir[] {
  const byPath = new Map<string, LaunchDir>()
  const add = (storeId: string, path: string, kind: LaunchDir['kind'], s?: Session): void => {
    const key = `${storeId}|${path}`
    const at = s?.lastActivityAt
    const existing = byPath.get(key)
    if (existing === undefined) {
      byPath.set(key, {
        storeId,
        path,
        kind: looksLikeWorktree(path) ? 'worktree' : kind,
        ...(at !== undefined ? { lastActivityAt: at } : {}),
        sessions: s !== undefined ? 1 : 0,
      })
      return
    }
    if (s !== undefined) existing.sessions += 1
    if (at !== undefined && (existing.lastActivityAt ?? '') < at) existing.lastActivityAt = at
    if (kind === 'root' && existing.kind === 'cwd' && !looksLikeWorktree(path)) {
      existing.kind = 'root'
    }
  }

  // Roots this project declares (Project.roots already covers the repo's
  // worktrees), then the cwds its own sessions used, then — for a custom
  // project, whose sessions carry their own auto projects — those roots.
  for (const r of project.auto?.roots ?? []) add(r.storeId, r.path, 'root')
  for (const s of project.sessions) {
    const cwds = s.cwds.length > 0 ? s.cwds : [s.cwd].filter((c): c is string => c !== undefined)
    for (const cwd of cwds) add(s.storeId, cwd, 'cwd', s)
  }
  for (const s of project.sessions) {
    for (const r of view.derivedOf.get(s.id)?.roots ?? []) add(r.storeId, r.path, 'root')
  }

  return [...byPath.values()].sort(
    (a, b) =>
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
      b.sessions - a.sessions ||
      a.path.localeCompare(b.path),
  )
}

const MODELS = [
  { id: '', label: 'default model' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

const MODES = [
  { id: '', label: 'default' },
  { id: 'plan', label: 'plan first' },
  { id: 'acceptEdits', label: 'auto-accept edits' },
]

interface PathCheck {
  exists: boolean
  git?: 'repo' | 'worktree'
}

export function NewSessionDialog(props: {
  project: RailProject
  view: View
  nowMs: number
  close: () => void
}) {
  const { project, view, nowMs, close } = props
  const dirs = useMemo(() => launchDirsOf(project, view), [project, view])
  const [pick, setPick] = useState<number | 'custom'>(dirs.length > 0 ? 0 : 'custom')
  const [customPath, setCustomPath] = useState('')
  const [customStore, setCustomStore] = useState(dirs[0]?.storeId ?? '')
  const [check, setCheck] = useState<PathCheck | undefined>(undefined)
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  const [busy, setBusy] = useState(false)

  const base = typeof pick === 'number' ? dirs[pick] : undefined
  const storeId = base?.storeId ?? customStore
  const target = typeof pick === 'number' ? base?.path : customPath.trim()

  // Confirm a typed path against the real filesystem (debounced): a
  // worktree kept outside the repo has no history to recognize it by, so
  // "does this directory exist" is the only honest check.
  useEffect(() => {
    if (pick !== 'custom' || customPath.trim() === '' || storeId === '') {
      setCheck(undefined)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void fetch(
        `/api/pathcheck?storeId=${encodeURIComponent(storeId)}&path=${encodeURIComponent(customPath.trim())}`,
      )
        .then((r) => r.json())
        .then((j: PathCheck) => {
          if (!cancelled) setCheck(j)
        })
        .catch(() => {
          if (!cancelled) setCheck(undefined)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [pick, customPath, storeId])

  const stores = useMemo(() => [...new Set(dirs.map((d) => d.storeId))], [dirs])
  const canStart =
    target !== undefined &&
    target !== '' &&
    storeId !== '' &&
    (pick !== 'custom' || check?.exists === true) &&
    !busy

  async function start(): Promise<void> {
    if (!canStart || target === undefined) return
    setBusy(true)
    close()
    await launchOrCopy({
      kind: 'new',
      storeId,
      root: target,
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
      ...(model !== '' ? { model } : {}),
      ...(mode !== '' ? { permissionMode: mode } : {}),
    })
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-app/70 pt-[10vh]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-[min(640px,calc(100vw-48px))] flex-col gap-3 rounded-lg border border-b5 bg-s5 p-4 shadow-2xl"
      >
        <div>
          <h2 className="font-ui text-[13.5px] font-bold text-fg">
            New session in {project.name}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-t4">claude starts in the directory you pick</p>
        </div>

        <div className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
          DIRECTORY
        </div>
        <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
          {dirs.map((d, i) => (
            <button
              key={`${d.storeId}|${d.path}`}
              onClick={() => setPick(i)}
              className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-left ${
                pick === i ? 'border-ac bg-ac/8' : 'border-b3 hover:border-b5'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-ui text-[12px] font-semibold text-fg">
                    {leaf(d.path)}
                  </span>
                  {d.kind === 'worktree' && (
                    <span className="shrink-0 rounded border border-rev/50 px-1 text-[9px] text-rev">
                      worktree
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[10px] text-t5">{d.path}</span>
              </span>
              <span className="shrink-0 whitespace-nowrap text-right font-mono text-[10px] text-t5">
                {d.sessions > 0
                  ? `${d.sessions} session${d.sessions === 1 ? '' : 's'}`
                  : 'no history'}
                {d.lastActivityAt !== undefined && ` · ${formatAge(nowMs, d.lastActivityAt)}`}
              </span>
            </button>
          ))}
          <button
            onClick={() => setPick('custom')}
            className={`rounded border px-2.5 py-1.5 text-left font-ui text-[12px] ${
              pick === 'custom' ? 'border-ac bg-ac/8 text-fg' : 'border-b3 text-t3 hover:border-b5'
            }`}
          >
            another folder…
            <span className="ml-1.5 font-mono text-[10px] text-t5">
              a worktree or checkout kept anywhere
            </span>
          </button>
        </div>

        {pick === 'custom' && (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              {stores.length > 1 && (
                <select
                  value={customStore}
                  onChange={(e) => setCustomStore(e.target.value)}
                  className="shrink-0 rounded border border-b4 bg-s3 px-2 py-1 text-[11.5px] text-t2"
                  title="which machine/store this path lives on"
                >
                  {stores.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="full path, e.g. /home/you/worktrees/my-feature"
                className="min-w-0 flex-1 rounded border border-b4 bg-app px-2 py-1 font-mono text-[11px] outline-none placeholder:text-t6 focus:border-ac"
              />
            </div>
            {customPath.trim() !== '' && (
              <p className="font-mono text-[10.5px]">
                {check === undefined ? (
                  <span className="text-t5">checking…</span>
                ) : check.exists ? (
                  <span className="text-run">
                    directory found
                    {check.git === 'worktree'
                      ? ' · git worktree'
                      : check.git === 'repo'
                        ? ' · git repo'
                        : ''}
                  </span>
                ) : (
                  <span className="text-ask">no directory there on this machine</span>
                )}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
              NAME
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="optional"
              className="rounded border border-b4 bg-app px-2 py-1 text-[11.5px] outline-none placeholder:text-t6 focus:border-ac"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
              MODEL
            </span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded border border-b4 bg-s3 px-2 py-1 text-[11.5px] text-t2"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-t5">
              PERMISSIONS
            </span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="rounded border border-b4 bg-s3 px-2 py-1 text-[11.5px] text-t2"
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {target !== undefined && target !== '' && (
          <p className="truncate rounded border border-b2 bg-app px-2 py-1 font-mono text-[10.5px] text-t4">
            {target}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={close}
            className="rounded border border-b4 px-3 py-1 text-[11.5px] text-t3 hover:border-b6 hover:text-fg"
          >
            cancel
          </button>
          <button
            onClick={() => void start()}
            disabled={!canStart}
            className="rounded bg-ac px-3.5 py-1 text-[11.5px] font-semibold text-ink hover:brightness-110 disabled:opacity-40"
          >
            start session
          </button>
        </div>
      </div>
    </div>
  )
}

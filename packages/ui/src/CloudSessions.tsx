import { useState } from 'react'
import type { CloudSession } from '@hodor/core'
import { formatAge, formatTokens, formatUsd, launchOrCopy, sendCloudMessage } from './data.js'

/**
 * A cloud session (claude.ai/code) rendered as an ORDINARY session row —
 * same anatomy as a local one, interleaved in the same list. No local
 * transcript, so the row speaks the listing's own metadata: triage
 * bucket, the session's own "needs action" words, cost, context fill.
 * Actions: teleport into a terminal, queue a message, open on the web.
 */

const BUCKETS: Record<string, { label: string; className: string }> = {
  working: { label: 'working', className: 'text-run' },
  blocked: { label: 'needs you', className: 'text-ask' },
  'review-ready': { label: 'review ready', className: 'text-rev' },
  completed: { label: 'done', className: 'text-t5' },
}

/** Does this cloud session read as waiting on the human? */
export const cloudNeedsYou = (s: CloudSession): boolean =>
  s.bucket === 'blocked' || s.needsAction !== undefined

export const cloudRunning = (s: CloudSession): boolean =>
  s.status === 'running' || s.bucket === 'working'

async function messageCloud(s: CloudSession): Promise<void> {
  const text = window.prompt(
    `Message to "${s.title ?? s.id.slice(0, 12)}" (queued, keeps running in the cloud):`,
  )
  if (text === null || text.trim().length === 0) return
  const result = await sendCloudMessage(s.id, text.trim())
  if (!result.ok) {
    window.alert(`couldn't send: ${result.error ?? result.output ?? 'unknown error'}`)
  }
}

const originTag = (origin: string | undefined): string | undefined => {
  if (origin === undefined) return undefined
  if (origin.startsWith('web')) return 'web'
  return origin.replace(/_/g, ' ')
}

export function CloudRow(props: {
  session: CloudSession
  nowMs: number
  /** All-view only: which rail project this session joined, for chips. */
  projectOf?: Map<string, { id: string; name: string }> | undefined
  openProject?: ((id: string) => void) | undefined
}) {
  const { session: s, nowMs, projectOf, openProject } = props
  const [open, setOpen] = useState(false)
  const project = projectOf?.get(s.id)
  const needsYou = cloudNeedsYou(s)
  const bucket = BUCKETS[s.bucket ?? ''] // undefined for unknown buckets
  const line2 =
    s.needsAction ?? s.statusDetail ?? s.recentAction ?? s.repo ?? s.branches.join(' · ')
  const model = s.model?.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <li
      onClick={() => setOpen(!open)}
      className={`group cursor-pointer px-4 py-2 ${open ? 'bg-s3' : 'hover:bg-s1/70'}`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border border-b4 bg-s1 text-[11px] text-t6"
          title="cloud session — lives on claude.ai/code"
        >
          ☁
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`shrink-0 text-[9px] ${
                needsYou ? 'text-ask' : cloudRunning(s) ? 'text-run' : s.bucket === 'review-ready' ? 'text-rev' : 'text-b6'
              }`}
              title={bucket?.label ?? s.status}
            >
              ●
            </span>
            <span className="truncate font-ui text-[12.5px] font-bold text-fg">
              {s.title ?? s.id.slice(0, 12)}
            </span>
            {originTag(s.origin) !== undefined && (
              <span className="shrink-0 text-[10px] text-t6">{originTag(s.origin)}</span>
            )}
            {project !== undefined ? (
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  openProject?.(project.id)
                }}
                className="shrink-0 cursor-pointer rounded border border-b4 px-1.5 py-px text-[10px] text-t3 hover:text-fg"
                title="open project"
              >
                {project.name}
              </span>
            ) : (
              s.repo !== undefined && (
                <span className="shrink-0 truncate text-[10px] text-t6">{s.repo}</span>
              )
            )}
            {s.bucket === 'review-ready' && (
              <span className="shrink-0 text-[10px] font-semibold text-rev">✓ review ready</span>
            )}
            <span
              onClick={stop}
              className="ml-auto flex shrink-0 items-center gap-2 opacity-0 transition group-hover:opacity-100"
            >
              <button
                onClick={() => void launchOrCopy({ kind: 'teleport', sessionId: s.id })}
                className="text-[10.5px] text-run hover:text-run"
                title="pull this session into a terminal (web copy goes read-only)"
              >
                teleport
              </button>
              <button
                onClick={() => void messageCloud(s)}
                className="text-[10.5px] text-t4 hover:text-t1"
                title="queue a message; the session keeps running in the cloud"
              >
                message
              </button>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="text-[10.5px] text-t4 hover:text-t1"
              >
                web ↗
              </a>
            </span>
          </div>
          <div
            className={`mt-0.5 truncate pl-[17px] text-[11px] ${
              needsYou ? 'text-ask/75' : 'text-t5'
            }`}
          >
            {s.needsAction !== undefined ? `"${s.needsAction}"` : line2}
          </div>
          {s.branchGone === true && (
            <div className="mt-0.5 truncate pl-[17px] text-[10.5px] text-ask/80">
              ▲ branch gone — opens on your current branch
            </div>
          )}
        </div>

        <span className="ml-2 shrink-0 whitespace-nowrap text-right text-[10.5px] text-t5">
          {needsYou ? (
            <span className="font-semibold text-ask">waiting {formatAge(nowMs, s.updatedAt)}</span>
          ) : (
            formatAge(nowMs, s.updatedAt)
          )}
          {model !== undefined && ` · ${model}`}
          {s.costUsd !== undefined && s.costUsd >= 0.01 && ` · ${formatUsd(s.costUsd)}`}
        </span>
      </div>

      {open && (
        <div className="mt-1.5 grid gap-x-6 gap-y-0.5 pb-1 pl-[34px] text-[11px] text-t4 sm:grid-cols-2">
          {s.statusDetail !== undefined && (
            <div className="text-t3 sm:col-span-2">{s.statusDetail}</div>
          )}
          {s.recentAction !== undefined && (
            <div className="sm:col-span-2">last: {s.recentAction}</div>
          )}
          <div>
            {s.model ?? '?'}
            {s.effort !== undefined ? ` · ${s.effort}` : ''}
            {s.origin !== undefined ? ` · from ${s.origin.replace(/_/g, ' ')}` : ''}
          </div>
          <div>
            {s.contextUsed !== undefined && s.contextMax !== undefined
              ? `context ${formatTokens(s.contextUsed)}/${formatTokens(s.contextMax)}`
              : ''}
            {s.costUsd !== undefined ? ` · ${formatUsd(s.costUsd)}` : ''}
          </div>
          {s.branches.length > 0 && (
            <div className="truncate sm:col-span-2">
              <span>{s.branches.join(' · ')}</span>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

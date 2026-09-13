import { useState } from 'react'
import type { CloudSession } from '@hodor/core'
import { formatAge, formatTokens, formatUsd, launchOrCopy, sendCloudMessage } from './data.js'

/**
 * Cloud sessions (claude.ai/code): no local transcript, so rows render
 * from the listing's own metadata — status bucket, the session's own
 * "needs action" words, cost, context fill. Actions: teleport into a
 * terminal (embedded in the desktop app), queue a message without
 * taking the session over, open on the web.
 */

const BUCKETS: Record<string, { label: string; className: string }> = {
  working: { label: 'working', className: 'text-run' },
  blocked: { label: 'needs you', className: 'text-ask' },
  'review-ready': { label: 'review ready', className: 'text-sky-300' },
  completed: { label: 'done', className: 'text-t4' },
}

function bucketBadge(s: CloudSession) {
  const bucket = BUCKETS[s.bucket ?? ''] ?? {
    label: s.bucket ?? s.status,
    className: 'text-t3',
  }
  return (
    <span className={`shrink-0 text-[11px] ${bucket.className}`}>
      {s.status === 'running' ? (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-run align-middle" />
      ) : null}
      {bucket.label}
    </span>
  )
}

async function messageCloud(s: CloudSession): Promise<void> {
  const text = window.prompt(`Message to "${s.title ?? s.id.slice(0, 12)}" (queued, keeps running in the cloud):`)
  if (text === null || text.trim().length === 0) return
  const result = await sendCloudMessage(s.id, text.trim())
  if (!result.ok) {
    window.alert(`couldn't send: ${result.error ?? result.output ?? 'unknown error'}`)
  }
}

export function CloudSessionList(props: {
  sessions: CloudSession[]
  nowMs: number
  /** All-view only: which rail project each session joined, for chips. */
  projectOf?: Map<string, { id: string; name: string }> | undefined
  openProject?: (id: string) => void
}) {
  const { sessions, nowMs, projectOf, openProject } = props
  const [open, setOpen] = useState<string | undefined>(undefined)
  if (sessions.length === 0) return null
  return (
    <div className="border-b border-b1/70 bg-s3/30">
      <div className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wider text-t4 uppercase">
        cloud
      </div>
      <ul className="divide-y divide-b2">
        {sessions.map((s) => (
          <li key={s.id} className="group px-4 py-1.5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setOpen(open === s.id ? undefined : s.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex items-center gap-3">
                  {bucketBadge(s)}
                  <span className="min-w-0 truncate text-t1">
                    {s.title ?? s.id.slice(0, 12)}
                  </span>
                  {projectOf?.get(s.id) !== undefined ? (
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        openProject?.(projectOf.get(s.id)!.id)
                      }}
                      className="shrink-0 cursor-pointer rounded bg-s5 px-1.5 text-[11px] text-t3 hover:text-t1"
                      title="open project"
                    >
                      {projectOf.get(s.id)!.name}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-t5">{s.repo ?? ''}</span>
                  )}
                  <span className="shrink-0 text-xs text-t5">
                    {formatAge(nowMs, s.updatedAt)}
                  </span>
                </span>
                {s.needsAction !== undefined && (
                  <span className="mt-0.5 block truncate text-xs text-ask/80">
                    → {s.needsAction}
                  </span>
                )}
              </button>
              <span className="hidden shrink-0 items-center gap-2 text-xs group-hover:flex">
                <button
                  onClick={() => void launchOrCopy({ kind: 'teleport', sessionId: s.id })}
                  className="rounded border border-b4 px-2 py-0.5 text-t2 hover:border-acb hover:text-fg"
                  title="pull this session into a terminal (web copy goes read-only)"
                >
                  teleport
                </button>
                <button
                  onClick={() => void messageCloud(s)}
                  className="rounded border border-b4 px-2 py-0.5 text-t2 hover:border-acb hover:text-fg"
                  title="queue a message; the session keeps running in the cloud"
                >
                  message
                </button>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-b4 px-2 py-0.5 text-t2 hover:border-acb hover:text-fg"
                >
                  web ↗
                </a>
              </span>
            </div>
            {open === s.id && (
              <div className="mt-1 grid gap-x-6 gap-y-0.5 pb-1 text-xs text-t4 sm:grid-cols-2">
                {s.statusDetail !== undefined && (
                  <div className="sm:col-span-2 text-t3">{s.statusDetail}</div>
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
                  <div className="sm:col-span-2 truncate">
                    <span className="font-mono">{s.branches.join(' · ')}</span>
                    {s.branchGone === true && (
                      <span
                        className="ml-2 text-ask"
                        title="This branch was deleted (usually after its PR merged). Claude will print 'Session resumed without branch' and continue on whatever branch you're on — the session content is unaffected."
                      >
                        branch gone — opens on your current branch
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

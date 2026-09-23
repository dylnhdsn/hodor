import { useEffect, useState } from 'react'
import type { Session, Snapshot } from '@hodor/core'
import {
  fetchTranscript,
  formatAge,
  formatBytes,
  formatTokens,
  formatUsd,
  launchOrCopy,
  postMutation,
  titleOf,
  type TranscriptEntry,
  type View,
} from './data.js'
import { promptText } from './dialog.js'
import { matcherValue, Section } from './ProjectSettings.js'

/**
 * A session's detail page (docs/brainstorm/011): facts, tools, hooks,
 * usage on the left; lineage, subagents, projects and the transcript tail
 * on the right. Lives on the project overlay's third page.
 */

export function SessionDetail(props: {
  session: Session
  nowMs: number
  view: View
  snapshot: Snapshot
  jump: (id: string) => void
}) {
  const { session: s, nowMs, view, snapshot, jump } = props
  const [tail, setTail] = useState<TranscriptEntry[] | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setTail(undefined)
    void fetchTranscript(s.id, 12).then((messages) => {
      if (!cancelled) setTail(messages)
    })
    return () => {
      cancelled = true
    }
    // refetch when activity moves, so an open pane follows a live session
  }, [s.id, s.lastActivityAt])

  const sidechains = s.threads.filter((t) => t.kind === 'sidechain')
  const placements = view.placementsBySession.get(s.id) ?? []
  const derived = view.derivedOf.get(s.id)
  const memoryRoots = new Set([...(derived?.roots.map((r) => r.path) ?? []), ...s.cwds])
  const memoryFiles = snapshot.memoryFiles.filter((f) => !f.userLevel && memoryRoots.has(f.root))
  const ancestor = s.forkedFrom !== undefined ? view.byId.get(s.forkedFrom) : undefined
  const forks = view.forksOf.get(s.id) ?? []
  const projectName = (id: string) => snapshot.customProjects.find((p) => p.id === id)?.name ?? id
  const isArchivedProject = (id: string) =>
    snapshot.customProjects.find((p) => p.id === id)?.archived === true

  async function rename() {
    const name = await promptText('rename session', { initial: titleOf(s), okLabel: 'rename' })
    if (name === undefined || name.trim().length === 0) return
    await postMutation('/api/session', { op: 'rename-session', sessionId: s.id, name: name.trim() })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[11.5px]">
      <div className="mb-1 flex items-start gap-2">
        <h2 className="min-w-0 flex-1 font-ui text-[14px] font-bold break-words text-fg">
          {titleOf(s)}
        </h2>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5 text-t4">
        <span className="font-mono">{s.id.slice(0, 8)}</span>
        <button
          onClick={() => void launchOrCopy({ kind: 'resume', sessionId: s.id })}
          className="text-run hover:text-run"
          title="open a terminal resuming this session"
        >
          resume
        </button>
        <button
          onClick={() => void launchOrCopy({ kind: 'fork', sessionId: s.id })}
          className="text-t4 hover:text-t1"
          title="resume as a new forked session"
        >
          fork
        </button>
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(`cd ${JSON.stringify(s.cwds[0] ?? s.cwd ?? '.')} && claude --resume ${s.id}`)
              .catch(() => {})
          }
          className="text-t5 hover:text-t2"
          title="copy the resume command"
        >
          copy cmd
        </button>
        <button
          onClick={() => void navigator.clipboard.writeText(s.id).catch(() => {})}
          className="text-t5 hover:text-t2"
        >
          copy id
        </button>
        <button onClick={() => void rename()} className="text-t5 hover:text-t2">
          rename
        </button>
        {s.hiddenBy === 'archived' ? (
          <button
            onClick={() =>
              void postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived: false })
            }
            className="text-t5 hover:text-t2"
          >
            unarchive
          </button>
        ) : (
          <button
            onClick={() =>
              void postMutation('/api/session', { op: 'archive-session', sessionId: s.id, archived: true })
            }
            className="text-t5 hover:text-t2"
          >
            archive
          </button>
        )}
      </div>

      {s.hiddenBy !== undefined && (
        <p className="mb-3 rounded bg-ask/10 px-2 py-1 text-ask">
          hidden — {s.hiddenBy}
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-6">
      <div>
      <Section title="facts">
        <Fact label="last activity" value={formatAge(nowMs, s.lastActivityAt)} />
        <Fact label="created" value={formatAge(nowMs, s.createdAt)} />
        <Fact label="messages" value={`${s.counts.user} you · ${s.counts.assistant} claude`} />
        {s.counts.toolCalls > 0 && <Fact label="tool calls" value={String(s.counts.toolCalls)} />}
        {s.gitBranch !== undefined && <Fact label="branch" value={s.gitBranch} />}
        <Fact label="entrypoint" value={s.entrypoints.join(', ') || '-'} />
        {s.slug !== undefined && <Fact label="slug" value={s.slug} mono />}
        {s.effort !== undefined && <Fact label="effort" value={s.effort} />}
        {s.fastMode === true && <Fact label="speed" value="fast mode used" />}
        {s.serviceTier !== undefined && s.serviceTier !== 'standard' && (
          <Fact label="tier" value={s.serviceTier} />
        )}
        {s.inferenceGeo !== undefined && <Fact label="inference geo" value={s.inferenceGeo} />}
        {s.contextTokens !== undefined && (
          <Fact label="context" value={`${formatTokens(s.contextTokens)} tokens`} />
        )}
        {s.compactions !== undefined && (
          <Fact
            label="compactions"
            value={
              s.lastCompaction?.preTokens !== undefined && s.lastCompaction.postTokens !== undefined
                ? `${s.compactions}× (last ${formatTokens(s.lastCompaction.preTokens)} → ${formatTokens(s.lastCompaction.postTokens)})`
                : `${s.compactions}×`
            }
          />
        )}
        {s.checkpoints !== undefined && (
          <Fact
            label="checkpoints"
            value={`${s.checkpoints.count} · ${s.checkpoints.files.length} files${
              s.checkpoints.backupFiles === undefined
                ? ''
                : s.checkpoints.backupFiles > 0
                  ? ' · restorable'
                  : ' · backups gone'
            }`}
          />
        )}
        {s.cliVersion !== undefined && <Fact label="cli" value={s.cliVersion} />}
        {memoryFiles.length > 0 && (
          <Fact
            label="memory"
            value={memoryFiles.map((f) => `${f.name} ${formatBytes(f.bytes)}`).join(' · ')}
          />
        )}
        <Fact label="cwd" value={s.cwd ?? '-'} mono />
        {s.apiErrors !== undefined && (
          <div className="flex justify-between gap-3 py-0.5">
            <span className="shrink-0 text-t5">api errors</span>
            <span className="text-ask">{s.apiErrors}</span>
          </div>
        )}
      </Section>

      {s.toolCounts !== undefined && <ToolsSection toolCounts={s.toolCounts} />}

      {s.hooks !== undefined && (
        <Section title="hooks">
          {Object.entries(s.hooks).map(([command, h]) => (
            <div key={command} className="flex items-center justify-between gap-2 py-0.5">
              <span className="min-w-0 truncate font-mono text-t3" title={command}>
                {command.split('/').pop()}
              </span>
              <span className="shrink-0 text-t5">
                {h.runs}× · {h.totalMs >= 1000 ? `${(h.totalMs / 1000).toFixed(1)}s` : `${h.totalMs}ms`}
              </span>
            </div>
          ))}
          {(s.hookErrors !== undefined || s.hookBlocks !== undefined) && (
            <p className="mt-1 text-ask">
              {s.hookErrors !== undefined ? `${s.hookErrors} error${s.hookErrors === 1 ? '' : 's'}` : ''}
              {s.hookErrors !== undefined && s.hookBlocks !== undefined ? ' · ' : ''}
              {s.hookBlocks !== undefined ? `blocked continuation ${s.hookBlocks}×` : ''}
            </p>
          )}
        </Section>
      )}

      {s.usage !== undefined && (
        <Section title="usage">
          {Object.entries(s.usage).map(([model, u]) => (
            <div key={model} className="py-0.5">
              <div className="text-t2">{model.replace(/^claude-/, '')}</div>
              <div className="pl-2 text-t4">
                in {formatTokens(u.input)} · out {formatTokens(u.output)}
                {u.thinking > 0 && <> (think {formatTokens(u.thinking)})</>} · cache read{' '}
                {formatTokens(u.cacheRead)} · cache write {formatTokens(u.cacheWrite5m + u.cacheWrite1h)}
              </div>
            </div>
          ))}
          {s.costUsd !== undefined && (
            <div className="mt-1 border-t border-b1 pt-1 text-t2">
              est. cost {formatUsd(s.costUsd)}
              {(s.costUnpriced ?? []).length > 0 && (
                <span className="text-ask"> + unpriced: {s.costUnpriced!.join(', ')}</span>
              )}
            </div>
          )}
        </Section>
      )}

      </div>
      <div>
      {(ancestor !== undefined || s.forkedFrom !== undefined || forks.length > 0) && (
        <Section title="lineage">
          {s.forkedFrom !== undefined && (
            <div className="py-0.5">
              forked from{' '}
              {ancestor !== undefined ? (
                <button onClick={() => jump(ancestor.id)} className="text-acb hover:underline">
                  {titleOf(ancestor)}
                </button>
              ) : (
                <span className="font-mono text-t4">{s.forkedFrom.slice(0, 8)} (gone)</span>
              )}
            </div>
          )}
          {forks.map((fork) => (
            <div key={fork.id} className="py-0.5">
              fork:{' '}
              <button onClick={() => jump(fork.id)} className="text-acb hover:underline">
                {titleOf(fork)}
              </button>
            </div>
          ))}
        </Section>
      )}

      {sidechains.length > 0 && (
        <Section title={`subagents (${sidechains.length})`}>
          {sidechains.map((t) => (
            <div key={t.id} className="py-0.5">
              <div className="flex items-center justify-between text-t3">
                <span>
                  ⑂ {t.agentType ?? 'agent'} · {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                  {t.costUsd !== undefined && t.costUsd >= 0.005 && (
                    <span className="text-t4"> · {formatUsd(t.costUsd)}</span>
                  )}
                </span>
                <span className="text-t5">{formatAge(nowMs, t.lastTs)}</span>
              </div>
              {t.description !== undefined && (
                <div className="truncate pl-4 text-t5">{t.description}</div>
              )}
            </div>
          ))}
        </Section>
      )}

      <Section title="projects">
        {placements.map((p) => (
          <div key={p.customProjectId} className="py-0.5">
            <span className="text-t2">{projectName(p.customProjectId)}</span>
            {isArchivedProject(p.customProjectId) && <span className="text-ask"> (archived)</span>}
            <span className="text-t5">
              {' — '}
              {p.via === 'include'
                ? 'pinned by you'
                : p.via === 'organize'
                  ? 'your organize logic'
                  : `${p.via.kind}=${matcherValue(p.via)}`}
            </span>
          </div>
        ))}
        {derived !== undefined && (
          <div className="py-0.5 text-t4">
            auto: {derived.name}
            <span className="text-t5">
              {' — '}
              {derived.identity.kind === 'git-remote'
                ? `remote ${derived.identity.url}`
                : `path ${derived.identity.root}`}
            </span>
          </div>
        )}
        {placements.length === 0 && derived === undefined && (
          <p className="text-t5">not grouped anywhere</p>
        )}
      </Section>

      <Section title="conversation">
        {tail === undefined && <p className="text-t5">loading…</p>}
        {tail !== undefined && tail.length === 0 && (
          <p className="text-t5">nothing readable in the transcript</p>
        )}
        {tail?.map((entry, i) => (
          <div key={i} className={`py-1 ${entry.isSidechain ? 'opacity-60' : ''}`}>
            <span
              className={`mr-1.5 font-medium ${
                entry.type === 'user' ? 'text-acb' : 'text-run'
              }`}
            >
              {entry.isSidechain ? '⑂ ' : ''}
              {entry.type === 'user' ? 'you' : 'claude'}
            </span>
            <span className="text-t3">{entry.text}</span>
          </div>
        ))}
      </Section>
      </div>
      </div>
    </div>
  )
}

function ToolsSection(props: { toolCounts: Record<string, number> }) {
  const entries = Object.entries(props.toolCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = entries.slice(0, 10)
  const rest = entries.length - shown.length
  const max = shown[0]?.[1] ?? 1
  return (
    <Section title="tools">
      {shown.map(([name, n]) => (
        <div key={name} className="flex items-center gap-2 py-0.5">
          <span className="w-36 shrink-0 truncate text-t3">{name}</span>
          <div className="h-1.5 min-w-0 flex-1 rounded bg-s3">
            <div
              className="h-1.5 rounded bg-ac/40"
              style={{ width: `${Math.max(3, Math.round((n / max) * 100))}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-t4">{n}</span>
        </div>
      ))}
      {rest > 0 && <p className="text-t5">+{rest} more</p>}
    </Section>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="shrink-0 text-t5">{props.label}</span>
      <span className={`truncate text-t2 ${props.mono === true ? 'font-mono' : ''}`}>
        {props.value}
      </span>
    </div>
  )
}

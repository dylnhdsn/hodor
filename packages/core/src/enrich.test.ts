import { describe, expect, it } from 'vitest'
import type { MessageLine } from './claude/transcript.js'
import { enrichGitContexts } from './enrich.js'
import type { SourceEvent } from './events.js'
import { emptyState, foldAll, gitKey } from './fold.js'
import { MemFs } from './fs.js'

const msg = (uuid: string, cwd: string): MessageLine => ({
  kind: 'message',
  type: 'user',
  uuid,
  parentUuid: null,
  isSidechain: false,
  cwd,
})

const linesFor = (id: string, cwds: string[]): SourceEvent => ({
  type: 'transcript-lines',
  storeId: 's1',
  transcriptPath: `/home/.claude/projects/-x/${id}.jsonl`,
  sessionId: id,
  lines: cwds.map((cwd, i) => msg(`${id}-${i}`, cwd)),
})

describe('enrichGitContexts', () => {
  it('resolves every unresolved cwd exactly once, including negatives', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/a/.git/config', '[remote "origin"]\n\turl = https://github.com/o/a\n')

    let state = foldAll(emptyState, [
      linesFor('one', ['/repo/a', '/elsewhere']),
      linesFor('two', ['/repo/a']),
    ])
    const events = await enrichGitContexts(state, fs)
    expect(events).toHaveLength(2) // '/repo/a' deduped across sessions

    state = foldAll(state, events)
    expect(state.gitContexts[gitKey('s1', '/repo/a')]).toMatchObject({ repoRoot: '/repo/a' })
    expect(state.gitContexts[gitKey('s1', '/elsewhere')]).toBeNull()

    // Second pass: everything cached, nothing to do.
    expect(await enrichGitContexts(state, fs)).toEqual([])
  })
})

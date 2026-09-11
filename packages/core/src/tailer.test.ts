import { describe, expect, it } from 'vitest'
import { MemFs } from './fs.js'
import { StoreTailer, scanStore, splitCompleteLines } from './tailer.js'
import type { SessionStore } from './types.js'

const store: SessionStore = {
  id: 's1',
  rootPath: '/home/.claude',
  pathFlavor: 'posix',
  origin: { kind: 'native' },
  watchStrategy: 'poll',
}

const bucket = '/home/.claude/projects/-repo-a'
const line = (uuid: string, extra = '') =>
  `{"type":"user","uuid":"${uuid}","parentUuid":null,"isSidechain":false${extra}}\n`

describe('splitCompleteLines', () => {
  const enc = (s: string) => new TextEncoder().encode(s)

  it('returns everything as rest when no newline exists', () => {
    const { lines, rest } = splitCompleteLines(enc('partial'))
    expect(lines).toEqual([])
    expect(new TextDecoder().decode(rest)).toBe('partial')
  })

  it('splits complete lines off and keeps the tail', () => {
    const { lines, rest } = splitCompleteLines(enc('a\nb\ncc'))
    expect(lines).toEqual(['a', 'b'])
    expect(new TextDecoder().decode(rest)).toBe('cc')
  })

  it('drops blank and whitespace-only lines', () => {
    const { lines, rest } = splitCompleteLines(enc('a\n\n  \nb\n'))
    expect(lines).toEqual(['a', 'b'])
    expect(rest.length).toBe(0)
  })
})

describe('StoreTailer', () => {
  it('first poll announces the store and reads existing transcripts', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1') + line('u2'))
    const events = await scanStore(fs, store)
    expect(events[0]).toEqual({ type: 'store-discovered', store })
    expect(events[1]).toMatchObject({ type: 'transcript-lines', sessionId: 'aaa' })
    expect(events[1]).toHaveProperty('lines.length', 2)
  })

  it('discovers modern subagent transcripts into the parent session', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1'))
    fs.writeFile(
      `${bucket}/aaa/subagents/agent-x1.jsonl`,
      `{"type":"user","uuid":"s1","parentUuid":null,"isSidechain":true,"agentId":"x1"}\n`,
    )
    fs.writeFile(
      `${bucket}/aaa/subagents/agent-x1.meta.json`,
      `{"agentType":"Explore","description":"probe the fixture","toolUseId":"t1"}`,
    )
    // non-transcript clutter in the session dir is ignored
    fs.writeFile(`${bucket}/aaa/ccr-tip.json`, `{}`)

    const events = await scanStore(fs, store)
    const meta = events.find((e) => e.type === 'subagent-meta')
    expect(meta).toEqual({
      type: 'subagent-meta',
      storeId: 's1',
      sessionId: 'aaa',
      transcriptPath: `${bucket}/aaa.jsonl`,
      agentId: 'x1',
      agentType: 'Explore',
      description: 'probe the fixture',
    })
    const lineEvents = events.filter((e) => e.type === 'transcript-lines')
    // both files feed session 'aaa', both carrying the MAIN transcript path
    expect(lineEvents).toHaveLength(2)
    for (const e of lineEvents) {
      expect(e).toMatchObject({ sessionId: 'aaa', transcriptPath: `${bucket}/aaa.jsonl` })
    }
  })

  it('tails subagent files incrementally and never removes the parent on their removal', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1'))
    const agent = `${bucket}/aaa/subagents/agent-x1.jsonl`
    fs.writeFile(agent, `{"type":"user","uuid":"s1","parentUuid":null,"isSidechain":true,"agentId":"x1"}\n`)
    const tailer = new StoreTailer(fs, store)
    await tailer.poll()

    fs.appendFile(agent, `{"type":"assistant","uuid":"s2","parentUuid":"s1","isSidechain":true,"agentId":"x1"}\n`)
    const appended = await tailer.poll()
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ type: 'transcript-lines', sessionId: 'aaa', lines: [{ uuid: 's2' }] })

    fs.removeFile(agent)
    const afterRemoval = await tailer.poll()
    expect(afterRemoval.filter((e) => e.type === 'transcript-removed')).toEqual([])
  })

  it('subsequent polls emit only appended lines', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1'))
    const tailer = new StoreTailer(fs, store)
    await tailer.poll()
    expect(await tailer.poll()).toEqual([])
    fs.appendFile(`${bucket}/aaa.jsonl`, line('u2'))
    const events = await tailer.poll()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'transcript-lines', lines: [{ uuid: 'u2' }] })
  })

  it('buffers a partial line until its newline arrives', async () => {
    const fs = new MemFs()
    const full = line('u1')
    fs.writeFile(`${bucket}/aaa.jsonl`, full.slice(0, 10))
    const tailer = new StoreTailer(fs, store)
    const first = await tailer.poll()
    expect(first.filter((e) => e.type === 'transcript-lines')).toEqual([])
    fs.appendFile(`${bucket}/aaa.jsonl`, full.slice(10))
    const events = await tailer.poll()
    expect(events[0]).toMatchObject({ type: 'transcript-lines', lines: [{ uuid: 'u1' }] })
  })

  it('reassembles a multi-byte character split across polls', async () => {
    const fs = new MemFs()
    const full = new TextEncoder().encode(line('u1', ',"cwd":"/héllo/wörld"'))
    const splitAt = full.indexOf(0xc3) + 1 // between the two bytes of é
    fs.writeFile(`${bucket}/aaa.jsonl`, '')
    const tailer = new StoreTailer(fs, store)
    await tailer.poll()
    fs.appendBytes(`${bucket}/aaa.jsonl`, full.slice(0, splitAt))
    const mid = await tailer.poll()
    expect(mid.filter((e) => e.type === 'transcript-lines')).toEqual([])
    fs.appendBytes(`${bucket}/aaa.jsonl`, full.slice(splitAt))
    const events = await tailer.poll()
    expect(events[0]).toMatchObject({ type: 'transcript-lines', lines: [{ cwd: '/héllo/wörld' }] })
  })

  it('emits transcript-removed when a file disappears', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1'))
    const tailer = new StoreTailer(fs, store)
    await tailer.poll()
    fs.removeFile(`${bucket}/aaa.jsonl`)
    expect(await tailer.poll()).toEqual([
      { type: 'transcript-removed', storeId: 's1', transcriptPath: `${bucket}/aaa.jsonl` },
    ])
  })

  it('treats truncation as removal plus fresh content', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1') + line('u2'))
    const tailer = new StoreTailer(fs, store)
    await tailer.poll()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u9'))
    const events = await tailer.poll()
    expect(events[0]).toMatchObject({ type: 'transcript-removed' })
    expect(events[1]).toMatchObject({ type: 'transcript-lines', lines: [{ uuid: 'u9' }] })
  })

  it('detects a same-size rewrite via mtime', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1'))
    const tailer = new StoreTailer(fs, store)
    await tailer.poll()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u2')) // same byte length
    const events = await tailer.poll()
    expect(events[0]).toMatchObject({ type: 'transcript-removed' })
    expect(events[1]).toMatchObject({ type: 'transcript-lines', lines: [{ uuid: 'u2' }] })
  })

  it('ignores non-jsonl files and nested noise', async () => {
    const fs = new MemFs()
    fs.writeFile(`${bucket}/aaa.jsonl`, line('u1'))
    fs.writeFile(`${bucket}/aaa/ccr-tip.json`, '{}')
    fs.writeFile('/home/.claude/settings.json', '{}')
    const events = await scanStore(fs, store)
    expect(events.filter((e) => e.type === 'transcript-lines')).toHaveLength(1)
  })
})

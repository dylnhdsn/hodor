import { describe, expect, it } from 'vitest'
import { REAL_LINES } from './fixtures.js'
import { PROMPT_TEXT_MAX_LENGTH, parseTranscript, parseTranscriptLine } from './transcript.js'

describe('parseTranscriptLine on real captured lines', () => {
  it('never throws and never yields invalid for real lines', () => {
    for (const raw of REAL_LINES) {
      const line = parseTranscriptLine(raw)
      expect(line.kind).not.toBe('invalid')
    }
  })

  it('parses a real user message line, prompt text and entrypoint included', () => {
    const raw = REAL_LINES.find((l) => JSON.parse(l).type === 'user')!
    const line = parseTranscriptLine(raw)
    expect(line).toMatchObject({
      kind: 'message',
      type: 'user',
      uuid: 'cb22b020-1446-4d7b-aa6d-7ac01a513582',
      parentUuid: null,
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-09T16:19:58.338Z',
      entrypoint: 'remote',
    })
    expect((line as { promptText?: string }).promptText).toMatch(/^Lets discuss the tool/)
  })

  it('parses a real assistant message line with cwd', () => {
    const raw = REAL_LINES.find((l) => JSON.parse(l).type === 'assistant')!
    const line = parseTranscriptLine(raw)
    expect(line).toMatchObject({
      kind: 'message',
      type: 'assistant',
      cwd: '/home/user/hodor',
    })
  })

  it('extracts an assistant text preview, collapsed and truncated', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'text', text: '  Done —\n\n the tests   pass. '.repeat(20) },
          ],
        },
      }),
    )
    expect(line.kind).toBe('message')
    const preview = (line as { textPreview?: string }).textPreview!
    expect(preview.startsWith('Done — the tests pass.')).toBe(true)
    expect(preview.length).toBe(200)

    // tool-use-only content yields no preview
    const toolOnly = parseTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read' }] },
      }),
    )
    expect(toolOnly).not.toHaveProperty('textPreview')
  })

  it('extracts model, message id, usage, and tool-use counts from assistant lines', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          role: 'assistant',
          id: 'msg_01ABC',
          model: 'claude-opus-5',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 19294,
            cache_read_input_tokens: 39066,
            output_tokens: 770,
            cache_creation: { ephemeral_1h_input_tokens: 19294, ephemeral_5m_input_tokens: 0 },
            service_tier: 'standard',
          },
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
      }),
    )
    expect(line).toMatchObject({
      model: 'claude-opus-5',
      messageId: 'msg_01ABC',
      usage: { input: 2, output: 770, cacheRead: 39066, cacheWrite5m: 0, cacheWrite1h: 19294 },
      toolUses: 2,
    })
  })

  it('falls back to the 5m TTL when only the cache-write total exists', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        message: {
          role: 'assistant',
          id: 'msg_2',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 123 },
          content: [{ type: 'text', text: 'hi' }],
        },
      }),
    )
    expect(line).toMatchObject({
      usage: { input: 5, output: 9, cacheRead: 0, cacheWrite5m: 123, cacheWrite1h: 0 },
    })
    expect(line).not.toHaveProperty('toolUses')
  })

  it('downgrades a uuid-less system line to operational noise', () => {
    const raw = REAL_LINES.find((l) => JSON.parse(l).type === 'system')!
    expect(parseTranscriptLine(raw)).toEqual({ kind: 'other', type: 'system' })
  })

  it('classifies operational line types as other', () => {
    const raw = REAL_LINES.find((l) => JSON.parse(l).type === 'queue-operation')!
    expect(parseTranscriptLine(raw)).toEqual({ kind: 'other', type: 'queue-operation' })
  })
})

describe('parseTranscriptLine edge cases', () => {
  it('parses summary lines', () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: 'summary', summary: 'Session manager brainstorm', leafUuid: 'abc' }),
    )
    expect(line).toEqual({ kind: 'summary', summary: 'Session manager brainstorm', leafUuid: 'abc' })
  })

  it('extracts sidechain spawn links', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: true,
        toolUseID: 'toolu_1',
        sourceToolAssistantUUID: 'a9',
      }),
    )
    expect(line).toMatchObject({
      kind: 'message',
      isSidechain: true,
      spawnedBy: { toolUseId: 'toolu_1', assistantUuid: 'a9' },
    })
  })

  it('accepts a system line that does carry a uuid', () => {
    const line = parseTranscriptLine(JSON.stringify({ type: 'system', uuid: 's1', parentUuid: 'p' }))
    expect(line).toMatchObject({ kind: 'message', type: 'system', uuid: 's1', parentUuid: 'p' })
  })

  it('omits spawnedBy unless both link fields are present', () => {
    const onlyTool = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u1', isSidechain: true, toolUseID: 't1' }),
    )
    expect(onlyTool).not.toHaveProperty('spawnedBy')
    const onlySource = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u1', isSidechain: true, sourceToolAssistantUUID: 'a1' }),
    )
    expect(onlySource).not.toHaveProperty('spawnedBy')
  })

  it('parses a summary without leafUuid to exactly two fields', () => {
    expect(parseTranscriptLine('{"type":"summary","summary":"t"}')).toEqual({
      kind: 'summary',
      summary: 't',
    })
  })

  it('extracts prompt text from block-array content and collapses whitespace', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: '  fix\n\nthe   bug  ' }] },
      }),
    )
    expect(line).toMatchObject({ promptText: 'fix the bug' })
  })

  it('truncates long prompts', () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x'.repeat(500) } }),
    )
    expect((line as { promptText?: string }).promptText).toHaveLength(PROMPT_TEXT_MAX_LENGTH)
  })

  it('takes no prompt text from meta lines, empty content, or non-text blocks', () => {
    const meta = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u1', isMeta: true, message: { content: 'noise' } }),
    )
    expect(meta).toMatchObject({ isMeta: true })
    expect(meta).not.toHaveProperty('promptText')
    const empty = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: '   ' } }),
    )
    expect(empty).not.toHaveProperty('promptText')
    const blocks = parseTranscriptLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', text: 'nope' }, null] },
      }),
    )
    expect(blocks).not.toHaveProperty('promptText')
  })

  it('extracts slash-command names instead of command markup', () => {
    const viaName = parseTranscriptLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: {
          content:
            '<command-message>gsd-resume-work</command-message>\n<command-name>/gsd-resume-work</command-name>',
        },
      }),
    )
    expect(viaName).toMatchObject({ commandName: '/gsd-resume-work' })
    expect(viaName).not.toHaveProperty('promptText')

    const viaMessage = parseTranscriptLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        message: { content: '<command-message>peri:peri</command-message>' },
      }),
    )
    expect(viaMessage).toMatchObject({ commandName: '/peri:peri' })

    const unextractable = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u3', message: { content: '<command-mystery/>' } }),
    )
    expect(unextractable).not.toHaveProperty('commandName')
    expect(unextractable).not.toHaveProperty('promptText')
  })

  it('never titles a session from machine-generated user turns', () => {
    for (const content of [
      '<local-command-stdout>Login successful</local-command-stdout>',
      '<task-notification> <task-id>abc</task-id>',
      '<system-reminder>stuff</system-reminder>',
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
    ]) {
      const line = parseTranscriptLine(
        JSON.stringify({ type: 'user', uuid: 'u1', message: { content } }),
      )
      expect(line, content).not.toHaveProperty('promptText')
      expect(line, content).not.toHaveProperty('commandName')
    }
  })

  it('reports why a line is invalid', () => {
    expect(parseTranscriptLine('{oops')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('not JSON') })
    expect(parseTranscriptLine('42')).toMatchObject({ kind: 'invalid', error: 'not a JSON object' })
    expect(parseTranscriptLine('{"no":"type"}')).toMatchObject({ kind: 'invalid', error: 'missing type' })
  })

  it('tolerates unknown line types', () => {
    expect(parseTranscriptLine('{"type":"hologram","x":1}')).toEqual({ kind: 'other', type: 'hologram' })
  })

  it('degrades malformed JSON to invalid without throwing', () => {
    expect(parseTranscriptLine('{oops').kind).toBe('invalid')
    expect(parseTranscriptLine('42').kind).toBe('invalid')
    expect(parseTranscriptLine('{"no":"type"}').kind).toBe('invalid')
  })
})

describe('parseTranscript', () => {
  it('parses every non-blank line of a body', () => {
    const body = REAL_LINES.join('\n') + '\n\n'
    expect(parseTranscript(body)).toHaveLength(REAL_LINES.length)
  })
})

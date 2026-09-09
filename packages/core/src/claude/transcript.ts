import { z } from 'zod'

/**
 * Tolerant parser for Claude Code transcript JSONL lines.
 *
 * The format is unversioned and drifts between CLI releases, so parsing is
 * deliberately loose: unknown line types and unknown fields never fail, and
 * a malformed line degrades to kind 'invalid' instead of throwing. Only the
 * fields hodor actually consumes are modeled.
 */

const messageLineSchema = z
  .object({
    type: z.string(),
    uuid: z.string(),
    parentUuid: z.string().nullish(),
    sessionId: z.string().optional(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    version: z.string().optional(),
    isSidechain: z.boolean().optional(),
    toolUseID: z.string().optional(),
    sourceToolAssistantUUID: z.string().optional(),
    message: z.object({ role: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()

const summaryLineSchema = z
  .object({
    type: z.literal('summary'),
    summary: z.string(),
    leafUuid: z.string().optional(),
  })
  .passthrough()

const MESSAGE_TYPES = new Set(['user', 'assistant', 'system'])

export interface MessageLine {
  kind: 'message'
  type: 'user' | 'assistant' | 'system'
  uuid: string
  parentUuid: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  isSidechain: boolean
  spawnedBy?: { toolUseId: string; assistantUuid: string }
}

export interface SummaryLine {
  kind: 'summary'
  summary: string
  leafUuid?: string
}

export interface OtherLine {
  kind: 'other'
  type: string
}

export interface InvalidLine {
  kind: 'invalid'
  error: string
}

export type TranscriptLine = MessageLine | SummaryLine | OtherLine | InvalidLine

export function parseTranscriptLine(raw: string): TranscriptLine {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { kind: 'invalid', error: `not JSON: ${String(error)}` }
  }
  if (typeof json !== 'object' || json === null) {
    return { kind: 'invalid', error: 'not a JSON object' }
  }

  const summary = summaryLineSchema.safeParse(json)
  if (summary.success) {
    return {
      kind: 'summary',
      summary: summary.data.summary,
      ...(summary.data.leafUuid !== undefined ? { leafUuid: summary.data.leafUuid } : {}),
    }
  }

  const type = (json as { type?: unknown }).type
  if (typeof type !== 'string') {
    return { kind: 'invalid', error: 'missing type' }
  }

  if (MESSAGE_TYPES.has(type)) {
    const parsed = messageLineSchema.safeParse(json)
    if (!parsed.success) {
      // A message-typed line without a uuid (or otherwise malformed) is
      // operational noise, not a message.
      return { kind: 'other', type }
    }
    const d = parsed.data
    const line: MessageLine = {
      kind: 'message',
      type: type as MessageLine['type'],
      uuid: d.uuid,
      parentUuid: d.parentUuid ?? null,
      isSidechain: d.isSidechain ?? false,
    }
    if (d.sessionId !== undefined) line.sessionId = d.sessionId
    if (d.timestamp !== undefined) line.timestamp = d.timestamp
    if (d.cwd !== undefined) line.cwd = d.cwd
    if (d.gitBranch !== undefined) line.gitBranch = d.gitBranch
    if (d.version !== undefined) line.version = d.version
    if (d.toolUseID !== undefined && d.sourceToolAssistantUUID !== undefined) {
      line.spawnedBy = { toolUseId: d.toolUseID, assistantUuid: d.sourceToolAssistantUUID }
    }
    return line
  }

  return { kind: 'other', type }
}

/** Parse a whole transcript body; skips blank lines, never throws. */
export function parseTranscript(content: string): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const raw of content.split('\n')) {
    if (raw.trim().length === 0) continue
    lines.push(parseTranscriptLine(raw))
  }
  return lines
}

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
    isMeta: z.boolean().optional(),
    entrypoint: z.string().optional(),
    toolUseID: z.string().optional(),
    sourceToolAssistantUUID: z.string().optional(),
    message: z
      .object({ role: z.string().optional(), content: z.unknown().optional() })
      .passthrough()
      .optional(),
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
  /** Synthetic context lines (command output etc.), not typed by a person. */
  isMeta: boolean
  /** How the session was started, as stamped on this line (cli, sdk, remote…). */
  entrypoint?: string
  /** For user messages: the prompt text, whitespace-collapsed and truncated. */
  promptText?: string
  /** For user messages that invoke a slash command: its name, e.g. "/model". */
  commandName?: string
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

export const PROMPT_TEXT_MAX_LENGTH = 120

/** Message content is a string or an array of blocks; take the first text. */
function firstTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const candidate = (block as { type?: unknown; text?: unknown } | null) ?? {}
    if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text
  }
  return undefined
}

type PromptContent = { kind: 'prompt'; text: string } | { kind: 'command'; name: string }

/**
 * Machine-generated user turns that make terrible titles: local command
 * stdout, task notifications, system envelopes, interruption markers.
 */
const NON_PROMPT_PREFIXES = [
  '<local-command-stdout>',
  '<task-notification>',
  '<system-',
  '[Request interrupted',
]

/**
 * A session started with a slash command records it as XML-ish markup
 * (`<command-message>…</command-message> <command-name>/foo</command-name>`),
 * which makes a terrible title — extract the command name instead.
 */
function classifyPromptContent(content: unknown): PromptContent | undefined {
  const text = firstTextOf(content)
  if (text === undefined) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return undefined
  if (collapsed.startsWith('<command-')) {
    const name =
      collapsed.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/)?.[1] ??
      collapsed.match(/<command-message>\s*([^<]+?)\s*<\/command-message>/)?.[1]
    if (name === undefined) return undefined
    return { kind: 'command', name: name.startsWith('/') ? name : `/${name}` }
  }
  if (NON_PROMPT_PREFIXES.some((prefix) => collapsed.startsWith(prefix))) return undefined
  return { kind: 'prompt', text: collapsed.slice(0, PROMPT_TEXT_MAX_LENGTH) }
}

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
      isMeta: d.isMeta ?? false,
    }
    if (d.sessionId !== undefined) line.sessionId = d.sessionId
    if (d.timestamp !== undefined) line.timestamp = d.timestamp
    if (d.cwd !== undefined) line.cwd = d.cwd
    if (d.gitBranch !== undefined) line.gitBranch = d.gitBranch
    if (d.version !== undefined) line.version = d.version
    if (d.entrypoint !== undefined) line.entrypoint = d.entrypoint
    if (type === 'user' && !line.isMeta) {
      const content = classifyPromptContent(d.message?.content)
      if (content?.kind === 'prompt') line.promptText = content.text
      if (content?.kind === 'command') line.commandName = content.name
    }
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

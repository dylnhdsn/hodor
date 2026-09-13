import { z } from 'zod'
import type { UsageTotals } from '../pricing.js'

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
    isApiErrorMessage: z.boolean().optional(),
    isCompactSummary: z.boolean().optional(),
    entrypoint: z.string().optional(),
    slug: z.string().optional(),
    effort: z.string().optional(),
    subtype: z.string().optional(),
    compactMetadata: z
      .object({
        preTokens: z.number().optional(),
        postTokens: z.number().optional(),
        cumulativeDroppedTokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    hookCount: z.number().optional(),
    hookInfos: z
      .array(z.object({ command: z.string(), durationMs: z.number().optional() }).passthrough())
      .optional(),
    hookErrors: z.array(z.unknown()).optional(),
    preventedContinuation: z.boolean().optional(),
    agentId: z.string().optional(),
    toolUseID: z.string().optional(),
    sourceToolAssistantUUID: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.unknown().optional(),
        id: z.string().optional(),
        model: z.string().optional(),
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            cache_read_input_tokens: z.number().optional(),
            cache_creation_input_tokens: z.number().optional(),
            cache_creation: z
              .object({
                ephemeral_5m_input_tokens: z.number().optional(),
                ephemeral_1h_input_tokens: z.number().optional(),
              })
              .passthrough()
              .optional(),
            output_tokens_details: z
              .object({ thinking_tokens: z.number().optional() })
              .passthrough()
              .optional(),
            service_tier: z.string().optional(),
            speed: z.string().optional(),
            inference_geo: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
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

/**
 * Checkpoint lines (the CLI's /rewind feature; shapes verified against
 * CLI 2.1.269 output). A file-history-snapshot marks one checkpoint —
 * written per prompt that starts a turn; trackedFileBackups maps each
 * tracked path (relative) to its backup record. A file-history-delta
 * records one file's first modification under the current checkpoint;
 * backupFileName null = the file did not exist at checkpoint time.
 */
const backupSchema = z
  .object({ realParentDir: z.string().optional() })
  .passthrough()
  .nullish()

const fileHistorySnapshotSchema = z
  .object({
    type: z.literal('file-history-snapshot'),
    messageId: z.string(),
    isSnapshotUpdate: z.boolean().optional(),
    snapshot: z
      .object({
        timestamp: z.string().optional(),
        trackedFileBackups: z.record(z.string(), backupSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const fileHistoryDeltaSchema = z
  .object({
    type: z.literal('file-history-delta'),
    trackingPath: z.string().optional(),
    backup: backupSchema,
    timestamp: z.string().optional(),
  })
  .passthrough()

/** Tracked paths are relative to the backup's realParentDir. */
function resolveTrackedPath(path: string, parentDir: string | null | undefined): string {
  if (parentDir === undefined || parentDir === null || parentDir.length === 0) return path
  const sep = parentDir.includes('\\') && !parentDir.includes('/') ? '\\' : '/'
  return parentDir.endsWith(sep) ? parentDir + path : parentDir + sep + path
}

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
  /** For assistant messages: first text block, collapsed and truncated. */
  textPreview?: string
  /** Modern subagent transcripts stamp every line with the run's agent id. */
  agentId?: string
  spawnedBy?: { toolUseId: string; assistantUuid: string }
  /** Assistant lines: which model produced this message. */
  model?: string
  /**
   * Assistant lines: the API message id. One API response is written as one
   * line PER CONTENT BLOCK, each repeating the same usage — billing must
   * dedupe on this id or token counts multiply by the block count.
   */
  messageId?: string
  /** Assistant lines: token usage for the whole API response. */
  usage?: UsageTotals
  /** Names of tool_use blocks on this line (each block appears once). */
  toolNames?: string[]
  /** Assistant lines: tool_use blocks with ids — the turn-state tracker
   * matches these against later tool_result ids to find PENDING tools
   * (an open AskUserQuestion dialog, a tool still running). Interactive
   * dialogs carry their question and option labels straight from the
   * tool input, so quick-reply chips are real data, never invented. */
  toolUses?: Array<{ id: string; name: string; question?: string; options?: string[] }>
  /** User lines: tool_use ids resolved by tool_result blocks on this line. */
  toolResultIds?: string[]
  /** The CLI's human-readable session slug, e.g. "structured-munching-map". */
  slug?: string
  /** Effort level in force for this turn (low…max). */
  effort?: string
  /** From usage: service tier, speed (fast mode), inference geography. */
  serviceTier?: string
  speed?: string
  inferenceGeo?: string
  /** Synthetic assistant line recording an API error. */
  isApiError?: boolean
  /** The post-compaction summary turn — machine text, never a title. */
  isCompactSummary?: boolean
  /** System lines: their operational subtype (e.g. "stop_hook_summary"). */
  subtype?: string
  /** compact_boundary lines: context size before/after the compaction.
   * Boundary lines appear both with and without a uuid across CLI
   * versions, so MessageLine and OtherLine both carry this. */
  compact?: { preTokens?: number; postTokens?: number; droppedTokens?: number }
  /** Hook summary lines: the hooks that ran, with wall-clock durations. */
  hookRuns?: Array<{ command: string; durationMs?: number }>
  /** Hook summary lines: how many hooks errored. */
  hookErrorCount?: number
  /** Hook summary lines: a hook blocked continuation. */
  hookBlocked?: boolean
}

export interface SummaryLine {
  kind: 'summary'
  summary: string
  leafUuid?: string
}

export interface OtherLine {
  kind: 'other'
  type: string
  /** Operational system lines: e.g. "compact_boundary". Kept even for
   * uuid-less lines, which is where compaction boundaries live. */
  subtype?: string
  /** compact_boundary lines: context size before/after the compaction. */
  compact?: { preTokens?: number; postTokens?: number; droppedTokens?: number }
  /** file-history-snapshot lines: one checkpoint per prompt (the /rewind
   * feature). Files are the paths tracked at snapshot time, resolved
   * against each backup's realParentDir. */
  checkpoint?: { id: string; isUpdate: boolean; ts?: string; files: string[] }
  /** file-history-delta lines: one file first-modified under a checkpoint. */
  checkpointDelta?: { file?: string; ts?: string }
}

export interface InvalidLine {
  kind: 'invalid'
  error: string
}

export type TranscriptLine = MessageLine | SummaryLine | OtherLine | InvalidLine

export const PROMPT_TEXT_MAX_LENGTH = 120
export const ASSISTANT_PREVIEW_MAX_LENGTH = 200

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

  const subtypeOf = (): string | undefined => {
    const subtype = (json as { subtype?: unknown }).subtype
    return typeof subtype === 'string' ? subtype : undefined
  }

  const compactOf = (): OtherLine['compact'] => {
    const meta = (json as { compactMetadata?: unknown }).compactMetadata
    if (typeof meta !== 'object' || meta === null) return undefined
    const m = meta as { preTokens?: unknown; postTokens?: unknown; cumulativeDroppedTokens?: unknown }
    return {
      ...(typeof m.preTokens === 'number' ? { preTokens: m.preTokens } : {}),
      ...(typeof m.postTokens === 'number' ? { postTokens: m.postTokens } : {}),
      ...(typeof m.cumulativeDroppedTokens === 'number'
        ? { droppedTokens: m.cumulativeDroppedTokens }
        : {}),
    }
  }

  if (MESSAGE_TYPES.has(type)) {
    const parsed = messageLineSchema.safeParse(json)
    if (!parsed.success) {
      // A message-typed line without a uuid (or otherwise malformed) is
      // operational noise, not a message — but its subtype can still carry
      // signal (compaction boundaries are uuid-less system lines).
      const subtype = subtypeOf()
      const compact = subtype === 'compact_boundary' ? compactOf() : undefined
      return {
        kind: 'other',
        type,
        ...(subtype !== undefined ? { subtype } : {}),
        ...(compact !== undefined ? { compact } : {}),
      }
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
    if (d.agentId !== undefined) line.agentId = d.agentId
    if (d.slug !== undefined) line.slug = d.slug
    if (d.effort !== undefined) line.effort = d.effort
    if (d.isApiErrorMessage === true) line.isApiError = true
    if (d.isCompactSummary === true) line.isCompactSummary = true
    if (d.subtype !== undefined) line.subtype = d.subtype
    if (d.subtype === 'compact_boundary' && d.compactMetadata !== undefined) {
      const m = d.compactMetadata
      line.compact = {
        ...(m.preTokens !== undefined ? { preTokens: m.preTokens } : {}),
        ...(m.postTokens !== undefined ? { postTokens: m.postTokens } : {}),
        ...(m.cumulativeDroppedTokens !== undefined
          ? { droppedTokens: m.cumulativeDroppedTokens }
          : {}),
      }
    }
    if (d.hookInfos !== undefined && d.hookInfos.length > 0) {
      line.hookRuns = d.hookInfos.map((info) => ({
        command: info.command,
        ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
      }))
    }
    if (d.hookErrors !== undefined && d.hookErrors.length > 0) {
      line.hookErrorCount = d.hookErrors.length
    }
    if (d.preventedContinuation === true) line.hookBlocked = true
    if (type === 'user' && !line.isMeta && line.isCompactSummary !== true) {
      const content = classifyPromptContent(d.message?.content)
      if (content?.kind === 'prompt') line.promptText = content.text
      if (content?.kind === 'command') line.commandName = content.name
    }
    if (type === 'assistant') {
      const text = firstTextOf(d.message?.content)?.replace(/\s+/g, ' ').trim()
      if (text !== undefined && text.length > 0) {
        line.textPreview = text.slice(0, ASSISTANT_PREVIEW_MAX_LENGTH)
      }
      if (d.message?.model !== undefined) line.model = d.message.model
      if (d.message?.id !== undefined) line.messageId = d.message.id
      const u = d.message?.usage
      if (u !== undefined) {
        // Prefer the per-TTL breakdown; older lines only have the total
        // cache_creation_input_tokens, which was always the 5m TTL then.
        const write5m = u.cache_creation?.ephemeral_5m_input_tokens
        const write1h = u.cache_creation?.ephemeral_1h_input_tokens
        line.usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite5m: write5m ?? u.cache_creation_input_tokens ?? 0,
          cacheWrite1h: write1h ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? 0,
        }
        if (u.service_tier !== undefined) line.serviceTier = u.service_tier
        if (u.speed !== undefined) line.speed = u.speed
        if (u.inference_geo !== undefined && u.inference_geo !== 'not_available') {
          line.inferenceGeo = u.inference_geo
        }
      }
      if (Array.isArray(d.message?.content)) {
        const names: string[] = []
        const uses: NonNullable<MessageLine['toolUses']> = []
        for (const raw of d.message.content) {
          const block =
            (raw as { type?: unknown; name?: unknown; id?: unknown; input?: unknown } | null) ?? {}
          if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
          names.push(block.name)
          if (typeof block.id !== 'string') continue
          const use: NonNullable<MessageLine['toolUses']>[number] = {
            id: block.id,
            name: block.name,
          }
          if (block.name === 'AskUserQuestion') {
            const q = (
              (block.input as { questions?: unknown } | null)?.questions as
                | Array<{ question?: unknown; options?: unknown }>
                | undefined
            )?.[0]
            if (typeof q?.question === 'string') use.question = q.question
            const options = (Array.isArray(q?.options) ? q.options : [])
              .map((o) => (o as { label?: unknown } | null)?.label)
              .filter((l): l is string => typeof l === 'string')
            if (options.length > 0) use.options = options
          }
          uses.push(use)
        }
        if (names.length > 0) line.toolNames = names
        if (uses.length > 0) line.toolUses = uses
      }
    }
    if (type === 'user' && Array.isArray(d.message?.content)) {
      const resultIds = d.message.content
        .map((block) => (block as { type?: unknown; tool_use_id?: unknown } | null) ?? {})
        .filter((block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
        .map((block) => block.tool_use_id as string)
      if (resultIds.length > 0) line.toolResultIds = resultIds
    }
    if (d.toolUseID !== undefined && d.sourceToolAssistantUUID !== undefined) {
      line.spawnedBy = { toolUseId: d.toolUseID, assistantUuid: d.sourceToolAssistantUUID }
    }
    return line
  }

  if (type === 'file-history-snapshot') {
    const parsed = fileHistorySnapshotSchema.safeParse(json)
    if (parsed.success) {
      const d = parsed.data
      const files = Object.entries(d.snapshot?.trackedFileBackups ?? {}).map(([path, backup]) =>
        resolveTrackedPath(path, backup?.realParentDir),
      )
      const ts = d.snapshot?.timestamp
      return {
        kind: 'other',
        type,
        checkpoint: {
          id: d.messageId,
          isUpdate: d.isSnapshotUpdate ?? false,
          ...(ts !== undefined ? { ts } : {}),
          files,
        },
      }
    }
  }

  if (type === 'file-history-delta') {
    const parsed = fileHistoryDeltaSchema.safeParse(json)
    if (parsed.success) {
      const d = parsed.data
      const file =
        d.trackingPath !== undefined
          ? resolveTrackedPath(d.trackingPath, d.backup?.realParentDir)
          : undefined
      return {
        kind: 'other',
        type,
        checkpointDelta: {
          ...(file !== undefined ? { file } : {}),
          ...(d.timestamp !== undefined ? { ts: d.timestamp } : {}),
        },
      }
    }
  }

  const subtype = subtypeOf()
  return { kind: 'other', type, ...(subtype !== undefined ? { subtype } : {}) }
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

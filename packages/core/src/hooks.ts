import type { SessionTurn } from './types.js'

/**
 * Claude Code hook facts (docs/brainstorm/026). The transcript IMPLIES
 * whose turn it is; Claude's own hooks STATE it, at the moment it
 * changes: a prompt was submitted, the agent finished (and said what),
 * permission is being asked for, the process ended. hodor installs a
 * hook per event that drops the hook's JSON input into a file the
 * store's tailer drains; this module turns that JSON into one small
 * typed fact and says what the fact means for the turn.
 */

export type HookName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'
  | 'StopFailure'
  | 'SessionEnd'

export const HOOK_EVENTS: readonly HookName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
]

export const isHookName = (v: unknown): v is HookName =>
  typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v)

export interface HookFact {
  name: HookName
  /** When the hook fired. */
  at: string
  /** Stop: the agent's last words. StopFailure: the error text. */
  text?: string
  /** PermissionRequest: the tool waiting on you. */
  tool?: string
  /** Notification: its notification_type (permission_prompt, idle_prompt…). */
  notification?: string
  /** SessionStart: source (startup/resume/…). SessionEnd: reason. */
  reason?: string
  /** Stop with background tasks or session crons pending: the agent will
   * wake itself, so the ball is NOT with the human yet. */
  busy?: boolean
}

export interface HookEventInput {
  sessionId: string
  cwd?: string
  transcriptPath?: string
  fact: HookFact
}

const PREVIEW_MAX = 200

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > PREVIEW_MAX ? `${one.slice(0, PREVIEW_MAX - 1)}…` : one
}

/** One line saying what a tool call wants, for a permission ask. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const pick =
    str(obj['command']) ?? str(obj['file_path']) ?? str(obj['path']) ?? str(obj['url']) ?? str(obj['description'])
  return pick !== undefined ? clip(`${tool}: ${pick}`) : tool
}

/** The hook's stdin JSON → a fact, or undefined when it is not one hodor
 * keeps (unknown event, no session id). `at` is the file's own stamp. */
export function normalizeHookEvent(raw: unknown, at: string): HookEventInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const name = r['hook_event_name']
  const sessionId = str(r['session_id'])
  if (!isHookName(name) || sessionId === undefined) return undefined
  const fact: HookFact = { name, at }
  switch (name) {
    case 'Stop': {
      const text = str(r['last_assistant_message'])
      if (text !== undefined) fact.text = clip(text)
      const tasks = Array.isArray(r['background_tasks']) ? r['background_tasks'].length : 0
      const crons = Array.isArray(r['session_crons']) ? r['session_crons'].length : 0
      if (tasks + crons > 0) fact.busy = true
      break
    }
    case 'StopFailure': {
      const text = str(r['error']) ?? str(r['message'])
      if (text !== undefined) fact.text = clip(text)
      break
    }
    case 'PermissionRequest': {
      const tool = str(r['tool_name'])
      if (tool !== undefined) {
        fact.tool = tool
        fact.text = summarizeToolInput(tool, r['tool_input'])
      }
      break
    }
    case 'Notification': {
      const kind = str(r['notification_type'])
      if (kind !== undefined) fact.notification = kind
      const text = str(r['message'])
      if (text !== undefined) fact.text = clip(text)
      break
    }
    case 'SessionStart': {
      const source = str(r['source'])
      if (source !== undefined) fact.reason = source
      break
    }
    case 'SessionEnd': {
      const reason = str(r['reason'])
      if (reason !== undefined) fact.reason = reason
      break
    }
    case 'UserPromptSubmit':
      break
  }
  const cwd = str(r['cwd'])
  const transcriptPath = str(r['transcript_path'])
  return {
    sessionId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    fact,
  }
}

/**
 * What a fact says about the turn, on its own. undefined = the fact is
 * about liveness or something else, not the turn (SessionStart, most
 * notification types). The caller decides whether the fact is still
 * current against the transcript's clock.
 */
export function turnFromHook(fact: HookFact): SessionTurn | undefined {
  switch (fact.name) {
    case 'UserPromptSubmit':
      return { state: 'working' }
    case 'Stop':
      if (fact.busy === true) return { state: 'working' }
      return { state: 'waiting', since: fact.at, ...(fact.text !== undefined ? { preview: fact.text } : {}) }
    case 'StopFailure':
      return { state: 'waiting', since: fact.at, preview: fact.text ?? 'API error' }
    case 'PermissionRequest':
      return {
        state: 'waiting',
        since: fact.at,
        ...(fact.text !== undefined ? { preview: fact.text } : {}),
        pending: { tool: fact.tool ?? 'permission' },
      }
    case 'Notification':
      if (fact.notification === 'permission_prompt') {
        return {
          state: 'waiting',
          since: fact.at,
          ...(fact.text !== undefined ? { preview: fact.text } : {}),
          pending: { tool: 'permission' },
        }
      }
      if (fact.notification === 'idle_prompt') return { state: 'waiting', since: fact.at }
      return undefined
    case 'SessionEnd':
      return { state: 'idle' }
    case 'SessionStart':
      return undefined
  }
}

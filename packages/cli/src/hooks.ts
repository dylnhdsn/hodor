import {
  HOOK_EVENTS,
  flavorOfPath,
  normalizeHookEvent,
  pathOps,
  type FileSystem,
  type SessionStore,
  type SourceEvent,
  type StoreId,
} from '@hodor/core'

/**
 * Claude hooks, hodor's side (docs/brainstorm/026).
 *
 * The toggle writes one command hook per event hodor cares about into a
 * store's ~/.claude/settings.json. The command is deliberately dumb: it
 * copies the hook's stdin JSON into a file under <store>/hodor/events/,
 * atomically (write .tmp, rename), and exits. No port, no hodor binary,
 * no network: from inside WSL2 127.0.0.1 is the VM, not Windows, so an
 * HTTP hook could never reach a Windows-hosted hodor, while a file in
 * the store is read across that boundary exactly like the transcripts.
 * Events queue while hodor is closed and drain when it starts.
 *
 * hodor's own entries are recognisable by the events path in the
 * command, so "off" removes exactly those and nothing the user wrote.
 */

export type HookHost = 'posix' | 'windows'
export type HooksStatus = 'on' | 'off' | 'partial' | 'unreadable'

export const hookHostOf = (store: SessionStore): HookHost =>
  store.pathFlavor === 'win32' ? 'windows' : 'posix'

const MARK_POSIX = '.claude/hodor/events'
const MARK_WIN = '.claude\\hodor\\events'

/** The command hook hodor installs for a host. Async: it never holds a
 * turn up (UserPromptSubmit hooks otherwise gate the prompt). */
export function hodorHookHandler(host: HookHost): Record<string, unknown> {
  if (host === 'windows') {
    return {
      type: 'command',
      shell: 'powershell',
      command:
        "$d = Join-Path $env:USERPROFILE '.claude\\hodor\\events'; " +
        'New-Item -ItemType Directory -Force -Path $d | Out-Null; ' +
        "$f = Join-Path $d ('{0}-{1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $PID); " +
        "[Console]::In.ReadToEnd() | Set-Content -NoNewline -Encoding utf8 -LiteralPath ($f + '.tmp'); " +
        "Move-Item -LiteralPath ($f + '.tmp') -Destination ($f + '.json')",
      async: true,
    }
  }
  return {
    type: 'command',
    command:
      'd="$HOME/.claude/hodor/events"; mkdir -p "$d"; f="$d/$(date +%s)-$$-$RANDOM"; ' +
      'cat > "$f.tmp" && mv "$f.tmp" "$f.json"',
    async: true,
  }
}

const isHodorHandler = (h: unknown): boolean => {
  if (typeof h !== 'object' || h === null) return false
  const command = (h as { command?: unknown }).command
  return typeof command === 'string' && (command.includes(MARK_POSIX) || command.includes(MARK_WIN))
}

const isHodorGroup = (g: unknown): boolean => {
  if (typeof g !== 'object' || g === null) return false
  const hooks = (g as { hooks?: unknown }).hooks
  return Array.isArray(hooks) && hooks.some(isHodorHandler)
}

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined

type Parsed = { ok: true; root: Obj } | { ok: false; error: string }

function parseSettings(text: string | undefined): Parsed {
  if (text === undefined || text.trim() === '') return { ok: true, root: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, error: 'settings.json is not valid JSON' }
  }
  const root = asObj(parsed)
  return root !== undefined ? { ok: true, root } : { ok: false, error: 'settings.json is not an object' }
}

/**
 * settings.json text → the same text with hodor's hooks present (on) or
 * absent (off). Everything the user wrote — other hooks, other keys —
 * survives untouched. A file hodor cannot parse is left alone: better no
 * hooks than a clobbered settings file.
 */
export function applyHodorHooks(
  text: string | undefined,
  enabled: boolean,
  host: HookHost,
): { text: string; changed: boolean } | { error: string } {
  const parsed = parseSettings(text)
  if (!parsed.ok) return { error: parsed.error }
  const root = parsed.root
  const before = JSON.stringify(root)
  const hooks: Obj = { ...(asObj(root['hooks']) ?? {}) }
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const kept = groups.filter((g) => !isHodorGroup(g))
    if (enabled) kept.push({ hooks: [hodorHookHandler(host)] })
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  const next: Obj = { ...root }
  if (Object.keys(hooks).length > 0) next['hooks'] = hooks
  else delete next['hooks']
  return { text: `${JSON.stringify(next, null, 2)}\n`, changed: JSON.stringify(next) !== before }
}

/** Are hodor's hooks in this settings text — all, none, or some? */
export function hooksStatus(text: string | undefined): HooksStatus {
  const parsed = parseSettings(text)
  if (!parsed.ok) return 'unreadable'
  const hooks = asObj(parsed.root['hooks']) ?? {}
  const present = HOOK_EVENTS.filter((event) => {
    const groups = hooks[event]
    return Array.isArray(groups) && groups.some(isHodorGroup)
  }).length
  return present === 0 ? 'off' : present === HOOK_EVENTS.length ? 'on' : 'partial'
}

export const settingsPathOf = (store: SessionStore): string =>
  pathOps(flavorOfPath(store.rootPath)).join(store.rootPath, 'settings.json')

const eventsDirOf = (store: SessionStore): string =>
  pathOps(flavorOfPath(store.rootPath)).join(store.rootPath, 'hodor', 'events')

/** A store, as the toggle reports it. */
export const storeLabel = (store: SessionStore): string =>
  store.origin.kind === 'wsl'
    ? `wsl · ${store.origin.distro}`
    : store.origin.kind === 'windows'
      ? 'windows'
      : 'this machine'

export interface HooksRow {
  storeId: StoreId
  label: string
  status: HooksStatus
  error?: string
}

export async function hooksStatusForStores(
  stores: SessionStore[],
  fsFor: (storeId: StoreId) => FileSystem,
): Promise<HooksRow[]> {
  const rows: HooksRow[] = []
  for (const store of stores) {
    const text = await fsFor(store.id).readFile(settingsPathOf(store))
    rows.push({ storeId: store.id, label: storeLabel(store), status: hooksStatus(text) })
  }
  return rows
}

export async function setHooksForStores(
  stores: SessionStore[],
  fsFor: (storeId: StoreId) => FileSystem,
  enabled: boolean,
): Promise<HooksRow[]> {
  const rows: HooksRow[] = []
  for (const store of stores) {
    const fs = fsFor(store.id)
    const path = settingsPathOf(store)
    const current = await fs.readFile(path)
    const result = applyHodorHooks(current, enabled, hookHostOf(store))
    if ('error' in result) {
      rows.push({ storeId: store.id, label: storeLabel(store), status: hooksStatus(current), error: result.error })
      continue
    }
    try {
      if (result.changed) await fs.writeFile(path, result.text)
      rows.push({ storeId: store.id, label: storeLabel(store), status: enabled ? 'on' : 'off' })
    } catch (error) {
      rows.push({
        storeId: store.id,
        label: storeLabel(store),
        status: hooksStatus(current),
        error: `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return rows
}

/** The file's own stamp when the filesystem gives none: the leading
 * digits of the name (seconds from the posix hook, ms from PowerShell). */
const atFromName = (name: string): string | undefined => {
  const digits = /^(\d{10,13})/.exec(name)?.[1]
  if (digits === undefined) return undefined
  const n = Number(digits)
  return new Date(digits.length <= 10 ? n * 1000 : n).toISOString()
}

const DRAIN_LIMIT = 200

/**
 * Consume the hook files a store has accumulated: each becomes one
 * `hook-event`, then the file is deleted. Unparseable files are deleted
 * too — retrying them forever helps no one. The hook writes .tmp then
 * renames, so a .json is always complete.
 */
export async function drainHookEvents(fs: FileSystem, store: SessionStore): Promise<SourceEvent[]> {
  const dir = eventsDirOf(store)
  const p = pathOps(flavorOfPath(store.rootPath))
  const names = (await fs.listDir(dir)).filter((n) => n.endsWith('.json')).sort().slice(0, DRAIN_LIMIT)
  const events: SourceEvent[] = []
  for (const name of names) {
    const path = p.join(dir, name)
    const stat = await fs.stat(path)
    const text = await fs.readFile(path)
    await fs.remove(path)
    if (text === undefined) continue
    const at =
      stat !== undefined && Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0
        ? new Date(stat.mtimeMs).toISOString()
        : (atFromName(name) ?? new Date().toISOString())
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      continue
    }
    const input = normalizeHookEvent(raw, at)
    if (input === undefined) continue
    events.push({
      type: 'hook-event',
      storeId: store.id,
      sessionId: input.sessionId,
      ...(input.transcriptPath !== undefined ? { transcriptPath: input.transcriptPath } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      fact: input.fact,
    })
  }
  return events
}

import { describe, expect, it } from 'vitest'
import { MemFs, type SessionStore } from '@hodor/core'
import {
  applyHodorHooks,
  drainHookEvents,
  hodorHookHandler,
  hooksStatus,
  setHooksForStores,
  hooksStatusForStores,
} from './hooks.js'

const posixStore: SessionStore = {
  id: 'local',
  rootPath: '/home/d/.claude',
  pathFlavor: 'posix',
  origin: { kind: 'native' },
  watchStrategy: 'poll',
}
const winStore: SessionStore = {
  id: 'win',
  rootPath: 'C:\\Users\\d\\.claude',
  pathFlavor: 'win32',
  origin: { kind: 'windows', mountRoot: '/mnt' },
  watchStrategy: 'poll',
}

const parse = (t: string) => JSON.parse(t) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }

describe('applyHodorHooks', () => {
  it('adds one hodor group per event to an empty file, and removes them again', () => {
    const on = applyHodorHooks(undefined, true, 'posix')
    if ('error' in on) throw new Error(on.error)
    expect(on.changed).toBe(true)
    const hooks = parse(on.text).hooks!
    expect(Object.keys(hooks).sort()).toEqual(
      ['Notification', 'PermissionRequest', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'].sort(),
    )
    expect(hooks['Stop']![0]!.hooks[0]!.command).toContain('.claude/hodor/events')
    expect(hooksStatus(on.text)).toBe('on')

    const off = applyHodorHooks(on.text, false, 'posix')
    if ('error' in off) throw new Error(off.error)
    expect(off.changed).toBe(true)
    expect(parse(off.text).hooks).toBeUndefined()
    expect(hooksStatus(off.text)).toBe('off')
  })

  // The user's own hooks and every other key must come through untouched.
  it('leaves everything the user wrote alone', () => {
    const theirs = JSON.stringify(
      {
        theme: 'dark',
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '/me/notify.sh' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/me/guard.sh' }] }],
        },
      },
      null,
      2,
    )
    const on = applyHodorHooks(theirs, true, 'posix')
    if ('error' in on) throw new Error(on.error)
    const doc = JSON.parse(on.text) as Record<string, unknown>
    expect(doc['theme']).toBe('dark')
    expect(doc['permissions']).toEqual({ allow: ['Bash(npm test)'] })
    const hooks = parse(on.text).hooks!
    expect(hooks['PreToolUse']).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: '/me/guard.sh' }] }])
    expect(hooks['Stop']).toHaveLength(2)
    expect(hooks['Stop']![0]!.hooks[0]!.command).toBe('/me/notify.sh')

    const off = applyHodorHooks(on.text, false, 'posix')
    if ('error' in off) throw new Error(off.error)
    expect(JSON.parse(off.text)).toEqual(JSON.parse(theirs))
  })

  it('is idempotent: on twice is one set of hooks and no change', () => {
    const once = applyHodorHooks(undefined, true, 'posix')
    if ('error' in once) throw new Error(once.error)
    const twice = applyHodorHooks(once.text, true, 'posix')
    if ('error' in twice) throw new Error(twice.error)
    expect(twice.changed).toBe(false)
    expect(parse(twice.text).hooks!['Stop']).toHaveLength(1)
    const offAgain = applyHodorHooks(twice.text, false, 'posix')
    if ('error' in offAgain) throw new Error(offAgain.error)
    const offTwice = applyHodorHooks(offAgain.text, false, 'posix')
    if ('error' in offTwice) throw new Error(offTwice.error)
    expect(offTwice.changed).toBe(false)
  })

  it('refuses to touch a file it cannot parse', () => {
    expect(applyHodorHooks('{ not json', true, 'posix')).toEqual({ error: 'settings.json is not valid JSON' })
    expect(applyHodorHooks('[1,2]', true, 'posix')).toEqual({ error: 'settings.json is not an object' })
    expect(hooksStatus('{ not json')).toBe('unreadable')
  })

  it('speaks PowerShell on the Windows store', () => {
    const h = hodorHookHandler('windows')
    expect(h['shell']).toBe('powershell')
    expect(h['async']).toBe(true)
    expect(String(h['command'])).toContain('.claude\\hodor\\events')
    expect(String(h['command'])).toContain("Move-Item")
    const on = applyHodorHooks(undefined, true, 'windows')
    if ('error' in on) throw new Error(on.error)
    expect(hooksStatus(on.text)).toBe('on')
  })

  it('reports partial when only some events carry hodor', () => {
    const on = applyHodorHooks(undefined, true, 'posix')
    if ('error' in on) throw new Error(on.error)
    const doc = parse(on.text)
    delete doc.hooks!['Stop']
    expect(hooksStatus(JSON.stringify(doc))).toBe('partial')
  })
})

describe('per-store toggling', () => {
  it('writes each store its own dialect and reads the status back', async () => {
    const fs = new MemFs()
    const fsFor = () => fs
    const rows = await setHooksForStores([posixStore, winStore], fsFor, true)
    expect(rows).toEqual([
      { storeId: 'local', label: 'this machine', status: 'on' },
      { storeId: 'win', label: 'windows', status: 'on' },
    ])
    const posix = await fs.readFile('/home/d/.claude/settings.json')
    const win = await fs.readFile('C:\\Users\\d\\.claude\\settings.json')
    expect(posix).toContain('$HOME/.claude/hodor/events')
    expect(win).toContain('powershell')
    expect(await hooksStatusForStores([posixStore, winStore], fsFor)).toEqual(rows)
    const off = await setHooksForStores([posixStore, winStore], fsFor, false)
    expect(off.every((r) => r.status === 'off')).toBe(true)
  })

  it('surfaces a store whose settings it cannot parse without touching it', async () => {
    const fs = new MemFs()
    await fs.writeFile('/home/d/.claude/settings.json', '{ broken')
    const rows = await setHooksForStores([posixStore], () => fs, true)
    expect(rows[0]).toMatchObject({ status: 'unreadable', error: 'settings.json is not valid JSON' })
    expect(await fs.readFile('/home/d/.claude/settings.json')).toBe('{ broken')
  })
})

describe('drainHookEvents', () => {
  const dir = '/home/d/.claude/hodor/events'
  const stop = { session_id: 's1', hook_event_name: 'Stop', cwd: '/w', transcript_path: '/t.jsonl', last_assistant_message: 'ok' }

  it('turns each file into an event, oldest first, and deletes it', async () => {
    const fs = new MemFs()
    await fs.writeFile(`${dir}/1758218400-2-9.json`, JSON.stringify({ ...stop, hook_event_name: 'UserPromptSubmit' }))
    await fs.writeFile(`${dir}/1758218460-2-9.json`, JSON.stringify(stop))
    await fs.writeFile(`${dir}/1758218470-2-9.json.tmp`, '{"half":')
    const events = await drainHookEvents(fs, posixStore)
    expect(events.map((e) => (e as { fact: { name: string } }).fact.name)).toEqual(['UserPromptSubmit', 'Stop'])
    expect(events[1]).toMatchObject({ type: 'hook-event', storeId: 'local', sessionId: 's1', cwd: '/w', transcriptPath: '/t.jsonl' })
    expect(await fs.listDir(dir)).toEqual(['1758218470-2-9.json.tmp'])
  })

  it('tolerates a BOM (Windows PowerShell 5) and drops junk', async () => {
    const fs = new MemFs()
    await fs.writeFile(`${dir}/1758218500123-44.json`, `\uFEFF${JSON.stringify(stop)}`)
    await fs.writeFile(`${dir}/1758218500124-44.json`, 'not json')
    await fs.writeFile(`${dir}/1758218500125-44.json`, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1' }))
    const events = await drainHookEvents(fs, posixStore)
    expect(events).toHaveLength(1)
    expect(await fs.listDir(dir)).toEqual([])
  })

  it('is empty and harmless when the directory does not exist', async () => {
    expect(await drainHookEvents(new MemFs(), posixStore)).toEqual([])
  })
})

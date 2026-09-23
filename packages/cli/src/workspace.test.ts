import { describe, expect, it } from 'vitest'
import { MemFs } from '@hodor/core'
import type { CliDeps } from './main.js'
import { loadWorkspaces, parseWorkspaceDoc, saveWorkspaces } from './workspace.js'

const deps = (fs: MemFs): CliDeps => ({ fs }) as unknown as CliDeps
const HOME = '/home/u/.hodor'

describe('parseWorkspaceDoc', () => {
  it('carries active and scope, and drops an active that names no workspace', () => {
    const doc = parseWorkspaceDoc({
      v: 2,
      active: 'b',
      workspaces: [
        { id: 'a', name: 'A', windows: [] },
        { id: 'b', name: 'B', scope: { projectId: 'p1' }, windows: [{ layout: { x: 1 } }] },
      ],
    })
    expect(doc).toEqual({
      v: 2,
      active: 'b',
      workspaces: [
        { id: 'a', name: 'A', windows: [] },
        { id: 'b', name: 'B', scope: { projectId: 'p1' }, windows: [{ layout: { x: 1 } }] },
      ],
    })
    expect(parseWorkspaceDoc({ v: 2, active: 'zzz', workspaces: [{ id: 'a', name: 'A' }] })?.active).toBeUndefined()
    expect(parseWorkspaceDoc({ workspaces: [{ id: 'a', name: 'A', scope: 'nope' }] })?.workspaces[0]?.scope).toBeUndefined()
  })

  it('keeps a workspace intent and drops an empty one', () => {
    const doc = parseWorkspaceDoc({
      v: 2,
      workspaces: [
        { id: 'a', name: 'A', intent: 'ship the electron bump', windows: [] },
        { id: 'b', name: 'B', intent: '', windows: [] },
        { id: 'c', name: 'C', intent: 42, windows: [] },
      ],
    })!
    expect(doc.workspaces[0]!.intent).toBe('ship the electron bump')
    expect(doc.workspaces[1]!.intent).toBeUndefined()
    expect(doc.workspaces[2]!.intent).toBeUndefined()
  })

  it('still reads a v1 document as v1', () => {
    expect(parseWorkspaceDoc({ v: 1, workspaces: [{ id: 'default', name: 'the desk', windows: [] }] })?.v).toBe(1)
    expect(parseWorkspaceDoc({ nope: true })).toBeUndefined()
  })
})

describe('loadWorkspaces / saveWorkspaces', () => {
  // The pre-027 desk saved one implicit workspace called "default"; a
  // build that knows workspaces lifts it to "main" without writing v1.
  it('seeds v2 from v1 in memory, leaving v1 untouched', async () => {
    const fs = new MemFs()
    const v1 = JSON.stringify({
      v: 1,
      dockHeight: 300,
      workspaces: [{ id: 'default', name: 'the desk', windows: [{ layout: { grid: 1 } }], defer: { s1: { hold: true } } }],
    })
    await fs.writeFile(`${HOME}/workspaces.json`, v1)
    const doc = await loadWorkspaces(deps(fs), HOME)
    expect(doc).toEqual({
      v: 2,
      dockHeight: 300,
      active: 'main',
      workspaces: [{ id: 'main', name: 'main', windows: [{ layout: { grid: 1 } }], defer: { s1: { hold: true } } }],
    })
    expect(await fs.readFile(`${HOME}/workspaces.json`)).toBe(v1)
    expect(await fs.readFile(`${HOME}/workspaces.v2.json`)).toBeUndefined()
  })

  it('writes v2 only, and prefers it over v1 from then on', async () => {
    const fs = new MemFs()
    await fs.writeFile(`${HOME}/workspaces.json`, JSON.stringify({ v: 1, workspaces: [{ id: 'default', name: 'the desk', windows: [] }] }))
    await saveWorkspaces(deps(fs), HOME, {
      v: 2,
      active: 'peri',
      workspaces: [
        { id: 'main', name: 'main', windows: [] },
        { id: 'peri', name: 'peri', windows: [] },
      ],
    })
    expect(await fs.readFile(`${HOME}/workspaces.json`)).toContain('"default"')
    const doc = await loadWorkspaces(deps(fs), HOME)
    expect(doc.active).toBe('peri')
    expect(doc.workspaces.map((w) => w.id)).toEqual(['main', 'peri'])
  })

  it('is empty when neither file exists, and on a corrupt v2', async () => {
    expect(await loadWorkspaces(deps(new MemFs()), HOME)).toEqual({ v: 2, workspaces: [] })
    const fs = new MemFs()
    await fs.writeFile(`${HOME}/workspaces.v2.json`, '{ nope')
    await fs.writeFile(`${HOME}/workspaces.json`, JSON.stringify({ v: 1, workspaces: [{ id: 'default', name: 'x', windows: [] }] }))
    // a corrupt v2 falls back to the v1 seed rather than an empty desk
    expect((await loadWorkspaces(deps(fs), HOME)).workspaces[0]?.id).toBe('main')
  })
})

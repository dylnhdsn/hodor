import { useEffect, useState } from 'react'

/**
 * Claude hooks (docs/brainstorm/026), as a tiny client store: whether
 * hodor's hooks are in each store's ~/.claude/settings.json. The settings
 * toggle writes it; the status bar's dot reads it.
 */
export interface HooksRow {
  storeId: string
  label: string
  status: 'on' | 'off' | 'partial' | 'unreadable'
  error?: string
}

let rows: HooksRow[] | undefined
let loading: Promise<void> | undefined
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const fn of listeners) fn()
}

export const hooksRows = (): HooksRow[] | undefined => rows

/** on: every store carries the hooks; off: none does; undefined: unknown yet. */
export const hooksOn = (): boolean | undefined =>
  rows === undefined ? undefined : rows.length > 0 && rows.every((r) => r.status === 'on')

export function refreshHooks(): Promise<void> {
  if (loading !== undefined) return loading
  loading = fetch('/api/hooks')
    .then((r) => r.json() as Promise<{ stores?: HooksRow[] }>)
    .then((body) => {
      rows = body.stores ?? []
    })
    .catch(() => {
      rows = []
    })
    .finally(() => {
      loading = undefined
      emit()
    })
  return loading
}

export async function setHooks(enabled: boolean): Promise<void> {
  try {
    const res = await fetch('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    const body = (await res.json()) as { stores?: HooksRow[] }
    if (body.stores !== undefined) {
      rows = body.stores
      emit()
      return
    }
  } catch {
    // fall through to a fresh read
  }
  await refreshHooks()
}

export function onHooksChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Subscribe a component; fetches once on first use. */
export function useHooks(): HooksRow[] | undefined {
  const [, force] = useState(0)
  useEffect(() => {
    if (rows === undefined) void refreshHooks()
    return onHooksChange(() => force((t) => t + 1))
  }, [])
  return rows
}

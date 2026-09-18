import { savePref } from './prefs.js'

/**
 * Turn-stack preset replies (docs/brainstorm/029): the chips under a
 * card that answer with one click. A user list in ~/.hodor/ui.json
 * (stackPresets) — edited from the chips' context menu or in settings —
 * with these as the starting set.
 */
export const DEFAULT_PRESETS = ['go ahead', 'use your judgment', 'looks good — proceed']

let presets: string[] = DEFAULT_PRESETS
const listeners = new Set<() => void>()
const notify = (): void => {
  for (const h of listeners) h()
}
const clean = (list: unknown): string[] | undefined =>
  Array.isArray(list)
    ? list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '')
    : undefined

export const getPresets = (): string[] => presets

/** The server copy at boot — no write-back. */
export function hydratePresets(raw: unknown): void {
  const next = clean(raw)
  if (next === undefined) return
  presets = next
  notify()
}

export function setPresets(next: string[]): void {
  presets = clean(next) ?? []
  savePref({ stackPresets: presets })
  notify()
}

export function onPresetsChange(handler: () => void): () => void {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

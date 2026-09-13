import { flavorOfPath, pathOps } from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * UI preferences (~/.hodor/ui.json): cosmetic client state — colorscheme,
 * font pack, rail collapse. Lives on hodor's own disk, NOT in browser
 * storage: the desktop app serves its UI from a random port every launch,
 * so an origin-keyed store forgets everything on each restart and update.
 */

export const PREFS_LIMIT = 256 * 1024

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const prefsPath = (home: string): string =>
  pathOps(flavorOfPath(home)).join(home, 'ui.json')

export async function loadPrefs(deps: CliDeps, home: string): Promise<Record<string, unknown>> {
  const text = await deps.fs.readFile(prefsPath(home))
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Shallow merge; null deletes a key — independent writers never clobber. */
export async function savePrefs(
  deps: CliDeps,
  home: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = { ...(await loadPrefs(deps, home)) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  await deps.fs.writeFile(prefsPath(home), JSON.stringify(next, null, 2) + '\n')
  return next
}

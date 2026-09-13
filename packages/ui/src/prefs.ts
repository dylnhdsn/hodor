/**
 * Server-backed UI prefs (~/.hodor/ui.json via /api/prefs). These survive
 * restarts and updates; localStorage is only the first-paint cache — the
 * desktop app serves from a random port each launch, so the origin-keyed
 * store starts empty every time.
 */

let fetched: Promise<Record<string, unknown>> | undefined

export function fetchPrefs(): Promise<Record<string, unknown>> {
  fetched ??= fetch('/api/prefs')
    .then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : {}))
    .catch(() => ({}) as Record<string, unknown>)
  return fetched
}

/** Fire-and-forget merge write; null deletes a key. */
export function savePref(patch: Record<string, unknown>): void {
  void fetch('/api/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {})
}

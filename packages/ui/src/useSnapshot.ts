import { useEffect, useState } from 'react'
import type { Snapshot } from '@hodor/core'

/**
 * Live snapshot: SSE from /api/events with automatic reconnect, seeded by a
 * plain fetch so first paint doesn't wait on the stream. The same stream
 * carries `workspace` frames — the document after any window saved it —
 * for whoever subscribes below.
 */

const docListeners = new Set<(doc: unknown) => void>()
/** The workspace document, each time any window saves it. */
export function onWorkspaceDoc(fn: (doc: unknown) => void): () => void {
  docListeners.add(fn)
  return () => docListeners.delete(fn)
}

export function useSnapshot(): { snapshot: Snapshot | undefined; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch('/api/snapshot')
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setSnapshot(json as Snapshot)
      })
      .catch(() => {})

    const source = new EventSource('/api/events')
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (event) => {
      try {
        setSnapshot(JSON.parse(event.data as string) as Snapshot)
      } catch {
        // partial frame; the next one wins
      }
    }
    source.addEventListener('workspace', (event) => {
      try {
        const doc: unknown = JSON.parse((event as MessageEvent).data as string)
        for (const fn of docListeners) fn(doc)
      } catch {
        // a torn frame; the next save sends another
      }
    })

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  return { snapshot, connected }
}

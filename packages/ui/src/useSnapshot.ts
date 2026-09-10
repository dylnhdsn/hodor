import { useEffect, useState } from 'react'
import type { Snapshot } from '@hodor/core'

/**
 * Live snapshot: SSE from /api/events with automatic reconnect, seeded by a
 * plain fetch so first paint doesn't wait on the stream.
 */
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

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  return { snapshot, connected }
}

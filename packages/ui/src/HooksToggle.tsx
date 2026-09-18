import { useEffect, useState } from 'react'

/**
 * The Claude hooks toggle (docs/brainstorm/026). One checkbox; under it,
 * each store hodor watches and whether its ~/.claude/settings.json
 * carries hodor's hooks. A store hodor could not write says why.
 */

interface HooksRow {
  storeId: string
  label: string
  status: 'on' | 'off' | 'partial' | 'unreadable'
  error?: string
}

export function HooksToggle() {
  const [rows, setRows] = useState<HooksRow[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/hooks')
      const body = (await res.json()) as { stores?: HooksRow[] }
      setRows(body.stores ?? [])
    } catch {
      setRows([])
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const on = rows !== undefined && rows.length > 0 && rows.every((r) => r.status === 'on')

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex w-fit cursor-pointer items-center gap-2.5 rounded border border-b3 bg-s1 px-3 py-2">
        <input
          type="checkbox"
          checked={on}
          disabled={rows === undefined || busy}
          onChange={async (e) => {
            setBusy(true)
            try {
              const res = await fetch('/api/hooks', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: e.target.checked }),
              })
              const body = (await res.json()) as { stores?: HooksRow[] }
              if (body.stores !== undefined) setRows(body.stores)
              else await load()
            } catch {
              await load()
            }
            setBusy(false)
          }}
          className="h-3.5 w-3.5 accent-ac"
        />
        <span className="text-[12px]">
          let Claude tell hodor whose turn it is — hooks in{' '}
          <span className="font-mono">~/.claude/settings.json</span>
        </span>
      </label>
      {rows !== undefined && rows.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 pl-1 text-[11px] text-t5">
          {rows.map((r) => (
            <span key={r.storeId}>
              {r.label}{' '}
              <span
                className={
                  r.status === 'on' ? 'text-run' : r.status === 'off' ? 'text-t6' : 'text-ask'
                }
                title={r.error}
              >
                {r.error !== undefined ? `${r.status} — ${r.error}` : r.status}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

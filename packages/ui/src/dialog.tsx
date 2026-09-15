import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * In-app prompt / confirm / notice.
 *
 * Electron does not implement window.prompt — it returns null without
 * showing anything, so every prompt-driven verb (rename, zone name, skip
 * note, cloud message) silently did nothing in the desktop app while
 * working fine in a browser. These render in the page instead, and they
 * also let us theme them and preselect text.
 */

type Kind = 'prompt' | 'confirm' | 'notice'

interface Request {
  kind: Kind
  title: string
  detail?: string | undefined
  initial?: string | undefined
  placeholder?: string | undefined
  /** Verb on the affirmative button. */
  okLabel?: string | undefined
  danger?: boolean | undefined
  resolve: (value: string | boolean | undefined) => void
}

let show: ((req: Request) => void) | undefined
const queued: Request[] = []

function submit(req: Request): void {
  if (show !== undefined) show(req)
  else queued.push(req) // before the host mounts (first paint)
}

/** Ask for a line of text. Resolves undefined when cancelled. */
export const promptText = (
  title: string,
  options: {
    initial?: string
    detail?: string
    placeholder?: string
    okLabel?: string
  } = {},
): Promise<string | undefined> =>
  new Promise((resolve) => {
    submit({
      kind: 'prompt',
      title,
      initial: options.initial,
      detail: options.detail,
      placeholder: options.placeholder,
      okLabel: options.okLabel,
      resolve: (value) => resolve(typeof value === 'string' ? value : undefined),
    })
  })

/** Yes/no. Resolves false when dismissed. */
export const confirmAction = (
  title: string,
  options: { detail?: string; okLabel?: string; danger?: boolean } = {},
): Promise<boolean> =>
  new Promise((resolve) => {
    submit({
      kind: 'confirm',
      title,
      detail: options.detail,
      okLabel: options.okLabel,
      danger: options.danger,
      resolve: (value) => resolve(value === true),
    })
  })

/** Tell the user something went wrong (replaces window.alert). */
export const notice = (title: string, detail?: string): Promise<void> =>
  new Promise((resolve) => {
    submit({ kind: 'notice', title, detail, resolve: () => resolve() })
  })

/** Mounted once by the app root. */
export function DialogHost() {
  const [req, setReq] = useState<Request | undefined>(undefined)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    show = (next) => {
      setValue(next.initial ?? '')
      setReq(next)
    }
    const pending = queued.splice(0, queued.length)
    for (const p of pending) show(p)
    return () => {
      show = undefined
    }
  }, [])

  useEffect(() => {
    if (req?.kind === 'prompt') {
      const input = inputRef.current
      input?.focus()
      input?.select()
    }
  }, [req])

  if (req === undefined) return null

  const close = (result: string | boolean | undefined): void => {
    req.resolve(result)
    setReq(undefined)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-app/70 pt-[18vh]"
      onClick={() => close(req.kind === 'confirm' ? false : undefined)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(480px,calc(100vw-48px))] rounded-lg border border-b5 bg-s5 p-4 shadow-2xl"
      >
        <h2 className="font-ui text-[13.5px] font-bold text-fg">{req.title}</h2>
        {req.detail !== undefined && (
          <p className="mt-1 text-[11.5px] leading-relaxed text-t3">{req.detail}</p>
        )}
        {req.kind === 'prompt' && (
          <input
            ref={inputRef}
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            // Enter/Escape belong to this dialog while it's up — it owns
            // the focus, so this isn't an app-wide key binding.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                close(value)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close(undefined)
              }
            }}
            className="mt-3 w-full rounded border border-b4 bg-app px-2.5 py-1.5 text-[12px] outline-none placeholder:text-t6 focus:border-ac"
          />
        )}
        <div className="mt-3.5 flex justify-end gap-2">
          {req.kind !== 'notice' && (
            <button
              onClick={() => close(req.kind === 'confirm' ? false : undefined)}
              className="rounded border border-b4 px-3 py-1 text-[11.5px] text-t3 hover:border-b6 hover:text-fg"
            >
              cancel
            </button>
          )}
          <button
            onClick={() => close(req.kind === 'prompt' ? value : true)}
            disabled={req.kind === 'prompt' && value.trim().length === 0}
            className={`rounded px-3.5 py-1 text-[11.5px] font-semibold disabled:opacity-40 ${
              req.danger === true
                ? 'bg-err text-ink hover:brightness-110'
                : 'bg-ac text-ink hover:brightness-110'
            }`}
          >
            {req.okLabel ?? (req.kind === 'notice' ? 'ok' : req.kind === 'confirm' ? 'yes' : 'save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

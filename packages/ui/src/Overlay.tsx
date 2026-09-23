/**
 * The v3 overlay frame: a 940×540 sheet centered over the desk, between
 * the title and status bars, with a dimmed backdrop that closes it. The
 * browser build has no desk to cover, so the same content renders inline
 * as the main area instead.
 */
export function Overlay(props: { onClose: () => void; inline?: boolean; children: React.ReactNode }) {
  if (props.inline === true) {
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-s3">{props.children}</div>
  }
  return (
    <div
      onClick={props.onClose}
      className="absolute inset-0 z-[15] flex items-center justify-center bg-app/62"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[540px] max-h-[calc(100%-24px)] w-[940px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-md border border-b5 bg-s3 shadow-[0_30px_60px_-12px_rgba(0,0,0,.7)]"
      >
        {props.children}
      </div>
    </div>
  )
}

/** The overlay's 40px header row. */
export function OverlayHeader(props: { children: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-b2 px-3.5">
      {props.children}
    </div>
  )
}

export const chipClass = (on: boolean): string =>
  `rounded border px-2 py-0.5 font-mono text-[10px] whitespace-nowrap hover:text-fg ${
    on ? 'border-ac text-fg' : 'border-b3 text-t4'
  }`

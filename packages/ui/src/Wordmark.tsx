/** The hodor wordmark (from the 023 design pass), stroke = currentColor. */
export function Wordmark({ height = 16 }: { height?: number }) {
  return (
    <svg viewBox="0 0 70 26" height={height} style={{ display: 'block' }} aria-label="hodor">
      <g fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 1.8 L3 24" />
        <path d="M3 13.5 C3 9.2 5.8 8 8 8 C10.6 8 13 9.4 13 13.5 L13 24" />
        <circle cx="23" cy="16" r="5.9" />
        <circle cx="37" cy="16" r="5.9" />
        <path d="M42.9 1.8 L42.9 24" />
        <circle cx="52" cy="16" r="5.9" />
        <path d="M61 8.3 L61 24" />
        <path d="M61 14.5 C61 9.6 63.8 8.2 67 8.2" />
      </g>
    </svg>
  )
}

/** Boot splash: shown until the first snapshot lands. */
export function BootSplash({ desk }: { desk: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-app">
      <div className="text-fg" style={{ animation: 'hjit 3.2s steps(1) infinite' }}>
        <Wordmark height={60} />
      </div>
      <span className="font-mono text-[11px] text-t5">
        {desk ? 'holding the door… restoring your desk' : 'holding the door…'}
      </span>
    </div>
  )
}

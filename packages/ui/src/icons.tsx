/**
 * Tiny inline SVG icons for the few places a glyph is needed but every
 * unicode candidate risks emoji presentation on Windows (⚙ ☁ …). Stroke
 * follows currentColor, so they tint like text.
 */

export function GearIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
      />
    </svg>
  )
}

export function CloudIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 12" fill="none" aria-hidden>
      <path
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        d="M4.2 10.5h7.6a2.7 2.7 0 0 0 .5-5.36 3.9 3.9 0 0 0-7.6-.9A3.15 3.15 0 0 0 4.2 10.5Z"
      />
    </svg>
  )
}

export function PhoneIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 16" fill="none" aria-hidden>
      <rect x="1" y="1" width="8" height="14" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M4 12.6h2" />
    </svg>
  )
}

/** Terminal-kind marks for desk tabs: the shell a tile actually runs in.
 * Icon by default, name on hover — a row of tabs shouldn't read as a
 * wall of text. */
export function ShellIcon({ env, size = 12 }: { env?: string | undefined; size?: number }) {
  const kind = env === undefined ? 'shell' : env.startsWith('wsl') ? 'wsl' : env
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none' } as const
  if (kind === 'wsl') {
    // a stylized penguin-ish mark: distinct silhouette at 12px
    return (
      <svg {...common} aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          d="M8 1.8c1.6 0 2.4 1.3 2.4 3 0 1 .9 1.8 1.5 3.1.7 1.5.6 3.3-.9 4.6-1 .9-1.9 1.2-3 1.2s-2-.3-3-1.2c-1.5-1.3-1.6-3.1-.9-4.6.6-1.3 1.5-2.1 1.5-3.1 0-1.7.8-3 2.4-3Z"
        />
        <circle cx="6.8" cy="5.6" r="0.7" fill="currentColor" />
        <circle cx="9.2" cy="5.6" r="0.7" fill="currentColor" />
      </svg>
    )
  }
  if (kind === 'powershell') {
    return (
      <svg {...common} aria-hidden>
        <rect x="1.2" y="2.6" width="13.6" height="10.8" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
        <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="m4.8 5.9 3 2.1-3 2.1" />
        <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M8.6 10.3h3" />
      </svg>
    )
  }
  if (kind === 'cmd') {
    return (
      <svg {...common} aria-hidden>
        <rect x="1.2" y="2.6" width="13.6" height="10.8" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
        <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="m4.4 6.2 2.2 1.8-2.2 1.8" />
      </svg>
    )
  }
  // plain shell (bash/zsh/native)
  return (
    <svg {...common} aria-hidden>
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="m2.6 4 3.4 4-3.4 4" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M7.8 12h5.6" />
    </svg>
  )
}

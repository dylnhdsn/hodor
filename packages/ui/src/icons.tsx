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

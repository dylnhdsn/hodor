import { CloudIcon } from './icons.js'
import type { RowStatus } from './data.js'

/**
 * The one-character status vocabulary (the v3 mock): ▲ your turn, ● working,
 * ○ idle, ❯ a shell, ◐ skipped, ▪ archived. Cloud sessions get the SVG
 * cloud — the code point risks emoji presentation on Windows.
 */
export type GlyphKind = 'ask' | 'run' | 'idle' | 'shell' | 'cloud' | 'skipped' | 'arch' | 'dead'

const GLYPH: Record<Exclude<GlyphKind, 'cloud'>, { text: string; cls: string }> = {
  ask: { text: '▲', cls: 'text-ask' },
  run: { text: '●', cls: 'text-run' },
  idle: { text: '○', cls: 'text-t5' },
  shell: { text: '❯', cls: 'text-t4' },
  skipped: { text: '◐', cls: 'text-rev' },
  arch: { text: '▪', cls: 'text-t6' },
  dead: { text: '○', cls: 'text-b6' },
}

export const glyphOfStatus = (status: RowStatus): GlyphKind =>
  status === 'needs-you' ? 'ask' : status === 'working' ? 'run' : status === 'skipped' ? 'skipped' : 'idle'

export function Glyph({
  kind,
  size = 9,
  className = '',
}: {
  kind: GlyphKind
  /** Font size in px (the cloud icon scales to match). */
  size?: number
  className?: string
}) {
  if (kind === 'cloud') {
    return (
      <span className={`inline-flex shrink-0 items-center text-rev ${className}`} aria-label="cloud">
        <CloudIcon size={size + 2} />
      </span>
    )
  }
  const g = GLYPH[kind]
  return (
    <span className={`inline-block shrink-0 leading-none ${g.cls} ${className}`} style={{ fontSize: size }}>
      {g.text}
    </span>
  )
}

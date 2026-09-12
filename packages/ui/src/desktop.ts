/**
 * The desktop bridge: present only when the UI runs inside the hodor
 * desktop app (the preload script exposes it). Everything degrades to the
 * plain browser behavior when absent.
 */

export interface TermInfo {
  id: string
  title: string
  exited?: number
}

export interface OpenResult {
  id?: string
  title?: string
  error?: string
  /** Copyable fallback when no embedded-terminal route exists. */
  command?: string
  cwd?: string
}

export interface HodorDesktop {
  openTerminal(target: {
    kind: 'resume' | 'fork' | 'new'
    sessionId?: string
    storeId?: string
    root?: string
  }): Promise<OpenResult>
  attach(id: string): Promise<{ backlog?: string; title?: string; exited?: number; error?: string }>
  detach(id: string): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  close(id: string): Promise<void>
  list(): Promise<TermInfo[]>
  popOut(id: string): Promise<void>
  info(): Promise<{ version: string; platform: string }>
  onData(handler: (payload: { id: string; data: string }) => void): () => void
  onEvent(
    handler: (payload: { type: string; id: string; title?: string; code?: number }) => void,
  ): () => void
}

export const desktop: HodorDesktop | undefined = (
  window as { hodorDesktop?: HodorDesktop }
).hodorDesktop

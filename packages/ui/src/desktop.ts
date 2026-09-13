/**
 * The desktop bridge: present only when the UI runs inside the hodor
 * desktop app (the preload script exposes it). Everything degrades to the
 * plain browser behavior when absent.
 */

/** How a terminal was opened — doubles as the workspace slot rule. */
export interface OpenTarget {
  kind: 'resume' | 'fork' | 'new' | 'teleport'
  sessionId?: string
  storeId?: string
  root?: string
}

export interface TermInfo {
  id: string
  title: string
  target?: OpenTarget
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

export type UpdateState =
  | { state: 'ready'; version: string }
  | { state: 'available-manual'; version: string; url: string }

export interface HodorDesktop {
  openTerminal(target: OpenTarget): Promise<OpenResult>
  attach(id: string): Promise<{ backlog?: string; title?: string; exited?: number; error?: string }>
  detach(id: string): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  close(id: string): Promise<void>
  list(): Promise<TermInfo[]>
  popOut(id: string): Promise<void>
  info(): Promise<{ version: string; platform: string }>
  updateState(): Promise<UpdateState | undefined>
  installUpdate(): Promise<void>
  onUpdateEvent(handler: (payload: UpdateState) => void): () => void
  onData(handler: (payload: { id: string; data: string }) => void): () => void
  onEvent(
    handler: (payload: {
      type: string
      id: string
      title?: string
      code?: number
      target?: OpenTarget
    }) => void,
  ): () => void
}

const raw: HodorDesktop | undefined = (window as { hodorDesktop?: HodorDesktop }).hodorDesktop

// Two views in one window can share a PTY (a desk tile and the turn-stack
// card). The main process tracks subscribers per WebContents, so the first
// detach from this window would silently freeze every other view of the
// same terminal — refcount here and only forward the last one.
const attachCounts = new Map<string, number>()

export const desktop: HodorDesktop | undefined =
  raw === undefined
    ? undefined
    : {
        ...raw,
        attach: (id) => {
          attachCounts.set(id, (attachCounts.get(id) ?? 0) + 1)
          return raw.attach(id)
        },
        detach: (id) => {
          const left = (attachCounts.get(id) ?? 1) - 1
          if (left <= 0) {
            attachCounts.delete(id)
            raw.detach(id)
          } else {
            attachCounts.set(id, left)
          }
        },
      }

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
  /** kind 'new' launch options (the new-session dialog). */
  name?: string
  model?: string
  permissionMode?: string
}

export interface TermInfo {
  id: string
  title: string
  target?: OpenTarget
  /** Where the shell actually runs: "wsl · Ubuntu", "cmd", "bash"… */
  env?: string
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
  | { state: 'checking' }
  | { state: 'none'; checkedAt: string }
  | { state: 'error'; message: string; checkedAt: string }

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
  /** Frameless-window controls (absent in older desktop builds). */
  winMinimize?(): void
  winMaximize?(): void
  winClose?(): void
  winIsMaximized?(): Promise<boolean>
  onWinState?(handler: (payload: { maximized: boolean }) => void): () => void
  /** Clipboard via the main process — reliable where the renderer's
   * navigator.clipboard needs permissions it may not have. */
  clipboardText?(): Promise<string>
  clipboardWrite?(text: string): void
  /** Tell the main process a terminal owns the keyboard, so app-level
   * key handling (zoom) steps aside and every key reaches the PTY. */
  setTermFocus?(focused: boolean): void
  updateState(): Promise<UpdateState | undefined>
  /** Kick an update check now (absent in older desktop builds). */
  updateCheck?(): Promise<UpdateState | undefined>
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
      env?: string
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

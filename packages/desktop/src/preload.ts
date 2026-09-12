/**
 * The renderer bridge: the web UI detects `window.hodorDesktop` and grows
 * terminals. Everything crosses IPC as plain data; no node reaches the page.
 */
import { contextBridge, ipcRenderer } from 'electron'

export interface OpenTarget {
  kind: 'resume' | 'fork' | 'new'
  sessionId?: string
  storeId?: string
  root?: string
}

const api = {
  openTerminal: (target: OpenTarget) => ipcRenderer.invoke('pty:open', target),
  attach: (id: string) => ipcRenderer.invoke('pty:attach', { id }),
  detach: (id: string) => ipcRenderer.send('pty:detach', { id }),
  write: (id: string, data: string) => ipcRenderer.send('pty:write', { id, data }),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),
  close: (id: string) => ipcRenderer.invoke('pty:close', { id }),
  list: () => ipcRenderer.invoke('pty:list'),
  popOut: (id: string) => ipcRenderer.invoke('pty:popout', { id }),
  info: () => ipcRenderer.invoke('desktop:info'),
  onData: (handler: (payload: { id: string; data: string }) => void) => {
    const listener = (_event: unknown, payload: { id: string; data: string }): void =>
      handler(payload)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onEvent: (
    handler: (payload: { type: string; id: string; title?: string; code?: number }) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: { type: string; id: string; title?: string; code?: number },
    ): void => handler(payload)
    ipcRenderer.on('pty:event', listener)
    return () => ipcRenderer.removeListener('pty:event', listener)
  },
}

contextBridge.exposeInMainWorld('hodorDesktop', api)

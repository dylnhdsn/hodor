/**
 * hodor desktop: the same data server the CLI runs, wrapped in an Electron
 * shell that owns real PTYs. The renderer is the ordinary web UI served
 * from the in-process server; a preload bridge adds terminals on top.
 *
 * PTYs live HERE, not in any window — a terminal survives its window and
 * can be re-attached (dock tab ⇄ pop-out) with its scrollback replayed
 * from a bounded backlog, tmux-style.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { IPty } from 'node-pty'
import { spawn as ptySpawn } from 'node-pty'
import { baseNodeDeps } from '../../cli/src/node-deps.js'
import { startServer, type RunningServer } from '../../cli/src/server.js'

const BACKLOG_LIMIT = 512 * 1024

interface OpenTarget {
  kind: string
  sessionId?: string
  storeId?: string
  root?: string
}

interface Term {
  id: string
  title: string
  /** How this terminal was opened — the workspace slot rule (doc 022). */
  target: OpenTarget
  pty: IPty
  /** Bounded scrollback for re-attach; chunks trimmed from the front. */
  backlog: Buffer[]
  backlogBytes: number
  exited?: number
  /** WebContents currently rendering this terminal. */
  subscribers: Set<Electron.WebContents>
  /** Set while a dedicated pop-out window shows this terminal. */
  popout?: BrowserWindow
}

const terms = new Map<string, Term>()
// Ids are unique across app restarts: saved workspace layouts carry the ids
// of dead PTYs, and a fresh boot must never mint one that matches.
const bootTag = Date.now().toString(36)
let nextTermId = 1
let server: RunningServer | undefined
let mainWindow: BrowserWindow | undefined

const stateFile = (): string => join(app.getPath('home'), '.hodor', 'desktop.json')

interface DesktopState {
  mainBounds?: Electron.Rectangle
}

function loadState(): DesktopState {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as DesktopState
  } catch {
    return {}
  }
}

function saveState(state: DesktopState): void {
  try {
    mkdirSync(join(app.getPath('home'), '.hodor'), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n')
  } catch {
    // bounds persistence is best-effort
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function termSummary(term: Term): { id: string; title: string; target: OpenTarget; exited?: number } {
  return {
    id: term.id,
    title: term.title,
    target: term.target,
    ...(term.exited !== undefined ? { exited: term.exited } : {}),
  }
}

interface PtySpec {
  file: string
  args: string[]
  cwd?: string
}

async function openTerminal(
  target: OpenTarget,
): Promise<{ id?: string; title?: string; error?: string; command?: string; cwd?: string }> {
  if (server === undefined) return { error: 'server not ready' }
  const res = await fetch(`${server.url}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...target, mode: 'pty' }),
  })
  const body = (await res.json()) as {
    spec?: PtySpec | null
    title?: string
    command?: string
    cwd?: string
    error?: string
  }
  if (body.spec === null || body.spec === undefined) {
    return {
      error: body.error ?? 'no embedded-terminal route for this session',
      ...(body.command !== undefined ? { command: body.command } : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
    }
  }

  const id = `t${bootTag}-${nextTermId++}`
  const title = body.title ?? id
  const pty = ptySpawn(body.spec.file, body.spec.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: body.spec.cwd ?? app.getPath('home'),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  const term: Term = { id, title, target, pty, backlog: [], backlogBytes: 0, subscribers: new Set() }
  terms.set(id, term)

  pty.onData((data) => {
    const chunk = Buffer.from(data, 'utf8')
    term.backlog.push(chunk)
    term.backlogBytes += chunk.length
    while (term.backlogBytes > BACKLOG_LIMIT && term.backlog.length > 1) {
      term.backlogBytes -= term.backlog[0]!.length
      term.backlog.shift()
    }
    for (const wc of term.subscribers) {
      if (!wc.isDestroyed()) wc.send('pty:data', { id, data })
    }
  })
  pty.onExit(({ exitCode }) => {
    term.exited = exitCode
    broadcast('pty:event', { type: 'exit', id, code: exitCode })
  })

  broadcast('pty:event', { type: 'opened', id, title, target })
  return { id, title }
}

function popOut(id: string): void {
  const term = terms.get(id)
  if (term === undefined || server === undefined) return
  if (term.popout !== undefined && !term.popout.isDestroyed()) {
    term.popout.focus()
    return
  }
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    title: term.title,
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  term.popout = win
  win.setMenuBarVisibility(false)
  void win.loadURL(`${server.url}/#pty=${id}`)
  win.on('page-title-updated', (event) => event.preventDefault())
  broadcast('pty:event', { type: 'popped', id })
  win.on('closed', () => {
    delete term.popout
    // The PTY survives its window: hand the terminal back to the dock,
    // unless it already exited and nobody is watching.
    if (terms.has(id)) {
      broadcast('pty:event', { type: 'returned', id, title: term.title, target: term.target })
    }
  })
}

function wireIpc(): void {
  ipcMain.handle('pty:open', (_event, target: Parameters<typeof openTerminal>[0]) =>
    openTerminal(target),
  )

  ipcMain.handle('pty:attach', (event, { id }: { id: string }) => {
    const term = terms.get(id)
    if (term === undefined) return { error: 'no such terminal' }
    term.subscribers.add(event.sender)
    event.sender.once('destroyed', () => term.subscribers.delete(event.sender))
    return {
      backlog: Buffer.concat(term.backlog).toString('utf8'),
      title: term.title,
      ...(term.exited !== undefined ? { exited: term.exited } : {}),
    }
  })

  ipcMain.on('pty:detach', (event, { id }: { id: string }) => {
    terms.get(id)?.subscribers.delete(event.sender)
  })

  ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => {
    const term = terms.get(id)
    if (term !== undefined && term.exited === undefined) term.pty.write(data)
  })

  ipcMain.on('pty:resize', (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const term = terms.get(id)
    if (term !== undefined && term.exited === undefined && cols > 0 && rows > 0) {
      try {
        term.pty.resize(cols, rows)
      } catch {
        // racing an exit is fine
      }
    }
  })

  ipcMain.handle('pty:close', (_event, { id }: { id: string }) => {
    const term = terms.get(id)
    if (term === undefined) return
    if (term.exited === undefined) term.pty.kill()
    if (term.popout !== undefined && !term.popout.isDestroyed()) term.popout.close()
    terms.delete(id)
    broadcast('pty:event', { type: 'closed', id })
  })

  ipcMain.handle('pty:list', () => [...terms.values()].map(termSummary))

  ipcMain.handle('pty:popout', (_event, { id }: { id: string }) => popOut(id))

  ipcMain.handle('desktop:info', () => ({
    version: typeof __HODOR_VERSION__ === 'string' ? __HODOR_VERSION__ : 'dev',
    platform: process.platform,
  }))

  ipcMain.handle('update:state', () => updateState)
  ipcMain.handle('update:install', () => {
    if (updateState?.state === 'ready') autoUpdater.quitAndInstall()
  })
}

declare const __HODOR_VERSION__: string | undefined

/**
 * Auto-update against the rolling release. Windows (NSIS) and Linux
 * (AppImage) update silently via electron-updater's generic feed — CI
 * publishes latest.yml / latest-linux.yml next to the installers.
 * Unsigned macOS can't be auto-installed (Squirrel refuses), so darwin
 * only compares build numbers against version.json and shows a notice.
 * Every failure here is quiet: the rolling release replaces assets one
 * by one, so a mid-upload check can mismatch — the next check heals it.
 */
type UpdateState =
  | { state: 'ready'; version: string }
  | { state: 'available-manual'; version: string; url: string }

let updateState: UpdateState | undefined

function announceUpdate(next: UpdateState): void {
  updateState = next
  broadcast('update:event', next)
}

const buildNumberOf = (version: string): number =>
  Number(/-build\.(\d+)\./.exec(version)?.[1] ?? 0)

async function checkMacUpdate(): Promise<void> {
  const local = typeof __HODOR_VERSION__ === 'string' ? __HODOR_VERSION__ : ''
  const res = await fetch('https://github.com/dylnhdsn/hodor/releases/download/latest/version.json')
  if (!res.ok) return
  const remote = ((await res.json()) as { version?: string }).version ?? ''
  if (buildNumberOf(remote) > buildNumberOf(local)) {
    announceUpdate({
      state: 'available-manual',
      version: remote,
      url: 'https://github.com/dylnhdsn/hodor/releases/download/latest/hodor-desktop-mac-arm64.dmg',
    })
  }
}

function setupUpdater(): void {
  if (!app.isPackaged) return
  const check =
    process.platform === 'darwin'
      ? (): void => void checkMacUpdate().catch(() => {})
      : (): void => void autoUpdater.checkForUpdates().catch(() => {})
  if (process.platform !== 'darwin') {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', (info) => {
      announceUpdate({ state: 'ready', version: info.version })
    })
    autoUpdater.on('error', () => {
      // quiet by design; see the doc comment above
    })
  }
  setTimeout(check, 15_000)
  setInterval(check, 30 * 60_000)
}

function createMainWindow(): void {
  if (server === undefined) return
  const state = loadState()
  mainWindow = new BrowserWindow({
    width: state.mainBounds?.width ?? 1280,
    height: state.mainBounds?.height ?? 840,
    ...(state.mainBounds !== undefined ? { x: state.mainBounds.x, y: state.mainBounds.y } : {}),
    backgroundColor: '#0a0a0b',
    title: 'hodor',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  void mainWindow.loadURL(server.url)
  // External links (e.g. the GitHub repo) open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(server?.url ?? '')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  const persistBounds = (): void => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      saveState({ ...loadState(), mainBounds: mainWindow.getBounds() })
    }
  }
  mainWindow.on('resized', persistBounds)
  mainWindow.on('moved', persistBounds)
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

app.whenReady().then(async () => {
  server = await startServer(
    {
      ...baseNodeDeps(),
      write: (text) => process.stdout.write(text),
      writeErr: (text) => process.stderr.write(text),
      selfUpdate: async () => {
        process.stderr.write('desktop builds update via GitHub releases\n')
        return 1
      },
    },
    { port: 0 },
  )
  wireIpc()
  setupUpdater()
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  for (const term of terms.values()) {
    if (term.exited === undefined) term.pty.kill()
  }
  void server?.close()
})

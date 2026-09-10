import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  StoreTailer,
  applyPlaneOp,
  applySessionOp,
  buildSnapshot,
  defaultHideRules,
  emptyState,
  enrichGitContexts,
  foldAll,
  mergeHideRules,
  slugifyProjectId,
  type CoreState,
  type PlaneOp,
  type SessionOp,
  type Snapshot,
} from '@hodor/core'
import type { CliDeps } from './main.js'
import { resolveStores, storeFs } from './stores.js'
import { uiAssets } from './ui-assets.js'
import { loadUserFiles, saveConfig, saveUserPlane, type UserFiles } from './userdata.js'

/**
 * The local UI/API server: the same pipeline the CLI runs, kept warm and
 * exposed over localhost. Data flows one way (sources → fold → snapshot →
 * SSE); mutations go through the same pure edit ops as the CLI verbs and
 * take effect on the next refresh, which POST handlers trigger immediately.
 */

export interface ServerOptions {
  port: number
  /** Poll cadence; 0 disables the timer (tests drive tick() manually). */
  intervalMs?: number
}

export interface RunningServer {
  port: number
  url: string
  tick(): Promise<void>
  close(): Promise<void>
}

const FALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>hodor</title>
<body style="font-family: system-ui; margin: 3rem; color: #ddd; background: #111">
<h1>hodor</h1>
<p>This build has no embedded UI (dev checkout). Run the Vite dev server:</p>
<pre>pnpm --filter @hodor/ui dev</pre>
<p>The API is live: <a style="color:#8bd" href="/api/snapshot">/api/snapshot</a></p>`

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

export async function startServer(deps: CliDeps, options: ServerOptions): Promise<RunningServer> {
  let files: UserFiles = await loadUserFiles(deps)
  const stores = await resolveStores(deps, { roots: [], noDiscover: false }, files.config)
  const fsFor = storeFs(deps, stores)
  const tailers = stores.map((store) => new StoreTailer(deps.fs, store))

  // Base state holds only source-derived facts; user files are overlaid
  // fresh on every snapshot so removals in config/projects.json take effect.
  let baseState: CoreState = emptyState
  let snapshot: Snapshot | undefined
  let snapshotJson = ''
  const sseClients = new Set<ServerResponse>()

  const configEventsOf = (f: UserFiles) => {
    const events: Parameters<typeof foldAll>[1] = [
      { type: 'config-changed', config: f.config },
      { type: 'userplane-changed', plane: f.plane },
    ]
    return events
  }

  async function refresh(): Promise<void> {
    for (const tailer of tailers) {
      const events = await tailer.poll()
      if (events.length > 0) baseState = foldAll(baseState, events)
    }
    baseState = foldAll(baseState, await enrichGitContexts(baseState, fsFor))
    files = await loadUserFiles(deps)

    let presented = foldAll(baseState, configEventsOf(files))
    for (const [sessionId, override] of Object.entries(files.config.sessions ?? {})) {
      presented = foldAll(presented, [
        {
          type: 'meta-changed',
          meta: {
            sessionId,
            ...(override.rename !== undefined ? { rename: override.rename } : {}),
            ...(override.archived !== undefined ? { archived: override.archived } : {}),
            ...(override.pinnedProject !== undefined
              ? { pinnedProject: override.pinnedProject }
              : {}),
          },
        },
      ])
    }

    const next = buildSnapshot(presented, {
      now: deps.now(),
      hide: mergeHideRules(defaultHideRules, files.config.hide),
    })
    const nextJson = JSON.stringify(next)
    if (nextJson !== snapshotJson) {
      snapshot = next
      snapshotJson = nextJson
      for (const client of sseClients) client.write(`data: ${snapshotJson}\n\n`)
    }
  }

  async function handleMutation(res: ServerResponse, kind: 'project' | 'session', body: string) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'body must be JSON' })
    }

    if (kind === 'session') {
      const op = payload as unknown as SessionOp
      if (op.op !== 'rename-session' && op.op !== 'archive-session') {
        return sendJson(res, 400, { error: `unknown session op` })
      }
      await saveConfig(deps, files.home, applySessionOp(files.config, op))
      await refresh()
      return sendJson(res, 200, { ok: true })
    }

    // create-project may omit the id; the server slugs one from the name.
    if (payload['op'] === 'create-project' && payload['id'] === undefined) {
      payload['id'] = slugifyProjectId(
        String(payload['name'] ?? ''),
        new Set(files.plane.projects.map((p) => p.id)),
      )
    }
    const op = payload as unknown as PlaneOp
    const result = applyPlaneOp(files.plane, op)
    if (result.error !== undefined) return sendJson(res, 400, { error: result.error })
    await saveUserPlane(deps, files.home, result.plane)
    await refresh()
    return sendJson(res, 200, { ok: true, id: op.id })
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/api/snapshot') {
        if (snapshot === undefined) await refresh()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(snapshotJson)
        return
      }

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        if (snapshot === undefined) await refresh()
        res.write(`data: ${snapshotJson}\n\n`)
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return
      }

      if (req.method === 'POST' && (path === '/api/project' || path === '/api/session')) {
        const body = await readBody(req)
        await handleMutation(res, path === '/api/project' ? 'project' : 'session', body)
        return
      }

      if (req.method === 'GET') {
        const assetPath = path === '/' ? '/index.html' : path
        const asset = uiAssets[assetPath]
        if (asset !== undefined) {
          const bytes = Buffer.from(asset.base64, 'base64')
          res.writeHead(200, { 'content-type': asset.type, 'content-length': bytes.length })
          res.end(bytes)
          return
        }
        if (path === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(FALLBACK_PAGE)
          return
        }
      }

      sendJson(res, 404, { error: 'not found' })
    })().catch((error: unknown) => {
      try {
        sendJson(res, 500, { error: String(error) })
      } catch {
        res.destroy()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  await refresh()

  const intervalMs = options.intervalMs ?? 2000
  const timer = intervalMs > 0 ? setInterval(() => void refresh().catch(() => {}), intervalMs) : undefined

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    tick: refresh,
    close: async () => {
      if (timer !== undefined) clearInterval(timer)
      for (const client of sseClients) client.end()
      sseClients.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

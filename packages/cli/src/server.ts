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
  enrichCheckpointBackups,
  enrichMemoryFiles,
  foldAll,
  mergeHideRules,
  parseTranscript,
  previewMatcher,
  slugifyProjectId,
  type CoreState,
  type Matcher,
  type MessageLine,
  type PlaneOp,
  type SessionOp,
  type Snapshot,
} from '@hodor/core'
import { flavorOfPath, pathOps } from '@hodor/core'
import { runLaunch, type LaunchTarget } from './launch.js'
import type { CliDeps } from './main.js'
import { materializeTarget } from './materialize.js'
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
  let presentedState: CoreState = emptyState
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
    baseState = foldAll(baseState, await enrichMemoryFiles(baseState, fsFor))
    baseState = foldAll(baseState, await enrichCheckpointBackups(baseState, fsFor))
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

    presentedState = presented
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

    // split-project may omit newId; slugged from the new project's name.
    if (payload['op'] === 'split-project' && payload['newId'] === undefined) {
      payload['newId'] = slugifyProjectId(
        String(payload['name'] ?? ''),
        new Set(files.plane.projects.map((p) => p.id)),
      )
    }

    const op = payload as unknown as PlaneOp
    let plane = files.plane

    // Editing an auto project materializes it first (docs/brainstorm/010) —
    // the UI never needs to know which kind it was talking to.
    const autoProjects = snapshot?.projects ?? []
    if (op.op !== 'create-project' && op.op !== 'delete-project') {
      const resolved = materializeTarget(plane, autoProjects, op.id)
      if ('error' in resolved) return sendJson(res, 400, { error: resolved.error })
      plane = resolved.plane
      op.id = resolved.id
      if (op.op === 'merge-projects') {
        const from = materializeTarget(plane, autoProjects, op.from)
        if ('error' in from) return sendJson(res, 400, { error: from.error })
        plane = from.plane
        op.from = from.id
      }
    }

    const result = applyPlaneOp(plane, op)
    if (result.error !== undefined) return sendJson(res, 400, { error: result.error })
    await saveUserPlane(deps, files.home, result.plane)
    await refresh()
    return sendJson(res, 200, { ok: true, id: op.id })
  }

  /**
   * The tail of a session's conversation, for the detail pane: the last
   * human-readable turns (prompts, commands, assistant text), meta and
   * tool-only lines skipped. Read-only, straight off the transcript file.
   */
  async function handleTranscript(res: ServerResponse, url: URL): Promise<void> {
    const id = url.searchParams.get('id') ?? ''
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 40)))
    const session = snapshot?.sessions.find((s) => s.id === id)
    if (session === undefined) return sendJson(res, 404, { error: `no session "${id}"` })

    // The main transcript plus any modern per-file subagent runs beside it
    // (<bucket>/<sessionId>/subagents/agent-*.jsonl), merged by timestamp.
    const paths = [session.transcriptPath]
    if (session.transcriptPath.endsWith('.jsonl')) {
      const sessionDir = session.transcriptPath.slice(0, -'.jsonl'.length)
      const p = pathOps(flavorOfPath(sessionDir))
      const subagentsDir = p.join(sessionDir, 'subagents')
      const entries = await deps.fs.listDir(subagentsDir).catch(() => [])
      for (const entry of entries) {
        if (entry.startsWith('agent-') && entry.endsWith('.jsonl')) {
          paths.push(p.join(subagentsDir, entry))
        }
      }
    }

    const messages: Array<{ type: string; timestamp?: string; isSidechain: boolean; text?: string }> = []
    for (const path of paths) {
      const content = await deps.fs.readFile(path).catch(() => undefined)
      if (content === undefined) continue
      for (const line of parseTranscript(content)) {
        if (line.kind !== 'message') continue
        const text = line.promptText ?? line.commandName ?? line.textPreview
        if (text === undefined) continue
        messages.push({
          type: line.type,
          ...(line.timestamp !== undefined ? { timestamp: line.timestamp } : {}),
          isSidechain: line.isSidechain,
          text,
        })
      }
    }
    messages.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
    return sendJson(res, 200, { messages: messages.slice(-limit) })
  }

  /**
   * Launch a real terminal on this machine: resume/fork a session in its
   * own cwd, or start a fresh claude in a known project root. Always
   * answers with the copyable command, so a failed spawn (headless box,
   * exotic terminal) still leaves the user one paste away.
   */
  async function handleLaunch(res: ServerResponse, body: string): Promise<void> {
    let payload: { kind?: string; sessionId?: string; storeId?: string; root?: string }
    try {
      payload = JSON.parse(body) as typeof payload
    } catch {
      return sendJson(res, 400, { error: 'body must be JSON' })
    }
    if (snapshot === undefined) await refresh()

    let target: LaunchTarget
    if (payload.kind === 'resume' || payload.kind === 'fork') {
      const session = snapshot?.sessions.find((s) => s.id === payload.sessionId)
      if (session === undefined) return sendJson(res, 404, { error: `no session "${payload.sessionId}"` })
      // Resume from the FIRST cwd: the store bucket is keyed by it, so
      // resuming elsewhere would re-home the session into a new bucket.
      const cwd = session.cwds[0] ?? session.cwd
      if (cwd === undefined) return sendJson(res, 400, { error: 'session has no cwd' })
      const store = snapshot?.stores.find((s) => s.id === session.storeId)
      if (store === undefined) return sendJson(res, 400, { error: 'session store unknown' })
      target = {
        cwd,
        flavor: store.pathFlavor,
        origin: store.origin,
        claudeArgs: [
          '--resume',
          session.id,
          ...(payload.kind === 'fork' ? ['--fork-session'] : []),
        ],
      }
    } else if (payload.kind === 'new') {
      const store = snapshot?.stores.find((s) => s.id === payload.storeId)
      if (store === undefined) return sendJson(res, 400, { error: 'unknown store' })
      // Only launch into places the data already knows about.
      const known =
        snapshot?.projects.some((p) =>
          p.roots.some((r) => r.storeId === payload.storeId && r.path === payload.root),
        ) === true ||
        snapshot?.sessions.some((s) => s.storeId === payload.storeId && s.cwds.includes(payload.root ?? '')) === true
      if (!known || payload.root === undefined) {
        return sendJson(res, 400, { error: 'root is not a known project root' })
      }
      target = { cwd: payload.root, flavor: store.pathFlavor, origin: store.origin, claudeArgs: [] }
    } else {
      return sendJson(res, 400, { error: 'kind must be resume, fork, or new' })
    }

    const result = await runLaunch(deps, target)
    return sendJson(res, result.ok ? 200 : 500, result)
  }

  function handlePreview(res: ServerResponse, body: string): void {
    let payload: { matcher?: Matcher }
    try {
      payload = JSON.parse(body) as { matcher?: Matcher }
    } catch {
      return sendJson(res, 400, { error: 'body must be JSON' })
    }
    const matcher = payload.matcher
    const valid =
      matcher !== undefined &&
      ((matcher.kind === 'remote' && typeof matcher.url === 'string') ||
        (matcher.kind === 'root' && typeof matcher.path === 'string') ||
        (matcher.kind === 'cwd' && typeof matcher.prefix === 'string') ||
        (matcher.kind === 'dir' && typeof matcher.path === 'string') ||
        (matcher.kind === 'session' && typeof matcher.id === 'string'))
    if (!valid) return sendJson(res, 400, { error: 'matcher must be remote/root/cwd/dir/session' })
    const sessionIds = previewMatcher(presentedState, snapshot?.sessions ?? [], matcher)
    return sendJson(res, 200, { sessionIds })
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      // HEAD mirrors GET for read routes (curl -I, health checks): same
      // headers, no body. SSE stays GET-only.
      const isHead = req.method === 'HEAD'
      const reads = isHead || req.method === 'GET'

      if (reads && path === '/api/snapshot') {
        if (snapshot === undefined) await refresh()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(isHead ? undefined : snapshotJson)
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

      if (req.method === 'POST' && path === '/api/preview') {
        handlePreview(res, await readBody(req))
        return
      }

      if (req.method === 'POST' && path === '/api/launch') {
        await handleLaunch(res, await readBody(req))
        return
      }

      if (req.method === 'GET' && path === '/api/transcript') {
        if (snapshot === undefined) await refresh()
        await handleTranscript(res, url)
        return
      }

      if (reads) {
        const assetPath = path === '/' ? '/index.html' : path
        const asset = uiAssets[assetPath]
        if (asset !== undefined) {
          const bytes = Buffer.from(asset.base64, 'base64')
          // index.html must always revalidate or a browser keeps running a
          // stale app after hodor update; Vite's hashed assets are immutable.
          const cache = assetPath.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache'
          res.writeHead(200, {
            'content-type': asset.type,
            'content-length': bytes.length,
            'cache-control': cache,
          })
          res.end(isHead ? undefined : bytes)
          return
        }
        if (path === '/') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
          })
          res.end(isHead ? undefined : FALLBACK_PAGE)
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

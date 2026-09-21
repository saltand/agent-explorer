import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { AGENT_LABELS, isIndexedSessionFile, resolveOwningRoot, type AgentRoot } from './agents'
import { cursorStoreToJsonl, isCursorStorePath } from './cursor-store'
import { SessionIndex } from './index-db'
import { pathForSessionId, scanSessions, summarizeOne, type SessionSummary } from './scan'
import { SessionWatcher } from './watch'

export interface ServerOptions {
  roots: AgentRoot[]
  index: SessionIndex
  staticDir?: string
  host: string
  port: number
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Resolves a session id to a path that must live under a known agent root.
 * Ids are client-supplied, so this is the boundary that prevents reading
 * arbitrary files off disk.
 */
function resolveSessionPath(id: string, roots: AgentRoot[]): string | undefined {
  let decoded: string
  try {
    decoded = pathForSessionId(id)
  } catch {
    return undefined
  }
  if (!decoded || decoded.includes('\0')) return undefined

  const absolute = resolve(decoded)
  const root = resolveOwningRoot(absolute, roots)
  if (!root || !isIndexedSessionFile(absolute, root)) return undefined
  return absolute
}

export function createAppServer(options: ServerOptions) {
  const { roots, index, staticDir } = options
  const sseClients = new Set<ServerResponse>()
  let scanning = false

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) {
      client.write(payload)
    }
  }

  async function reindex(summary: SessionSummary, reason: 'created' | 'updated'): Promise<void> {
    try {
      await index.indexSession(summary)
      broadcast('session', { reason, session: summary })
    } catch {
      // A partially written file will be picked up by the next event.
    }
  }

  const watcher = new SessionWatcher(roots, (change) => {
    void (async () => {
      const summary = await summarizeOne(change.path, change.agent as SessionSummary['agent'])
      if (!summary) return
      // Determine novelty before indexing, since indexing inserts the row.
      const reason = index.hasSession(summary.id) ? 'updated' : 'created'
      if (!index.needsIndexing(summary)) return
      await reindex(summary, reason)
    })()
  })

  /** Full rescan: cheap because unchanged files are skipped by mtime/size. */
  async function rescan(): Promise<{ scanned: number; indexed: number }> {
    if (scanning) return { scanned: 0, indexed: 0 }
    scanning = true
    try {
      const summaries = await scanSessions(roots)
      let indexed = 0
      for (const summary of summaries) {
        if (!index.needsIndexing(summary)) {
          index.upsertSession(summary)
          continue
        }
        try {
          await index.indexSession(summary)
          indexed += 1
        } catch {
          // Skip unreadable files.
        }
      }
      broadcast('rescan', { scanned: summaries.length, indexed })
      return { scanned: summaries.length, indexed }
    } finally {
      scanning = false
    }
  }

  async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!staticDir) {
      sendJson(response, 404, { error: 'Static assets are not bundled in this build' })
      return
    }

    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(staticDir, relative)

    // Containment check against path traversal.
    if (!filePath.startsWith(staticDir + sep) && filePath !== staticDir) {
      sendJson(response, 403, { error: 'Forbidden' })
      return
    }

    try {
      const info = await stat(filePath)
      if (info.isDirectory()) filePath = join(filePath, 'index.html')
    } catch {
      // Unknown paths fall through to the SPA entry point.
      filePath = join(staticDir, 'index.html')
    }

    try {
      const info = await stat(filePath)
      const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
      const isHashed = /-[A-Za-z0-9_-]{8,}\./.test(filePath)
      response.writeHead(200, {
        'content-type': type,
        'content-length': info.size,
        'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      createReadStream(filePath).pipe(response)
    } catch {
      sendJson(response, 404, { error: 'Not found' })
    }
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response)
  })

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const { pathname } = url

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    try {
      if (pathname === '/api/agents') {
        const counts = new Map<string, number>()
        for (const summary of index.listSessions({ limit: 100_000 })) {
          counts.set(summary.agent, (counts.get(summary.agent) ?? 0) + 1)
        }
        const agents = []
        const seen = new Set<string>()
        for (const root of roots) {
          if (seen.has(root.agent)) continue
          seen.add(root.agent)
          agents.push({
            agent: root.agent,
            label: AGENT_LABELS[root.agent],
            dir: root.dir,
            sessionCount: counts.get(root.agent) ?? 0,
          })
        }
        sendJson(response, 200, { agents })
        return
      }

      if (pathname === '/api/sessions') {
        const agent = url.searchParams.get('agent') ?? undefined
        const limit = Number(url.searchParams.get('limit') ?? '300')
        const offset = Number(url.searchParams.get('offset') ?? '0')
        sendJson(response, 200, {
          sessions: index.listSessions({
            agent,
            limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 2000) : 300,
            offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
          }),
          total: index.countSessions(agent),
        })
        return
      }

      if (pathname === '/api/search') {
        const query = url.searchParams.get('q') ?? ''
        const agent = url.searchParams.get('agent') ?? undefined
        const limit = Number(url.searchParams.get('limit') ?? '100')
        sendJson(response, 200, {
          query,
          hits: index.search({
            query,
            agent,
            limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
          }),
        })
        return
      }

      if (pathname === '/api/session') {
        const id = url.searchParams.get('id')
        if (!id) {
          sendJson(response, 400, { error: 'Missing id' })
          return
        }
        const filePath = resolveSessionPath(id, roots)
        if (!filePath) {
          sendJson(response, 404, { error: 'Unknown session' })
          return
        }

        if (isCursorStorePath(filePath)) {
          let jsonl: string
          try {
            jsonl = cursorStoreToJsonl(filePath)
          } catch {
            sendJson(response, 404, { error: 'Session file is no longer available' })
            return
          }
          const body = Buffer.from(jsonl, 'utf8')
          response.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-length': body.length,
            'cache-control': 'no-store',
          })
          if (request.method === 'HEAD') {
            response.end()
            return
          }
          response.end(body)
          return
        }

        let info
        try {
          info = await stat(filePath)
        } catch {
          sendJson(response, 404, { error: 'Session file is no longer available' })
          return
        }

        response.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-length': info.size,
          'cache-control': 'no-store',
        })
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        createReadStream(filePath).pipe(response)
        return
      }

      if (pathname === '/api/rescan') {
        const result = await rescan()
        sendJson(response, 200, result)
        return
      }

      if (pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        sseClients.add(response)

        // Comment frames keep intermediaries from closing an idle stream.
        const heartbeat = setInterval(() => response.write(': ping\n\n'), 25_000)
        heartbeat.unref?.()
        request.on('close', () => {
          clearInterval(heartbeat)
          sseClients.delete(response)
        })
        return
      }

      if (pathname === '/api/stats') {
        sendJson(response, 200, {
          sessions: index.countSessions(),
          messages: index.countMessages(),
        })
        return
      }

      if (pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Unknown endpoint' })
        return
      }

      await serveStatic(request, response, pathname)
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Internal error',
      })
    }
  }

  return {
    server,
    rescan,
    startWatching: () => watcher.start(),
    close: () => {
      watcher.close()
      for (const client of sseClients) client.end()
      sseClients.clear()
      server.close()
    },
  }
}

/**
 * Client for the local `agent-explorer` server. All endpoints are relative, so
 * the app works whether it is served by the CLI or by the Vite dev server with
 * a proxy.
 */

export interface RemoteSessionSummary {
  id: string
  path: string
  agent: string
  fileName: string
  cwd?: string
  title?: string
  size: number
  mtimeMs: number
  startedAt?: number
  endedAt?: number
}

export interface RemoteAgent {
  agent: string
  label: string
  dir: string
  sessionCount: number
}

export interface SnippetPart {
  text: string
  match: boolean
}

export interface RemoteSearchHit {
  sessionId: string
  path: string
  agent: string
  fileName: string
  cwd?: string
  title?: string
  mtimeMs: number
  lineIndex: number
  role: string
  snippet: SnippetPart[]
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) {
    let message = `Request failed with ${response.status}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

/** True when the local server is reachable; false in plain static hosting. */
export async function probeServer(signal?: AbortSignal): Promise<boolean> {
  try {
    await getJson<{ sessions: number }>('/api/stats', signal)
    return true
  } catch {
    return false
  }
}

export function fetchAgents(signal?: AbortSignal): Promise<{ agents: RemoteAgent[] }> {
  return getJson('/api/agents', signal)
}

export function fetchSessions(
  options: { agent?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<{ sessions: RemoteSessionSummary[]; total: number }> {
  const params = new URLSearchParams()
  if (options.agent) params.set('agent', options.agent)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  const query = params.toString()
  return getJson(`/api/sessions${query ? `?${query}` : ''}`, signal)
}

export function searchSessions(
  options: { query: string; agent?: string; limit?: number },
  signal?: AbortSignal,
): Promise<{ query: string; hits: RemoteSearchHit[] }> {
  const params = new URLSearchParams({ q: options.query })
  if (options.agent) params.set('agent', options.agent)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  return getJson(`/api/search?${params.toString()}`, signal)
}

/** Fetches the raw JSONL for a session so the existing adapters can parse it. */
export async function fetchSessionText(id: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`, { signal })
  if (!response.ok) {
    let message = `Failed to load session (${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message)
  }
  return await response.text()
}

export function requestRescan(signal?: AbortSignal): Promise<{ scanned: number; indexed: number }> {
  return getJson('/api/rescan', signal)
}

export interface SessionEvent {
  reason: 'created' | 'updated'
  session: RemoteSessionSummary
}

/**
 * Subscribes to server-sent events. The browser's EventSource reconnects on its
 * own, so callers only need to handle payloads.
 */
export function subscribeToEvents(handlers: {
  onSession?: (event: SessionEvent) => void
  onRescan?: (event: { scanned: number; indexed: number }) => void
}): () => void {
  const source = new EventSource('/api/events')

  const handleSession = (event: MessageEvent<string>) => {
    try {
      handlers.onSession?.(JSON.parse(event.data) as SessionEvent)
    } catch {
      // Ignore malformed frames.
    }
  }
  const handleRescan = (event: MessageEvent<string>) => {
    try {
      handlers.onRescan?.(JSON.parse(event.data) as { scanned: number; indexed: number })
    } catch {
      // Ignore malformed frames.
    }
  }

  source.addEventListener('session', handleSession as EventListener)
  source.addEventListener('rescan', handleRescan as EventListener)

  return () => {
    source.removeEventListener('session', handleSession as EventListener)
    source.removeEventListener('rescan', handleRescan as EventListener)
    source.close()
  }
}

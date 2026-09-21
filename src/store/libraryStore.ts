import { create } from 'zustand'
import {
  fetchAgents,
  fetchSessions,
  probeServer,
  requestRescan,
  searchSessions,
  subscribeToEvents,
  type RemoteAgent,
  type RemoteSearchHit,
  type RemoteSessionSummary,
} from '../core/serverApi'

/**
 * `unknown` until the probe finishes, then either `connected` (running under the
 * CLI) or `offline` (static hosting, drag-and-drop only).
 */
export type ServerStatus = 'unknown' | 'connected' | 'offline'

interface LibraryState {
  status: ServerStatus
  agents: RemoteAgent[]
  sessions: RemoteSessionSummary[]
  total: number
  agentFilter?: string
  /** Query for cross-session full-text search, distinct from in-session search. */
  libraryQuery: string
  hits: RemoteSearchHit[]
  isSearching: boolean
  isLoadingSessions: boolean
  isLoadingMore: boolean
  isRescanning: boolean
  /** Session id currently open in the viewer. */
  activeSessionId?: string
  /** Sessions whose files changed on disk while open. */
  staleSessionIds: string[]
  error?: string

  connect: () => Promise<void>
  refreshSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  setAgentFilter: (agent?: string) => Promise<void>
  setLibraryQuery: (query: string) => void
  runSearch: (query: string) => Promise<void>
  rescan: () => Promise<void>
  setActiveSessionId: (id?: string) => void
  clearStale: (id: string) => void
}

/** Sessions fetched per page; the list appends as the user scrolls. */
const SESSION_PAGE_SIZE = 300

let searchToken = 0
let unsubscribe: (() => void) | undefined

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  status: 'unknown',
  agents: [],
  sessions: [],
  total: 0,
  libraryQuery: '',
  hits: [],
  isSearching: false,
  isLoadingSessions: false,
  isLoadingMore: false,
  isRescanning: false,
  staleSessionIds: [],

  connect: async () => {
    const available = await probeServer()
    if (!available) {
      set({ status: 'offline' })
      return
    }

    set({ status: 'connected' })
    await Promise.all([
      fetchAgents()
        .then(({ agents }) => set({ agents }))
        .catch(() => undefined),
      get().refreshSessions(),
    ])

    unsubscribe?.()
    unsubscribe = subscribeToEvents({
      onSession: ({ session }) => {
        set((prev) => {
          // Respect the active agent chip: an event for a filtered-out agent
          // should not appear in the visible list.
          if (prev.agentFilter && session.agent !== prev.agentFilter) return prev
          const isNew = !prev.sessions.some((item) => item.id === session.id)
          const sessions = [session, ...prev.sessions.filter((item) => item.id !== session.id)]
          sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
          // Flag the open session as stale so the user can reload on demand
          // rather than having the view swapped underneath them.
          const staleSessionIds =
            prev.activeSessionId === session.id && !prev.staleSessionIds.includes(session.id)
              ? [...prev.staleSessionIds, session.id]
              : prev.staleSessionIds
          return { sessions, staleSessionIds, total: isNew ? prev.total + 1 : prev.total }
        })
      },
      onRescan: () => {
        void get().refreshSessions()
      },
    })
  },

  refreshSessions: async () => {
    set({ isLoadingSessions: true })
    try {
      // Keep whatever the user had already paged in, so a live update or a
      // rescan does not collapse a long list back to the first page.
      const loaded = get().sessions.length
      const { sessions, total } = await fetchSessions({
        agent: get().agentFilter,
        limit: Math.max(loaded, SESSION_PAGE_SIZE),
      })
      set({ sessions, total, isLoadingSessions: false, error: undefined })
    } catch (error) {
      set({
        isLoadingSessions: false,
        error: error instanceof Error ? error.message : 'Failed to load sessions',
      })
    }
  },

  loadMoreSessions: async () => {
    const { sessions, total, isLoadingMore, isLoadingSessions, agentFilter } = get()
    if (isLoadingMore || isLoadingSessions || sessions.length >= total) return

    set({ isLoadingMore: true })
    try {
      const page = await fetchSessions({
        agent: agentFilter,
        limit: SESSION_PAGE_SIZE,
        offset: sessions.length,
      })
      set((prev) => {
        // Files can shift between pages as sessions are written, so dedupe.
        const seen = new Set(prev.sessions.map((item) => item.id))
        const added = page.sessions.filter((item) => !seen.has(item.id))
        return {
          sessions: [...prev.sessions, ...added],
          total: page.total,
          isLoadingMore: false,
        }
      })
    } catch (error) {
      set({
        isLoadingMore: false,
        error: error instanceof Error ? error.message : 'Failed to load more sessions',
      })
    }
  },

  setAgentFilter: async (agent) => {
    set({ agentFilter: agent, sessions: [] })
    const { libraryQuery, runSearch, refreshSessions } = get()
    await (libraryQuery.trim() ? runSearch(libraryQuery) : refreshSessions())
  },

  setLibraryQuery: (libraryQuery) => {
    set({ libraryQuery })
    if (!libraryQuery.trim()) {
      searchToken += 1
      set({ hits: [], isSearching: false })
    }
  },

  runSearch: async (query) => {
    const trimmed = query.trim()
    if (!trimmed) {
      set({ hits: [], isSearching: false })
      return
    }

    const token = ++searchToken
    set({ isSearching: true })
    try {
      const { hits } = await searchSessions({
        query: trimmed,
        agent: get().agentFilter,
        limit: 200,
      })
      // Drop results from superseded queries.
      if (token !== searchToken) return
      set({ hits, isSearching: false, error: undefined })
    } catch (error) {
      if (token !== searchToken) return
      set({
        isSearching: false,
        error: error instanceof Error ? error.message : 'Search failed',
      })
    }
  },

  rescan: async () => {
    set({ isRescanning: true })
    try {
      await requestRescan()
      await get().refreshSessions()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Rescan failed' })
    } finally {
      set({ isRescanning: false })
    }
  },

  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),

  clearStale: (id) =>
    set((prev) => ({ staleSessionIds: prev.staleSessionIds.filter((item) => item !== id) })),
}))

import { RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { RemoteSearchHit } from '../../core/serverApi'
import { useLibraryStore } from '../../store/libraryStore'
import { useSessionStore } from '../../store/sessionStore'
import {
  chipActive,
  chipInactive,
  emptyStateXs,
  inputFocus,
  panelHeader,
  textInput,
} from '../../styles/uiClasses'
import { ToolbarButton } from '../shared/ToolbarButton'
import { SearchHitItem } from './SearchHitItem'
import { SessionListItem } from './SessionListItem'

const SESSION_ITEM_HEIGHT = 78
const HIT_ITEM_HEIGHT = 96
const SEARCH_DEBOUNCE_MS = 180

export function LibraryPanel() {
  const status = useLibraryStore((s) => s.status)
  const agents = useLibraryStore((s) => s.agents)
  const sessions = useLibraryStore((s) => s.sessions)
  const total = useLibraryStore((s) => s.total)
  const agentFilter = useLibraryStore((s) => s.agentFilter)
  const libraryQuery = useLibraryStore((s) => s.libraryQuery)
  const hits = useLibraryStore((s) => s.hits)
  const isSearching = useLibraryStore((s) => s.isSearching)
  const isRescanning = useLibraryStore((s) => s.isRescanning)
  const isLoadingMore = useLibraryStore((s) => s.isLoadingMore)
  const activeSessionId = useLibraryStore((s) => s.activeSessionId)
  const staleSessionIds = useLibraryStore((s) => s.staleSessionIds)
  const error = useLibraryStore((s) => s.error)
  const setAgentFilter = useLibraryStore((s) => s.setAgentFilter)
  const setLibraryQuery = useLibraryStore((s) => s.setLibraryQuery)
  const runSearch = useLibraryStore((s) => s.runSearch)
  const rescan = useLibraryStore((s) => s.rescan)
  const loadMoreSessions = useLibraryStore((s) => s.loadMoreSessions)
  const loadRemoteSession = useSessionStore((s) => s.loadRemoteSession)

  const parentRef = useRef<HTMLDivElement>(null)
  const [selectedHitKey, setSelectedHitKey] = useState<string>()

  const isSearchMode = libraryQuery.trim().length > 0
  const staleSet = useMemo(() => new Set(staleSessionIds), [staleSessionIds])

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const trimmed = libraryQuery.trim()
    if (!trimmed) return
    const timer = setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [libraryQuery, runSearch])

  const count = isSearchMode ? hits.length : sessions.length
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (isSearchMode ? HIT_ITEM_HEIGHT : SESSION_ITEM_HEIGHT),
    overscan: 10,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const hasMore = !isSearchMode && sessions.length < total

  // Page in the next batch once the tail of the list is rendered.
  useEffect(() => {
    if (!hasMore) return
    const last = virtualItems.at(-1)
    if (last && last.index >= sessions.length - 5) void loadMoreSessions()
  }, [hasMore, virtualItems, sessions.length, loadMoreSessions])

  function handleOpenHit(hit: RemoteSearchHit) {
    setSelectedHitKey(`${hit.sessionId}:${hit.lineIndex}`)
    void loadRemoteSession(hit.sessionId, { lineIndex: hit.lineIndex })
  }

  if (status === 'offline') {
    return (
      <div className={`flex h-full flex-col items-center justify-center gap-2 p-4 text-center ${emptyStateXs}`}>
        <p>Local session library is unavailable.</p>
        <p className="text-tertiary">
          Run <code className="rounded bg-overlay px-1">npx @saltand/agent-explorer</code> to browse and
          search sessions on this machine.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className={`flex items-center gap-1 ${panelHeader}`}>
        <span>
          Library · {count}
          {!isSearchMode && total > sessions.length ? ` / ${total}` : ''}
        </span>
        <div className="flex-1" />
        <ToolbarButton
          onClick={() => void rescan()}
          aria-label="Rescan session directories"
          title="Rescan session directories"
        >
          <RefreshCw
            size={13}
            strokeWidth={1.75}
            className={isRescanning ? 'animate-spin' : undefined}
            aria-hidden
          />
        </ToolbarButton>
      </div>

      <div className="border-b border-separator p-1.5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tertiary"
            size={13}
            strokeWidth={1.75}
            aria-hidden
          />
          <input
            type="text"
            role="searchbox"
            value={libraryQuery}
            onChange={(event) => setLibraryQuery(event.target.value)}
            placeholder="Search all sessions…"
            className={`h-7 w-full rounded pl-7 pr-7 text-xs ${textInput} ${inputFocus}`}
          />
          {libraryQuery && (
            <button
              type="button"
              onClick={() => setLibraryQuery('')}
              className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-tertiary hover:bg-overlay hover:text-primary"
              aria-label="Clear library search"
            >
              <X size={12} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {agents.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-separator px-1.5 py-1">
          <button
            type="button"
            onClick={() => void setAgentFilter(undefined)}
            className={`rounded px-2 py-0.5 text-[11px] ${!agentFilter ? chipActive : chipInactive}`}
          >
            All
          </button>
          {agents.map((agent) => (
            <button
              key={agent.agent}
              type="button"
              onClick={() => void setAgentFilter(agent.agent)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                agentFilter === agent.agent ? chipActive : chipInactive
              }`}
              title={agent.dir}
            >
              {agent.label}
              <span className="ml-1 text-tertiary">{agent.sessionCount}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="border-b border-separator px-3 py-1.5 text-[11px] text-danger">{error}</div>
      )}

      <div ref={parentRef} className="flex-1 overflow-auto">
        {count === 0 ? (
          <div className={`flex h-full items-center justify-center p-4 text-center ${emptyStateXs}`}>
            {isSearchMode
              ? isSearching
                ? 'Searching…'
                : 'No matches'
              : status === 'unknown'
                ? 'Connecting…'
                : 'No sessions found'}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualItems.map((row) => {
              const hit = isSearchMode ? hits[row.index] : undefined
              const session = isSearchMode ? undefined : sessions[row.index]
              const key = hit ? `${hit.sessionId}:${hit.lineIndex}` : (session?.id ?? row.index)

              return (
                <div
                  key={key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  style={{ position: 'absolute', top: row.start, left: 0, width: '100%' }}
                >
                  {hit ? (
                    <SearchHitItem
                      hit={hit}
                      selected={selectedHitKey === `${hit.sessionId}:${hit.lineIndex}`}
                      onSelect={handleOpenHit}
                    />
                  ) : session ? (
                    <SessionListItem
                      session={session}
                      selected={activeSessionId === session.id}
                      stale={staleSet.has(session.id)}
                      onSelect={(id) => void loadRemoteSession(id)}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
        {isLoadingMore && (
          <div className={`px-3 py-2 text-center ${emptyStateXs}`}>Loading more…</div>
        )}
      </div>
    </div>
  )
}

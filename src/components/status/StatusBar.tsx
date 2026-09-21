import { Moon, PanelLeft, RotateCw, Sun } from 'lucide-react'
import { ToolbarButton } from '../shared/ToolbarButton'
import { useLibraryStore } from '../../store/libraryStore'
import { useSessionStore } from '../../store/sessionStore'
import { ParseWarningsBadge } from './ParseWarningsBadge'
import { SearchInput } from './SearchInput'
import { SettingsPopover } from './SettingsPopover'

export function StatusBar() {
  const session = useSessionStore((s) => s.session)
  const error = useSessionStore((s) => s.error)
  const theme = useSessionStore((s) => s.theme)
  const libraryOpen = useSessionStore((s) => s.libraryOpen)
  const loadRemoteSession = useSessionStore((s) => s.loadRemoteSession)
  const setTheme = useSessionStore((s) => s.setTheme)
  const toggleLibrary = useSessionStore((s) => s.toggleLibrary)
  const serverStatus = useLibraryStore((s) => s.status)
  const activeSessionId = useLibraryStore((s) => s.activeSessionId)
  const staleSessionIds = useLibraryStore((s) => s.staleSessionIds)

  const isStale = !!activeSessionId && staleSessionIds.includes(activeSessionId)

  function toggleTheme() {
    const next =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'light'
          : 'dark'
        : theme === 'dark'
          ? 'light'
          : 'dark'
    setTheme(next)
  }

  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-separator bg-background px-1.5">
      <span className="px-2 text-sm font-semibold text-primary">Agent Explorer</span>

      {serverStatus === 'connected' && (
        <ToolbarButton
          onClick={toggleLibrary}
          aria-label={libraryOpen ? 'Hide session library' : 'Show session library'}
          title={libraryOpen ? 'Hide library' : 'Show library'}
          aria-pressed={libraryOpen}
        >
          <PanelLeft size={14} strokeWidth={1.75} aria-hidden />
        </ToolbarButton>
      )}

      <div className="flex items-baseline gap-1">
        {session && (
          <span className="rounded bg-overlay px-2 py-0.5 text-[10px] font-medium text-secondary">
            {session.fileType}
          </span>
        )}

        {session && (
          <span className="truncate text-xs text-secondary">{session.fileName}</span>
        )}

        {session && session.parseWarnings.length > 0 && (
          <ParseWarningsBadge warnings={session.parseWarnings} />
        )}

        {isStale && (
          <button
            type="button"
            onClick={() => void loadRemoteSession(activeSessionId)}
            className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/25"
            title="This session changed on disk. Reload to see the latest events."
          >
            <RotateCw size={10} strokeWidth={2} aria-hidden />
            Reload
          </button>
        )}

        {error && <span className="truncate text-xs text-danger">{error}</span>}
      </div>

      <div className="flex-1" />

      <div className="flex gap-1">
        {session && (
          <>
            <SearchInput />
            <SettingsPopover />
          </>
        )}

        <ToolbarButton
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          title={isDark ? 'Light mode' : 'Dark mode'}
        >
          {isDark ? (
            <Sun size={14} strokeWidth={1.75} aria-hidden />
          ) : (
            <Moon size={14} strokeWidth={1.75} aria-hidden />
          )}
        </ToolbarButton>
      </div>
    </header>
  )
}

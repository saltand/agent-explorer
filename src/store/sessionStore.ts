import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { detectAndParse } from '../core/registry'
import { fetchSessionText } from '../core/serverApi'
import type { ExplorerSession, TimelineEvent, ConversationListItem, Selection } from '../core/types'
import { useLibraryStore } from './libraryStore'
import { useSettingsStore } from './settingsStore'

type Theme = 'light' | 'dark' | 'system'

interface SessionState {
  session: ExplorerSession | null
  selection: Selection | null
  theme: Theme
  isLoading: boolean
  error: string | null
  /** Visibility of the local session library sidebar. */
  libraryOpen: boolean
  loadText: (text: string, fileName: string) => void
  /** Loads a session served by the local CLI, optionally jumping to a line. */
  loadRemoteSession: (id: string, options?: { lineIndex?: number }) => Promise<void>
  setSelection: (selection: Selection | null) => void
  selectTimelineEvent: (event: TimelineEvent) => void
  selectConversationItem: (item: ConversationListItem) => void
  /** Reveals an event in every panel, used for search-hit navigation. */
  revealEvent: (event: TimelineEvent) => void
  setTheme: (theme: Theme) => void
  toggleLibrary: () => void
  clearSession: () => void
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
  root.classList.toggle('dark', isDark)
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      session: null,
      selection: null,
      theme: 'system',
      isLoading: false,
      error: null,
      libraryOpen: true,

      loadText: (text, fileName) => {
        set({ isLoading: true, error: null })
        useSettingsStore.getState().resetSessionFilters()
        try {
          const session = detectAndParse(text, fileName)
          set({
            session,
            selection: null,
            isLoading: false,
          })
        } catch (error) {
          set({
            session: null,
            selection: null,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to parse file',
          })
        }
      },

      loadRemoteSession: async (id, options) => {
        const library = useLibraryStore.getState()
        const summary = library.sessions.find((item) => item.id === id)
        set({ isLoading: true, error: null })
        try {
          const text = await fetchSessionText(id)
          get().loadText(text, summary?.fileName ?? 'session.jsonl')
          library.setActiveSessionId(id)
          library.clearStale(id)

          // Jump to the matching record when opening from a search hit.
          if (options?.lineIndex !== undefined) {
            const session = get().session
            const event = session?.events.find((item) => item.lineIndex === options.lineIndex)
            if (event) get().revealEvent(event)
          }
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to load session',
          })
        }
      },

      setSelection: (selection) => set({ selection }),

      selectTimelineEvent: (event) => {
        if (!event) return
        const syncSelection = useSettingsStore.getState().syncSelection
        set((prev) => {
          const conversationItem = syncSelection
            ? event.conversationItem
            : prev.selection?.conversationItem
          return {
            selection: { source: 'timeline', event, conversationItem }
          }
        })
      },

      selectConversationItem: (item) => {
        if (!item) return
        const syncSelection = useSettingsStore.getState().syncSelection
        set((prev) => {
          const event = syncSelection ? item.event : prev.selection?.event
          return {
            selection: { source: 'conversation', event, conversationItem: item },
          }
        })
      },

      revealEvent: (event) => {
        if (!event) return
        set({
          selection: {
            source: 'external',
            event,
            conversationItem: event.conversationItem,
          },
        })
      },

      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },

      toggleLibrary: () => set((prev) => ({ libraryOpen: !prev.libraryOpen })),

      clearSession: () => set({ session: null, selection: null, error: null }),
    }),
    {
      name: 'agent-explorer',
      partialize: (state) => ({ theme: state.theme, libraryOpen: state.libraryOpen }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme)
      },
    },
  ),
)
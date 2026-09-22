import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { EventCategory } from '../core/types'

export type TimelineCategoryFilter = 'all' | EventCategory

export interface ExplorerSettings {
  searchQuery: string
  timelineCategoryFilter: TimelineCategoryFilter
  /** Epoch-ms interval selected on the timing chart; filters the event list. */
  timeRange: [number, number] | null
  hideSystem: boolean
  hideThinking: boolean
  hideToolCalls: boolean
  syncSelection: boolean
  highlightSameRequest: boolean
}

interface SettingsState extends ExplorerSettings {
  setSearchQuery: (query: string) => void
  setTimelineCategoryFilter: (filter: TimelineCategoryFilter) => void
  setTimeRange: (range: [number, number] | null) => void
  setHideSystem: (hide: boolean) => void
  setHideThinking: (hide: boolean) => void
  setHideToolCalls: (hide: boolean) => void
  setSyncSelection: (sync: boolean) => void
  setHighlightSameRequest: (highlight: boolean) => void
  resetSessionFilters: () => void
}

const DEFAULT_SETTINGS: ExplorerSettings = {
  searchQuery: '',
  timelineCategoryFilter: 'all',
  timeRange: null,
  hideSystem: false,
  hideThinking: false,
  hideToolCalls: false,
  syncSelection: true,
  highlightSameRequest: true,
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setTimelineCategoryFilter: (timelineCategoryFilter) => set({ timelineCategoryFilter }),
      setTimeRange: (timeRange) => set({ timeRange }),
      setHideSystem: (hideSystem) => set({ hideSystem }),
      setHideThinking: (hideThinking) => set({ hideThinking }),
      setHideToolCalls: (hideToolCalls) => set({ hideToolCalls }),
      setSyncSelection: (syncSelection) => set({ syncSelection }),
      setHighlightSameRequest: (highlightSameRequest) => set({ highlightSameRequest }),
      resetSessionFilters: () =>
        set({
          searchQuery: '',
          timelineCategoryFilter: 'all',
          timeRange: null,
        }),
    }),
    {
      name: 'agent-explorer-settings',
      partialize: (state) => ({
        timelineCategoryFilter: state.timelineCategoryFilter,
        hideSystem: state.hideSystem,
        hideThinking: state.hideThinking,
        hideToolCalls: state.hideToolCalls,
        syncSelection: state.syncSelection,
        highlightSameRequest: state.highlightSameRequest,
      }),
    },
  ),
)
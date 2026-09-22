import type { ExplorerSettings } from '../store/settingsStore'
import type {
  ConversationListItem,
  EventCategory,
  ExplorerSession,
  TimelineEvent,
} from './types'

export interface SessionStats {
  toolCallCount: number
  toolResultCount: number
  thinkingCount: number
}

export function computeSessionStats(session: ExplorerSession): SessionStats {
  let toolCallCount = 0
  let toolResultCount = 0
  let thinkingCount = 0

  for (const item of session.conversationItems) {
    if (item.role === 'tool_call') toolCallCount++
    else if (item.role === 'tool_result') toolResultCount++
    else if (item.role === 'thinking') thinkingCount++
  }

  return { toolCallCount, toolResultCount, thinkingCount }
}

function matchesSearch(haystack: string, query: string): boolean {
  if (!query) return true
  return haystack.toLowerCase().includes(query.toLowerCase())
}

function timelineSearchText(event: TimelineEvent): string {
  return [
    String(event.lineIndex),
    event.kind,
    event.label,
    event.preview ?? '',
  ].join(' ')
}

function conversationSearchText(
  item: ConversationListItem,
): string {
  const event = item.event
  return [
    item.role,
    item.block?.text ?? '',
    item.block?.toolName ?? '',
    event?.preview ?? '',
    event?.turnIndex !== undefined ? String(event.turnIndex) : '',
  ].join(' ')
}

function isSystemTimelineEvent(event: TimelineEvent): boolean {
  return event.category === 'meta' || event.category === 'system'
}

function isSystemConversationItem(item: ConversationListItem): boolean {
  return item.role === 'system'
}

function isToolTimelineEvent(event: TimelineEvent): boolean {
  return event.category === 'tool' || event.label.startsWith('tool_use')
}

function isToolConversationItem(item: ConversationListItem): boolean {
  return item.role === 'tool_call' || item.role === 'tool_result'
}

export function filterTimelineEvents(
  events: TimelineEvent[],
  settings: Pick<
    ExplorerSettings,
    'searchQuery' | 'timelineCategoryFilter' | 'timeRange' | 'hideSystem' | 'hideToolCalls'
  >,
): TimelineEvent[] {
  const query = settings.searchQuery.trim()

  return events.filter((event) => {
    if (settings.hideSystem && isSystemTimelineEvent(event)) return false
    // An interval selection can only contain events that carry a timestamp.
    if (
      settings.timeRange &&
      (event.timestamp === undefined ||
        event.timestamp < settings.timeRange[0] ||
        event.timestamp > settings.timeRange[1])
    ) {
      return false
    }
    if (settings.hideToolCalls && isToolTimelineEvent(event)) return false
    if (
      settings.timelineCategoryFilter !== 'all' &&
      event.category !== settings.timelineCategoryFilter
    ) {
      return false
    }
    if (!matchesSearch(timelineSearchText(event), query)) return false
    return true
  })
}

export function filterConversationItems(
  items: ConversationListItem[],
  settings: Pick<
    ExplorerSettings,
    'searchQuery' | 'hideSystem' | 'hideThinking' | 'hideToolCalls'
  >,
): ConversationListItem[] {
  const query = settings.searchQuery.trim()

  return items.filter((item) => {
    if (settings.hideSystem && isSystemConversationItem(item)) return false
    if (settings.hideThinking && item.role === 'thinking') return false
    if (settings.hideToolCalls && isToolConversationItem(item)) return false
    if (!matchesSearch(conversationSearchText(item), query)) return false
    return true
  })
}

export const TIMELINE_CATEGORY_OPTIONS: Array<{
  value: EventCategory | 'all'
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'tool', label: 'Tool' },
  { value: 'meta', label: 'Meta' },
  { value: 'system', label: 'System' },
]
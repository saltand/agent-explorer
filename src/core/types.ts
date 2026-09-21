export type EventCategory =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'system'
  | 'meta'
  | 'unknown'

export type ConversationRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'

export interface SessionMeta {
  sessionId?: string
  model?: string
  cwd?: string
  version?: string
  eventCount: number
  turnCount: number
}

export interface ParseWarning {
  lineIndex: number
  message: string
}

export interface TokenUsage {
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use'
  text: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolCallId?: string
  status?: 'pending' | 'completed' | 'failed'
}

export interface TimelineEvent {
  id: string
  lineIndex: number
  timestamp?: number
  category: EventCategory
  kind: string
  label: string
  preview: string
  turnIndex?: number
  requestId?: string
  model?: string
  usage?: TokenUsage
  uuid?: string
  sessionId?: string
  cwd?: string
  timestampLabel?: string
  role?: string
  stopReason?: string
  conversationItem?: ConversationListItem
  raw: unknown
}

export interface ConversationListItem {
  id: string
  event: TimelineEvent
  role: ConversationRole
  block?: ContentBlock
}

export interface ExplorerSession {
  fileType: string
  fileName: string
  meta: SessionMeta
  events: TimelineEvent[]
  conversationItems: ConversationListItem[]
  parseWarnings: ParseWarning[]
}

export interface ParsedLine {
  lineIndex: number
  raw: string
  data: unknown
}

/**
 * Which view originated a selection. Panels skip auto-scrolling when they are
 * the source; `external` marks programmatic jumps (e.g. opening a search hit),
 * so every panel scrolls to reveal the target.
 */
export type SelectionSource = 'timeline' | 'conversation' | 'external'

export interface Selection {
  source: SelectionSource
  event?: TimelineEvent
  conversationItem?: ConversationListItem
}

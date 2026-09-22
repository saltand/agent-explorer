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

/** Missing counts stay undefined; zero means explicitly reported or safely derived. */
export interface TokenCounts {
  /** Ordinary input, excluding both cache reads and cache writes. */
  inputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  /** All input, including cache reads and writes. Never an extra billable category. */
  totalInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  /** Output excluding reasoning; only derived when inclusion is established. */
  contentOutputTokens?: number
}

export interface TokenUsage extends TokenCounts {
  /** Paths into the owning TimelineEvent.raw; derived counts list every operand. */
  sources: Partial<Record<keyof TokenCounts, string[]>>
  /** Invalid counts and inconsistent totals remain inspectable in raw JSON. */
  issues: string[]
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

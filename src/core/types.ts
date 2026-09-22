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

/**
 * What one recorded usage object covers. Only `request` records may be summed;
 * `cumulative` snapshots already include every earlier request in the session.
 */
export type UsageScope = 'request' | 'cumulative'

export interface TokenUsage extends TokenCounts {
  /** Paths into the owning TimelineEvent.raw; derived counts list every operand. */
  sources: Partial<Record<keyof TokenCounts, string[]>>
  /** Invalid counts and inconsistent totals remain inspectable in raw JSON. */
  issues: string[]
  /** Defaults to `request`; aggregation refuses to sum cumulative snapshots. */
  scope?: UsageScope
  /**
   * Records sharing a key describe one request, so aggregation counts only one
   * of them. Absent when the log gives no way to tell repeats apart.
   */
  requestKey?: string
  /**
   * Which record wins among repeats. `keep-last` suits logs that re-emit a
   * growing total while a response streams; `keep-first` suits logs that echo
   * a stale record after the request already finished. Defaults to `keep-last`.
   */
  duplicatePolicy?: 'keep-last' | 'keep-first'
  /**
   * Session-to-date total recorded alongside a per-request record, used to
   * check summed requests against the log's own running total.
   */
  sessionTotalTokens?: number
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

import type { SessionAdapter } from './types'
import { truncateBlockText, truncatePreview } from '../core/text'
import { normalizeTokenUsage } from '../core/tokenUsage'
import type {
  ContentBlock,
  ConversationListItem,
  ConversationRole,
  EventCategory,
  ExplorerSession,
  ParsedLine,
  TimelineEvent,
  TokenUsage,
} from '../core/types'

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  if (typeof value === 'number') return value
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Codex records cumulative and per-request counts in `token_count` events.
 * Its `input_tokens` already covers cache reads and writes, so it maps to
 * `totalInputTokens` and the shared normalizer derives ordinary input.
 */
const CODEX_USAGE_FIELDS = {
  totalInputTokens: 'input_tokens',
  cacheReadInputTokens: 'cached_input_tokens',
  cacheCreationInputTokens: 'cache_write_input_tokens',
  outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
} as const

function codexTotalTokens(record: Record<string, unknown>): number | undefined {
  const value = record.total_tokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Codex repeats a `token_count` event for every stream update, so the same
 * request appears many times and some repeats arrive zeroed out after the
 * request finished. The cumulative `total_token_usage` advances exactly once per
 * request, which both identifies the request and orders the repeats: the first
 * record at a given cumulative total is the real one.
 */
function parseCodexTokenUsage(payload: Record<string, unknown>): TokenUsage | undefined {
  const info = payload.info
  if (!isRecord(info)) return undefined
  const last = isRecord(info.last_token_usage) ? info.last_token_usage : undefined
  const total = isRecord(info.total_token_usage) ? info.total_token_usage : undefined
  const source = last ?? total
  if (!source) return undefined

  const usage = normalizeTokenUsage(source, {
    path: last ? 'payload.info.last_token_usage' : 'payload.info.total_token_usage',
    fields: CODEX_USAGE_FIELDS,
    outputIncludesReasoning: true,
  })
  if (!usage) return undefined

  // Without `last_token_usage` the only figure available is the running total,
  // which must not be added to per-request records.
  if (!last) return { ...usage, scope: 'cumulative' }

  const cumulative = total ? codexTotalTokens(total) : undefined
  if (cumulative === undefined) return usage
  return {
    ...usage,
    requestKey: `cumulative:${cumulative}`,
    duplicatePolicy: 'keep-first',
    sessionTotalTokens: cumulative,
  }
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!isRecord(part)) return ''
      if (
        (part.type === 'input_text' || part.type === 'output_text') &&
        typeof part.text === 'string'
      ) {
        return part.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractReasoningText(payload: Record<string, unknown>): string {
  const summary = Array.isArray(payload.summary)
    ? payload.summary
        .map((entry) => (isRecord(entry) ? getString(entry, 'text') ?? '' : ''))
        .filter(Boolean)
        .join('\n')
    : ''
  return summary || '(encrypted reasoning)'
}

function shortCallId(callId: string | undefined): string | undefined {
  if (!callId) return undefined
  return callId.length > 12 ? callId.slice(0, 12) : callId
}

function messageRoleToConversationRole(role: string | undefined): ConversationRole {
  if (role === 'developer') return 'system'
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'system'
}

function messageRoleToCategory(role: string | undefined): EventCategory {
  if (role === 'developer') return 'system'
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'unknown'
}

function parseToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson) return {}
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    return isRecord(parsed) ? parsed : { raw: argumentsJson }
  } catch {
    return { raw: argumentsJson }
  }
}

function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  return JSON.stringify(output, null, 2)
}

function isFailedToolOutput(payload: Record<string, unknown>): boolean {
  const output = getString(payload, 'output')
  if (!output) return false
  try {
    const parsed: unknown = JSON.parse(output)
    if (!isRecord(parsed)) return false
    const metadata = parsed.metadata
    if (isRecord(metadata) && typeof metadata.exit_code === 'number') {
      return metadata.exit_code !== 0
    }
  } catch {
    return false
  }
  return getString(payload, 'status') === 'failed'
}

const LEGACY_RESPONSE_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'local_shell_call',
  'custom_tool_call',
  'custom_tool_call_output',
  'web_search_call',
])

/**
 * Rollouts written before the envelope format stored response items at the top
 * level and the session header as a bare `{ id, timestamp, instructions }` line.
 * Wrapping them here lets one parser handle both layouts.
 */
function normalizeLegacyLine(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(record.payload)) return record

  const type = getString(record, 'type')
  if (type !== undefined && LEGACY_RESPONSE_ITEM_TYPES.has(type)) {
    return { type: 'response_item', timestamp: record.timestamp, payload: record }
  }
  if (type === undefined && getString(record, 'id') && 'instructions' in record) {
    return { type: 'session_meta', timestamp: record.timestamp, payload: record }
  }
  return undefined
}

function responseItemType(payload: Record<string, unknown>): string {
  return getString(payload, 'type') ?? 'response_item'
}

function extractResponseItemBlock(
  payload: Record<string, unknown>,
  itemType: string,
): ContentBlock | undefined {
  if (itemType === 'message') {
    const text = extractMessageText(payload.content)
    return text ? { type: 'text', text: truncateBlockText(text) } : undefined
  }
  if (itemType === 'reasoning') {
    return { type: 'thinking', text: truncateBlockText(extractReasoningText(payload)) }
  }
  if (itemType === 'function_call' || itemType === 'custom_tool_call') {
    const toolName = getString(payload, 'name') ?? 'tool'
    const callId = getString(payload, 'call_id')
    const argsSource =
      itemType === 'function_call'
        ? getString(payload, 'arguments')
        : getString(payload, 'input')
    const toolInput = parseToolArguments(argsSource)
    const inputText = truncateBlockText(
      argsSource ? toolOutputText(argsSource) : JSON.stringify(toolInput, null, 2),
    )
    return {
      type: 'tool_use',
      text: inputText,
      toolName,
      toolInput,
      toolCallId: callId,
      status: 'pending',
    }
  }
  if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
    const callId = getString(payload, 'call_id')
    const text = truncateBlockText(toolOutputText(payload.output))
    const failed = isFailedToolOutput(payload)
    return text
      ? {
          type: 'text',
          text,
          toolCallId: callId,
          status: failed ? 'failed' : 'completed',
        }
      : undefined
  }
  return undefined
}

function responseItemRole(itemType: string, role: string | undefined): ConversationRole {
  if (itemType === 'message') return messageRoleToConversationRole(role)
  if (itemType === 'reasoning') return 'thinking'
  if (itemType === 'function_call' || itemType === 'custom_tool_call') return 'tool_call'
  if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
    return 'tool_result'
  }
  return 'system'
}

function responseItemId(lineIndex: number, itemType: string, role: string | undefined): string {
  if (itemType === 'message') {
    return `conv-${lineIndex}-${messageRoleToConversationRole(role)}`
  }
  if (itemType === 'reasoning') return `conv-${lineIndex}-thinking`
  if (itemType === 'function_call' || itemType === 'custom_tool_call') {
    return `conv-${lineIndex}-tool-call`
  }
  if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
    return `conv-${lineIndex}-tool-result`
  }
  return `conv-${lineIndex}-response-item`
}

function timelineKind(envelopeType: string, payload: Record<string, unknown>): string {
  if (envelopeType === 'event_msg') return getString(payload, 'type') ?? 'event_msg'
  if (envelopeType === 'response_item') return responseItemType(payload)
  return envelopeType
}

function timelineCategory(
  envelopeType: string,
  payload: Record<string, unknown>,
): EventCategory {
  if (envelopeType === 'session_meta' || envelopeType === 'turn_context') return 'meta'
  if (envelopeType === 'event_msg') {
    const kind = getString(payload, 'type') ?? 'event_msg'
    if (kind === 'user_message') return 'user'
    if (kind === 'agent_message') return 'assistant'
    if (kind === 'task_started' || kind === 'task_complete' || kind === 'token_count') {
      return 'meta'
    }
    return 'unknown'
  }
  if (envelopeType === 'response_item') {
    const itemType = responseItemType(payload)
    if (itemType === 'message') return messageRoleToCategory(getString(payload, 'role'))
    if (itemType === 'reasoning') return 'thinking'
    if (
      itemType === 'function_call' ||
      itemType === 'custom_tool_call' ||
      itemType === 'function_call_output' ||
      itemType === 'custom_tool_call_output'
    ) {
      return 'tool'
    }
    return 'unknown'
  }
  return 'unknown'
}

function timelineLabel(envelopeType: string, payload: Record<string, unknown>): string {
  if (envelopeType === 'session_meta') return 'session_meta'
  if (envelopeType === 'turn_context') return 'turn_context'
  if (envelopeType === 'event_msg') return getString(payload, 'type') ?? 'event_msg'
  if (envelopeType === 'response_item') {
    const itemType = responseItemType(payload)
    if (itemType === 'message') return getString(payload, 'role') ?? 'message'
    if (itemType === 'reasoning') return 'reasoning'
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const toolName = getString(payload, 'name') ?? 'tool'
      return `tool_use ${toolName}`
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      return `tool_result ${shortCallId(getString(payload, 'call_id')) ?? 'unknown'}`
    }
    return itemType
  }
  return envelopeType
}

function timelinePreview(
  envelopeType: string,
  payload: Record<string, unknown>,
  sessionId?: string,
  cwd?: string,
): string {
  if (envelopeType === 'session_meta') {
    return truncatePreview(sessionId ?? cwd ?? '')
  }
  if (envelopeType === 'turn_context') {
    return truncatePreview(
      [getString(payload, 'model'), getString(payload, 'cwd')].filter(Boolean).join(' · '),
    )
  }
  if (envelopeType === 'event_msg') {
    const message = getString(payload, 'message')
    if (message) return truncatePreview(message)
    const turnId = getString(payload, 'turn_id')
    if (turnId) return truncatePreview(turnId)
    return ''
  }
  if (envelopeType === 'response_item') {
    const itemType = responseItemType(payload)
    if (itemType === 'message') {
      return truncatePreview(extractMessageText(payload.content))
    }
    if (itemType === 'reasoning') {
      return truncatePreview(extractReasoningText(payload))
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      return truncatePreview(
        getString(payload, 'arguments') ?? getString(payload, 'input') ?? '',
      )
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      return truncatePreview(toolOutputText(payload.output))
    }
  }
  return ''
}

export const codexRolloutAdapter: SessionAdapter = {
  detect(samples: ParsedLine[]): number {
    if (samples.length === 0) return 0
    let hits = 0
    let considered = 0
    for (const sample of samples) {
      if (!isRecord(sample.data)) continue
      // Legacy rollouts interleave `record_type` bookkeeping lines that carry no
      // conversation payload, so they must not dilute the confidence score.
      if ('record_type' in sample.data && getString(sample.data, 'type') === undefined) continue
      considered += 1
      const normalized = normalizeLegacyLine(sample.data)
      if (normalized === undefined) continue
      const type = getString(normalized, 'type')
      const payload = normalized.payload
      if (
        (type === 'session_meta' ||
          type === 'event_msg' ||
          type === 'response_item' ||
          type === 'turn_context') &&
        isRecord(payload)
      ) {
        hits++
      }
    }
    if (considered === 0) return 0
    return hits / considered
  },

  parse(lines: ParsedLine[], fileName: string): ExplorerSession {
    const events: TimelineEvent[] = []
    const conversationItems: ConversationListItem[] = []

    let sessionId: string | undefined
    let cwd: string | undefined
    let version: string | undefined
    let model: string | undefined
    let currentTurnId: string | undefined
    let defaultTurnIndex = 1
    const turnIdToIndex = new Map<string, number>()

    function registerTurn(turnId: string): number {
      const existing = turnIdToIndex.get(turnId)
      if (existing !== undefined) return existing
      const nextIndex = turnIdToIndex.size + 1
      turnIdToIndex.set(turnId, nextIndex)
      return nextIndex
    }

    function currentTurnIndex(): number {
      if (currentTurnId) return registerTurn(currentTurnId)
      return defaultTurnIndex
    }

    for (const line of lines) {
      if (!isRecord(line.data)) continue
      const envelope = normalizeLegacyLine(line.data)
      if (envelope === undefined) continue

      const envelopeType = getString(envelope, 'type') ?? 'unknown'
      const payload = envelope.payload
      if (!isRecord(payload)) continue

      const eventId = `line-${line.lineIndex}`

      if (envelopeType === 'session_meta') {
        sessionId ??= getString(payload, 'id')
        cwd ??= getString(payload, 'cwd')
        version ??= getString(payload, 'cli_version')
      }

      if (envelopeType === 'turn_context') {
        const turnId = getString(payload, 'turn_id')
        if (turnId) currentTurnId = turnId
        cwd ??= getString(payload, 'cwd')
        model = getString(payload, 'model') ?? model
      }

      if (envelopeType === 'event_msg') {
        const kind = getString(payload, 'type') ?? 'event_msg'
        if (kind === 'task_started') {
          const turnId = getString(payload, 'turn_id')
          if (turnId) currentTurnId = turnId
        }
      }

      const turnIndex = currentTurnIndex()
      const itemType = envelopeType === 'response_item' ? responseItemType(payload) : undefined
      const messageRole =
        envelopeType === 'response_item' && itemType === 'message'
          ? getString(payload, 'role')
          : undefined

      let event: TimelineEvent = {
        id: eventId,
        lineIndex: line.lineIndex,
        timestamp: parseTimestamp(envelope.timestamp),
        category: timelineCategory(envelopeType, payload),
        kind: timelineKind(envelopeType, payload),
        label: timelineLabel(envelopeType, payload),
        preview: timelinePreview(envelopeType, payload, sessionId, cwd),
        turnIndex,
        model: envelopeType === 'turn_context' ? getString(payload, 'model') : model,
        sessionId: envelopeType === 'session_meta' ? sessionId : undefined,
        cwd:
          envelopeType === 'session_meta' || envelopeType === 'turn_context'
            ? getString(payload, 'cwd') ?? cwd
            : undefined,
        timestampLabel: getString(envelope, 'timestamp'),
        role: messageRole,
        usage:
          envelopeType === 'event_msg' && getString(payload, 'type') === 'token_count'
            ? parseCodexTokenUsage(payload)
            : undefined,
        // Keep the file's original line so Raw JSON never shows the legacy wrapper.
        raw: line.data,
      }

      if (envelopeType === 'response_item' && itemType) {
        const block = extractResponseItemBlock(payload, itemType)
        const item: ConversationListItem = {
          id: responseItemId(line.lineIndex, itemType, messageRole),
          event,
          role: responseItemRole(itemType, messageRole),
          block,
        }
        conversationItems.push(item)
        event.conversationItem = item
      }

      events.push(event)
    }

    const turnCount =
      turnIdToIndex.size > 0 ? turnIdToIndex.size : conversationItems.length > 0 ? 1 : 0

    return {
      fileType: 'Codex',
      fileName,
      meta: {
        sessionId,
        model,
        cwd,
        version,
        eventCount: events.length,
        turnCount,
      },
      events,
      conversationItems,
      parseWarnings: [],
    }
  },
}
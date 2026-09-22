import type { SessionAdapter } from './types'
import { normalizeTokenUsage } from '../core/tokenUsage'
import {
  truncateBlockText,
  truncatePreview,
} from '../core/text'
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

function getBoolean(record: Record<string, unknown>, key: string, defaultValue?: boolean): boolean {
  const value = record[key]
  return typeof value === 'boolean' ? value : (defaultValue ?? false)
}

function isToolResultUser(record: Record<string, unknown>): boolean {
  if (record.type !== 'user' || !isRecord(record.message)) return false
  const content = record.message.content
  if (!Array.isArray(content) || content.length === 0) return false
  const first = content[0]
  return isRecord(first) && first.type === 'tool_result'
}

function extractUserText(record: Record<string, unknown>): string {
  if (!isRecord(record.message)) return ''
  const content = record.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!isRecord(part)) return ''
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      if (part.type === 'tool_result' && typeof part.content === 'string') {
        return part.content
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractContentBlocks(record: Record<string, unknown>): ContentBlock[] {
  if (!isRecord(record.message) || !Array.isArray(record.message.content)) {
    return []
  }

  const blocks: ContentBlock[] = []
  for (const part of record.message.content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: truncateBlockText(part.text) })
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      blocks.push({ type: 'thinking', text: truncateBlockText(part.thinking) })
    } else if (part.type === 'tool_use' && typeof part.name === 'string' && typeof part.id === 'string') {
      const input = isRecord(part.input) ? part.input : {}
      blocks.push({
        type: 'tool_use',
        text: truncateBlockText(JSON.stringify(input, null, 2)),
        toolName: part.name,
        toolInput: input,
        toolCallId: part.id,
        status: 'pending',
      })
    }
  }
  return blocks
}

function blockToRole(block: ContentBlock): ConversationRole {
  if (block.type === 'thinking') return 'thinking'
  if (block.type === 'tool_use') return 'tool_call'
  return 'assistant'
}

function blockLabel(block: ContentBlock): string {
  if (block.type === 'tool_use') return `tool_use ${block.toolName ?? 'unknown'}`
  if (block.type === 'thinking') return 'thinking'
  return 'text'
}

function blockPreview(block: ContentBlock): string {
  if (block.type === 'tool_use') {
    return truncatePreview(`${block.toolName}: ${block.text}`)
  }
  return truncatePreview(block.text)
}

function timelineCategory(
  type: string,
  record: Record<string, unknown>,
): EventCategory {
  if (type === 'user') {
    return isToolResultUser(record) ? 'tool' : 'user'
  }
  if (type === 'assistant') return 'assistant'
  if (type === 'file-history-snapshot') return 'meta'
  return 'unknown'
}

function timelineLabel(type: string, record: Record<string, unknown>): string {
  if (type === 'user') {
    if (isToolResultUser(record)) {
      const content = record.message as Record<string, unknown>
      const parts = content.content as unknown[]
      const first = parts?.[0] as Record<string, unknown> | undefined
      const toolId = first?.tool_use_id
      return typeof toolId === 'string' ? `tool_result ${toolId.slice(0, 12)}` : 'tool_result'
    }
    return 'user'
  }
  if (type === 'assistant') {
    const blocks = extractContentBlocks(record)
    if (blocks.length === 1) return blockLabel(blocks[0]!)
    if (blocks.length > 1) return `assistant (${blocks.length} blocks)`
    return 'assistant'
  }
  if (type === 'file-history-snapshot') return 'file-history-snapshot'
  return type
}

function timelinePreview(type: string, record: Record<string, unknown>): string {
  if (type === 'user') return truncatePreview(extractUserText(record))
  if (type === 'assistant') {
    const blocks = extractContentBlocks(record)
    if (blocks.length > 0) return blockPreview(blocks[0]!)
    return ''
  }
  return ''
}

export function parseClaudeTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.message)) return undefined

  const usage = raw.message.usage
  if (!isRecord(usage)) return undefined

  return normalizeTokenUsage(usage, {
    path: 'message.usage',
    fields: {
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      cacheCreationInputTokens: 'cache_creation_input_tokens',
      cacheReadInputTokens: 'cache_read_input_tokens',
    },
  })
}

export function parseClaudeModel(raw: unknown): string | undefined {
  if (!isRecord(raw) || !isRecord(raw.message)) return undefined
  const model = raw.message.model
  return typeof model === 'string' && model.length > 0 ? model : undefined
}

export function extractClaudeEventMeta(
  raw: unknown,
): Pick<
  TimelineEvent,
  'uuid' | 'sessionId' | 'cwd' | 'timestampLabel' | 'role' | 'stopReason'
> {
  const meta: Pick<
    TimelineEvent,
    'uuid' | 'sessionId' | 'cwd' | 'timestampLabel' | 'role' | 'stopReason'
  > = {}

  if (!isRecord(raw)) return meta

  if (typeof raw.uuid === 'string') meta.uuid = raw.uuid
  if (typeof raw.sessionId === 'string') meta.sessionId = raw.sessionId
  if (typeof raw.cwd === 'string') meta.cwd = raw.cwd
  if (typeof raw.timestamp === 'string') meta.timestampLabel = raw.timestamp

  const message = isRecord(raw.message) ? raw.message : undefined
  if (message) {
    if (typeof message.role === 'string') meta.role = message.role
    if (typeof message.stop_reason === 'string') meta.stopReason = message.stop_reason
  }

  return meta
}

const CLAUDE_META_TYPES = new Set([
  'attachment',
  'ai-title',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'system',
  'summary',
])

export const claudeTranscriptAdapter: SessionAdapter = {
  detect(samples: ParsedLine[]): number {
    if (samples.length === 0) return 0
    let hits = 0
    let considered = 0
    let metaLines = 0
    for (const sample of samples) {
      if (!isRecord(sample.data)) {
        considered++
        continue
      }
      const type = getString(sample.data, 'type')
      if (type && CLAUDE_META_TYPES.has(type)) {
        metaLines++
        continue
      }
      considered++
      const uuid = getString(sample.data, 'uuid')
      const hasMessage = isRecord(sample.data.message)
      if ((type === 'user' || type === 'assistant') && uuid && hasMessage) {
        hits++
      }
    }
    if (considered === 0) return metaLines > 0 ? 1 : 0
    return hits / considered
  },

  parse(lines: ParsedLine[], fileName: string): ExplorerSession {
    const events: TimelineEvent[] = []
    const conversationItems: ConversationListItem[] = []

    let turnIndex = 0
    let lastPromptId: string | undefined
    let sessionId: string | undefined
    let model: string | undefined
    let cwd: string | undefined
    let version: string | undefined

    for (const line of lines) {
      const record = line.data
      if (!isRecord(record)) continue

      const type = getString(record, 'type') ?? 'unknown'
      const eventId = `line-${line.lineIndex}`
      const promptId = getString(record, 'promptId') ?? eventId

      sessionId ??= getString(record, 'sessionId')
      cwd ??= getString(record, 'cwd')
      version ??= getString(record, 'version')

      if (type === 'user' && promptId != lastPromptId && !isToolResultUser(record)) {
        turnIndex++
      }

      let event: TimelineEvent = {
        id: eventId,
        lineIndex: line.lineIndex,
        timestamp: parseTimestamp(record.timestamp),
        category: timelineCategory(type, record),
        kind: type,
        label: timelineLabel(type, record),
        preview: timelinePreview(type, record),
        turnIndex,
        requestId: getString(record, 'requestId'),
        model: parseClaudeModel(record),
        usage: parseClaudeTokenUsage(record),
        ...extractClaudeEventMeta(record),
        raw: record,
      }

      if (type === 'user') {
        lastPromptId = promptId
        if (isToolResultUser(record)) {
          const content = record.message as Record<string, unknown>
          const parts = content.content as unknown[]
          const first = parts?.[0] as Record<string, unknown> | undefined
          const toolCallId =
            typeof first?.tool_use_id === 'string' ? first.tool_use_id : undefined
          const isError = first?.is_error === true
          const text = extractUserText(record)

          const itemId = `conv-${line.lineIndex}-tool-result`
          const item: ConversationListItem = {
            id: itemId,
            event,
            role: 'tool_result',
            block: text ? {
              type: 'text',
              text: truncateBlockText(text),
              toolCallId,
              status: isError ? 'failed' : 'completed',
            } : undefined,
          }
          conversationItems.push(item)
          event.conversationItem = item
        } else if (!getBoolean(record, 'isMeta')) {
          const text = extractUserText(record)
          const itemId = `conv-${line.lineIndex}-user`
          const item: ConversationListItem = {
            id: itemId,
            event,
            role: 'user',
            block: text ? { type: 'text', text: truncateBlockText(text) } : undefined,
          }
          conversationItems.push(item)
          event.conversationItem = item
        }
      } else if (type === 'assistant') {
        const blocks = extractContentBlocks(record)
        if (isRecord(record.message) && typeof record.message.model === 'string') {
          model = record.message.model
        }

        if (blocks.length === 0) {
          const itemId = `conv-${line.lineIndex}-assistant`
          const item: ConversationListItem = {
            id: itemId,
            event,
            role: 'assistant',
          };
          conversationItems.push(item)
          event.conversationItem = item;
        } else {
          blocks.forEach((block, blockIndex) => {
            const itemId = `conv-${line.lineIndex}-block-${blockIndex}`
            const role = blockToRole(block)
            const item: ConversationListItem = {
              id: itemId,
              event,
              role,
              block,
            }
            conversationItems.push(item)
            event.conversationItem = item
          })
        }
      }

      events.push(event)
    }

    return {
      fileType: 'Claude Code',
      fileName,
      meta: {
        sessionId,
        model,
        cwd,
        version,
        eventCount: events.length,
        turnCount: turnIndex,
      },
      events,
      conversationItems,
      parseWarnings: [],
    }
  },
}

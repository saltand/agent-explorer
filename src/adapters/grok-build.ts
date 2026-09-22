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
import type { SessionAdapter } from './types'

const GROK_TYPES = new Set(['system', 'user', 'assistant', 'reasoning', 'tool_result'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// updates.jsonl records unix seconds; guard against millisecond timestamps.
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function extractUserQuery(text: string): string | undefined {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text)
  const inner = match?.[1]?.trim()
  return inner || undefined
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Keep the raw string.
    }
    return { arguments: value }
  }
  return value === undefined ? {} : { value }
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!isRecord(part)) return ''
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      if (part.type === 'image') return '[Image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function userFacingText(content: unknown): string {
  const text = extractContentText(content)
  return extractUserQuery(text) ?? text
}

/**
 * Grok's `inputTokens` already includes cache reads and writes, so it maps to
 * `totalInputTokens` and the shared normalizer derives ordinary input.
 */
function parseGrokTokenUsage(record: Record<string, unknown>): TokenUsage | undefined {
  if (!isRecord(record.usage)) return undefined
  return normalizeTokenUsage(record.usage, {
    path: 'usage',
    fields: {
      totalInputTokens: 'inputTokens',
      cacheReadInputTokens: 'cachedReadTokens',
      cacheCreationInputTokens: 'cacheCreationTokens',
      outputTokens: 'outputTokens',
      reasoningOutputTokens: 'reasoningTokens',
    },
    outputIncludesReasoning: true,
  })
}

function isScaffoldingUser(content: unknown): boolean {
  const text = extractContentText(content)
  if (extractUserQuery(text)) return false
  return /^<(user_info|git_status|rules|system-reminder|user_instructions)\b/.test(text.trimStart())
}

function reasoningText(record: Record<string, unknown>): string {
  const summary = record.summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function assistantBlocks(record: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const text = extractContentText(record.content)
  if (text) blocks.push({ type: 'text', text: truncateBlockText(text) })

  const calls = record.tool_calls
  if (!Array.isArray(calls)) return blocks
  for (const call of calls) {
    if (!isRecord(call)) continue
    const name = getString(call, 'name') ?? 'tool'
    const input = toolInput(call.arguments)
    blocks.push({
      type: 'tool_use',
      text: truncateBlockText(formatJson(call.arguments ?? input)),
      toolName: name,
      toolInput: input,
      toolCallId: getString(call, 'id'),
      status: 'pending',
    })
  }
  return blocks
}

function blockRole(block: ContentBlock): ConversationRole {
  if (block.type === 'thinking') return 'thinking'
  if (block.type === 'tool_use') return 'tool_call'
  return 'assistant'
}

function blockLabel(block: ContentBlock): string {
  if (block.type === 'thinking') return 'thinking'
  if (block.type === 'tool_use') return `tool_use ${block.toolName ?? 'tool'}`
  return 'text'
}

function blockPreview(block: ContentBlock): string {
  if (block.type === 'tool_use') return truncatePreview(`${block.toolName ?? 'tool'}: ${block.text}`)
  return truncatePreview(block.text)
}

function eventCategory(type: string, record: Record<string, unknown>): EventCategory {
  if (type === 'user') {
    if (getString(record, 'synthetic_reason') || isScaffoldingUser(record.content)) return 'system'
    return 'user'
  }
  if (type === 'assistant') return 'assistant'
  if (type === 'reasoning') return 'thinking'
  if (type === 'tool_result') return 'tool'
  if (type === 'system') return 'system'
  if (type === 'turn_completed') return 'meta'
  return 'unknown'
}

function eventLabel(type: string, record: Record<string, unknown>, blocks: ContentBlock[]): string {
  if (type === 'user') {
    if (getString(record, 'synthetic_reason')) return 'system_reminder'
    if (isScaffoldingUser(record.content)) return 'context'
    return 'user'
  }
  if (type === 'assistant') {
    if (blocks.length === 1) return blockLabel(blocks[0]!)
    if (blocks.length > 1) return `assistant (${blocks.length} blocks)`
    return 'assistant'
  }
  if (type === 'tool_result') return 'tool_result'
  return type
}

function eventPreview(type: string, record: Record<string, unknown>, blocks: ContentBlock[]): string {
  if (type === 'user') return truncatePreview(userFacingText(record.content))
  if (type === 'assistant') return blocks[0] ? blockPreview(blocks[0]) : ''
  if (type === 'reasoning') return truncatePreview(reasoningText(record))
  if (type === 'tool_result') return truncatePreview(extractContentText(record.content))
  if (type === 'system') return truncatePreview(extractContentText(record.content))
  if (type === 'turn_completed') {
    const usage = isRecord(record.usage) ? record.usage : undefined
    const total = usage && typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined
    const stop = getString(record, 'stop_reason')
    const parts = [total === undefined ? undefined : `${total.toLocaleString()} tokens`, stop]
    return truncatePreview(parts.filter(Boolean).join(' · '))
  }
  return ''
}

export const grokBuildAdapter: SessionAdapter = {
  detect(samples: ParsedLine[]): number {
    if (samples.length === 0) return 0
    let hits = 0
    for (const sample of samples) {
      if (!isRecord(sample.data)) continue
      // Claude / Pi / Cursor nest the payload under `message`.
      if (isRecord(sample.data.message)) continue
      const type = getString(sample.data, 'type')
      // Turn usage records are spliced in from the sibling updates.jsonl.
      if (type === 'turn_completed' && isRecord(sample.data.usage)) {
        hits += 1
        continue
      }
      if (!type || !GROK_TYPES.has(type)) continue
      if (type === 'reasoning' || type === 'tool_result' || Array.isArray(sample.data.tool_calls)) {
        hits += 1
        continue
      }
      if ('content' in sample.data) hits += 1
    }
    return hits / samples.length
  },

  parse(lines: ParsedLine[], fileName: string): ExplorerSession {
    const events: TimelineEvent[] = []
    const conversationItems: ConversationListItem[] = []
    let model: string | undefined
    let turnIndex = 0

    for (const line of lines) {
      const record = line.data
      if (!isRecord(record)) continue
      const type = getString(record, 'type') ?? 'unknown'
      const blocks = type === 'assistant' ? assistantBlocks(record) : []
      const isSyntheticUser = type === 'user' && Boolean(getString(record, 'synthetic_reason'))
      const isScaffolding = type === 'user' && isScaffoldingUser(record.content)

      if (type === 'assistant') model = getString(record, 'model_id') ?? model
      if (type === 'user' && !isSyntheticUser && !isScaffolding) turnIndex += 1

      const event: TimelineEvent = {
        id: `line-${line.lineIndex}`,
        lineIndex: line.lineIndex,
        timestamp: parseTimestamp(record.timestamp),
        category: eventCategory(type, record),
        kind: type,
        label: eventLabel(type, record, blocks),
        preview: eventPreview(type, record, blocks),
        turnIndex,
        model: getString(record, 'model_id') ?? model,
        uuid: getString(record, 'id') ?? getString(record, 'tool_call_id'),
        role: type === 'tool_result' ? 'tool' : type,
        usage: type === 'turn_completed' ? parseGrokTokenUsage(record) : undefined,
        raw: record,
      }

      const items: ConversationListItem[] = []
      if (type === 'user' && !isSyntheticUser && !isScaffolding) {
        const text = userFacingText(record.content)
        items.push({
          id: `conv-${line.lineIndex}-user`,
          event,
          role: 'user',
          block: text ? { type: 'text', text: truncateBlockText(text) } : undefined,
        })
      } else if (type === 'assistant') {
        if (blocks.length === 0) {
          items.push({ id: `conv-${line.lineIndex}-assistant`, event, role: 'assistant' })
        } else {
          blocks.forEach((block, index) => {
            items.push({
              id: `conv-${line.lineIndex}-block-${index}`,
              event,
              role: blockRole(block),
              block,
            })
          })
        }
      } else if (type === 'reasoning') {
        const text = reasoningText(record)
        if (text) {
          items.push({
            id: `conv-${line.lineIndex}-thinking`,
            event,
            role: 'thinking',
            block: { type: 'thinking', text: truncateBlockText(text) },
          })
        }
      } else if (type === 'tool_result') {
        const text = extractContentText(record.content)
        items.push({
          id: `conv-${line.lineIndex}-tool-result`,
          event,
          role: 'tool_result',
          block: {
            type: 'text',
            text: truncateBlockText(text),
            toolCallId: getString(record, 'tool_call_id'),
            status: 'completed',
          },
        })
      }

      for (const item of items) conversationItems.push(item)
      if (items.length > 0) event.conversationItem = items.at(-1)
      events.push(event)
    }

    return {
      fileType: 'Grok Build',
      fileName,
      meta: {
        model,
        eventCount: events.length,
        turnCount: turnIndex,
      },
      events,
      conversationItems,
      parseWarnings: [],
    }
  },
}

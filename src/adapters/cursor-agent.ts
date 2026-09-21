import { truncateBlockText, truncatePreview } from '../core/text'
import type {
  ContentBlock,
  ConversationListItem,
  ConversationRole,
  EventCategory,
  ExplorerSession,
  ParsedLine,
  TimelineEvent,
} from '../core/types'
import type { SessionAdapter } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  return isRecord(value) ? value : value === undefined ? {} : { value }
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

function isScaffoldingUser(content: unknown): boolean {
  const text = extractContentText(content)
  if (extractUserQuery(text)) return false
  return /^<(user_info|git_status|rules|system-reminder|user_instructions|timestamp)\b/.test(
    text.trimStart(),
  )
}

function extractAssistantBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: truncateBlockText(content) }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: ContentBlock[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text) blocks.push({ type: 'text', text: truncateBlockText(part.text) })
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      if (part.thinking) blocks.push({ type: 'thinking', text: truncateBlockText(part.thinking) })
    } else if (part.type === 'reasoning') {
      const text =
        (typeof part.text === 'string' && part.text) ||
        (typeof part.thinking === 'string' && part.thinking) ||
        ''
      if (text) blocks.push({ type: 'thinking', text: truncateBlockText(text) })
    } else if (part.type === 'tool_use') {
      const name = getString(part, 'name') ?? 'tool'
      const input = toolInput(part.input)
      blocks.push({
        type: 'tool_use',
        text: truncateBlockText(formatJson(part.input ?? input)),
        toolName: name,
        toolInput: input,
        toolCallId: getString(part, 'id'),
        status: 'pending',
      })
    }
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

function eventCategory(record: Record<string, unknown>, content: unknown): EventCategory {
  const type = getString(record, 'type')
  if (type === 'turn_ended') return 'meta'
  const role = getString(record, 'role')
  if (role === 'user') return isScaffoldingUser(content) ? 'system' : 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool' || role === 'tool_result') return 'tool'
  if (role === 'system') return 'system'
  return 'unknown'
}

export const cursorAgentAdapter: SessionAdapter = {
  detect(samples: ParsedLine[]): number {
    if (samples.length === 0) return 0
    let hits = 0
    for (const sample of samples) {
      if (!isRecord(sample.data)) continue
      // Claude transcripts also nest `message`, but they carry a `uuid`.
      if (getString(sample.data, 'uuid')) continue
      const role = getString(sample.data, 'role')
      if (role === 'user' || role === 'assistant') {
        if (isRecord(sample.data.message) || 'content' in sample.data) {
          hits += 1
          continue
        }
      }
      if (getString(sample.data, 'type') === 'turn_ended') hits += 1
    }
    return hits / samples.length
  },

  parse(lines: ParsedLine[], fileName: string): ExplorerSession {
    const events: TimelineEvent[] = []
    const conversationItems: ConversationListItem[] = []
    let turnIndex = 0

    for (const line of lines) {
      const record = line.data
      if (!isRecord(record)) continue

      const type = getString(record, 'type')
      const role = getString(record, 'role')
      const message = isRecord(record.message) ? record.message : undefined
      const content = message?.content ?? record.content
      const blocks = role === 'assistant' ? extractAssistantBlocks(content) : []
      const scaffolding = role === 'user' && isScaffoldingUser(content)

      if (role === 'user' && !scaffolding) turnIndex += 1

      const kind = type ?? role ?? 'unknown'
      const event: TimelineEvent = {
        id: `line-${line.lineIndex}`,
        lineIndex: line.lineIndex,
        category: eventCategory(record, content),
        kind,
        label:
          role === 'assistant' && blocks.length === 1
            ? blockLabel(blocks[0]!)
            : role === 'assistant' && blocks.length > 1
              ? `assistant (${blocks.length} blocks)`
              : kind,
        preview:
          role === 'user'
            ? truncatePreview(userFacingText(content))
            : role === 'assistant' && blocks[0]
              ? blockPreview(blocks[0])
              : type === 'turn_ended'
                ? getString(record, 'status') ?? ''
                : '',
        turnIndex,
        role,
        raw: record,
      }

      const items: ConversationListItem[] = []
      if (role === 'user' && !scaffolding) {
        const text = userFacingText(content)
        items.push({
          id: `conv-${line.lineIndex}-user`,
          event,
          role: 'user',
          block: text ? { type: 'text', text: truncateBlockText(text) } : undefined,
        })
      } else if (role === 'assistant') {
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
      } else if (role === 'tool' || role === 'tool_result') {
        const text = extractContentText(content)
        items.push({
          id: `conv-${line.lineIndex}-tool-result`,
          event,
          role: 'tool_result',
          block: {
            type: 'text',
            text: truncateBlockText(text),
            status: 'completed',
          },
        })
      }

      for (const item of items) conversationItems.push(item)
      if (items.length > 0) event.conversationItem = items.at(-1)
      events.push(event)
    }

    return {
      fileType: 'Cursor Agent',
      fileName,
      meta: {
        eventCount: events.length,
        turnCount: turnIndex,
      },
      events,
      conversationItems,
      parseWarnings: [],
    }
  },
}

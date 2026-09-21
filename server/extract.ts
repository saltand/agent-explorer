/**
 * Extracts searchable conversation text from a raw JSONL record.
 *
 * This deliberately ignores tool output, injected context blocks, and system
 * scaffolding. Indexing every string in every record produced a database an
 * order of magnitude larger and far slower to build, without improving results.
 */

export interface ExtractedMessage {
  role: string
  text: string
}

/**
 * Roles that carry no searchable prose. `toolResult` and `bashExecution` are
 * Pi's names for tool output, which is the bulk of a session by volume and the
 * main reason a naive index balloons in size.
 */
const SKIPPED_ROLES = new Set([
  'system',
  'developer',
  'tool',
  'toolResult',
  'bashExecution',
  'custom',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Injected context masquerades as user input; it is noise for search. */
function isInjectedContext(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('<')) return false
  return /^<(environment_context|user_instructions|user_info|app-context|recommended_plugins|system-reminder|ide_context|plugins|git_status|rules)\b/.test(
    trimmed,
  )
}

/**
 * Cursor Agent and Grok Build wrap the real prompt in `<user_query>`. Prefer
 * that inner text for titles and search so the envelope is not indexed.
 */
export function extractUserQuery(text: string): string | undefined {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text)
  const inner = match?.[1]?.trim()
  return inner || undefined
}

function collectText(content: unknown, out: string[]): void {
  if (typeof content === 'string') {
    out.push(content)
    return
  }
  if (!Array.isArray(content)) return

  for (const part of content) {
    if (!isRecord(part)) continue
    const type = typeof part.type === 'string' ? part.type : undefined

    // Tool results and images carry no useful prose.
    if (type === 'tool_result' || type === 'tool_use' || type === 'image') continue

    if (typeof part.text === 'string') {
      out.push(part.text)
    } else if (typeof part.thinking === 'string') {
      out.push(part.thinking)
    } else if (type === 'summary_text' && typeof part.summary === 'string') {
      out.push(part.summary)
    }
  }
}

/**
 * Returns the indexable messages in a record, or an empty array when the record
 * holds no conversation prose.
 */
export function extractMessages(record: unknown): ExtractedMessage[] {
  if (!isRecord(record)) return []
  // Grok injects skill reminders as synthetic user turns.
  if (typeof record.synthetic_reason === 'string') return []

  const type = typeof record.type === 'string' ? record.type : undefined

  // Codex envelope: unwrap the payload and recurse.
  if (isRecord(record.payload)) {
    const payloadType = typeof record.payload.type === 'string' ? record.payload.type : undefined
    if (type === 'event_msg' || payloadType === 'function_call_output') return []
    return extractMessages(record.payload)
  }

  if (type === 'function_call' || type === 'function_call_output' || type === 'tool_result') {
    return []
  }

  // Codex / Grok reasoning items.
  if (type === 'reasoning') {
    const texts: string[] = []
    collectText(record.summary, texts)
    collectText(record.content, texts)
    return buildMessages('thinking', texts)
  }

  // Pi / Claude / Cursor nest the payload under `message`.
  const message = isRecord(record.message) ? record.message : undefined
  const role =
    (typeof record.role === 'string' ? record.role : undefined) ??
    (message && typeof message.role === 'string' ? message.role : undefined) ??
    (type === 'user' || type === 'assistant' ? type : undefined)

  if (!role || SKIPPED_ROLES.has(role)) return []

  const texts: string[] = []
  collectText(message?.content ?? record.content ?? record.text, texts)
  return buildMessages(role, texts)
}

function buildMessages(role: string, texts: string[]): ExtractedMessage[] {
  const messages: ExtractedMessage[] = []
  for (const text of texts) {
    const trimmed = text.trim()
    if (!trimmed) continue
    const query = extractUserQuery(trimmed)
    if (query) {
      messages.push({ role, text: query })
      continue
    }
    if (isInjectedContext(trimmed)) continue
    messages.push({ role, text: trimmed })
  }
  return messages
}

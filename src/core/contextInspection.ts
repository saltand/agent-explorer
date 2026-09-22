import type { ExplorerSession, TimelineEvent, TokenUsage } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter((text) => text.length > 0)
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

export interface SystemPromptRecord {
  event: TimelineEvent
  text: string
  /** Where the prompt came from when the log records it. */
  provenance?: string
}

export interface ContextFieldChange {
  field: string
  before?: string
  after?: string
}

export interface ContextSnapshot {
  event: TimelineEvent
  status: 'initial' | 'unchanged' | 'changed'
  changes: ContextFieldChange[]
}

export interface CompactionEntry {
  event: TimelineEvent
  summary?: string
  /** Tokens the context held before compaction, when recorded. */
  tokensBefore?: number
  /** Usage of the compaction call itself, when recorded. */
  usage?: TokenUsage
  /** Number of history records the compaction replaced, when recorded. */
  replacedRecords?: number
  readFiles: string[]
  modifiedFiles: string[]
}

export interface ContextInspection {
  systemPrompts: SystemPromptRecord[]
  /** Per-turn context snapshots with the fields that changed since the last one. */
  snapshots: ContextSnapshot[]
  compactions: CompactionEntry[]
}

/** turn_context fields worth diffing, as JSON paths into the payload. */
const TURN_CONTEXT_FIELDS: Array<[string, (p: Record<string, unknown>) => unknown]> = [
  ['model', (p) => p.model],
  ['effort', (p) => p.effort],
  ['personality', (p) => p.personality],
  ['cwd', (p) => p.cwd],
  ['workspace_roots', (p) => p.workspace_roots],
  ['approval_policy', (p) => p.approval_policy],
  ['sandbox_policy', (p) => p.sandbox_policy],
  ['realtime_active', (p) => p.realtime_active],
  [
    'developer_instructions',
    (p) =>
      isRecord(p.collaboration_mode) && isRecord(p.collaboration_mode.settings)
        ? p.collaboration_mode.settings.developer_instructions
        : undefined,
  ],
]

function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function payloadOf(event: TimelineEvent): Record<string, unknown> | undefined {
  return isRecord(event.raw) && isRecord(event.raw.payload) ? event.raw.payload : undefined
}

function systemPrompts(session: ExplorerSession): SystemPromptRecord[] {
  const prompts: SystemPromptRecord[] = []
  for (const event of session.events) {
    if (event.kind === 'session_meta') {
      const payload = payloadOf(event) ?? (isRecord(event.raw) ? event.raw : undefined)
      const base = isRecord(payload?.base_instructions) ? payload.base_instructions : undefined
      const text =
        typeof base?.text === 'string'
          ? base.text
          : typeof payload?.instructions === 'string'
            ? payload.instructions
            : undefined
      if (text === undefined) continue
      const provenance = isRecord(base?.provenance)
        ? [base.provenance.type, base.provenance.model].filter(Boolean).join(' · ')
        : undefined
      prompts.push({ event, text, provenance })
    } else if (event.kind === 'system' && isRecord(event.raw)) {
      const text = textFromContent(event.raw.content)
      if (text !== undefined) prompts.push({ event, text })
    }
  }
  return prompts
}

function snapshots(session: ExplorerSession): ContextSnapshot[] {
  const out: ContextSnapshot[] = []
  let previous: Map<string, string> | undefined
  for (const event of session.events) {
    if (event.kind !== 'turn_context') continue
    const payload = payloadOf(event)
    if (!payload) continue
    const fields = new Map<string, string>()
    for (const [field, read] of TURN_CONTEXT_FIELDS) {
      const value = serialize(read(payload))
      if (value !== undefined) fields.set(field, value)
    }
    if (previous === undefined) {
      out.push({ event, status: 'initial', changes: [] })
    } else {
      const changes: ContextFieldChange[] = []
      for (const [field, after] of fields) {
        const before = previous.get(field)
        if (before !== after) changes.push({ field, before, after })
      }
      for (const field of previous.keys()) {
        if (!fields.has(field)) changes.push({ field, before: previous.get(field) })
      }
      out.push({ event, status: changes.length > 0 ? 'changed' : 'unchanged', changes })
    }
    previous = fields
  }
  return out
}

function compactions(session: ExplorerSession): CompactionEntry[] {
  const out: CompactionEntry[] = []
  for (const event of session.events) {
    const raw = isRecord(event.raw) ? event.raw : undefined
    const payload = payloadOf(event)
    const details = isRecord(raw?.details) ? raw.details : undefined
    const readList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

    if (event.kind === 'compaction' || event.kind === 'branch_summary') {
      out.push({
        event,
        summary: typeof raw?.summary === 'string' ? raw.summary : undefined,
        tokensBefore: num(raw?.tokensBefore),
        usage: event.usage,
        readFiles: readList(details?.readFiles),
        modifiedFiles: readList(details?.modifiedFiles),
      })
    } else if (event.kind === 'compacted') {
      const replacement = Array.isArray(payload?.replacement_history)
        ? payload.replacement_history.length
        : undefined
      const message = typeof payload?.message === 'string' ? payload.message : undefined
      out.push({
        event,
        summary: message && message.length > 0 ? message : undefined,
        replacedRecords: replacement,
        readFiles: [],
        modifiedFiles: [],
      })
    } else if (event.kind === 'summary' && raw) {
      const text =
        typeof raw.summary === 'string' ? raw.summary : textFromContent(raw.content)
      if (text !== undefined) {
        out.push({ event, summary: text, readFiles: [], modifiedFiles: [] })
      }
    }
  }
  return out
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Session-level view of recorded context: system prompts, per-turn context
 * changes, and compression events. Every entry links back to its source record.
 */
export function inspectContext(session: ExplorerSession): ContextInspection {
  return {
    systemPrompts: systemPrompts(session),
    snapshots: snapshots(session),
    compactions: compactions(session),
  }
}

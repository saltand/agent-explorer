import type { ConversationListItem, Selection } from './types'

export interface ToolCallPair {
  callId: string
  call?: ConversationListItem
  result?: ConversationListItem
}

export interface ToolCallLink {
  item: ConversationListItem
  relation: string
}

export interface ToolCallInspection {
  callId?: string
  toolName?: string
  /**
   * `pending` means the call was recorded but no result record exists;
   * `running` means the result reports work still in progress (live session).
   */
  status: 'pending' | 'running' | 'completed' | 'failed'
  /** Live exec session id the result announces, when still running. */
  sessionId?: number
  call?: ConversationListItem
  result?: ConversationListItem
  /** Time between the recorded call and result events. */
  eventSpanMs?: number
  /** Duration the tool itself reported inside its result record. */
  reportedDurationMs?: number
  /** Recorded process exit code, shown whether or not it failed. */
  exitCode?: number
  errors: Array<{ label: string; value: string }>
  /** An explicitly recorded call this one belongs to (subagent or session). */
  parent?: ToolCallLink
  /** Calls explicitly recorded as belonging to this one. */
  children: ToolCallLink[]
}

/** Resolves the tool item a selection refers to, honoring which panel made it. */
export function selectedToolItem(selection: Selection): ConversationListItem | undefined {
  const item =
    selection.source === 'timeline'
      ? selection.event?.conversationItem
      : (selection.conversationItem ?? selection.event?.conversationItem)
  return item && (item.role === 'tool_call' || item.role === 'tool_result') ? item : undefined
}

/** Pairs `tool_call` items with `tool_result` items sharing the same call id. */
export function buildToolCallIndex(items: ConversationListItem[]): Map<string, ToolCallPair> {
  const index = new Map<string, ToolCallPair>()
  for (const item of items) {
    const callId = item.block?.toolCallId
    if (!callId) continue
    const pair = index.get(callId) ?? { callId }
    if (item.role === 'tool_call' && !pair.call) pair.call = item
    if (item.role === 'tool_result' && !pair.result) pair.result = item
    index.set(callId, pair)
  }
  return index
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Every string the result payload carries, including texts nested in arrays. */
function outputTexts(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  const payload = isRecord(raw.payload) ? raw.payload : raw
  const output = payload.output ?? (isRecord(payload.message) ? payload.message.content : undefined)
  const texts: string[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || value === undefined || value === null) return
    if (typeof value === 'string') {
      texts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    if (isRecord(value)) {
      if (typeof value.text === 'string') texts.push(value.text)
      else for (const entry of Object.values(value)) visit(entry, depth + 1)
    }
  }
  visit(output, 0)
  return texts
}

function outputRecords(raw: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const text of outputTexts(raw)) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) records.push(parsed)
    } catch {
      // Plain-text output is common; only JSON output can carry fields.
    }
  }
  return records
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const nested = record.metadata
    if (isRecord(nested)) {
      const inner = nested[key]
      if (typeof inner === 'number' && Number.isFinite(inner)) return inner
    }
  }
  return undefined
}

/** Duration a tool result reports itself, e.g. Codex "Wall time" / wall_time_seconds. */
export function reportedDurationMs(resultRaw: unknown): number | undefined {
  for (const record of outputRecords(resultRaw)) {
    const seconds = numberField(record, ['wall_time_seconds'])
    if (seconds !== undefined) return seconds * 1000
    const ms = numberField(record, ['wall_time_ms', 'duration_ms', 'elapsed_ms'])
    if (ms !== undefined) return ms
  }
  for (const text of outputTexts(resultRaw)) {
    const match = /Wall time:\s*([\d.]+)\s*seconds/i.exec(text)
    if (match) return Number.parseFloat(match[1]!) * 1000
  }
  return undefined
}

/** Exit code a result record carries, from fields or the exec output text. */
export function toolExitCode(resultRaw: unknown): number | undefined {
  if (!isRecord(resultRaw)) return undefined
  const message = isRecord(resultRaw.message) ? resultRaw.message : undefined
  const direct = message ? numberField(message, ['exitCode', 'exit_code']) : undefined
  if (direct !== undefined) return direct
  const recorded = outputRecords(resultRaw)
    .map((record) => numberField(record, ['exit_code', 'exitCode']))
    .find((code) => code !== undefined)
  if (recorded !== undefined) return recorded
  for (const text of outputTexts(resultRaw)) {
    const match = /exited with code (-?\d+)/i.exec(text)
    if (match) return Number.parseInt(match[1]!, 10)
  }
  return undefined
}

/** Structured failure evidence a result record carries explicitly. */
export function toolErrorDetails(resultRaw: unknown): Array<{ label: string; value: string }> {
  const details: Array<{ label: string; value: string }> = []
  if (!isRecord(resultRaw)) return details

  const message = isRecord(resultRaw.message) ? resultRaw.message : undefined
  const flagged =
    message?.isError === true ||
    (Array.isArray(message?.content) &&
      message.content.some((part) => isRecord(part) && part.is_error === true))
  if (flagged) details.push({ label: 'Error flag', value: 'Result is marked as an error' })
  if (message?.cancelled === true) details.push({ label: 'Cancelled', value: 'true' })
  return details
}

/** Codex exec results announce a still-running process as "session ID N". */
export function execSessionId(resultRaw: unknown): number | undefined {
  for (const text of outputTexts(resultRaw)) {
    const match = /session ID\s+(\d+)/i.exec(text)
    if (match) return Number.parseInt(match[1]!, 10)
  }
  for (const record of outputRecords(resultRaw)) {
    const id = numberField(record, ['session_id', 'sessionId'])
    if (id !== undefined) return id
  }
  return undefined
}

/** Codex `spawn_agent` results return the spawned agent's path as task_name. */
function spawnedAgentPath(resultRaw: unknown): string | undefined {
  for (const record of outputRecords(resultRaw)) {
    const path = record.task_name ?? record.agent_path ?? record.path
    if (typeof path === 'string' && path.startsWith('/')) return path
  }
  return undefined
}

function callTarget(call: ConversationListItem): string | undefined {
  const target = call.block?.toolInput?.target
  return typeof target === 'string' && target.startsWith('/') ? target : undefined
}

function callSessionId(call: ConversationListItem): number | undefined {
  const id = call.block?.toolInput?.session_id
  return typeof id === 'number' && Number.isFinite(id) ? id : undefined
}

function parentPath(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index > 0 ? trimmed.slice(0, index) : undefined
}

function pairOf(
  item: ConversationListItem,
  index: Map<string, ToolCallPair>,
): ToolCallPair | undefined {
  const callId = item.block?.toolCallId
  return callId ? index.get(callId) : undefined
}

/**
 * Resolves the call/result pair around a selected tool item and reports what
 * the records establish: status, error fields, timing, and calls linked by an
 * explicit id (a spawned agent's path or an exec session id). Unlinked calls
 * are never grouped by proximity.
 */
export function inspectToolCall(
  items: ConversationListItem[],
  item: ConversationListItem,
): ToolCallInspection | undefined {
  if (item.role !== 'tool_call' && item.role !== 'tool_result') return undefined
  const index = buildToolCallIndex(items)
  const pair = pairOf(item, index)
  const call = item.role === 'tool_call' ? item : pair?.call
  const result = item.role === 'tool_result' ? item : pair?.result
  if (!call && !result) return undefined

  const exitCode = result ? toolExitCode(result.event.raw) : undefined
  // A session id only marks work as running when the result has no exit code.
  const liveSession =
    result && exitCode === undefined ? execSessionId(result.event.raw) : undefined
  const status = !result
    ? 'pending'
    : result.block?.status === 'failed'
      ? 'failed'
      : liveSession !== undefined
        ? 'running'
        : 'completed'

  const callTs = call?.event.timestamp
  const resultTs = result?.event.timestamp
  const eventSpanMs =
    callTs !== undefined && resultTs !== undefined && resultTs >= callTs
      ? resultTs - callTs
      : undefined

  const children: ToolCallLink[] = []
  let parent: ToolCallLink | undefined
  const spawnPath = result ? spawnedAgentPath(result.event.raw) : undefined
  const sessionId = result ? execSessionId(result.event.raw) : undefined

  for (const other of items) {
    if (other.role !== 'tool_call' || other === call) continue
    const target = callTarget(other)
    const otherSession = callSessionId(other)
    if (spawnPath && target && (target === spawnPath || target.startsWith(`${spawnPath}/`))) {
      children.push({ item: other, relation: `targets ${target}` })
      continue
    }
    if (sessionId !== undefined && otherSession === sessionId) {
      children.push({ item: other, relation: `writes to session ${sessionId}` })
      continue
    }
    // An agent spawned under this one is a nested call of this spawn.
    const otherPair = pairOf(other, index)
    const childPath = otherPair?.result
      ? spawnedAgentPath(otherPair.result.event.raw)
      : undefined
    if (spawnPath && childPath && parentPath(childPath) === spawnPath) {
      children.push({ item: other, relation: `spawned ${childPath}` })
    }
  }

  if (call) {
    const target = callTarget(call)
    const ownSession = callSessionId(call)
    // A nested spawn's own result path points at its parent agent.
    const ownPath = result ? spawnedAgentPath(result.event.raw) : undefined
    let bestParentPath: string | undefined
    for (const candidate of items) {
      if (candidate.role !== 'tool_call' || candidate === call) continue
      const candidateResult = pairOf(candidate, index)?.result
      if (!candidateResult) continue
      const candidatePath = spawnedAgentPath(candidateResult.event.raw)
      const candidateSession = execSessionId(candidateResult.event.raw)
      const ownsTarget =
        target !== undefined &&
        target !== '/root' &&
        candidatePath !== undefined &&
        (target === candidatePath || target.startsWith(`${candidatePath}/`))
      const spawnedUnder =
        ownPath !== undefined &&
        candidatePath !== undefined &&
        ownPath.startsWith(`${candidatePath}/`)
      if (
        (ownsTarget || spawnedUnder) &&
        (bestParentPath === undefined || candidatePath.length > bestParentPath.length)
      ) {
        // The nearest ancestor spawn owns the call: longest matching path wins.
        bestParentPath = candidatePath
        parent = { item: candidate, relation: `spawned ${candidatePath}` }
      }
      if (
        parent === undefined &&
        ownSession !== undefined &&
        candidateSession === ownSession
      ) {
        parent = { item: candidate, relation: `opened session ${ownSession}` }
      }
    }
  }

  return {
    callId: call?.block?.toolCallId ?? result?.block?.toolCallId,
    toolName: call?.block?.toolName ?? result?.block?.toolName,
    status,
    sessionId: liveSession,
    call,
    result,
    eventSpanMs,
    reportedDurationMs: result ? reportedDurationMs(result.event.raw) : undefined,
    exitCode,
    errors: result ? toolErrorDetails(result.event.raw) : [],
    parent,
    children,
  }
}

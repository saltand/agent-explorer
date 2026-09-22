import { buildToolCallIndex, execSessionId } from './toolCalls'
import type { ExplorerSession, TimelineEvent } from './types'

export type TimingSpanKind = 'request' | 'tool' | 'turn'

export interface TimingSpan {
  id: string
  kind: TimingSpanKind
  label: string
  /** Epoch ms; `end === start` marks a point event with no recorded duration. */
  start: number
  end: number
  status: 'completed' | 'failed' | 'running' | 'pending'
  /** The record a click selects. */
  event: TimelineEvent
  /** Which recorded fields the span is derived from. */
  basis: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function envelopePayload(event: TimelineEvent): Record<string, unknown> | undefined {
  return isRecord(event.raw) && isRecord(event.raw.payload) ? event.raw.payload : undefined
}

function secondsToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined
}

function toolSpans(session: ExplorerSession): TimingSpan[] {
  const spans: TimingSpan[] = []
  for (const pair of buildToolCallIndex(session.conversationItems).values()) {
    const { call, result } = pair
    const start = call?.event.timestamp
    const end = result?.event.timestamp
    if (start === undefined) continue
    const failed = result?.block?.status === 'failed'
    const running = result ? execSessionId(result.event.raw) !== undefined : false
    spans.push({
      id: `tool-${pair.callId}`,
      kind: 'tool',
      label: call?.block?.toolName ?? result?.block?.toolName ?? 'tool',
      start,
      end: end !== undefined && end >= start ? end : start,
      status: failed ? 'failed' : running ? 'running' : result ? 'completed' : 'pending',
      event: call!.event,
      basis: 'call → result records',
    })
  }
  return spans
}

/**
 * Claude repeats one request across several streamed records, so a request's
 * span is the earliest-to-latest record sharing its `requestId`.
 */
function requestIdSpans(session: ExplorerSession): TimingSpan[] {
  const groups = new Map<string, { first: TimelineEvent; start: number; end: number }>()
  for (const event of session.events) {
    if (!event.requestId || event.timestamp === undefined) continue
    const group = groups.get(event.requestId)
    if (!group) {
      groups.set(event.requestId, { first: event, start: event.timestamp, end: event.timestamp })
    } else {
      if (event.timestamp < group.start) {
        group.start = event.timestamp
        group.first = event
      }
      if (event.timestamp > group.end) group.end = event.timestamp
    }
  }
  return [...groups.entries()].map(([requestId, group]) => ({
    id: `request-${requestId}`,
    kind: 'request',
    label: `request ${requestId.slice(0, 8)}`,
    start: group.start,
    end: group.end,
    status: 'completed',
    event: group.first,
    basis: 'records sharing requestId',
  }))
}

/**
 * Grok logs one `turn_completed` record per turn carrying `elapsed_ms` for the
 * whole turn and `usage.apiDurationMs` for the model calls inside it.
 */
function grokTurnSpans(session: ExplorerSession): TimingSpan[] {
  const spans: TimingSpan[] = []
  for (const event of session.events) {
    if (event.kind !== 'turn_completed' || event.timestamp === undefined) continue
    if (!isRecord(event.raw)) continue
    const usage = isRecord(event.raw.usage) ? event.raw.usage : undefined
    const apiMs = typeof usage?.apiDurationMs === 'number' ? usage.apiDurationMs : undefined
    const elapsedMs =
      typeof event.raw.elapsed_ms === 'number' ? event.raw.elapsed_ms : undefined
    const failed = event.raw.stop_reason === 'error'
    if (elapsedMs !== undefined) {
      spans.push({
        id: `grok-turn-${event.id}`,
        kind: 'turn',
        label: `Turn ${event.turnIndex ?? '?'}`,
        start: event.timestamp - elapsedMs,
        end: event.timestamp,
        status: failed ? 'failed' : 'completed',
        event,
        basis: 'elapsed_ms from turn_completed',
      })
    }
    if (apiMs !== undefined) {
      spans.push({
        id: `grok-api-${event.id}`,
        kind: 'request',
        label: `API · turn ${event.turnIndex ?? '?'}`,
        start: event.timestamp - apiMs,
        end: event.timestamp,
        status: failed ? 'failed' : 'completed',
        event,
        basis: 'apiDurationMs from turn_completed',
      })
    }
  }
  return spans
}

/** Codex brackets each turn with `task_started` / `task_complete` events. */
function codexTurnSpans(session: ExplorerSession): TimingSpan[] {
  const started = new Map<string, TimelineEvent>()
  const completed = new Map<string, TimelineEvent>()
  for (const event of session.events) {
    const turnId = envelopePayload(event)?.turn_id
    if (typeof turnId !== 'string') continue
    if (event.kind === 'task_started' && !started.has(turnId)) started.set(turnId, event)
    if (event.kind === 'task_complete') completed.set(turnId, event)
  }
  const spans: TimingSpan[] = []
  for (const [turnId, startEvent] of started) {
    const endEvent = completed.get(turnId)
    const start =
      secondsToMs(envelopePayload(startEvent)?.started_at) ?? startEvent.timestamp
    const end = endEvent?.timestamp
    if (start === undefined) continue
    const error = envelopePayload(endEvent ?? startEvent)?.error
    spans.push({
      id: `codex-turn-${turnId}`,
      kind: 'turn',
      label: `Turn ${startEvent.turnIndex ?? '?'}`,
      start,
      end: end !== undefined && end >= start ? end : start,
      status: error ? 'failed' : end ? 'completed' : 'running',
      event: startEvent,
      basis: 'task_started → task_complete',
    })
  }
  return spans
}

/**
 * Every span here is bracketed by recorded lifecycle events or carries a
 * recorded duration field; nothing is inferred from neighbouring messages.
 */
export function buildTimingSpans(session: ExplorerSession): TimingSpan[] {
  return [...toolSpans(session), ...requestIdSpans(session), ...grokTurnSpans(session), ...codexTurnSpans(session)].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )
}

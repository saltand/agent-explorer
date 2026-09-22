import type { ExplorerSession, TimelineEvent } from './types'

/**
 * Timing figures for the request or turn a record belongs to. Every field is
 * absent unless a record in the log actually marks that point; nothing is
 * inferred from neighbouring messages.
 */
export interface RequestMetrics {
  /** What the figures describe, e.g. 'Request req_abc123' or 'Turn 3'. */
  subject: string
  turnIndex?: number
  /** Epoch ms when the request or turn started, per its basis. */
  startedAt?: number
  /** Epoch ms when it completed. */
  endedAt?: number
  /** `endedAt - startedAt` when both ends are recorded. */
  totalMs?: number
  /** Request dispatch → first model output. No adapter records dispatch today. */
  ttftMs?: number
  /** First recorded model output → completion. */
  generationMs?: number
  outputTokens?: number
  /** Output tokens over the generation window. */
  outputTokensPerSec?: number
  /** Recorded fields the figures are derived from. */
  basis: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function envelopePayload(event: TimelineEvent): Record<string, unknown> | undefined {
  return isRecord(event.raw) && isRecord(event.raw.payload) ? event.raw.payload : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = num(value)
  return seconds === undefined ? undefined : seconds * 1000
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id
}

/** Claude streams one request across records sharing a `requestId`. */
function requestIdMetrics(
  session: ExplorerSession,
  event: TimelineEvent,
): RequestMetrics | undefined {
  const requestId = event.requestId
  if (!requestId) return undefined

  let start: number | undefined
  let end: number | undefined
  let outputTokens: number | undefined
  for (const candidate of session.events) {
    if (candidate.requestId !== requestId) continue
    if (candidate.timestamp !== undefined) {
      if (start === undefined || candidate.timestamp < start) start = candidate.timestamp
      if (end === undefined || candidate.timestamp > end) end = candidate.timestamp
    }
    const output = candidate.usage?.outputTokens
    if (output !== undefined && (outputTokens === undefined || output > outputTokens)) {
      outputTokens = output
    }
  }
  if (start === undefined || end === undefined) return undefined

  const generationMs = end > start ? end - start : undefined
  return {
    subject: `Request ${shortId(requestId)}`,
    turnIndex: event.turnIndex,
    startedAt: start,
    endedAt: end,
    totalMs: generationMs,
    generationMs,
    outputTokens,
    outputTokensPerSec:
      outputTokens !== undefined && generationMs
        ? outputTokens / (generationMs / 1000)
        : undefined,
    basis: [
      'earliest → latest timestamp among records sharing requestId',
      'the first streamed record already follows dispatch, so TTFT is not derivable',
    ],
  }
}

/** Grok records turn timing once, on `turn_completed`. */
function grokTurnMetrics(event: TimelineEvent): RequestMetrics | undefined {
  if (event.kind !== 'turn_completed' || event.timestamp === undefined) return undefined
  if (!isRecord(event.raw)) return undefined
  const usage = isRecord(event.raw.usage) ? event.raw.usage : undefined
  const apiMs = num(usage?.apiDurationMs)
  const elapsedMs = num(event.raw.elapsed_ms)
  if (elapsedMs === undefined && apiMs === undefined) return undefined
  const modelCalls = num(usage?.modelCalls)
  const outputTokens = event.usage?.outputTokens ?? num(usage?.outputTokens)
  return {
    subject: `Turn ${event.turnIndex ?? '?'}`,
    turnIndex: event.turnIndex,
    startedAt:
      elapsedMs !== undefined
        ? event.timestamp - elapsedMs
        : apiMs !== undefined
          ? event.timestamp - apiMs
          : undefined,
    endedAt: event.timestamp,
    totalMs: elapsedMs,
    generationMs: apiMs,
    outputTokens,
    outputTokensPerSec:
      outputTokens !== undefined && apiMs ? outputTokens / (apiMs / 1000) : undefined,
    basis: [
      'elapsed_ms and usage.apiDurationMs from turn_completed',
      modelCalls === undefined
        ? 'API time covers the model calls in this turn'
        : `API time covers ${modelCalls} model call${modelCalls === 1 ? '' : 's'} in this turn`,
    ],
  }
}

/** Codex marks request completion with `token_usage_record` / `token_count`. */
function codexRequestMetrics(event: TimelineEvent): RequestMetrics | undefined {
  if (event.kind === 'token_usage_record') {
    const payload = envelopePayload(event)
    const responseId = typeof payload?.response_id === 'string' ? payload.response_id : undefined
    const usage = isRecord(payload?.usage) ? payload.usage : undefined
    return {
      subject: responseId ? `Request ${shortId(responseId)}` : 'Request',
      turnIndex: event.turnIndex,
      endedAt: event.timestamp,
      outputTokens: num(usage?.output_tokens),
      basis: [
        'token_usage_record timestamp marks completion',
        'request dispatch is not logged, so start, duration and TTFT are unavailable',
      ],
    }
  }
  if (event.kind === 'token_count') {
    return {
      subject: 'Request',
      turnIndex: event.turnIndex,
      endedAt: event.timestamp,
      outputTokens: event.usage?.outputTokens,
      basis: [
        'token_count is emitted once when the response completes',
        'request dispatch is not logged, so start, duration and TTFT are unavailable',
      ],
    }
  }
  return undefined
}

/** Pi assistant messages carry the API response id and a completion timestamp. */
function piMessageMetrics(event: TimelineEvent): RequestMetrics | undefined {
  if (event.role !== 'assistant') return undefined
  const message = isRecord(event.raw) && isRecord(event.raw.message) ? event.raw.message : undefined
  const responseId = typeof message?.responseId === 'string' ? message.responseId : undefined
  if (!responseId) return undefined
  return {
    subject: `Request ${shortId(responseId)}`,
    turnIndex: event.turnIndex,
    endedAt: event.timestamp,
    outputTokens: event.usage?.outputTokens,
    basis: [
      'message timestamp marks completion',
      'request dispatch is not logged, so start, duration and TTFT are unavailable',
    ],
  }
}

/** Turn-level fallback from recorded turn brackets (Codex, Grok). */
function turnMetrics(
  session: ExplorerSession,
  event: TimelineEvent,
): RequestMetrics | undefined {
  if (event.turnIndex === undefined) return undefined

  const turnCompleted = session.events.find(
    (e) => e.kind === 'turn_completed' && e.turnIndex === event.turnIndex,
  )
  if (turnCompleted) return grokTurnMetrics(turnCompleted)

  const started = session.events.find(
    (e) => e.kind === 'task_started' && e.turnIndex === event.turnIndex,
  )
  const completed = session.events.find(
    (e) => e.kind === 'task_complete' && e.turnIndex === event.turnIndex,
  )
  const start = started
    ? (secondsToMs(envelopePayload(started)?.started_at) ?? started.timestamp)
    : undefined
  const end = completed?.timestamp
  if (start === undefined && end === undefined) return undefined
  const error = envelopePayload(completed ?? started!)?.error
  return {
    subject: `Turn ${event.turnIndex}`,
    turnIndex: event.turnIndex,
    startedAt: start,
    endedAt: end,
    totalMs: start !== undefined && end !== undefined && end >= start ? end - start : undefined,
    basis: [
      'task_started → task_complete',
      error ? 'turn completed with an error' : end === undefined ? 'turn has no completion record' : 'turn bracket recorded',
    ],
  }
}

/**
 * Metrics for the request the selected record belongs to, plus the enclosing
 * turn when the record is not itself a turn record. Empty when the record sits
 * in no timed request or turn.
 */
export function requestMetricsForEvent(
  session: ExplorerSession,
  event: TimelineEvent,
): RequestMetrics[] {
  const direct = [
    requestIdMetrics(session, event),
    grokTurnMetrics(event),
    codexRequestMetrics(event),
    piMessageMetrics(event),
  ].filter((m): m is RequestMetrics => m !== undefined)

  if (event.kind === 'turn_completed') return direct

  const turn = turnMetrics(session, event)
  if (turn) direct.push(turn)

  return direct
}

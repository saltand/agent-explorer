import { describe, expect, it } from 'vitest'
import { requestMetricsForEvent } from './requestMetrics'
import type { ExplorerSession, TimelineEvent } from './types'

function event(partial: Partial<TimelineEvent> & { lineIndex: number }): TimelineEvent {
  return {
    id: `line-${partial.lineIndex}`,
    category: 'unknown',
    kind: 'unknown',
    label: '',
    preview: '',
    raw: {},
    ...partial,
  }
}

function session(events: TimelineEvent[]): ExplorerSession {
  return {
    fileType: 'Test',
    fileName: 'test.jsonl',
    meta: { eventCount: events.length, turnCount: 1 },
    events,
    conversationItems: [],
    parseWarnings: [],
  }
}

describe('requestMetricsForEvent', () => {
  it('spans a Claude request across records sharing requestId', () => {
    const events = [
      event({ lineIndex: 1, timestamp: 1000, requestId: 'req_abc', turnIndex: 1 }),
      event({
        lineIndex: 2,
        timestamp: 3400,
        requestId: 'req_abc',
        usage: { outputTokens: 200, sources: {} as never, issues: [] } as never,
      }),
      event({ lineIndex: 3, timestamp: 500, requestId: 'req_abc' }),
    ]
    const [metrics] = requestMetricsForEvent(session(events), events[0]!)
    expect(metrics).toMatchObject({
      startedAt: 500,
      endedAt: 3400,
      totalMs: 2900,
      generationMs: 2900,
      outputTokens: 200,
    })
    expect(metrics!.outputTokensPerSec).toBeCloseTo(200 / 2.9, 1)
    expect(metrics!.ttftMs).toBeUndefined()
  })

  it('derives Grok turn timing from elapsed_ms and apiDurationMs', () => {
    const end = 1788369846000
    const tc = event({
      lineIndex: 5,
      kind: 'turn_completed',
      turnIndex: 2,
      timestamp: end,
      raw: {
        type: 'turn_completed',
        elapsed_ms: 9000,
        usage: { apiDurationMs: 4000, modelCalls: 2, outputTokens: 100 },
      },
    })
    const [metrics] = requestMetricsForEvent(session([tc]), tc)
    expect(metrics).toMatchObject({
      subject: 'Turn 2',
      startedAt: end - 9000,
      endedAt: end,
      totalMs: 9000,
      generationMs: 4000,
      outputTokens: 100,
    })
    expect(metrics!.outputTokensPerSec).toBeCloseTo(25, 1)
    expect(metrics!.basis.join(' ')).toContain('2 model calls')
  })

  it('maps other Grok records in the turn to the same turn metrics', () => {
    const tc = event({
      lineIndex: 9,
      kind: 'turn_completed',
      turnIndex: 1,
      timestamp: 10000,
      raw: { type: 'turn_completed', elapsed_ms: 2000, usage: {} },
    })
    const other = event({ lineIndex: 4, turnIndex: 1, timestamp: 9000 })
    const metrics = requestMetricsForEvent(session([other, tc]), other)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({ subject: 'Turn 1', totalMs: 2000 })
  })

  it('reports only completion for Codex request records', () => {
    const tur = event({
      lineIndex: 7,
      kind: 'token_usage_record',
      turnIndex: 1,
      timestamp: 5000,
      raw: { type: 'token_usage_record', payload: { response_id: 'resp_msg_123', usage: { output_tokens: 21 } } },
    })
    const metrics = requestMetricsForEvent(session([tur]), tur)
    const request = metrics.find((m) => m.subject.startsWith('Request'))
    expect(request).toMatchObject({ endedAt: 5000, outputTokens: 21 })
    expect(request!.startedAt).toBeUndefined()
    expect(request!.totalMs).toBeUndefined()
    expect(request!.ttftMs).toBeUndefined()
    expect(request!.basis.join(' ')).toContain('dispatch is not logged')
  })

  it('falls back to Codex turn brackets for ordinary records', () => {
    const events = [
      event({ lineIndex: 1, kind: 'task_started', turnIndex: 1, timestamp: 1000, raw: { payload: { type: 'task_started', turn_id: 't1' } } }),
      event({ lineIndex: 4, kind: 'function_call', turnIndex: 1, timestamp: 2000 }),
      event({ lineIndex: 8, kind: 'task_complete', turnIndex: 1, timestamp: 6000, raw: { payload: { type: 'task_complete', turn_id: 't1' } } }),
    ]
    const metrics = requestMetricsForEvent(session(events), events[1]!)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({ subject: 'Turn 1', startedAt: 1000, endedAt: 6000, totalMs: 5000 })
  })

  it('reads Pi assistant response id and completion time', () => {
    const pi = event({
      lineIndex: 3,
      role: 'assistant',
      timestamp: 8000,
      raw: { message: { role: 'assistant', responseId: 'msg_0e5496d7' } },
      usage: { outputTokens: 50, sources: {} as never, issues: [] } as never,
    })
    const [metrics] = requestMetricsForEvent(session([pi]), pi)
    expect(metrics).toMatchObject({ endedAt: 8000, outputTokens: 50 })
    expect(metrics!.totalMs).toBeUndefined()
  })

  it('returns nothing for records outside any timed request or turn', () => {
    const meta = event({ lineIndex: 1, kind: 'session_meta' })
    expect(requestMetricsForEvent(session([meta]), meta)).toHaveLength(0)
  })
})

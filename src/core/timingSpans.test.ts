import { describe, expect, it } from 'vitest'
import { buildTimingSpans } from './timingSpans'
import type { ConversationListItem, ExplorerSession, TimelineEvent } from './types'

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

function session(events: TimelineEvent[], items: ConversationListItem[] = []): ExplorerSession {
  return {
    fileType: 'Test',
    fileName: 'test.jsonl',
    meta: { eventCount: events.length, turnCount: 1 },
    events,
    conversationItems: items,
    parseWarnings: [],
  }
}

function toolPair(callId: string, start: number, end: number, failed = false): ConversationListItem[] {
  const callEvent = event({ lineIndex: 1, timestamp: start, category: 'tool' })
  const resultEvent = event({ lineIndex: 2, timestamp: end, category: 'tool', raw: {} })
  return [
    {
      id: `c-${callId}`,
      event: callEvent,
      role: 'tool_call',
      block: { type: 'tool_use', text: '', toolName: 'bash', toolCallId: callId, status: 'pending' },
    },
    {
      id: `r-${callId}`,
      event: resultEvent,
      role: 'tool_result',
      block: { type: 'text', text: '', toolCallId: callId, status: failed ? 'failed' : 'completed' },
    },
  ]
}

describe('buildTimingSpans', () => {
  it('spans paired tool calls from their two recorded events', () => {
    const items = toolPair('c1', 1000, 1600)
    const spans = buildTimingSpans(session([], items))
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ kind: 'tool', label: 'bash', start: 1000, end: 1600, status: 'completed' })
  })

  it('marks failed calls and still-running sessions', () => {
    const items = [
      ...toolPair('c1', 0, 100, true),
      ...(() => {
        const callEvent = event({ lineIndex: 3, timestamp: 200, category: 'tool' })
        const resultEvent = event({
          lineIndex: 4,
          timestamp: 300,
          category: 'tool',
          raw: { payload: { output: 'Wall time: 0.1 seconds\nProcess running with session ID 7' } },
        })
        return [
          { id: 'c2', event: callEvent, role: 'tool_call' as const, block: { type: 'tool_use' as const, text: '', toolName: 'exec_command', toolCallId: 'c2', status: 'pending' as const } },
          { id: 'r2', event: resultEvent, role: 'tool_result' as const, block: { type: 'text' as const, text: '', toolCallId: 'c2', status: 'completed' as const } },
        ]
      })(),
    ]
    const spans = buildTimingSpans(session([], items))
    expect(spans.find((s) => s.id === 'tool-c1')?.status).toBe('failed')
    expect(spans.find((s) => s.id === 'tool-c2')?.status).toBe('running')
  })

  it('spans Claude requests by shared requestId', () => {
    const events = [
      event({ lineIndex: 1, timestamp: 1000, requestId: 'req-abc' }),
      event({ lineIndex: 2, timestamp: 1400, requestId: 'req-abc' }),
      event({ lineIndex: 3, timestamp: 900, requestId: 'req-abc' }),
      event({ lineIndex: 4, timestamp: 2000, requestId: 'req-def' }),
      event({ lineIndex: 5 }), // no requestId — skipped
    ]
    const spans = buildTimingSpans(session(events))
    const req = spans.filter((s) => s.kind === 'request')
    expect(req).toHaveLength(2)
    const abc = req.find((s) => s.id === 'request-req-abc')!
    expect(abc.start).toBe(900)
    expect(abc.end).toBe(1400)
    expect(abc.event.id).toBe('line-3')
  })

  it('spans Grok turns and API time from turn_completed records', () => {
    const raw = {
      type: 'turn_completed',
      prompt_index: 0,
      stop_reason: 'end_turn',
      elapsed_ms: 9000,
      usage: { apiDurationMs: 4000 },
      timestamp: 1788369846,
    }
    const end = 1788369846 * 1000
    const spans = buildTimingSpans(
      session([event({ lineIndex: 9, kind: 'turn_completed', timestamp: end, turnIndex: 1, raw })]),
    )
    const turn = spans.find((s) => s.kind === 'turn')!
    expect(turn.start).toBe(end - 9000)
    const api = spans.find((s) => s.kind === 'request')!
    expect(api.start).toBe(end - 4000)
    expect(api.basis).toContain('apiDurationMs')
  })

  it('spans Codex turns between task_started and task_complete', () => {
    const events = [
      event({
        lineIndex: 1,
        kind: 'task_started',
        turnIndex: 1,
        timestamp: 1000,
        raw: { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 0.9 } },
      }),
      event({
        lineIndex: 5,
        kind: 'task_complete',
        turnIndex: 1,
        timestamp: 5000,
        raw: { type: 'event_msg', timestamp: 'x', payload: { type: 'task_complete', turn_id: 't1' } },
      }),
    ]
    const spans = buildTimingSpans(session(events))
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ kind: 'turn', start: 900, end: 5000, status: 'completed' })
  })

  it('marks a turn failed when task_complete carries an error', () => {
    const events = [
      event({ lineIndex: 1, kind: 'task_started', timestamp: 1000, raw: { payload: { type: 'task_started', turn_id: 't1' } } }),
      event({ lineIndex: 2, kind: 'task_complete', timestamp: 2000, raw: { payload: { type: 'task_complete', turn_id: 't1', error: { message: 'boom' } } } }),
    ]
    const spans = buildTimingSpans(session(events))
    expect(spans[0]?.status).toBe('failed')
  })
})

import { describe, expect, it } from 'vitest'
import { inspectContext } from './contextInspection'
import { lineDiff } from './lineDiff'
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

function turnContext(turnIndex: number, payload: Record<string, unknown>): TimelineEvent {
  return event({
    lineIndex: turnIndex * 10,
    kind: 'turn_context',
    turnIndex,
    timestamp: turnIndex * 1000,
    raw: { type: 'turn_context', payload },
  })
}

describe('inspectContext', () => {
  it('reads the Codex base instructions as the system prompt', () => {
    const meta = event({
      lineIndex: 0,
      kind: 'session_meta',
      raw: {
        type: 'session_meta',
        payload: {
          base_instructions: {
            text: 'You are Codex, a coding agent.',
            provenance: { type: 'model', model: 'claude-opus-5' },
          },
        },
      },
    })
    const { systemPrompts } = inspectContext(session([meta]))
    expect(systemPrompts).toHaveLength(1)
    expect(systemPrompts[0]!.text).toBe('You are Codex, a coding agent.')
    expect(systemPrompts[0]!.provenance).toBe('model · claude-opus-5')
  })

  it('reads Grok system records from string or part content', () => {
    const sys = event({
      lineIndex: 1,
      kind: 'system',
      raw: { type: 'system', content: [{ type: 'text', text: 'You are Grok.' }] },
    })
    expect(inspectContext(session([sys])).systemPrompts[0]?.text).toBe('You are Grok.')
  })

  it('diffs consecutive turn_context records and reports unchanged turns', () => {
    const events = [
      turnContext(1, { model: 'a', cwd: '/x', approval_policy: 'never' }),
      turnContext(2, { model: 'a', cwd: '/x', approval_policy: 'never' }),
      turnContext(3, { model: 'b', cwd: '/x' }),
    ]
    const { snapshots } = inspectContext(session(events))
    expect(snapshots.map((s) => s.status)).toEqual(['initial', 'unchanged', 'changed'])
    const changes = snapshots[2]!.changes
    expect(changes.find((c) => c.field === 'model')).toEqual({ field: 'model', before: 'a', after: 'b' })
    expect(changes.find((c) => c.field === 'approval_policy')).toEqual({
      field: 'approval_policy',
      before: 'never',
      after: undefined,
    })
  })

  it('extracts Pi compaction summary, tokensBefore, usage, and file lists', () => {
    const compaction = event({
      lineIndex: 9,
      kind: 'compaction',
      turnIndex: 4,
      raw: {
        type: 'compaction',
        summary: '## Goal …',
        tokensBefore: 978600,
        details: { readFiles: ['/a.ts'], modifiedFiles: ['/b.ts'] },
      },
      usage: { outputTokens: 2846 } as never,
    })
    const [entry] = inspectContext(session([compaction])).compactions
    expect(entry).toMatchObject({
      summary: '## Goal …',
      tokensBefore: 978600,
      readFiles: ['/a.ts'],
      modifiedFiles: ['/b.ts'],
    })
    expect(entry!.usage?.outputTokens).toBe(2846)
  })

  it('counts Codex replacement history on compacted records', () => {
    const compacted = event({
      lineIndex: 5,
      kind: 'compacted',
      raw: { type: 'compacted', payload: { message: '', replacement_history: [{}, {}, {}] } },
    })
    const [entry] = inspectContext(session([compacted])).compactions
    expect(entry!.replacedRecords).toBe(3)
  })

  it('returns empty sections when nothing is recorded', () => {
    const inspection = inspectContext(session([event({ lineIndex: 1 })]))
    expect(inspection.systemPrompts).toHaveLength(0)
    expect(inspection.snapshots).toHaveLength(0)
    expect(inspection.compactions).toHaveLength(0)
  })
})

describe('lineDiff', () => {
  it('marks added, removed, and unchanged lines', () => {
    const diff = lineDiff('a\nb\nc', 'a\nx\nc')
    expect(diff).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
    ])
  })

  it('handles empty inputs', () => {
    expect(lineDiff('', 'x')).toEqual([{ type: 'add', text: 'x' }])
    expect(lineDiff('x', '')).toEqual([{ type: 'del', text: 'x' }])
  })
})

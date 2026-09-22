import { describe, expect, it } from 'vitest'
import { billableTotal, computeSessionTurns } from './sessionTurns'
import type { ExplorerSession, TimelineEvent, TokenUsage } from './types'

function usage(counts: Partial<TokenUsage>): TokenUsage {
  return { sources: {}, issues: [], ...counts }
}

function event(over: Partial<TimelineEvent> & { lineIndex: number }): TimelineEvent {
  return {
    id: `line-${over.lineIndex}`,
    category: 'meta',
    kind: 'token_count',
    label: 'token_count',
    preview: '',
    raw: {},
    ...over,
  }
}

function session(events: TimelineEvent[]): ExplorerSession {
  return {
    fileType: 'Test',
    fileName: 'test.jsonl',
    meta: { eventCount: events.length, turnCount: 0 },
    events,
    conversationItems: [],
    parseWarnings: [],
  }
}

describe('billableTotal', () => {
  it('uses total input plus output when total input is known', () => {
    expect(billableTotal({ totalInputTokens: 100, outputTokens: 20 })).toBe(120)
  })

  it('derives input from the three categories when total input is missing', () => {
    expect(
      billableTotal({
        inputTokens: 10,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        outputTokens: 3,
      }),
    ).toBe(20)
  })

  it('returns undefined when a needed count is missing', () => {
    expect(billableTotal({ inputTokens: 10 })).toBeUndefined()
    expect(billableTotal({ outputTokens: 10 })).toBeUndefined()
  })
})

describe('computeSessionTurns', () => {
  it('groups usage by turn in first-seen order', () => {
    const result = computeSessionTurns(
      session([
        event({ lineIndex: 1, turnIndex: 1, usage: usage({ totalInputTokens: 100, outputTokens: 10 }) }),
        event({ lineIndex: 2, turnIndex: 1, usage: usage({ totalInputTokens: 50, outputTokens: 5 }) }),
        event({ lineIndex: 3, turnIndex: 2, usage: usage({ totalInputTokens: 200, outputTokens: 20 }) }),
      ]),
    )
    expect(result.turns.map((t) => t.turnIndex)).toEqual([1, 2])
    expect(result.turns[0].usage.requestCount).toBe(2)
    expect(result.turns[0].totalTokens).toBe(165)
    expect(result.turns[1].totalTokens).toBe(220)
  })

  it('ranks the heaviest requests first with their line index', () => {
    const result = computeSessionTurns(
      session([
        event({ lineIndex: 1, turnIndex: 1, usage: usage({ totalInputTokens: 100, outputTokens: 10 }) }),
        event({ lineIndex: 2, turnIndex: 1, usage: usage({ totalInputTokens: 900, outputTokens: 90 }) }),
        event({ lineIndex: 3, turnIndex: 2, usage: usage({ totalInputTokens: 300, outputTokens: 30 }) }),
      ]),
      { topRequestLimit: 2 },
    )
    expect(result.topRequests.map((r) => r.lineIndex)).toEqual([2, 3])
    expect(result.topRequests[0].totalTokens).toBe(990)
    expect(result.topRequests[0].turnIndex).toBe(1)
  })

  it('does not rank cumulative snapshots as their own requests', () => {
    const result = computeSessionTurns(
      session([
        event({ lineIndex: 1, turnIndex: 1, usage: usage({ scope: 'cumulative', totalInputTokens: 500, outputTokens: 40 }) }),
        event({ lineIndex: 2, turnIndex: 1, usage: usage({ totalInputTokens: 100, outputTokens: 10 }) }),
      ]),
    )
    expect(result.topRequests.map((r) => r.lineIndex)).toEqual([2])
  })

  it('does not list one streaming request twice, keeping its largest total', () => {
    const result = computeSessionTurns(
      session([
        event({ lineIndex: 5, turnIndex: 1, usage: usage({ requestKey: 'r1', totalInputTokens: 100, outputTokens: 5 }) }),
        event({ lineIndex: 5, turnIndex: 1, usage: usage({ requestKey: 'r1', totalInputTokens: 100, outputTokens: 80 }) }),
      ]),
    )
    expect(result.topRequests).toHaveLength(1)
    expect(result.topRequests[0].totalTokens).toBe(180)
  })

  it('flags usage records that carry no turn', () => {
    const result = computeSessionTurns(
      session([event({ lineIndex: 1, usage: usage({ totalInputTokens: 100, outputTokens: 10 }) })]),
    )
    expect(result.hasUnassignedTurn).toBe(true)
    expect(result.turns[0].turnIndex).toBe(0)
  })
})

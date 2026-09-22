import { describe, expect, it } from 'vitest'
import { UsageAccumulator, aggregateUsage } from './usageAggregate'
import type { TokenUsage } from './types'

function usage(counts: Partial<TokenUsage>): TokenUsage {
  return { sources: {}, issues: [], ...counts }
}

describe('aggregateUsage', () => {
  it('sums independent per-request records', () => {
    const result = aggregateUsage([
      { usage: usage({ inputTokens: 10, outputTokens: 5 }), model: 'a' },
      { usage: usage({ inputTokens: 20, outputTokens: 7 }), model: 'a' },
    ])
    expect(result.inputTokens).toBe(30)
    expect(result.outputTokens).toBe(12)
    expect(result.requestCount).toBe(2)
    expect(result.duplicateCount).toBe(0)
    expect(result.issues).toEqual([])
  })

  it('keeps the last of a streaming request so a growing total is not added up', () => {
    const result = aggregateUsage([
      { usage: usage({ requestKey: 'r1', inputTokens: 9, outputTokens: 8 }) },
      { usage: usage({ requestKey: 'r1', inputTokens: 9, outputTokens: 238 }) },
    ])
    expect(result.outputTokens).toBe(238)
    expect(result.inputTokens).toBe(9)
    expect(result.requestCount).toBe(1)
    expect(result.duplicateCount).toBe(1)
  })

  it('keeps the first record when later repeats are stale echoes', () => {
    const result = aggregateUsage([
      { usage: usage({ requestKey: 'r1', duplicatePolicy: 'keep-first', inputTokens: 100, outputTokens: 20 }) },
      { usage: usage({ requestKey: 'r1', duplicatePolicy: 'keep-first', inputTokens: 0, outputTokens: 0 }) },
    ])
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(20)
    expect(result.requestCount).toBe(1)
    expect(result.duplicateCount).toBe(1)
  })

  it('refuses to sum cumulative snapshots', () => {
    const result = aggregateUsage([
      { usage: usage({ scope: 'cumulative', totalInputTokens: 500, outputTokens: 40 }) },
      { usage: usage({ scope: 'cumulative', totalInputTokens: 900, outputTokens: 80 }) },
    ])
    expect(result.requestCount).toBe(0)
    expect(result.inputTokens).toBeUndefined()
    expect(result.outputTokens).toBeUndefined()
    expect(result.issues.join(' ')).toContain('cannot be summed')
  })

  it('marks a category incomplete when only some requests reported it', () => {
    const result = aggregateUsage([
      { usage: usage({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3 }) },
      { usage: usage({ inputTokens: 20, outputTokens: 5 }) },
    ])
    expect(result.cacheReadInputTokens).toBe(3)
    expect(result.incomplete).toBe(true)
    expect(result.issues.join(' ')).toContain('did not report every token category')
  })

  it('reports the shortfall when the log total exceeds the summed requests', () => {
    const result = aggregateUsage([
      { usage: usage({ totalInputTokens: 100, outputTokens: 10, sessionTotalTokens: 110 }) },
      // A later request advanced the running total without recording its usage.
      { usage: usage({ totalInputTokens: 200, outputTokens: 20, sessionTotalTokens: 500 }) },
    ])
    expect(result.summedTotalTokens).toBe(330)
    expect(result.reportedSessionTotalTokens).toBe(500)
    expect(result.incomplete).toBe(true)
    expect(result.issues.join(' ')).toContain('170 tokens belong to requests that recorded no usage')
  })

  it('excludes a total inherited from a resumed session', () => {
    // First record already sits at 1,000,110 but only accounts for 110 itself.
    const result = aggregateUsage([
      { usage: usage({ totalInputTokens: 100, outputTokens: 10, sessionTotalTokens: 1_000_110 }) },
      { usage: usage({ totalInputTokens: 200, outputTokens: 20, sessionTotalTokens: 1_000_330 }) },
    ])
    expect(result.inheritedTotalTokens).toBe(1_000_000)
    expect(result.reportedSessionTotalTokens).toBe(330)
    expect(result.summedTotalTokens).toBe(330)
    expect(result.issues).toEqual([])
  })

  it('accumulates incrementally without rescanning earlier records', () => {
    const accumulator = new UsageAccumulator()
    accumulator.add(usage({ inputTokens: 10, outputTokens: 5 }))
    expect(accumulator.result().inputTokens).toBe(10)
    accumulator.add(usage({ inputTokens: 4, outputTokens: 1 }))
    const result = accumulator.result()
    expect(result.inputTokens).toBe(14)
    expect(result.outputTokens).toBe(6)
    expect(result.requestCount).toBe(2)
  })

  it('records each model once in first-seen order', () => {
    const result = aggregateUsage([
      { usage: usage({ inputTokens: 1, outputTokens: 1 }), model: 'sonnet' },
      { usage: usage({ inputTokens: 1, outputTokens: 1 }), model: 'opus' },
      { usage: usage({ inputTokens: 1, outputTokens: 1 }), model: 'sonnet' },
    ])
    expect(result.models).toEqual(['sonnet', 'opus'])
  })
})

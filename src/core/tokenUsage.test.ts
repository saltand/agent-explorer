import { describe, expect, it } from 'vitest'
import { cacheReadShare, normalizeTokenUsage } from './tokenUsage'
import { calculateUsageCost } from './modelPricing'

const mapping = {
  path: 'message.usage',
  fields: {
    inputTokens: 'input', totalInputTokens: 'total',
    cacheReadInputTokens: 'read', cacheCreationInputTokens: 'write',
    outputTokens: 'output', reasoningOutputTokens: 'reasoning',
  },
}

describe('normalizeTokenUsage', () => {
  it('keeps missing fields unknown and explicit zeroes known', () => {
    const usage = normalizeTokenUsage({ input: 0, output: 4 }, mapping)!
    expect(usage.inputTokens).toBe(0)
    expect(usage.cacheReadInputTokens).toBeUndefined()
    expect(usage.totalInputTokens).toBeUndefined()
    expect(usage.reasoningOutputTokens).toBeUndefined()
    expect(usage.contentOutputTokens).toBeUndefined()
    expect(normalizeTokenUsage({}, mapping)).toBeUndefined()
    expect(normalizeTokenUsage({ cost: { total: 1 } }, mapping)).toBeUndefined()
  })

  it('adds disjoint input categories and retains all source paths', () => {
    const usage = normalizeTokenUsage({ input: 5, read: 80, write: 15 }, mapping)!
    expect(usage.totalInputTokens).toBe(100)
    expect(usage.sources.totalInputTokens).toEqual(['message.usage.input', 'message.usage.read', 'message.usage.write'])
  })

  it('separates inclusive input before pricing it', () => {
    const usage = normalizeTokenUsage({ total: 100, read: 80, write: 0, output: 10 }, mapping)!
    expect(usage.inputTokens).toBe(20)
    expect(usage.sources.inputTokens).toEqual(['message.usage.total', 'message.usage.read', 'message.usage.write'])
    expect(calculateUsageCost(usage, { inputCostPerToken: 1, cacheReadInputTokenCost: 0.1, outputCostPerToken: 2 }).total).toBe(48)
  })

  it('does not subtract an unknown cache category from inclusive input', () => {
    const usage = normalizeTokenUsage({ total: 100, read: 80 }, mapping)!
    expect(usage.totalInputTokens).toBe(100)
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.cacheCreationInputTokens).toBeUndefined()
  })

  it.each([-1, 1.5, Infinity, NaN, '10', null, Number.MAX_SAFE_INTEGER + 1])('flags invalid counts (%s) without replacing them with zero', value => {
    const usage = normalizeTokenUsage({ input: value }, mapping)!
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.sources.inputTokens).toEqual(['message.usage.input'])
    expect(usage.issues).toHaveLength(1)
  })

  it('does not overwrite invalid reported values with derived ones', () => {
    const usage = normalizeTokenUsage({ input: -1, total: 100, read: 80, write: 0 }, mapping)!
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.issues).not.toHaveLength(0)
  })

  it('does not clamp inconsistent totals into a valid-looking breakdown', () => {
    const usage = normalizeTokenUsage({ total: 10, read: 20, write: 0 }, mapping)!
    expect(usage.totalInputTokens).toBe(10)
    expect(usage.cacheReadInputTokens).toBe(20)
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.issues.length).toBeGreaterThan(0)
    const mismatch = normalizeTokenUsage({ input: 10, read: 20, write: 0, total: 100 }, mapping)!
    expect(mismatch.totalInputTokens).toBe(100)
    expect(mismatch.issues.length).toBeGreaterThan(0)
  })

  it('requires an explicit output inclusion rule before deriving non-reasoning output', () => {
    const record = { output: 30, reasoning: 20 }
    expect(normalizeTokenUsage(record, mapping)?.contentOutputTokens).toBeUndefined()
    const usage = normalizeTokenUsage(record, { ...mapping, outputIncludesReasoning: true })!
    expect(usage.contentOutputTokens).toBe(10)
    expect(usage.sources.contentOutputTokens).toEqual(['message.usage.output', 'message.usage.reasoning'])
    expect(normalizeTokenUsage({ output: 30, reasoning: 0 }, { ...mapping, outputIncludesReasoning: true })?.contentOutputTokens).toBe(30)
  })

  it('flags reasoning greater than output without deriving a negative count', () => {
    const usage = normalizeTokenUsage({ output: 1, reasoning: 2 }, { ...mapping, outputIncludesReasoning: true })!
    expect(usage.reasoningOutputTokens).toBe(2)
    expect(usage.contentOutputTokens).toBeUndefined()
    expect(usage.issues).toHaveLength(1)
  })

  it('rejects a derived total beyond safe integer precision', () => {
    const usage = normalizeTokenUsage({ input: Number.MAX_SAFE_INTEGER, read: 1, write: 0 }, mapping)!
    expect(usage.totalInputTokens).toBeUndefined()
    expect(usage.issues).toHaveLength(1)
  })
})

describe('cacheReadShare', () => {
  it('divides cache reads by total input', () => {
    expect(cacheReadShare({ cacheReadInputTokens: 40, totalInputTokens: 100 })).toBeCloseTo(0.4)
  })

  it('returns undefined when either figure is missing', () => {
    expect(cacheReadShare({ totalInputTokens: 100 })).toBeUndefined()
    expect(cacheReadShare({ cacheReadInputTokens: 40 })).toBeUndefined()
  })

  it('returns undefined when total input is zero, avoiding a divide by zero', () => {
    expect(cacheReadShare({ cacheReadInputTokens: 0, totalInputTokens: 0 })).toBeUndefined()
  })

  it('ignores cache writes, counting only reads as hits', () => {
    // 30 reads out of 100 total input is 30%, regardless of any cache writes.
    expect(
      cacheReadShare({
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 50,
        totalInputTokens: 100,
      }),
    ).toBeCloseTo(0.3)
  })
})

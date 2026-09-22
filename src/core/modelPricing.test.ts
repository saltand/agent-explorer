import { describe, expect, it } from 'vitest'
import {
  calculateUsageCost,
  formatUsd,
  parseLiteLlmPricingTable,
  resolveModelPricing,
} from './modelPricing'

describe('parseLiteLlmPricingTable', () => {
  it('retains partial pricing without inventing missing rates', () => {
    const table = parseLiteLlmPricingTable({
      'claude-opus-4-7': {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_creation_input_token_cost: 6.25e-6,
        cache_read_input_token_cost: 5e-7,
        max_tokens: 128000,
      },
      incomplete: {
        input_cost_per_token: 1e-6,
      },
      invalid: { input_cost_per_token: -1, output_cost_per_token: Infinity },
    })

    expect(table['claude-opus-4-7']).toEqual({
      inputCostPerToken: 5e-6,
      outputCostPerToken: 2.5e-5,
      cacheCreationInputTokenCost: 6.25e-6,
      cacheReadInputTokenCost: 5e-7,
    })
    expect(table.incomplete?.inputCostPerToken).toBe(1e-6)
    expect(table.incomplete?.cacheReadInputTokenCost).toBeUndefined()
    expect(table.invalid).toBeUndefined()
  })
})

describe('resolveModelPricing', () => {
  const table = parseLiteLlmPricingTable({
    'claude-opus-4-7': {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
      cache_creation_input_token_cost: 6.25e-6,
      cache_read_input_token_cost: 5e-7,
    },
  })

  it('matches exact and stripped model ids', () => {
    expect(resolveModelPricing(table, 'claude-opus-4-7')).toBeDefined()
    expect(resolveModelPricing(table, 'unknown-model')).toBeUndefined()
  })
})

describe('calculateUsageCost', () => {
  it('computes per-category and total costs', () => {
    const pricing = {
      inputCostPerToken: 5e-6,
      outputCostPerToken: 2.5e-5,
      cacheCreationInputTokenCost: 6.25e-6,
      cacheReadInputTokenCost: 5e-7,
    }

    const breakdown = calculateUsageCost(
      {
        inputTokens: 6,
        cacheCreationInputTokens: 30175,
        cacheReadInputTokens: 25392,
        outputTokens: 1042,
      },
      pricing,
    )

    expect(breakdown.input).toBeCloseTo(0.00003)
    expect(breakdown.total).toBeGreaterThan(0)
    expect(formatUsd(breakdown.total!)).toMatch(/^\$/)
  })

  const pricing = { inputCostPerToken: 1, outputCostPerToken: 2, cacheCreationInputTokenCost: 3, cacheReadInputTokenCost: 0.5 }

  it('does not turn unknown counts into free tokens or a complete total', () => {
    const result = calculateUsageCost({ inputTokens: 10, outputTokens: 2 }, pricing)
    expect(result).toMatchObject({ input: 10, output: 4, subtotal: 14 })
    expect(result.cacheRead).toBeUndefined()
    expect(result.cacheCreation).toBeUndefined()
    expect(result.total).toBeUndefined()
  })

  it('prices known categories without falling back to ordinary input rates', () => {
    const result = calculateUsageCost({ inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 8 }, { inputCostPerToken: 1, outputCostPerToken: 2 })
    expect(result.subtotal).toBe(14)
    expect(result.cacheCreation).toBe(0)
    expect(result.cacheRead).toBeUndefined()
    expect(result.total).toBeUndefined()
  })

  it('does not charge total input or reasoning a second time', () => {
    const result = calculateUsageCost({ inputTokens: 10, totalInputTokens: 23, cacheReadInputTokens: 8, cacheCreationInputTokens: 5, outputTokens: 6, reasoningOutputTokens: 4 }, pricing)
    expect(result.total).toBe(10 + 4 + 15 + 12)
  })

  it('accepts explicit zero counts without requiring rates', () => {
    expect(calculateUsageCost({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, {}).total).toBe(0)
    expect(calculateUsageCost({}, {}).subtotal).toBeUndefined()
  })

  it('withholds a total for invalid or inconsistent usage', () => {
    expect(calculateUsageCost({ inputTokens: -1, outputTokens: NaN }, pricing).subtotal).toBeUndefined()
    expect(calculateUsageCost({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, issues: ['Inconsistent counts'] }, pricing).total).toBeUndefined()
  })

  it('formats small and large USD amounts', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('$0.0040')
    expect(formatUsd(0.42)).toBe('$0.42')
  })
})

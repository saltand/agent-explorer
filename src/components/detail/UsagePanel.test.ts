import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageDetails } from './UsagePanel'
import { normalizeTokenUsage } from '../../core/tokenUsage'

const mapping = {
  path: 'message.usage',
  fields: { inputTokens: 'input', cacheReadInputTokens: 'read', cacheCreationInputTokens: 'write', outputTokens: 'output', reasoningOutputTokens: 'reasoning' },
  outputIncludesReasoning: true,
}
const pricingTable = { test: { inputCostPerToken: 1, outputCostPerToken: 2, cacheReadInputTokenCost: 0.5, cacheCreationInputTokenCost: 3 } }

function render(record: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(UsageDetails, {
    usage: normalizeTokenUsage(record, mapping)!, model: 'test', pricingState: 'ready', pricingTable,
  }))
}

describe('Usage details', () => {
  it('distinguishes unknown cache counts from explicit zero and labels incomplete estimates', () => {
    const html = render({ input: 0, output: 2 })
    expect(html).toContain('0 ($0.00)')
    expect(html).toContain('Not reported')
    expect(html).toContain('Estimated subtotal')
    expect(html).toContain('Incomplete:')
    expect(html).not.toContain('Estimated total')
    expect(html).not.toContain('Non-reasoning output tokens')
  })

  it('shows known output breakdown, total estimate and inspectable source paths', () => {
    const html = render({ input: 10, read: 8, write: 0, output: 6, reasoning: 2 })
    expect(html).toContain('Estimated total')
    expect(html).toContain('$26.00')
    expect(html).toContain('Non-reasoning output tokens')
    expect(html).toContain('message.usage.reasoning')
    expect(html).not.toContain('Incomplete:')
  })

  it('flags invalid counts and points to original JSON', () => {
    const html = render({ input: -1, output: 2 })
    expect(html).toContain('Recorded usage needs review')
    expect(html).toContain('Raw JSON')
    expect(html).not.toContain('-1 ($')
  })
})

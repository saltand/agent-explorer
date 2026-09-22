import {
  calculateUsageCost,
  formatUsd,
  resolveModelPricing,
  type ModelPricing,
  type UsageCostBreakdown,
} from '../../core/modelPricing'
import type { Selection, TokenCounts, TokenUsage } from '../../core/types'
import { cacheReadShare } from '../../core/tokenUsage'
import { SummaryRow } from './SummaryRow'
import { useModelPricing, type PricingState } from './useModelPricing'

const tokenLabels: Record<keyof TokenCounts, string> = {
  totalInputTokens: 'Total input tokens',
  inputTokens: 'Ordinary input tokens',
  cacheCreationInputTokens: 'Cache write tokens',
  cacheReadInputTokens: 'Cache read tokens',
  outputTokens: 'Output tokens',
  reasoningOutputTokens: 'Reasoning tokens',
  contentOutputTokens: 'Non-reasoning output tokens',
}

function formatMetricValue(
  count: number | undefined,
  cost: number | undefined,
  pricingState: PricingState,
): string {
  if (count === undefined) return 'Not reported'
  if (cost === undefined || pricingState !== 'ready') {
    return count.toLocaleString()
  }
  return `${count.toLocaleString()} (${formatUsd(cost)})`
}

export function UsagePanel({ selection }: { selection: Selection }) {
  const { pricingState, pricingTable } = useModelPricing()

  const { usage, model } = selection.event || {}
  if (!usage) return null
  return <UsageDetails usage={usage} model={model} pricingState={pricingState} pricingTable={pricingTable} />
}

export function UsageDetails({ usage, model, pricingState, pricingTable }: {
  usage: TokenUsage
  model?: string
  pricingState: PricingState
  pricingTable: Record<string, ModelPricing> | null
}) {
  const modelPricing =
    pricingState === 'ready' && pricingTable
      ? resolveModelPricing(pricingTable, model)
      : undefined

  const costs: UsageCostBreakdown | undefined = modelPricing
    ? calculateUsageCost(usage, modelPricing)
    : undefined

  const rows: Array<{ label: string; value: string }> = []

  if (model) rows.push({ label: 'Model', value: model })

  rows.push({
    label: tokenLabels.totalInputTokens,
    value: formatMetricValue(usage.totalInputTokens, undefined, pricingState),
  })
  rows.push({
    label: tokenLabels.inputTokens,
    value: formatMetricValue(usage.inputTokens, costs?.input, pricingState),
  })
  rows.push({
    label: tokenLabels.cacheCreationInputTokens,
    value: formatMetricValue(
      usage.cacheCreationInputTokens,
      costs?.cacheCreation,
      pricingState,
    ),
  })
  rows.push({
    label: tokenLabels.cacheReadInputTokens,
    value: formatMetricValue(usage.cacheReadInputTokens, costs?.cacheRead, pricingState),
  })
  // Cache hit rate needs cache reads and total input on the same basis.
  const share = cacheReadShare(usage)
  if (share !== undefined) {
    rows.push({ label: 'Cache read share', value: `${(share * 100).toFixed(1)}% of total input` })
  }
  rows.push({
    label: tokenLabels.outputTokens,
    value: formatMetricValue(usage.outputTokens, costs?.output, pricingState),
  })
  rows.push({
    label: tokenLabels.reasoningOutputTokens,
    value: formatMetricValue(usage.reasoningOutputTokens, undefined, pricingState),
  })
  if (usage.contentOutputTokens !== undefined) {
    rows.push({
      label: tokenLabels.contentOutputTokens,
      value: formatMetricValue(usage.contentOutputTokens, undefined, pricingState),
    })
  }

  if (pricingState === 'loading' || pricingState === 'idle') {
    rows.push({ label: 'Estimated total', value: 'Fetching model pricing...' })
  } else if (pricingState === 'error') {
    rows.push({ label: 'Estimated total', value: 'Pricing unavailable' })
  } else if (costs?.total !== undefined) {
    rows.push({ label: 'Estimated total', value: formatUsd(costs.total) })
  } else if (costs) {
    rows.push({
      label: 'Estimated subtotal',
      value: costs.subtotal === undefined ? 'Unavailable' : formatUsd(costs.subtotal),
    })
    rows.push({
      label: 'Estimate status',
      value: usage.issues.length > 0
        ? 'Incomplete: recorded usage contains invalid or inconsistent counts.'
        : 'Incomplete: some token counts or prices are not available.',
    })
  } else {
    rows.push({ label: 'Estimated total', value: model ? 'Pricing unavailable for this model' : 'Model not reported' })
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <SummaryRow key={row.label} label={row.label} value={row.value} />
      ))}
      <p className="text-xs text-secondary">
        Total input includes ordinary input, cache reads and cache writes.
        Missing counts are not treated as zero. Estimates use current model prices.
      </p>
      {usage.issues.length > 0 && (
        <div role="note" className="text-xs text-warning-text">
          <p>Recorded usage needs review. See Raw JSON for the original values.</p>
          <ul className="list-disc space-y-1 pl-4">
            {usage.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}
      <details className="text-xs text-secondary">
        <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-accent">Token field sources</summary>
        <div className="mt-2 flex flex-col gap-2">
          {(Object.entries(usage.sources) as [keyof TokenCounts, string[]][]).map(([field, paths]) => (
            <SummaryRow key={field} label={tokenLabels[field]} value={paths.join(', ')} />
          ))}
        </div>
      </details>
    </div>
  )
}

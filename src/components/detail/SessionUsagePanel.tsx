import { useMemo } from 'react'
import {
  calculateUsageCost,
  formatUsd,
  resolveModelPricing,
  type UsageCostBreakdown,
} from '../../core/modelPricing'
import { computeSessionUsage } from '../../core/sessionUsage'
import type { ExplorerSession } from '../../core/types'
import { SummaryRow } from './SummaryRow'
import { useModelPricing, type PricingState } from './useModelPricing'

function formatCount(value: number | undefined): string {
  return value === undefined ? 'Not reported' : value.toLocaleString()
}

function formatCountAndCost(
  count: number | undefined,
  cost: number | undefined,
  pricingState: PricingState,
): string {
  if (count === undefined) return 'Not reported'
  if (cost === undefined || pricingState !== 'ready') return count.toLocaleString()
  return `${count.toLocaleString()} (${formatUsd(cost)})`
}

export function SessionUsagePanel({ session }: { session: ExplorerSession }) {
  const { pricingState, pricingTable } = useModelPricing()
  const usage = useMemo(() => computeSessionUsage(session), [session])

  if (usage.requestCount === 0 && usage.issues.length === 0) {
    return (
      <p className="text-xs text-secondary">
        This session records no token usage.
      </p>
    )
  }

  // One price only applies when the whole session used one model.
  const singleModel = usage.models.length === 1 ? usage.models[0] : undefined
  const pricing =
    pricingState === 'ready' && pricingTable && singleModel
      ? resolveModelPricing(pricingTable, singleModel)
      : undefined
  const costs: UsageCostBreakdown | undefined = pricing
    ? calculateUsageCost(usage, pricing)
    : undefined

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Requests', value: usage.requestCount.toLocaleString() },
  ]

  if (usage.duplicateCount > 0) {
    rows.push({
      label: 'Repeated records',
      value: `${usage.duplicateCount.toLocaleString()} collapsed`,
    })
  }
  if (usage.models.length > 0) {
    rows.push({ label: 'Models', value: usage.models.join(', ') })
  }

  rows.push({ label: 'Total input tokens', value: formatCount(usage.totalInputTokens) })
  rows.push({
    label: 'Ordinary input tokens',
    value: formatCountAndCost(usage.inputTokens, costs?.input, pricingState),
  })
  rows.push({
    label: 'Cache write tokens',
    value: formatCountAndCost(usage.cacheCreationInputTokens, costs?.cacheCreation, pricingState),
  })
  rows.push({
    label: 'Cache read tokens',
    value: formatCountAndCost(usage.cacheReadInputTokens, costs?.cacheRead, pricingState),
  })
  rows.push({
    label: 'Output tokens',
    value: formatCountAndCost(usage.outputTokens, costs?.output, pricingState),
  })
  if (usage.reasoningOutputTokens !== undefined) {
    rows.push({ label: 'Reasoning tokens', value: formatCount(usage.reasoningOutputTokens) })
  }

  // Cache hit rate needs both figures on the same basis and a non-zero divisor.
  if (
    usage.cacheReadInputTokens !== undefined &&
    usage.totalInputTokens !== undefined &&
    usage.totalInputTokens > 0 &&
    !usage.incomplete
  ) {
    const rate = (usage.cacheReadInputTokens / usage.totalInputTokens) * 100
    rows.push({ label: 'Cache read share', value: `${rate.toFixed(1)}% of total input` })
  }

  if (usage.summedTotalTokens !== undefined) {
    rows.push({ label: 'Summed requests', value: `${usage.summedTotalTokens.toLocaleString()} tokens` })
  }
  if (usage.reportedSessionTotalTokens !== undefined) {
    rows.push({
      label: 'Log session total',
      value: `${usage.reportedSessionTotalTokens.toLocaleString()} tokens`,
    })
  }
  if (usage.inheritedTotalTokens !== undefined) {
    rows.push({
      label: 'Resumed from',
      value: `${usage.inheritedTotalTokens.toLocaleString()} tokens spent before this log`,
    })
  }

  if (pricingState === 'loading' || pricingState === 'idle') {
    rows.push({ label: 'Estimated total', value: 'Fetching model pricing...' })
  } else if (pricingState === 'error') {
    rows.push({ label: 'Estimated total', value: 'Pricing unavailable' })
  } else if (usage.models.length > 1) {
    rows.push({
      label: 'Estimated total',
      value: 'Unavailable: session mixes models, which need separate prices',
    })
  } else if (costs?.total !== undefined) {
    rows.push({ label: 'Estimated total', value: formatUsd(costs.total) })
  } else if (costs) {
    rows.push({
      label: 'Estimated subtotal',
      value: costs.subtotal === undefined ? 'Unavailable' : formatUsd(costs.subtotal),
    })
  } else {
    rows.push({
      label: 'Estimated total',
      value: singleModel ? 'Pricing unavailable for this model' : 'Model not reported',
    })
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <SummaryRow key={row.label} label={row.label} value={row.value} />
      ))}
      <p className="text-xs text-secondary">
        Covers requests that recorded usage. Repeated records of one request are
        counted once. Missing counts are not treated as zero.
      </p>
      {usage.issues.length > 0 && (
        <div role="note" className="text-xs text-warning-text">
          <p>This total does not cover the whole session.</p>
          <ul className="list-disc space-y-1 pl-4">
            {usage.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

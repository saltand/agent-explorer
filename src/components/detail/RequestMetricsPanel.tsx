import { useMemo } from 'react'
import { requestMetricsForEvent, type RequestMetrics } from '../../core/requestMetrics'
import type { ExplorerSession, Selection } from '../../core/types'
import { SummaryRow } from './SummaryRow'

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${Math.round(seconds % 60)} s`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const base = d.toLocaleTimeString('en-GB', { hour12: false })
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function formatSpeed(tokens: number, perSec: number | undefined): string {
  return perSec === undefined
    ? `${tokens.toLocaleString()} tokens`
    : `${tokens.toLocaleString()} tokens · ${perSec.toFixed(1)} tok/s`
}

function MetricRows({ metrics }: { metrics: RequestMetrics }) {
  const rows: Array<{ label: string; value: string }> = []
  if (metrics.startedAt !== undefined) {
    rows.push({ label: 'Started', value: formatTime(metrics.startedAt) })
  }
  if (metrics.endedAt !== undefined) {
    rows.push({ label: 'Completed', value: formatTime(metrics.endedAt) })
  }
  rows.push({
    label: 'Total duration',
    value: metrics.totalMs === undefined ? 'Not recorded' : formatMs(metrics.totalMs),
  })
  rows.push({
    label: 'TTFT',
    value: metrics.ttftMs === undefined ? 'Not recorded' : formatMs(metrics.ttftMs),
  })
  rows.push({
    label: 'Generation',
    value:
      metrics.generationMs === undefined ? 'Not recorded' : formatMs(metrics.generationMs),
  })
  if (metrics.outputTokens !== undefined) {
    rows.push({
      label: 'Output speed',
      value: formatSpeed(metrics.outputTokens, metrics.outputTokensPerSec),
    })
  }
  return (
    <>
      {rows.map((row) => (
        <SummaryRow key={row.label} label={row.label} value={row.value} />
      ))}
    </>
  )
}

/**
 * Timing metrics for the request and turn the selected record belongs to.
 * Metrics whose evidence the log does not contain render as "Not recorded"
 * rather than being estimated from neighbouring events.
 */
export function RequestMetricsPanel({
  session,
  selection,
}: {
  session: ExplorerSession
  selection: Selection
}) {
  const event = selection.event
  const metrics = useMemo(
    () => (event ? requestMetricsForEvent(session, event) : []),
    [session, event],
  )
  if (!event || metrics.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {metrics.map((metric) => (
        <section key={metric.subject} className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-primary">{metric.subject} timing</h4>
          <MetricRows metrics={metric} />
          <p className="text-[11px] leading-relaxed text-tertiary">
            {metric.basis.join('; ')}.
          </p>
        </section>
      ))}
    </div>
  )
}

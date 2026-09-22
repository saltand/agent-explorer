import { isTokenCount } from './tokenUsage'
import { UsageAccumulator, type UsageAggregate } from './usageAggregate'
import type { ExplorerSession, TokenCounts, TokenUsage } from './types'

/** Billable total for one record, mirroring how logs compute their running total. */
export function billableTotal(counts: TokenCounts): number | undefined {
  const input = isTokenCount(counts.totalInputTokens)
    ? counts.totalInputTokens
    : [counts.inputTokens, counts.cacheReadInputTokens, counts.cacheCreationInputTokens].reduce<
        number | undefined
      >((sum, value) => (sum === undefined || !isTokenCount(value) ? undefined : sum + value), 0)
  if (input === undefined || !isTokenCount(counts.outputTokens)) return undefined
  return input + counts.outputTokens
}

/** Per-turn usage, ordered by the turn's first appearance in the log. */
export interface TurnUsage {
  /** 1-based turn number as assigned by the adapter, or 0 when unknown. */
  turnIndex: number
  /** Aggregated usage for the requests inside this turn. */
  usage: UsageAggregate
  /** Billable total for the turn, when derivable. */
  totalTokens?: number
  /** Line index of the turn's first usage record, for locating it in a panel. */
  firstLineIndex?: number
}

/** One request singled out because it consumed a lot, with where to find it. */
export interface RequestUsage {
  /** Line index of the originating timeline event. */
  lineIndex: number
  turnIndex?: number
  model?: string
  usage: TokenUsage
  /** Billable total for the request, used for ranking. */
  totalTokens: number
}

export interface SessionTurnBreakdown {
  turns: TurnUsage[]
  /** Requests ranked by billable total, largest first. */
  topRequests: RequestUsage[]
  /** True when at least one usage record could not be assigned to a turn. */
  hasUnassignedTurn: boolean
}

/**
 * Groups a session's recorded usage by turn and ranks its heaviest requests.
 * Records are read in file order so repeats collapse the same way they do in
 * the session-wide total. Only records that carry a per-request usage object
 * participate; cumulative snapshots are handled by {@link UsageAccumulator} and
 * do not appear as their own requests.
 */
export function computeSessionTurns(
  session: ExplorerSession,
  options: { topRequestLimit?: number } = {},
): SessionTurnBreakdown {
  const limit = options.topRequestLimit ?? 5
  const perTurn = new Map<number, { accumulator: UsageAccumulator; firstLineIndex?: number }>()
  const turnOrder: number[] = []
  const requests: RequestUsage[] = []
  let hasUnassignedTurn = false

  for (const event of session.events) {
    const usage = event.usage
    if (!usage) continue
    const turnIndex = event.turnIndex ?? 0
    if (event.turnIndex === undefined) hasUnassignedTurn = true

    let entry = perTurn.get(turnIndex)
    if (!entry) {
      entry = { accumulator: new UsageAccumulator(), firstLineIndex: event.lineIndex }
      perTurn.set(turnIndex, entry)
      turnOrder.push(turnIndex)
    }
    entry.accumulator.add(usage, event.model)

    // Cumulative snapshots already fold every earlier request in, so ranking
    // them as individual requests would double count the session.
    if (usage.scope !== 'cumulative') {
      const total = billableTotal(usage)
      if (total !== undefined) {
        requests.push({
          lineIndex: event.lineIndex,
          turnIndex: event.turnIndex,
          model: event.model,
          usage,
          totalTokens: total,
        })
      }
    }
  }

  const turns: TurnUsage[] = turnOrder.map((turnIndex) => {
    const entry = perTurn.get(turnIndex)!
    const usage = entry.accumulator.result()
    return {
      turnIndex,
      usage,
      totalTokens: billableTotal(usage),
      firstLineIndex: entry.firstLineIndex,
    }
  })

  // A request may repeat across streaming records; rank by the largest total
  // seen per line so the same request is not listed twice.
  const bestByLine = new Map<number, RequestUsage>()
  for (const request of requests) {
    const existing = bestByLine.get(request.lineIndex)
    if (!existing || request.totalTokens > existing.totalTokens) {
      bestByLine.set(request.lineIndex, request)
    }
  }
  const topRequests = [...bestByLine.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit)

  return { turns, topRequests, hasUnassignedTurn }
}

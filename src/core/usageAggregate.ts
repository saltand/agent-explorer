import { isTokenCount } from './tokenUsage'
import type { TokenCounts, TokenUsage } from './types'

export interface UsageAggregate extends TokenCounts {
  /** Requests counted, after collapsing repeated records of one request. */
  requestCount: number
  /** Records dropped as repeats of an already-counted request. */
  duplicateCount: number
  /** Models seen among counted requests, in first-seen order. */
  models: string[]
  /** Aggregation-level problems, separate from each record's own issues. */
  issues: string[]
  /**
   * True when some counted request omitted a category, so totals for that
   * category cover only part of the session.
   */
  incomplete: boolean
  /**
   * Tokens the log's own running total attributes to this session, after
   * removing any total inherited from a session it resumed. Logs that skip a
   * request's usage event still advance this figure, so it can exceed the
   * summed requests and is then the better session-level answer.
   */
  reportedSessionTotalTokens?: number
  /**
   * Running total already present before this log's first request, when it
   * resumes an earlier session. Those tokens were spent outside this log.
   */
  inheritedTotalTokens?: number
  /** Billable total of the summed requests, for comparison with the above. */
  summedTotalTokens?: number
}

const COUNT_FIELDS: (keyof TokenCounts)[] = [
  'inputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'totalInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'contentOutputTokens',
]

interface FieldState {
  sum: number
  /** Requests that reported this field, compared against requestCount. */
  reported: number
}

/** Total billable tokens, mirroring how logs compute their own running total. */
function recordTotal(usage: TokenCounts): number | undefined {
  const input = isTokenCount(usage.totalInputTokens)
    ? usage.totalInputTokens
    : [usage.inputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens].reduce<
        number | undefined
      >((sum, value) => (sum === undefined || !isTokenCount(value) ? undefined : sum + value), 0)
  if (input === undefined || !isTokenCount(usage.outputTokens)) return undefined
  return input + usage.outputTokens
}

/**
 * Sums per-request token usage while tracking what it had to leave out, so a
 * session total can state whether it covers every request. Records are added
 * one at a time so a growing session does not need a full rescan.
 */
export class UsageAccumulator {
  private fields = new Map<keyof TokenCounts, FieldState>()
  /** Last counted record per request key, so a superseded one can be undone. */
  private countedByKey = new Map<string, TokenUsage>()
  private modelSet = new Set<string>()
  private models: string[] = []
  private requestCount = 0
  private duplicateCount = 0
  private skippedCumulative = 0
  /** Largest session-to-date total the log reported, used as a cross-check. */
  private sessionTotal?: number
  /**
   * Running total that predates this log's first request. A resumed session
   * starts its counter above its own first request, and those earlier tokens
   * must not be read as requests this log failed to record.
   */
  private inheritedTotal?: number

  /**
   * Adds one recorded usage object, collapsing repeats of a request it has
   * already counted.
   */
  add(usage: TokenUsage, model?: string): void {
    // A cumulative snapshot already contains every earlier request, so adding it
    // to per-request records would double-count the session.
    if (usage.scope === 'cumulative') {
      this.skippedCumulative += 1
      this.noteSessionTotal(recordTotal(usage))
      return
    }

    const key = usage.requestKey
    if (key !== undefined) {
      const previous = this.countedByKey.get(key)
      if (previous) {
        this.duplicateCount += 1
        // A later record either refines the request's counts or is a stale echo
        // of a finished one; only the former replaces what was counted.
        if (usage.duplicatePolicy !== 'keep-first') {
          this.subtract(previous)
          this.countedByKey.set(key, usage)
          this.accumulate(usage, model)
        }
        return
      }
      this.countedByKey.set(key, usage)
    }
    this.accumulate(usage, model)
  }

  private accumulate(usage: TokenUsage, model?: string): void {
    this.requestCount += 1
    for (const field of COUNT_FIELDS) {
      const value = usage[field]
      if (!isTokenCount(value)) continue
      const state = this.fields.get(field) ?? { sum: 0, reported: 0 }
      state.sum += value
      state.reported += 1
      this.fields.set(field, state)
    }
    if (model !== undefined && !this.modelSet.has(model)) {
      this.modelSet.add(model)
      this.models.push(model)
    }
    this.noteSessionTotal(usage.sessionTotalTokens, recordTotal(usage))
  }

  private subtract(usage: TokenUsage): void {
    this.requestCount -= 1
    for (const field of COUNT_FIELDS) {
      const value = usage[field]
      if (!isTokenCount(value)) continue
      const state = this.fields.get(field)
      if (!state) continue
      state.sum -= value
      state.reported -= 1
    }
  }

  private noteSessionTotal(value: number | undefined, requestTotal?: number): void {
    if (!isTokenCount(value)) return
    if (this.inheritedTotal === undefined) {
      // The first record's running total minus its own counts is whatever the
      // session started with.
      const baseline = isTokenCount(requestTotal) ? value - requestTotal : value
      this.inheritedTotal = baseline > 0 ? baseline : 0
    }
    this.sessionTotal = this.sessionTotal === undefined ? value : Math.max(this.sessionTotal, value)
  }

  result(): UsageAggregate {
    const aggregate: UsageAggregate = {
      requestCount: this.requestCount,
      duplicateCount: this.duplicateCount,
      models: [...this.models],
      issues: [],
      incomplete: false,
    }

    for (const field of COUNT_FIELDS) {
      const state = this.fields.get(field)
      if (!state || state.reported === 0) continue
      aggregate[field] = state.sum
      if (state.reported < this.requestCount) aggregate.incomplete = true
    }

    if (aggregate.incomplete) {
      aggregate.issues.push('Some requests did not report every token category.')
    }

    if (this.requestCount === 0 && this.skippedCumulative > 0) {
      aggregate.issues.push('Session reported only cumulative snapshots, which cannot be summed.')
    }

    // The log's own running total is independent evidence. When it exceeds the
    // summed requests, the log advanced its total without recording usage for
    // every request, so the sum alone would understate the session.
    const summed = recordTotal(aggregate)
    aggregate.summedTotalTokens = summed
    const inherited = this.inheritedTotal ?? 0
    if (inherited > 0) aggregate.inheritedTotalTokens = inherited
    // Compare like with like: only the portion of the running total this log is
    // responsible for.
    const ownTotal =
      this.sessionTotal === undefined ? undefined : this.sessionTotal - inherited
    aggregate.reportedSessionTotalTokens = ownTotal

    if (ownTotal !== undefined && summed !== undefined && this.requestCount > 0) {
      const missing = ownTotal - summed
      if (missing > 0) {
        aggregate.incomplete = true
        aggregate.issues.push(
          `Per-request records cover ${summed.toLocaleString()} tokens, but the log reports ${ownTotal.toLocaleString()} for the session. ${missing.toLocaleString()} tokens belong to requests that recorded no usage.`,
        )
      } else if (missing < 0) {
        aggregate.issues.push(
          `Summed requests (${summed.toLocaleString()}) exceed the session total reported in the log (${ownTotal.toLocaleString()}), so some records may be counted twice.`,
        )
      }
    }
    return aggregate
  }
}

/** Sums usage for a set of records, for callers without incremental needs. */
export function aggregateUsage(
  records: Array<{ usage: TokenUsage; model?: string }>,
): UsageAggregate {
  const accumulator = new UsageAccumulator()
  for (const record of records) accumulator.add(record.usage, record.model)
  return accumulator.result()
}

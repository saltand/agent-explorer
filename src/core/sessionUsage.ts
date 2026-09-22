import { UsageAccumulator, type UsageAggregate } from './usageAggregate'
import type { ExplorerSession } from './types'

/**
 * Sums every recorded usage event in a session. Events are fed in file order so
 * repeated records of one request collapse the same way they would while the
 * log is still being appended to.
 */
export function computeSessionUsage(session: ExplorerSession): UsageAggregate {
  const accumulator = new UsageAccumulator()
  for (const event of session.events) {
    if (event.usage) accumulator.add(event.usage, event.model)
  }
  return accumulator.result()
}

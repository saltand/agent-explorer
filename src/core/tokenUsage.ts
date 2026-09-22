import type { TokenCounts, TokenUsage } from './types'

interface UsageMapping {
  /** Path to the usage object within the original event. */
  path: string
  /** Map inclusive input to totalInputTokens, never to inputTokens. */
  fields: Partial<Record<Exclude<keyof TokenCounts, 'contentOutputTokens'>, string>>
  outputIncludesReasoning?: boolean
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Cache read share on the "cache read tokens ÷ total input tokens" basis. Only
 * returns a value when both figures are known on the same basis and the divisor
 * is positive; cache writes never count as a hit. A ratio in `[0, 1]`, so the
 * caller decides how to present it.
 */
export function cacheReadShare(counts: TokenCounts): number | undefined {
  const read = counts.cacheReadInputTokens
  const total = counts.totalInputTokens
  if (!isTokenCount(read) || !isTokenCount(total) || total <= 0) return undefined
  return read / total
}

/** Normalize one recorded usage object without inferring absent cache or reasoning counts. */
export function normalizeTokenUsage(
  record: Record<string, unknown>,
  mapping: UsageMapping,
): TokenUsage | undefined {
  const usage: TokenUsage = { sources: {}, issues: [] }
  let hasField = false
  for (const [field, key] of Object.entries(mapping.fields)) {
    const value = record[key]
    if (value === undefined) continue
    hasField = true
    const target = field as keyof TokenCounts
    const path = `${mapping.path}.${key}`
    usage.sources[target] = [path]
    if (isTokenCount(value)) usage[target] = value
    else usage.issues.push(`${path}: expected a non-negative safe integer.`)
  }
  if (!hasField) return undefined

  function derive(target: keyof TokenCounts, operands: (keyof TokenCounts)[], value: number) {
    // Do not replace a reported invalid value with an inferred value.
    if (usage.sources[target] !== undefined) return
    if (!isTokenCount(value)) {
      usage.issues.push(`${target}: recorded counts cannot produce a valid total.`)
      return
    }
    usage[target] = value
    usage.sources[target] = operands.flatMap(field => usage.sources[field] ?? [])
  }

  const { inputTokens: input, cacheReadInputTokens: read, cacheCreationInputTokens: write,
    totalInputTokens: total, outputTokens: output, reasoningOutputTokens: reasoning } = usage
  if (input !== undefined && read !== undefined && write !== undefined) {
    const sum = input + read + write
    if (total !== undefined && total !== sum) {
      usage.issues.push('Total input differs from ordinary input plus cache reads and writes.')
    } else {
      derive('totalInputTokens', ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'], sum)
    }
  } else if (total !== undefined && read !== undefined && write !== undefined) {
    derive('inputTokens', ['totalInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'], total - read - write)
  }
  if (total !== undefined && (input ?? 0) + (read ?? 0) + (write ?? 0) > total) {
    usage.issues.push('Known input categories exceed the recorded total input.')
  }
  if (mapping.outputIncludesReasoning && output !== undefined && reasoning !== undefined) {
    derive('contentOutputTokens', ['outputTokens', 'reasoningOutputTokens'], output - reasoning)
  }
  return usage
}

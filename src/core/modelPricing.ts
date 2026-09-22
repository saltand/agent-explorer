import type { TokenCounts, TokenUsage } from './types'
import { isTokenCount } from './tokenUsage'

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export interface ModelPricing {
  inputCostPerToken?: number
  outputCostPerToken?: number
  cacheCreationInputTokenCost?: number
  cacheReadInputTokenCost?: number
}

export interface UsageCostBreakdown {
  input?: number
  cacheCreation?: number
  cacheRead?: number
  output?: number
  /** Only known and priced categories, including explicit zeroes. */
  subtotal?: number
  /** Present only when every billable category is known and priced. */
  total?: number
}

let pricingCache: Record<string, ModelPricing> | null = null
let pricingPromise: Promise<Record<string, ModelPricing>> | null = null

function readCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseLiteLlmPricingTable(
  data: Record<string, unknown>,
): Record<string, ModelPricing> {
  const result: Record<string, ModelPricing> = {}

  for (const [model, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>

    const inputCostPerToken = readCost(record.input_cost_per_token)
    const outputCostPerToken = readCost(record.output_cost_per_token)
    const cacheCreationInputTokenCost = readCost(record.cache_creation_input_token_cost)
    const cacheReadInputTokenCost = readCost(record.cache_read_input_token_cost)

    if (
      inputCostPerToken === undefined &&
      outputCostPerToken === undefined &&
      cacheCreationInputTokenCost === undefined &&
      cacheReadInputTokenCost === undefined
    ) {
      continue
    }

    result[model] = {
      inputCostPerToken,
      outputCostPerToken,
      cacheCreationInputTokenCost,
      cacheReadInputTokenCost,
    }
  }

  return result
}

export async function fetchModelPricing(
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, ModelPricing>> {
  if (pricingCache) return pricingCache
  if (!pricingPromise) {
    pricingPromise = fetchImpl(LITELLM_PRICING_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to fetch model pricing (${response.status})`)
        }
        return response.json() as Promise<Record<string, unknown>>
      })
      .then((data) => {
        pricingCache = parseLiteLlmPricingTable(data)
        return pricingCache
      })
      .catch((error) => {
        pricingPromise = null
        throw error
      })
  }
  return pricingPromise
}

export function resetModelPricingCache(): void {
  pricingCache = null
  pricingPromise = null
}

export function resolveModelPricing(
  table: Record<string, ModelPricing>,
  model: string | undefined,
): ModelPricing | undefined {
  if (!model) return undefined
  if (table[model]) return table[model]

  const normalized = model.toLowerCase()
  const exactIgnoreCase = Object.entries(table).find(
    ([key]) => key.toLowerCase() === normalized,
  )
  if (exactIgnoreCase) return exactIgnoreCase[1]

  const stripped = model.replace(/-20\d{6}$/, '')
  if (stripped !== model && table[stripped]) return table[stripped]

  return undefined
}

export function calculateUsageCost(
  usage: TokenCounts & Partial<Pick<TokenUsage, 'issues'>>,
  pricing: ModelPricing,
): UsageCostBreakdown {
  function cost(count: number | undefined, rate: number | undefined): number | undefined {
    if (!isTokenCount(count)) return undefined
    if (count === 0) return 0
    if (readCost(rate) === undefined) return undefined
    return readCost(count * rate!)
  }
  // Total input and reasoning are not additional billable categories.
  const input = cost(usage.inputTokens, pricing.inputCostPerToken)
  const cacheCreation = cost(usage.cacheCreationInputTokens, pricing.cacheCreationInputTokenCost)
  const cacheRead = cost(usage.cacheReadInputTokens, pricing.cacheReadInputTokenCost)
  const output = cost(usage.outputTokens, pricing.outputCostPerToken)
  const known = [input, cacheCreation, cacheRead, output].filter(value => value !== undefined)
  const subtotal = known.length > 0 ? readCost(known.reduce((sum, value) => sum + value, 0)) : undefined

  return {
    input,
    cacheCreation,
    cacheRead,
    output,
    subtotal,
    total: known.length === 4 && !usage.issues?.length ? subtotal : undefined,
  }
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00'
  const abs = Math.abs(amount)
  if (abs < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

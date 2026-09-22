import { useEffect, useState } from 'react'
import { fetchModelPricing, type ModelPricing } from '../../core/modelPricing'

export type PricingState = 'idle' | 'loading' | 'ready' | 'error'

/** Loads the shared pricing table once and reports its state to callers. */
export function useModelPricing(): {
  pricingState: PricingState
  pricingTable: Record<string, ModelPricing> | null
} {
  const [pricingState, setPricingState] = useState<PricingState>('idle')
  const [pricingTable, setPricingTable] = useState<Record<string, ModelPricing> | null>(null)

  useEffect(() => {
    let cancelled = false
    setPricingState('loading')
    void fetchModelPricing()
      .then((table) => {
        if (cancelled) return
        setPricingTable(table)
        setPricingState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setPricingState('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  return { pricingState, pricingTable }
}

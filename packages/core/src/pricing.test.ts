import { describe, expect, it } from 'vitest'
import {
  addUsage,
  costOfUsage,
  defaultPricing,
  emptyUsage,
  mergePricing,
  pricingFor,
  totalTokens,
  type UsageTotals,
} from './pricing.js'

const usage = (over: Partial<UsageTotals>): UsageTotals => ({ ...emptyUsage(), ...over })

describe('defaultPricing', () => {
  it('derives cache rates from base input: 1.25x (5m), 2x (1h), 0.1x (read)', () => {
    const opus = defaultPricing['claude-opus-5']!
    expect(opus).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 })
  })

  it('prices fable-5-1 cache reads at the flat $0.25/MTok, fable-5 at 0.1x', () => {
    expect(defaultPricing['claude-fable-5-1']!.cacheRead).toBe(0.25)
    expect(defaultPricing['claude-fable-5']!.cacheRead).toBe(1)
  })
})

describe('pricingFor', () => {
  it('matches exact, date-suffixed, and prefixed ids; unknown is undefined', () => {
    expect(pricingFor('claude-haiku-4-5', defaultPricing)).toBeDefined()
    expect(pricingFor('claude-haiku-4-5-20251001', defaultPricing)).toEqual(
      defaultPricing['claude-haiku-4-5'],
    )
    expect(pricingFor('claude-sonnet-5-something', defaultPricing)).toEqual(
      defaultPricing['claude-sonnet-5'],
    )
    expect(pricingFor('claude-3-5-sonnet-20241022', defaultPricing)).toBeUndefined()
    expect(pricingFor('<synthetic>', defaultPricing)).toBeUndefined()
  })
})

describe('costOfUsage', () => {
  it('computes dollars per token class and reports unpriced models', () => {
    const { usd, unpriced } = costOfUsage({
      // 1M of everything on opus-5: 5 + 25 + 0.5 + 6.25 + 10 = 46.75
      'claude-opus-5': usage({
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
      }),
      'claude-ancient-1': usage({ output: 5 }),
      'claude-ancient-0-tokens': usage({}),
    })
    expect(usd).toBeCloseTo(46.75, 6)
    // zero-token unknown models don't count as unpriced
    expect(unpriced).toEqual(['claude-ancient-1'])
  })

  it('honors config overrides via mergePricing, including new models', () => {
    const table = mergePricing({
      'claude-opus-5': { output: 30 },
      'claude-ancient-1': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    })
    expect(costOfUsage({ 'claude-opus-5': usage({ output: 1_000_000 }) }, table).usd).toBe(30)
    const ancient = costOfUsage({ 'claude-ancient-1': usage({ input: 2_000_000 }) }, table)
    expect(ancient.usd).toBe(2)
    expect(ancient.unpriced).toEqual([])
  })
})

describe('usage arithmetic', () => {
  it('adds and totals', () => {
    const into = usage({ input: 1, output: 2 })
    addUsage(into, usage({ input: 10, cacheRead: 5, cacheWrite5m: 3, cacheWrite1h: 4, output: 1 }))
    expect(into).toEqual({ input: 11, output: 3, cacheRead: 5, cacheWrite5m: 3, cacheWrite1h: 4 })
    expect(totalTokens(into)).toBe(26)
  })
})

/**
 * Token usage accounting and cost estimation.
 *
 * Tokens are facts (read off transcript lines); dollars are estimates
 * (tokens × a pricing table that drifts). The default table covers the
 * current model generation, priced in USD per million tokens; unknown
 * models still get full token accounting and are reported as unpriced
 * rather than silently costing $0. config.json `pricing` entries merge
 * over the defaults, so users can add legacy models or correct drift.
 *
 * Cache economics (Anthropic first-party API): writes cost 1.25× base
 * input for the 5-minute TTL and 2× for the 1-hour TTL; reads cost 0.1×
 * base input — except claude-fable-5-1 / claude-mythos-5-1, which read at
 * a flat $0.25/MTok (0.025×).
 */

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /** Thinking tokens — a SUBSET of output (same price), tracked for insight.
   * Never added to cost or totals separately, or it would double-count. */
  thinking: number
}

export const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  thinking: 0,
})

export function addUsage(into: UsageTotals, add: UsageTotals): void {
  into.input += add.input
  into.output += add.output
  into.cacheRead += add.cacheRead
  into.cacheWrite5m += add.cacheWrite5m
  into.cacheWrite1h += add.cacheWrite1h
  into.thinking += add.thinking
}

export const totalTokens = (u: UsageTotals): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h

/** USD per million tokens, by token class. */
export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

const tier = (input: number, output: number, cacheRead = input * 0.1): ModelPricing => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
})

/** Current-generation Anthropic first-party rates (USD/MTok). */
export const defaultPricing: Record<string, ModelPricing> = {
  'claude-fable-5-1': tier(10, 50, 0.25),
  'claude-mythos-5-1': tier(10, 50, 0.25),
  'claude-fable-5': tier(10, 50),
  'claude-mythos-5': tier(10, 50),
  'claude-opus-5': tier(5, 25),
  'claude-opus-4-8': tier(5, 25),
  'claude-opus-4-7': tier(5, 25),
  'claude-opus-4-6': tier(5, 25),
  'claude-sonnet-5': tier(2, 10),
  'claude-sonnet-4-6': tier(3, 15),
  'claude-haiku-4-5': tier(1, 5),
}

/** Merge user overrides (config.json `pricing`) over the defaults. */
export function mergePricing(
  overrides?: Record<string, Partial<ModelPricing>>,
): Record<string, ModelPricing> {
  const merged: Record<string, ModelPricing> = { ...defaultPricing }
  for (const [model, partial] of Object.entries(overrides ?? {})) {
    const base = merged[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    merged[model] = { ...base, ...partial }
  }
  return merged
}

/**
 * Rates for a model id: exact match, then with any trailing date suffix
 * stripped (claude-haiku-4-5-20251001), then the longest table key that
 * prefixes the id. undefined = unpriced.
 */
export function pricingFor(
  model: string,
  table: Record<string, ModelPricing>,
): ModelPricing | undefined {
  const direct = table[model]
  if (direct !== undefined) return direct
  const undated = model.replace(/-\d{8}$/, '')
  if (table[undated] !== undefined) return table[undated]
  let best: string | undefined
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key
  }
  return best !== undefined ? table[best] : undefined
}

export interface CostEstimate {
  /** Sum over priced models. A partial figure when unpriced is non-empty. */
  usd: number
  /** Models that contributed tokens but have no pricing entry. */
  unpriced: string[]
}

export function costOfUsage(
  byModel: Record<string, UsageTotals>,
  table: Record<string, ModelPricing> = defaultPricing,
): CostEstimate {
  let usd = 0
  const unpriced: string[] = []
  for (const [model, usage] of Object.entries(byModel)) {
    const rates = pricingFor(model, table)
    if (rates === undefined) {
      if (totalTokens(usage) > 0) unpriced.push(model)
      continue
    }
    usd +=
      (usage.input * rates.input +
        usage.output * rates.output +
        usage.cacheRead * rates.cacheRead +
        usage.cacheWrite5m * rates.cacheWrite5m +
        usage.cacheWrite1h * rates.cacheWrite1h) /
      1_000_000
  }
  unpriced.sort()
  return { usd, unpriced }
}

import { z } from 'zod'
import type { ModelPricing } from './pricing.js'
import type { SessionId } from './types.js'
import type { HideRules } from './visibility.js'

/**
 * Hodor's persisted user configuration (~/.hodor/config.json): the durable
 * layer that beats heuristics. Everything here survives rescans; nothing
 * here is ever inferred.
 */

export interface SessionOverride {
  rename?: string
  archived?: boolean
  pinnedProject?: string
  tags?: string[]
}

export interface HideOverrides {
  /** Appended to the default lists. */
  pathPrefixes?: string[]
  pathSegments?: string[]
  pathInfixes?: string[]
  dotSegmentAllowlist?: string[]
  interactiveEntrypoints?: string[]
  /** Override the default toggles. */
  hideDotSegments?: boolean
  hideNonInteractive?: boolean
}

export interface HodorConfig {
  hide?: HideOverrides
  /** Set false to stop auto-discovering cross-boundary (WSL/Windows) stores. */
  discoverStores?: boolean
  /**
   * Roots to detach from remote-based grouping into their own project —
   * the "split" escape hatch when a clone of a repo is its own workstream.
   */
  splitRoots?: string[]
  /** Display-name overrides keyed by project id (see scan --json). */
  projectNames?: Record<string, string>
  /** Per-session overrides keyed by session id. */
  sessions?: Record<SessionId, SessionOverride>
  /**
   * Cost-table overrides by model id (USD per million tokens). Merged over
   * the built-in current-generation table — add legacy models or correct
   * price drift here.
   */
  pricing?: Record<string, Partial<ModelPricing>>
}

const hideSchema = z
  .object({
    pathPrefixes: z.array(z.string()).optional(),
    pathSegments: z.array(z.string()).optional(),
    pathInfixes: z.array(z.string()).optional(),
    dotSegmentAllowlist: z.array(z.string()).optional(),
    interactiveEntrypoints: z.array(z.string()).optional(),
    hideDotSegments: z.boolean().optional(),
    hideNonInteractive: z.boolean().optional(),
  })
  .passthrough()

const sessionOverrideSchema = z
  .object({
    rename: z.string().optional(),
    archived: z.boolean().optional(),
    pinnedProject: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()

const pricingSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite5m: z.number().optional(),
    cacheWrite1h: z.number().optional(),
  })
  .passthrough()

const configSchema = z
  .object({
    hide: hideSchema.optional(),
    discoverStores: z.boolean().optional(),
    splitRoots: z.array(z.string()).optional(),
    projectNames: z.record(z.string(), z.string()).optional(),
    sessions: z.record(z.string(), sessionOverrideSchema).optional(),
    pricing: z.record(z.string(), pricingSchema).optional(),
  })
  .passthrough()

export function parseHodorConfig(content: string): { config: HodorConfig; error?: string } {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (error) {
    return { config: {}, error: `not valid JSON (${String(error)})` }
  }
  const parsed = configSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
    return { config: {}, error: `invalid config${where}: ${issue?.message ?? 'schema mismatch'}` }
  }
  return { config: parsed.data as HodorConfig }
}

/** Defaults + config: lists extend, toggles override. */
export function mergeHideRules(base: HideRules, overrides?: HideOverrides): HideRules {
  if (overrides === undefined) {
    return {
      ...base,
      pathPrefixes: [...base.pathPrefixes],
      pathSegments: [...base.pathSegments],
      pathInfixes: [...base.pathInfixes],
      dotSegmentAllowlist: [...base.dotSegmentAllowlist],
      interactiveEntrypoints: [...base.interactiveEntrypoints],
    }
  }
  return {
    pathPrefixes: [...base.pathPrefixes, ...(overrides.pathPrefixes ?? [])],
    pathSegments: [...base.pathSegments, ...(overrides.pathSegments ?? [])],
    pathInfixes: [...base.pathInfixes, ...(overrides.pathInfixes ?? [])],
    dotSegmentAllowlist: [...base.dotSegmentAllowlist, ...(overrides.dotSegmentAllowlist ?? [])],
    interactiveEntrypoints: [
      ...base.interactiveEntrypoints,
      ...(overrides.interactiveEntrypoints ?? []),
    ],
    hideDotSegments: overrides.hideDotSegments ?? base.hideDotSegments,
    hideNonInteractive: overrides.hideNonInteractive ?? base.hideNonInteractive,
  }
}

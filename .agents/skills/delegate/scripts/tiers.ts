/**
 * Tier resolution: a tier is a name for an OpenRouter slug and the routing it
 * runs with. The skill's own `tiers.json` is the default; a project can
 * replace it whole with `.delegate/tiers.json` at its root.
 *
 * Each tier's `options` go into the OpenCode config the launcher generates,
 * and a tier whose options do not state reasoning and routing is refused: an
 * unconfigured slug does not fail, it runs with no reasoning effort and no
 * provider routing, producing worse output that reads exactly like good output.
 *
 * `max` is a tier with no slug yet, so naming it is refused — spending at that
 * tier is a choice a brief will make explicitly once a slug has passed an
 * eval, never one the launcher reaches on its own.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type TierOptions = {
  reasoning: Record<string, unknown>
  provider: Record<string, unknown>
}

export type Tier = {
  slug: string | null
  budgetUsd: number
  options?: TierOptions
}

export type TierFile = {
  $comment?: string
  defaultTier: string
  tiers: Record<string, Tier>
}

export type ResolvedTier = {
  tier: string
  slug: string
  budgetUsd: number
  options: TierOptions
}

export type TierResolution =
  | { ok: true; value: ResolvedTier }
  | { ok: false; reason: string }

const SLUG = /^[a-z0-9-]+\/[a-z0-9.:_-]+$/
const SORTS = ['price', 'throughput', 'latency']
const PROVIDER_SLUG = /^[a-z0-9-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Why a tier's options are not a complete model configuration, or null. */
export function optionsProblem(options: unknown): string | null {
  if (!isRecord(options)) return 'has no `options`'
  if (!isRecord(options.reasoning)) return 'has no `options.reasoning` object'
  const provider = options.provider
  if (!isRecord(provider)) return 'has no `options.provider` object'
  const sorted = typeof provider.sort === 'string' && SORTS.includes(provider.sort)
  const ordered =
    Array.isArray(provider.order) &&
    provider.order.length > 0 &&
    provider.order.every((p) => typeof p === 'string' && PROVIDER_SLUG.test(p))
  if (!sorted && !ordered) {
    return 'states no routing (`options.provider.sort` of price, throughput or latency, or an `options.provider.order` list)'
  }
  return null
}

/** Checks a parsed tier file's shape, throwing with the first problem found. */
export function checkTierFile(data: unknown): TierFile {
  if (!isRecord(data)) throw new Error('the tier file is not a JSON object')
  for (const key of Object.keys(data)) {
    if (!['$comment', 'defaultTier', 'tiers'].includes(key)) {
      throw new Error(`unknown key \`${key}\``)
    }
  }
  if (typeof data.defaultTier !== 'string') throw new Error('`defaultTier` is not a string')
  if (!isRecord(data.tiers)) throw new Error('`tiers` is not an object')
  for (const [name, tier] of Object.entries(data.tiers)) {
    if (!isRecord(tier)) throw new Error(`tier \`${name}\` is not an object`)
    for (const key of Object.keys(tier)) {
      if (!['slug', 'budgetUsd', 'options'].includes(key)) {
        throw new Error(`tier \`${name}\` has unknown key \`${key}\``)
      }
    }
    if (tier.slug !== null && (typeof tier.slug !== 'string' || !SLUG.test(tier.slug))) {
      throw new Error(`tier \`${name}\` has an invalid slug`)
    }
    if (typeof tier.budgetUsd !== 'number' || !(tier.budgetUsd > 0)) {
      throw new Error(`tier \`${name}\` needs a positive \`budgetUsd\``)
    }
  }
  return data as TierFile
}

export function loadTierFile(path: string): TierFile {
  return checkTierFile(JSON.parse(readFileSync(path, 'utf8')))
}

/** The skill's own default tier file. */
export const DEFAULT_TIER_FILE = join(import.meta.dir, '..', 'tiers.json')

/** Where a project replaces the default, relative to its root. */
export const PROJECT_TIER_FILE = '.delegate/tiers.json'

/** The project's override when it has one, else the skill's default. */
export function tierFilePath(root: string): string {
  const project = join(root, PROJECT_TIER_FILE)
  return existsSync(project) ? project : DEFAULT_TIER_FILE
}

export function resolveTier(
  file: TierFile,
  requested: string | undefined
): TierResolution {
  const tier = requested ?? file.defaultTier
  const entry = file.tiers[tier]
  if (!entry) {
    const known = Object.keys(file.tiers).join(', ')
    return { ok: false, reason: `tier \`${tier}\` is not one of ${known}` }
  }
  if (entry.slug === null) {
    return {
      ok: false,
      reason: `tier \`${tier}\` has no model assigned yet, so nothing can run at it`,
    }
  }
  const problem = optionsProblem(entry.options)
  if (problem !== null) {
    return {
      ok: false,
      reason: `tier \`${tier}\` (${entry.slug}) ${problem}, so it would run unrouted`,
    }
  }
  return {
    ok: true,
    value: {
      tier,
      slug: entry.slug,
      budgetUsd: entry.budgetUsd,
      options: entry.options as TierOptions,
    },
  }
}

/**
 * The delegation brief: one Markdown file whose frontmatter is config and whose
 * body is the prompt. Checked strictly because it is input to a script that
 * spends money, and an unknown key is refused rather than ignored — a typo in
 * `budget_usd` must not silently fall back to the default.
 *
 * Two modes. A `scout` reads and reports. A `worker` edits the paths its
 * `scope` names, and its `checks` are the oracle: no check, no delegated
 * write. `review`, and a worker's `ladder` and `git` keys, are named in the
 * design and refused here until they are built, so a brief written for them
 * fails loudly instead of running as something else.
 */

export const BRIEF_MODES_NOT_YET: Record<string, string> = {
  review: 'review mode is not built yet',
}

// Worker keys the design names that this launcher does not act on yet.
// Refused by name, so a brief that relies on one does not run without it.
const WORKER_KEYS_NOT_YET: Record<string, string> = {
  ladder: 'a worker `ladder` is not built yet: name one `tier` and re-brief on failure',
  git: 'a worker `git` field is not built yet: a worker never commits, the parent does',
}

// Keys that belong to worker briefs. Named so the refusal says why, rather
// than reporting an unknown key a reader will think is a typo.
const WORKER_ONLY_KEYS = ['ladder', 'scope', 'checks', 'git'] as const

const SHARED_KEYS = ['mode', 'tier', 'budget_usd', 'timeout_min']
const WORKER_KEYS = [...SHARED_KEYS, 'scope', 'checks']

type Shared = { tier?: string; budget_usd?: number; timeout_min?: number }

export type ScoutConfig = { mode: 'scout' } & Shared

export type WorkerConfig = {
  mode: 'worker'
  // Globs relative to the repo root (`Bun.Glob`). A changed path outside
  // every one of them is out of scope.
  scope: string[]
  // Shell commands the launcher runs itself, from the repo root, after the
  // worker stops. Every one exiting 0 is what `done` means.
  checks: string[]
} & Shared

export type BriefConfig = ScoutConfig | WorkerConfig

/**
 * Checks the frontmatter against the brief's shape, collecting every problem
 * as `key: message`. Hand-written rather than a schema library so the skill
 * runs from its own folder with no dependencies installed.
 */
export function checkBriefConfig(
  record: Record<string, unknown>
): { ok: true; config: BriefConfig } | { ok: false; issues: string[] } {
  const issues: string[] = []
  const mode = record.mode
  if (mode !== 'scout' && mode !== 'worker') {
    return { ok: false, issues: ['mode: must be `scout` or `worker`'] }
  }
  const allowed = mode === 'worker' ? WORKER_KEYS : SHARED_KEYS
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.push(`${key}: unknown key`)
  }
  const config: Record<string, unknown> = { mode }

  if (record.tier !== undefined) {
    if (typeof record.tier !== 'string' || record.tier.length === 0) {
      issues.push('tier: must be a non-empty string')
    } else config.tier = record.tier
  }
  if (record.budget_usd !== undefined) {
    const b = record.budget_usd
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 20) {
      issues.push('budget_usd: must be a number above 0 and at most 20')
    } else config.budget_usd = b
  }
  if (record.timeout_min !== undefined) {
    const t = record.timeout_min
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 120) {
      issues.push('timeout_min: must be a whole number from 1 to 120')
    } else config.timeout_min = t
  }

  if (mode === 'worker') {
    const list = (key: 'scope' | 'checks', empty: string) => {
      const value = record[key]
      if (value === undefined) {
        issues.push(`${key}: is required for a worker`)
        return
      }
      if (!Array.isArray(value)) {
        issues.push(`${key}: must be a list of strings`)
        return
      }
      const items: string[] = []
      for (const [i, item] of value.entries()) {
        if (typeof item !== 'string' || item.trim().length === 0) {
          issues.push(`${key}.${i}: must be a non-empty string`)
        } else items.push(item.trim())
      }
      if (value.length === 0) issues.push(`${key}: ${empty}`)
      config[key] = items
    }
    list('scope', 'a worker needs at least one scope glob')
    list('checks', 'a worker needs at least one check: no oracle, no delegated write')
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, config: config as BriefConfig }
}

export type Brief = {
  config: BriefConfig
  body: string
}

export type BriefParse = { ok: true; brief: Brief } | { ok: false; reason: string }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseBrief(text: string): BriefParse {
  const match = FRONTMATTER.exec(text)
  if (!match) {
    return { ok: false, reason: 'the brief has no `---` frontmatter block' }
  }
  const [, head, rawBody] = match

  let data: unknown
  try {
    data = Bun.YAML.parse(head)
  } catch (error) {
    return { ok: false, reason: `the frontmatter is not valid YAML: ${String(error)}` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'the frontmatter is not a key/value block' }
  }

  const record = data as Record<string, unknown>
  const mode = record.mode
  if (typeof mode === 'string' && mode in BRIEF_MODES_NOT_YET) {
    return { ok: false, reason: BRIEF_MODES_NOT_YET[mode] }
  }
  const workerKeys = WORKER_ONLY_KEYS.filter((key) => key in record)
  if (mode === 'scout' && workerKeys.length > 0) {
    return {
      ok: false,
      reason: `a scout is read-only, so ${workerKeys.map((k) => `\`${k}\``).join(', ')} does not apply to it`,
    }
  }
  if (mode === 'worker') {
    const notYet = Object.entries(WORKER_KEYS_NOT_YET).find(([key]) => key in record)
    if (notYet) return { ok: false, reason: notYet[1] }
  }

  const parsed = checkBriefConfig(record)
  if (!parsed.ok) {
    return { ok: false, reason: `the frontmatter is invalid — ${parsed.issues.join('; ')}` }
  }

  const body = rawBody.trim()
  if (body.length === 0) {
    return { ok: false, reason: 'the brief has no body, so there is nothing to ask' }
  }

  return { ok: true, brief: { config: parsed.config, body } }
}

/**
 * The result contract. `result.json` is written by the launcher only, and
 * everything in it is a fact the launcher observed — except `workerClaims`,
 * which is the model's final message and is named for what it is.
 *
 * `result.md` is the only file the parent is told to read, so it is capped at
 * RESULT_MD_MAX_LINES and puts the status first.
 */

export const RESULT_MD_MAX_LINES = 60
export const WORKER_CLAIMS_MAX_CHARS = 1500

export const STATUSES = [
  'done',
  'checks_failed',
  'no_change',
  'out_of_scope',
  'budget_exceeded',
  'timeout',
  'harness_error',
  'skipped',
] as const

export type Status = (typeof STATUSES)[number]

export type Tokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
}

export type Check = {
  cmd: string
  exit: number
  tailPath: string
}

export type Attempt = {
  tier: string
  slug: string
  durationS: number
  exit: number | null
  // Read from OpenRouter's key endpoint: exact for the key, but a concurrent
  // run on the same key lands in it too. Null when the endpoint did not answer.
  costUsd: number | null
  // The harness's own per-session accounting, summed from its step events.
  // Per run even under concurrency; null when it reported none.
  harnessCostUsd: number | null
  tokens: Tokens | null
  checks: Check[]
  // Why this attempt was followed by another, or null for the one that
  // counted. Only a startup lock on OpenCode's database is retried, once.
  retried: string | null
}

export type Result = {
  version: 1
  id: string
  mode: string
  status: Status
  reason: string | null
  startedAt: string
  finishedAt: string
  attempts: Attempt[]
  diff: {
    files: string[]
    stat: string
    outOfScope: string[]
    sensitive: string[]
    // Git refs (HEAD, branches, stash, remote-tracking) that moved during the
    // run, as `ref: before → after`.
    refsMoved: string[]
  }
  workerClaims: string | null
  mossbear: {
    // Whether the project has Mossbear's OpenCode plugin, so the run is
    // recorded there. Without it the run happens, untracked, and says so.
    tracked: boolean
    // OpenCode's own session id — the key Mossbear records the run under.
    agentSessionId: string | null
  }
  paths: {
    brief: string
    transcript: string | null
    stderr: string | null
  }
}

export function truncateClaims(text: string | null): string | null {
  if (text === null) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length <= WORKER_CLAIMS_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, WORKER_CLAIMS_MAX_CHARS - 1)}…`
}

function usd(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(4)}`
}

function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((x): x is number => x !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}

export function renderResultMarkdown(result: Result): string {
  const facts: string[] = []
  facts.push(`# delegate ${result.id}: ${result.status}`)
  facts.push('')
  if (result.reason) facts.push(`Reason: ${result.reason}`)
  facts.push(`Mode: ${result.mode}`)
  for (const attempt of result.attempts) {
    facts.push(
      `Attempt: ${attempt.tier} (${attempt.slug}), ${attempt.durationS}s, exit ${attempt.exit ?? 'none'}${attempt.retried ? ` — ${attempt.retried}` : ''}`
    )
  }
  if (result.attempts.length > 0) {
    const keyCost = sumOrNull(result.attempts.map((a) => a.costUsd))
    const harnessCost = sumOrNull(result.attempts.map((a) => a.harnessCostUsd))
    facts.push(
      `Cost: ${usd(keyCost)} by key usage, ${usd(harnessCost)} by harness accounting`
    )
  }
  if (result.diff.files.length > 0) {
    const shown = result.diff.files.slice(0, 10)
    const more = result.diff.files.length - shown.length
    facts.push(
      `Tree changed: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''} — see result.json`
    )
  } else if (result.attempts.length > 0) {
    facts.push('Tree changed: nothing')
  }
  if (result.diff.outOfScope.length > 0 && result.mode === 'worker') {
    const shown = result.diff.outOfScope.slice(0, 10)
    const more = result.diff.outOfScope.length - shown.length
    facts.push(
      `Outside the scope: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
    )
  }
  if (result.diff.sensitive.length > 0) {
    const shown = result.diff.sensitive.slice(0, 10)
    const more = result.diff.sensitive.length - shown.length
    facts.push(
      `Sensitive (read these hunks before accepting): ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
    )
  }
  for (const check of result.attempts.flatMap((attempt) => attempt.checks)) {
    facts.push(
      `Check: \`${check.cmd}\` exited ${check.exit}${check.exit === 0 ? '' : ` — log ${check.tailPath}`}`
    )
  }
  if (result.diff.refsMoved.length > 0) {
    const shown = result.diff.refsMoved.slice(0, 5)
    const more = result.diff.refsMoved.length - shown.length
    facts.push(`Git refs moved: ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`)
  } else if (result.attempts.length > 0) {
    facts.push('Git refs moved: none')
  }
  facts.push(
    result.mossbear.tracked
      ? `Mossbear session: ${result.mossbear.agentSessionId ?? 'none reported'}`
      : `Mossbear session: not tracked (no Mossbear OpenCode plugin in this project); OpenCode session ${result.mossbear.agentSessionId ?? 'none reported'}`
  )

  const header = [...facts, '', '## Worker claims (unverified)', '']
  const budget = RESULT_MD_MAX_LINES - header.length - 1
  const claimLines = (result.workerClaims ?? '(no final message)').split('\n')
  const kept = claimLines.slice(0, Math.max(budget, 1))
  if (kept.length < claimLines.length) {
    kept[kept.length - 1] = '… (truncated; full text in result.json)'
  }
  return `${[...header, ...kept].join('\n')}\n`
}

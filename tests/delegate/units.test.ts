import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseBrief } from '../../.agents/skills/delegate/scripts/brief'
import { matchesAny, sensitivePaths, takeWorkerLock } from '../../.agents/skills/delegate/scripts/index'
import { finalMessageOf, foldEvent, newEventSummary } from '../../.agents/skills/delegate/scripts/opencode'
import {
  RESULT_MD_MAX_LINES,
  renderResultMarkdown,
  truncateClaims,
  WORKER_CLAIMS_MAX_CHARS,
  type Result,
} from '../../.agents/skills/delegate/scripts/result'
import {
  checkTierFile,
  DEFAULT_TIER_FILE,
  loadTierFile,
  optionsProblem,
  resolveTier,
  type TierFile,
} from '../../.agents/skills/delegate/scripts/tiers'

const brief = (head: string, body = '## Goal\nFind every caller of foo.') =>
  `---\n${head}\n---\n${body}\n`

describe('parseBrief', () => {
  it('accepts a minimal scout brief and keeps the body as the prompt', () => {
    const parsed = parseBrief(brief('mode: scout'))
    expect(parsed).toEqual({
      ok: true,
      brief: { config: { mode: 'scout' }, body: '## Goal\nFind every caller of foo.' },
    })
  })

  it('accepts the optional knobs', () => {
    const parsed = parseBrief(
      brief('mode: scout\ntier: pro\nbudget_usd: 0.25\ntimeout_min: 5')
    )
    expect(parsed.ok && parsed.brief.config).toEqual({
      mode: 'scout',
      tier: 'pro',
      budget_usd: 0.25,
      timeout_min: 5,
    })
  })

  it('refuses a typo rather than falling back to a default', () => {
    const parsed = parseBrief(brief('mode: scout\nbudget: 0.25'))
    expect(parsed.ok).toBe(false)
  })

  it('refuses review mode by the slice that adds it', () => {
    const review = parseBrief(brief('mode: review'))
    expect(!review.ok && review.reason).toContain('not built yet')
  })

  it('accepts a worker brief with a scope and checks', () => {
    const parsed = parseBrief(
      brief('mode: worker\nscope: ["src/**"]\nchecks:\n  - bun test\ntier: pro')
    )
    expect(parsed.ok && parsed.brief.config).toEqual({
      mode: 'worker',
      scope: ['src/**'],
      checks: ['bun test'],
      tier: 'pro',
    })
  })

  it('refuses a worker with no checks or no scope: no oracle, no delegated write', () => {
    const noChecks = parseBrief(brief('mode: worker\nscope: ["src/**"]'))
    expect(!noChecks.ok && noChecks.reason).toContain('checks')
    const emptyChecks = parseBrief(brief('mode: worker\nscope: ["src/**"]\nchecks: []'))
    expect(!emptyChecks.ok && emptyChecks.reason).toContain('no oracle')
    const blankCheck = parseBrief(
      brief('mode: worker\nscope: ["src/**"]\nchecks: ["  "]')
    )
    expect(blankCheck.ok).toBe(false)
    const noScope = parseBrief(brief('mode: worker\nchecks: ["bun test"]'))
    expect(!noScope.ok && noScope.reason).toContain('scope')
  })

  it('refuses the worker keys that are not built yet, by name', () => {
    const base = 'mode: worker\nscope: ["src/**"]\nchecks: ["bun test"]'
    const ladder = parseBrief(brief(`${base}\nladder: [flash, pro]`))
    expect(!ladder.ok && ladder.reason).toContain('`ladder`')
    const git = parseBrief(brief(`${base}\ngit: push`))
    expect(!git.ok && git.reason).toContain('`git`')
  })

  it('refuses worker-only keys on a scout and names them', () => {
    const parsed = parseBrief(brief('mode: scout\nchecks:\n  - bun test'))
    expect(!parsed.ok && parsed.reason).toContain('`checks`')
  })

  it('refuses a brief with no frontmatter, bad YAML, or no body', () => {
    expect(parseBrief('## Goal\nx').ok).toBe(false)
    expect(parseBrief(brief('mode: [scout')).ok).toBe(false)
    expect(parseBrief(brief('mode: scout', '   ')).ok).toBe(false)
  })

  it('refuses a budget that is zero, negative, or absurd', () => {
    expect(parseBrief(brief('mode: scout\nbudget_usd: 0')).ok).toBe(false)
    expect(parseBrief(brief('mode: scout\nbudget_usd: -1')).ok).toBe(false)
    expect(parseBrief(brief('mode: scout\nbudget_usd: 500')).ok).toBe(false)
  })
})

describe('worker scope and sensitive paths', () => {
  it('matches repo-relative paths against the scope globs', () => {
    const scope = ['packages/cli/src/guides/**', 'packages/cli/tests/*.test.ts']
    expect(matchesAny('packages/cli/src/guides/import-client.ts', scope)).toBe(true)
    expect(matchesAny('packages/cli/tests/import.test.ts', scope)).toBe(true)
    expect(matchesAny('packages/cli/tests/fixtures/a.json', scope)).toBe(false)
    expect(matchesAny('packages/cli/src/commands/init.ts', scope)).toBe(false)
  })

  it('flags the paths a passing check cannot vouch for', () => {
    expect(
      sensitivePaths([
        'apps/dashboard/src/zero/queries.ts',
        'apps/dashboard/app/api/v1/guides+api.ts',
        'apps/dashboard/src/server/logger.ts',
        'apps/dashboard/src/database/schema-mossbear.ts',
        'apps/dashboard/src/features/auth/useSession.ts',
        '.github/workflows/ci.yml',
        'packages/cli/src/guides/import-client.ts',
        'docs/architecture.md',
      ])
    ).toEqual([
      'apps/dashboard/src/zero/queries.ts',
      'apps/dashboard/app/api/v1/guides+api.ts',
      'apps/dashboard/src/server/logger.ts',
      'apps/dashboard/src/database/schema-mossbear.ts',
      'apps/dashboard/src/features/auth/useSession.ts',
      '.github/workflows/ci.yml',
    ])
  })
})

describe('takeWorkerLock', () => {
  const DEAD_PID = '2147483646'
  const staleCheckout = () => {
    const root = mkdtempSync(join(tmpdir(), 'delegate-lock-'))
    mkdirSync(join(root, '.delegate'))
    writeFileSync(join(root, '.delegate/worker.lock'), DEAD_PID)
    return root
  }

  it('takes over a lock whose pid is gone, and cleans up after itself', () => {
    const root = staleCheckout()
    const lock = takeWorkerLock(root)
    expect(lock.ok).toBe(true)
    expect(readFileSync(join(root, '.delegate/worker.lock'), 'utf8')).toBe(
      String(process.pid)
    )
    expect(existsSync(join(root, '.delegate/worker.lock.takeover'))).toBe(false)
    if (lock.ok) lock.release()
    expect(existsSync(join(root, '.delegate/worker.lock'))).toBe(false)
  })

  it('refuses a takeover another launcher is already making', () => {
    const root = staleCheckout()
    writeFileSync(join(root, '.delegate/worker.lock.takeover'), '1')
    const lock = takeWorkerLock(root)
    expect(!lock.ok && lock.reason).toContain('taking over')
    expect(readFileSync(join(root, '.delegate/worker.lock'), 'utf8')).toBe(DEAD_PID)
  })
})

describe('resolveTier', () => {
  const ROUTED = { reasoning: { effort: 'high' }, provider: { sort: 'price' } }
  const file: TierFile = {
    defaultTier: 'flash',
    tiers: {
      flash: { slug: 'z-ai/glm-5.3-flash', budgetUsd: 0.5, options: ROUTED },
      max: { slug: null, budgetUsd: 5 },
    },
  }

  it('defaults to the default tier', () => {
    expect(resolveTier(file, undefined)).toEqual({
      ok: true,
      value: { tier: 'flash', slug: 'z-ai/glm-5.3-flash', budgetUsd: 0.5, options: ROUTED },
    })
  })

  it('refuses a tier with no slug, which is how max is held back in v1', () => {
    const resolved = resolveTier(file, 'max')
    expect(resolved.ok).toBe(false)
  })

  it('refuses an unknown tier and lists the known ones', () => {
    const resolved = resolveTier(file, 'turbo')
    expect(!resolved.ok && resolved.reason).toContain('flash, max')
  })

  it("reads the skill's default tier file, and every named slug states its routing", () => {
    const committed = loadTierFile(DEFAULT_TIER_FILE)
    expect(committed.defaultTier).toBe('flash')
    for (const [tier, entry] of Object.entries(committed.tiers)) {
      if (entry.slug === null) {
        expect(tier).toBe('max')
        continue
      }
      expect({ tier, problem: optionsProblem(entry.options) }).toEqual({ tier, problem: null })
    }
  })

  it('refuses a tier whose options state no routing', () => {
    const unrouted = resolveTier(
      {
        defaultTier: 'x',
        tiers: { x: { slug: 'a/b', budgetUsd: 1, options: { reasoning: {}, provider: {} } } },
      },
      undefined
    )
    expect(!unrouted.ok && unrouted.reason).toContain('routing')
    expect(optionsProblem({ reasoning: {}, provider: { order: ['deepinfra'] } })).toBeNull()
    expect(optionsProblem({ reasoning: {}, provider: { order: ['Deep Infra'] } })).not.toBeNull()
    expect(optionsProblem({ provider: { sort: 'price' } })).toContain('reasoning')
  })

  it('refuses a tier file with an unknown key', () => {
    expect(() => checkTierFile({ defaultTier: 'x', tiers: {}, extra: 1 })).toThrow('extra')
    expect(() =>
      checkTierFile({ defaultTier: 'x', tiers: { x: { slug: 'a/b', budgetUsd: 0 } } })
    ).toThrow('budgetUsd')
  })
})

describe('foldEvent', () => {
  // Shapes copied from a real `opencode run --format json` at 1.18.32.
  const lines = [
    '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start","messageID":"msg_a"}}',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","messageID":"msg_a","text":"Looking."}}',
    '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","messageID":"msg_a","tokens":{"total":10,"input":7,"output":2,"reasoning":1,"cache":{"write":0,"read":40}},"cost":0.0012}}',
    'not json at all',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","messageID":"msg_b","text":"Answer: "}}',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","messageID":"msg_b","text":"three callers."}}',
    '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","messageID":"msg_b","tokens":{"input":5,"output":3,"reasoning":0,"cache":{"read":2}},"cost":0.0008}}',
  ]

  it('reads 2.x events, which keep the 1.x shape', () => {
    // From a real `opencode run --standalone --format json` at 2.0.18, trimmed
    // to the fields the fold reads (plus the top-level `timestamp` 2.x adds).
    const summary = newEventSummary()
    for (const line of [
      '{"type":"step_finish","timestamp":1790467449638,"sessionID":"ses_f1fd2f03bffeGp3ueC32hWp0C2","part":{"type":"step-finish","messageID":"msg_0e02d1248001sXA9w3HLXv7Td5","tokens":{"input":16448,"output":61,"reasoning":193,"cache":{"read":2048,"write":0}},"cost":0}}',
      '{"type":"text","timestamp":1790467660329,"sessionID":"ses_f1fd2f03bffeGp3ueC32hWp0C2","part":{"type":"text","messageID":"msg_0e02dbf7a0016K4KPoyZo2fToT","text":"**Tools:** glob, grep, read, shell, skil"}}',
    ]) {
      foldEvent(summary, line)
    }
    expect(summary.sessionId).toBe('ses_f1fd2f03bffeGp3ueC32hWp0C2')
    expect(summary.costUsd).toBe(0)
    expect(summary.tokens).toEqual({
      input: 16448,
      output: 61,
      reasoning: 193,
      cacheRead: 2048,
    })
    expect(finalMessageOf(summary)).toBe('**Tools:** glob, grep, read, shell, skil')
  })

  it('keeps the session id, sums cost and tokens, and returns the last message', () => {
    const summary = newEventSummary()
    for (const line of lines) foldEvent(summary, line)
    expect(summary.sessionId).toBe('ses_1')
    expect(summary.costUsd).toBeCloseTo(0.002, 10)
    expect(summary.tokens).toEqual({ input: 12, output: 5, reasoning: 1, cacheRead: 42 })
    expect(finalMessageOf(summary)).toBe('Answer: three callers.')
  })

  it('reports no final message and no cost when nothing arrived', () => {
    const summary = newEventSummary()
    expect(finalMessageOf(summary)).toBeNull()
    expect(summary.costUsd).toBeNull()
  })
})

const result = (overrides: Partial<Result> = {}): Result => ({
  version: 1,
  id: 'find-callers',
  mode: 'scout',
  status: 'done',
  reason: null,
  startedAt: '2026-09-26T00:00:00.000Z',
  finishedAt: '2026-09-26T00:01:00.000Z',
  attempts: [
    {
      tier: 'flash',
      slug: 'z-ai/glm-5.3-flash',
      durationS: 60,
      exit: 0,
      costUsd: 0.01,
      harnessCostUsd: 0.0098,
      tokens: null,
      checks: [],
      retried: null,
    },
  ],
  diff: { files: [], stat: '', outOfScope: [], sensitive: [], refsMoved: [] },
  workerClaims: 'Three callers.',
  mossbear: { tracked: true, agentSessionId: 'ses_1' },
  paths: { brief: '.delegate/x/brief.md', transcript: null, stderr: null },
  ...overrides,
})

describe('renderResultMarkdown', () => {
  it('puts the status first and labels the claims as unverified', () => {
    const md = renderResultMarkdown(result())
    expect(md.split('\n')[0]).toBe('# delegate find-callers: done')
    expect(md).toContain('$0.0100 by key usage, $0.0098 by harness accounting')
    expect(md).toContain('## Worker claims (unverified)')
    expect(md).toContain('Mossbear session: ses_1')
  })

  it('never exceeds the line cap, however long the claims are', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const md = renderResultMarkdown(result({ workerClaims: long }))
    expect(md.trimEnd().split('\n').length).toBeLessThanOrEqual(RESULT_MD_MAX_LINES)
    expect(md).toContain('truncated')
  })

  it('says the cost is unknown rather than zero when no figure came back', () => {
    const md = renderResultMarkdown(
      result({
        attempts: [{ ...result().attempts[0], costUsd: null, harnessCostUsd: null }],
      })
    )
    expect(md).toContain('unknown by key usage, unknown by harness accounting')
  })

  it("lists a worker's checks, out-of-scope and sensitive paths as facts", () => {
    const md = renderResultMarkdown(
      result({
        mode: 'worker',
        status: 'out_of_scope',
        attempts: [
          {
            ...result().attempts[0],
            checks: [
              { cmd: 'bun run typecheck', exit: 0, tailPath: '.delegate/x/check-1.log' },
              { cmd: 'bun test', exit: 1, tailPath: '.delegate/x/check-2.log' },
            ],
          },
        ],
        diff: {
          files: ['src/a.ts', 'src/server/b.ts', 'README.md'],
          stat: '',
          outOfScope: ['README.md'],
          sensitive: ['src/server/b.ts'],
          refsMoved: [],
        },
      })
    )
    expect(md).toContain('Outside the scope: README.md')
    expect(md).toContain('Sensitive (read these hunks before accepting): src/server/b.ts')
    expect(md).toContain('Check: `bun run typecheck` exited 0\n')
    expect(md).toContain('Check: `bun test` exited 1 — log .delegate/x/check-2.log')
  })
})

describe('truncateClaims', () => {
  it('caps the claims and treats an empty message as none', () => {
    expect(truncateClaims('x'.repeat(5000))?.length).toBe(WORKER_CLAIMS_MAX_CHARS)
    expect(truncateClaims('   ')).toBeNull()
    expect(truncateClaims(null)).toBeNull()
  })
})

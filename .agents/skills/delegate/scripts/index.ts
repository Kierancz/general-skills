#!/usr/bin/env bun
/**
 * `bun "$SKILL_DIR/scripts/index.ts" <brief.md>` — hand one bounded task to
 * an open-weights model on OpenRouter, running headless under OpenCode on this
 * machine, and write back a small result the parent session can trust.
 *
 * Self-contained: Node built-ins and Bun only, so it runs from wherever the
 * skill is installed with nothing to install. Two modes, one brief at a
 * time: a scout answers a read-only question; a worker edits inside the
 * brief's `scope`, and the launcher then runs the brief's `checks` itself.
 *
 * The parent trusts facts, not prose. Everything in result.json is something
 * this script observed — the harness's exit, what changed in the tree, cost
 * from OpenRouter's key endpoint — except `workerClaims`, the model's final
 * message, which is labelled as a claim.
 *
 * Exits 0 whenever it wrote a result, whatever the result says: the status
 * lives in result.json, and the parent is notified on exit either way. Exits 2
 * only on a usage error, when there is nowhere to write one.
 *
 * Every preflight failure is `skipped` with its reason, and nothing runs.
 * There is no degraded mode for routing: a run on a model whose reasoning and
 * routing are not stated is not a cheaper version of a good run. Mossbear
 * tracking follows the project: one that has Mossbear's OpenCode plugin gets
 * every run recorded or none (a half-wired hook spends credits and records
 * nothing), and one without it runs untracked and says so in the result.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { parseBrief, type BriefConfig } from './brief'
import { generatedConfig, projectMcpServers } from './config'
import { locateOpencode } from './install'
import { probeMossbear } from './mossbear'
import { isolatedOpencodeDirs, runOpencode, type HarnessOutcome } from './opencode'
import { openRouterBase, probeKey } from './openrouter'
import {
  renderResultMarkdown,
  STATUSES,
  truncateClaims,
  type Attempt,
  type Check,
  type Result,
  type Status,
} from './result'
import { loadTierFile, resolveTier, tierFilePath, type ResolvedTier } from './tiers'

const DEFAULT_TIMEOUT_MIN = 20
const DEFAULT_POLL_MS = 20_000

// The launcher's own output folder, one directory per run. Excluded from the
// tree diff whole: under concurrent scouts, every other run's brief,
// transcript and result land here while this one runs.
const DELEGATE_DIR = '.delegate'

// What OpenCode 1.x writes into `.opencode/` the first time it starts in a
// checkout: it installs `@opencode-ai/plugin` there for the plugin loader, and
// writes a `.gitignore` naming exactly these. Measured on 1.18.32: about 3,650
// files on the first start, nothing on later ones. Scouts run 2.x, which
// writes nothing there (measured at 2.0.18 on its first start in a checkout),
// but another tool on the machine may still run 1.x and make that first start
// while a scout runs, which would come back `out_of_scope` without these. They
// are skipped only while the install is not finished before the run: once it
// is, a write to them changes what loads at the next start, as one to
// `.opencode/plugins/` (never skipped) does. `package-lock.json` is the
// finished marker because it is written last, after `node_modules/` and
// `package.json` (measured on 1.18.32), so an install in flight, or one a
// killed run left half done, is still skipped.
const OPENCODE_INSTALL_DONE = '.opencode/package-lock.json'
const OPENCODE_INSTALL = [
  '.opencode/.gitignore',
  '.opencode/node_modules',
  '.opencode/package.json',
  '.opencode/package-lock.json',
  '.opencode/bun.lock',
]

// OpenCode 1.x keeps one SQLite database per user, and two harnesses starting
// in the same second can race for it: one exits 1 at once with `database is
// locked` in stderr. That exit, inside this window, is retried once after a
// randomized delay. 2.x has not been seen to do it (six 3-way concurrent
// `--standalone` runs, 2026-09-26), and the retry stays because it costs a run
// nothing unless the lock is actually named. A separate data dir per run would
// avoid sharing the database, but makes every run a cold first start.
const LOCK_RETRY_WINDOW_S = 10
const LOCK_RETRY_DELAY_MS = [500, 2500] as const

// Mossbear's OpenCode plugin, which `mossbear init` writes into a project.
// Its presence is what makes a run tracked.
const MOSSBEAR_PLUGIN = '.opencode/plugins/mossbear.ts'

// The OpenCode agent that serves each mode (generated, see config.ts).
const AGENT_FOR_MODE = { scout: 'scout', worker: 'worker' } as const

// One worker per checkout: two writers in one tree make each one's diff
// meaningless. Scouts take no lock. Under `.delegate/`, so it is never part
// of a run's diff.
const WORKER_LOCK = join(DELEGATE_DIR, 'worker.lock')

// A check that runs longer than this is killed and counts as failed.
const CHECK_TIMEOUT_S = 600

// Paths whose changes are allowed but not trusted: a worker diff touching one
// is listed as `sensitive`, and the parent reads those hunks (or has them
// security-reviewed) before accepting. Passing checks is not enough there — a
// query that forgot to scope on the current user passes every test that did
// not think to look.
const SENSITIVE_GLOBS = [
  '**/src/zero/**',
  '**/src/lib/zero/**',
  '**/src/data/queries/**',
  '**/src/data/server/**',
  '**/app/api/**',
  '**/src/server/**',
  '**/src/database/**',
  '**/auth/**',
  '**/*auth*.{ts,tsx}',
  // CI configuration: what runs with the repository's secrets.
  '**/.github/**',
]

/** Whether a repo-relative path matches any of the globs. */
export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => new Bun.Glob(glob).match(path))
}

/** The changed paths a parent must read before accepting a worker's diff. */
export function sensitivePaths(files: string[]): string[] {
  return files.filter((path) => matchesAny(path, SENSITIVE_GLOBS))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes the checkout's worker lock, or says who holds it. A lock whose pid is
 * gone was left by a launcher that was killed, and is taken over — under a
 * second exclusive file, so two launchers finding the same dead lock cannot
 * both take it: the one that loses the takeover file is refused.
 */
export function takeWorkerLock(
  root: string
): { ok: true; release: () => void } | { ok: false; reason: string } {
  const path = join(root, WORKER_LOCK)
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
  } catch {
    const holder = Number(readOr(path, '').trim())
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      return {
        ok: false,
        reason: `another worker is running in this checkout (pid ${holder} holds ${WORKER_LOCK})`,
      }
    }
    const takeover = `${path}.takeover`
    try {
      writeFileSync(takeover, String(process.pid), { flag: 'wx' })
    } catch {
      return {
        ok: false,
        reason: `another launcher is taking over a stale ${WORKER_LOCK}; if none is, delete ${WORKER_LOCK}.takeover`,
      }
    }
    // Re-read under the takeover file: a launcher that took the lock between
    // the read above and here has its own live pid in it now.
    const current = Number(readOr(path, '').trim())
    const stolen = current !== holder && pidAlive(current)
    if (!stolen) writeFileSync(path, String(process.pid))
    rmSync(takeover, { force: true })
    if (stolen) {
      return {
        ok: false,
        reason: `another worker is running in this checkout (pid ${current} holds ${WORKER_LOCK})`,
      }
    }
  }
  return { ok: true, release: () => rmSync(path, { force: true }) }
}

/**
 * Runs each check from the repo root, in order, stdout and stderr together
 * into `check-<n>.log` beside the brief. Every check runs, even after one
 * fails, so the parent sees the whole picture from one result.
 */
async function runChecks(
  checks: string[],
  root: string,
  outDir: string,
  env: Env
): Promise<Check[]> {
  const results: Check[] = []
  for (const [i, cmd] of checks.entries()) {
    const logPath = join(outDir, `check-${i + 1}.log`)
    const proc = Bun.spawn(['bash', '-c', `exec 2>&1\n${cmd}`], {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: Bun.file(logPath),
      timeout: CHECK_TIMEOUT_S * 1000,
    })
    const exit = await proc.exited
    results.push({
      cmd,
      // Killed by the timeout, or on a signal: a failure either way.
      exit: proc.signalCode !== null ? 124 : exit,
      tailPath: relative(root, logPath),
    })
  }
  return results
}

type Env = Record<string, string | undefined>

function git(root: string, args: string[]): string {
  const out = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  return out.exitCode === 0 ? out.stdout.toString() : ''
}

/**
 * Paths `git status` reports as changed or untracked, relative to the root,
 * each with its two-letter status code — so staging an already-dirty path
 * (` M` → `M `) reads as a change, not as the same dirt.
 */
export function dirtyPaths(root: string): Map<string, string> {
  const out = git(root, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const paths = new Map<string, string>()
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    paths.set(entry.slice(3), entry.slice(0, 2))
    // A rename carries its source as the next NUL-separated field.
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return paths
}

/**
 * Every file under the root, gitignored ones included, keyed to its mtime and
 * size. Diffing two of these is how the launcher sees writes `git status`
 * never reports: without it a scout could write to `.env` or `node_modules/`
 * and the result would still say the tree was untouched. `.git/` and the paths
 * in `skip` are left out, since git and the launcher write those.
 *
 * A before/after diff rather than `find -newer <marker>`: file timestamps tick
 * at the kernel's clock granularity, so a write in the marker's own tick is
 * not "newer" and went unseen on CI. A changed (mtime, size) pair or a new or
 * missing path does not depend on the tick.
 */
export function treeSnapshot(root: string, skip: string[]): Map<string, string> {
  const prunes = ['.git', ...skip].flatMap((path) => [
    '-path',
    join(root, path),
    '-prune',
    '-o',
  ])
  const out = Bun.spawnSync(
    [
      'find',
      root,
      ...prunes,
      '(',
      '-type',
      'f',
      '-o',
      '-type',
      'l',
      ')',
      '-printf',
      '%P\\t%T@ %s\\0',
    ],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const files = new Map<string, string>()
  for (const entry of out.stdout.toString().split('\0')) {
    const tab = entry.lastIndexOf('\t')
    if (tab > 0) files.set(entry.slice(0, tab), entry.slice(tab + 1))
  }
  return files
}

/** Paths created, modified or deleted between two snapshots. */
export function snapshotChanges(
  before: Map<string, string>,
  after: Map<string, string>
): Set<string> {
  const changed = new Set<string>()
  for (const [path, stamp] of after) {
    if (before.get(path) !== stamp) changed.add(path)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path)
  }
  return changed
}

/**
 * Every local ref, and what HEAD points at. A scout that commits, stashes,
 * switches branch or pushes (a push moves the remote-tracking ref) can leave
 * the working tree looking untouched — committing the parent's dirty files
 * even makes it cleaner — so refs are compared too. A push to a remote with no
 * tracking ref is not visible here; recording `git ls-remote` around a run is
 * worker-mode work, where pushing can be allowed.
 */
export function refSnapshot(root: string): Map<string, string> {
  const refs = new Map<string, string>()
  const head = git(root, ['symbolic-ref', '-q', 'HEAD']).trim()
  refs.set(
    'HEAD',
    `${head || 'detached'} ${git(root, ['rev-parse', '-q', 'HEAD']).trim()}`
  )
  for (const line of git(root, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
  ]).split('\n')) {
    const space = line.indexOf(' ')
    if (space > 0) refs.set(line.slice(0, space), line.slice(space + 1))
  }
  return refs
}

/** Refs created, moved or deleted between two snapshots, one line each. */
export function refChanges(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const changes: string[] = []
  for (const [ref, value] of after) {
    const was = before.get(ref)
    if (was !== value) changes.push(`${ref}: ${was ?? '(new)'} → ${value}`)
  }
  for (const ref of before.keys()) {
    if (!after.has(ref)) changes.push(`${ref}: ${before.get(ref)} → (deleted)`)
  }
  return changes.sort()
}

function isoNow(): string {
  return new Date().toISOString()
}

type Preflight =
  | {
      ok: true
      key: string
      slug: string
      tier: string
      budgetUsd: number
      timeoutS: number
      bin: string
      usageBefore: number
      resolved: ResolvedTier
      tracked: boolean
      configContent: string
    }
  | { ok: false; reason: string }

async function preflight(
  root: string,
  env: Env,
  config: BriefConfig
): Promise<Preflight> {
  const key = env.OR_DELEGATE_API_KEY
  if (!key) {
    return { ok: false, reason: 'OR_DELEGATE_API_KEY is not set in this environment' }
  }

  const tierPath = tierFilePath(root)
  let tierFile
  try {
    tierFile = loadTierFile(tierPath)
  } catch (error) {
    return {
      ok: false,
      reason: `${tierPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const tier = resolveTier(tierFile, config.tier)
  if (!tier.ok) return { ok: false, reason: tier.reason }

  // A project with Mossbear's plugin has every run tracked, or the run does
  // not happen: a plugin whose hook cannot upload records nothing anyone sees.
  const tracked = existsSync(join(root, MOSSBEAR_PLUGIN))
  if (tracked) {
    if (!Bun.which('mossbear-hook', { PATH: env.PATH ?? '' })) {
      return {
        ok: false,
        reason: `Mossbear is not wired: ${MOSSBEAR_PLUGIN} is here but \`mossbear-hook\` is not on PATH`,
      }
    }
    const mossbear = await probeMossbear(env)
    if (!mossbear.ok) return { ok: false, reason: mossbear.reason }
  }

  const located = await locateOpencode(env, env.HOME ?? homedir())
  if (!located.ok) return { ok: false, reason: located.reason }

  const configContent = JSON.stringify(
    generatedConfig({
      tiers: [tier.value],
      projectServers: projectMcpServers(root),
      mossbear: Bun.which('mossbear', { PATH: env.PATH ?? '' }) !== null,
    })
  )

  // Last, because it is the only check that costs a round trip — a rejected
  // key must not mask a broken config, and a broken config costs nothing to find.
  const probe = await probeKey(openRouterBase(env), key)
  if (!probe.ok) {
    return { ok: false, reason: `the delegation key is not usable: ${probe.reason}` }
  }

  return {
    ok: true,
    key,
    slug: tier.value.slug,
    tier: tier.value.tier,
    budgetUsd: config.budget_usd ?? tier.value.budgetUsd,
    // DELEGATE_TIMEOUT_S exists for the launcher's own tests, which cannot
    // wait out a minute per timeout case. Briefs set `timeout_min`.
    timeoutS: env.DELEGATE_TIMEOUT_S
      ? Number(env.DELEGATE_TIMEOUT_S)
      : (config.timeout_min ?? DEFAULT_TIMEOUT_MIN) * 60,
    bin: located.bin,
    usageBefore: probe.usageUsd,
    resolved: tier.value,
    tracked,
    configContent,
  }
}

function statusOf(
  outcome: HarnessOutcome,
  budgetHit: string | null
): { status: Status; reason: string | null } {
  if (budgetHit !== null) return { status: 'budget_exceeded', reason: budgetHit }
  if (outcome.timedOut) return { status: 'timeout', reason: outcome.killedFor }
  if (outcome.exit !== 0) {
    return {
      status: 'harness_error',
      reason: `opencode exited ${outcome.exit ?? 'on a signal'}`,
    }
  }
  // OpenCode exits 0 on some errors, so a clean exit with nothing said is an
  // error, not an empty answer.
  if (outcome.finalMessage === null) {
    return {
      status: 'harness_error',
      reason: 'opencode exited 0 without a final message',
    }
  }
  return { status: 'done', reason: null }
}

/**
 * Why an attempt that ended this way should be retried, or null. Only the
 * startup race on OpenCode's database qualifies: an early nonzero exit whose
 * stderr names the lock.
 */
export function lockRetryReason(
  outcome: HarnessOutcome,
  durationS: number,
  stderr: string
): string | null {
  if (outcome.exit === null || outcome.exit === 0) return null
  if (durationS > LOCK_RETRY_WINDOW_S) return null
  if (!stderr.includes('database is locked')) return null
  return `opencode exited ${outcome.exit} after ${durationS.toFixed(1)}s with 'database is locked' in stderr`
}

function readOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

export async function delegate(briefArg: string, env: Env, cwd: string): Promise<Result> {
  const briefPath = resolve(cwd, briefArg)
  const outDir = dirname(briefPath)
  const id = basename(outDir)
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim() || cwd
  const rel = (p: string) => relative(root, p)
  const startedAt = isoNow()

  const base = {
    version: 1 as const,
    id,
    startedAt,
    attempts: [] as Attempt[],
    diff: {
      files: [] as string[],
      stat: '',
      outOfScope: [] as string[],
      sensitive: [] as string[],
      refsMoved: [] as string[],
    },
    workerClaims: null,
    mossbear: { tracked: false, agentSessionId: null },
    paths: { brief: rel(briefPath), transcript: null, stderr: null },
  }
  const skipped = (mode: string, reason: string): Result => ({
    ...base,
    mode,
    status: 'skipped',
    reason,
    finishedAt: isoNow(),
  })

  const parsed = parseBrief(readFileSync(briefPath, 'utf8'))
  if (!parsed.ok) return skipped('unknown', `brief refused: ${parsed.reason}`)
  const { config, body } = parsed.brief

  const ready = await preflight(root, env, config)
  if (!ready.ok) return skipped(config.mode, ready.reason)

  // A worker takes the checkout's lock. It is released before the result is
  // returned; a launcher that dies first leaves a lock naming a dead pid,
  // which the next worker takes over.
  let lock: { release: () => void } | null = null
  if (config.mode === 'worker') {
    // A path already dirty inside the scope cannot be told apart from the
    // worker's own edit to it, so a worker does not start on one.
    const dirtyInScope = [...dirtyPaths(root).keys()].filter((path) =>
      matchesAny(path, config.scope)
    )
    if (dirtyInScope.length > 0) {
      const shown = dirtyInScope.slice(0, 5).join(', ')
      const more = dirtyInScope.length > 5 ? ` (+${dirtyInScope.length - 5} more)` : ''
      return skipped(
        config.mode,
        `the scope already has uncommitted changes (${shown}${more}); commit or stash them first`
      )
    }
    const taken = takeWorkerLock(root)
    if (!taken.ok) return skipped(config.mode, taken.reason)
    lock = taken
  }
  const checks = config.mode === 'worker' ? config.checks : null

  mkdirSync(outDir, { recursive: true })
  const transcriptPath = join(outDir, 'transcript.jsonl')
  const stderrPath = join(outDir, 'stderr.log')
  // `.delegate/` whole, OpenCode's own install while it is unfinished, and
  // this run's own files for a brief kept outside
  // `.delegate/`: skipping the brief's whole directory would skip the whole
  // tree for a brief kept at the root. result.json and result.md are written
  // after the diff, so they need no entry.
  const skip = [
    DELEGATE_DIR,
    ...(existsSync(join(root, OPENCODE_INSTALL_DONE)) ? [] : OPENCODE_INSTALL),
    relative(root, transcriptPath),
    relative(root, stderrPath),
  ]
  const isSkipped = (path: string) =>
    skip.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  const dirtyBefore = dirtyPaths(root)
  const refsBefore = refSnapshot(root)
  const treeBefore = treeSnapshot(root, skip)
  const base_url = openRouterBase(env)

  // Why the run was stopped for spend, once it has been.
  let budgetHit: string | null = null
  let harness: ReturnType<typeof runOpencode> | null = null
  const overBudget = (spent: number) => {
    if (spent > ready.budgetUsd && budgetHit === null) {
      budgetHit = `spent $${spent.toFixed(4)} against a $${ready.budgetUsd} budget`
      harness?.kill(budgetHit)
    }
  }

  const pollMs = Number(env.DELEGATE_POLL_MS ?? DEFAULT_POLL_MS)
  const pollKey = async () => {
    const probe = await probeKey(base_url, ready.key)
    if (probe.ok) overBudget(probe.usageUsd - ready.usageBefore)
  }
  const poller = setInterval(pollKey, pollMs)
  // The harness prices its steps at list rates, not at the routed endpoint's,
  // so its figure runs high: a live worker run reported $4.07 where the key
  // was charged $1.32, and was killed on the harness's number. Its figure
  // only prompts a key read, which is what decides; one read at a time.
  let confirming = false
  const onHarnessCost = (harnessSpent: number) => {
    if (harnessSpent <= ready.budgetUsd || confirming || budgetHit !== null) return
    confirming = true
    void pollKey().finally(() => {
      confirming = false
    })
  }

  const tries: { outcome: HarnessOutcome; durationS: number; retried: string | null }[] =
    []
  for (;;) {
    const began = performance.now()
    harness = runOpencode({
      bin: ready.bin,
      agent: AGENT_FOR_MODE[config.mode],
      slug: ready.slug,
      title: `delegate ${id}`,
      prompt: body,
      cwd: root,
      env: {
        ...env,
        // The delegation key, in the child only. Whatever OPENROUTER_API_KEY
        // the parent holds belongs to something else.
        OPENROUTER_API_KEY: ready.key,
        ...isolatedOpencodeDirs(env.HOME ?? homedir()),
        // The binary whose store holds this run, for the `mossbear report` the
        // shim starts at each turn's end to export the session with. It is
        // not on PATH, and 2.x names itself to its children no other way.
        MOSSBEAR_OPENCODE_BIN: ready.bin,
        OPENCODE_CONFIG_CONTENT: ready.configContent,
      },
      timeoutS: ready.timeoutS,
      transcriptPath,
      stderrPath,
      onHarnessCost,
    })
    const outcome = await harness.outcome
    const durationS = (performance.now() - began) / 1000
    // Once only: a second lock is reported as the harness error it is.
    const why =
      tries.length === 0 && budgetHit === null
        ? lockRetryReason(outcome, durationS, readOr(stderrPath, ''))
        : null
    if (why === null) {
      tries.push({ outcome, durationS, retried: null })
      break
    }
    const [lo, hi] = LOCK_RETRY_DELAY_MS
    const delayMs = Math.round(lo + Math.random() * (hi - lo))
    tries.push({
      outcome,
      durationS,
      retried: `${why}; retried after ${(delayMs / 1000).toFixed(1)}s`,
    })
    await Bun.sleep(delayMs)
    // The poller runs through the delay, and a budget passed there has no
    // live run to kill, so it stops the retry instead.
    if (budgetHit !== null) {
      tries[tries.length - 1].retried = null
      break
    }
  }
  clearInterval(poller)
  const outcome = tries[tries.length - 1].outcome

  const after = await probeKey(base_url, ready.key)
  // Read for the record, not to stop anything: a run that finished on its own
  // is graded, and any spend past the budget since the last poll shows in its
  // cost line.
  const keyCost = after.ok ? Math.max(0, after.usageUsd - ready.usageBefore) : null

  // What the run changed, excluding anything already dirty before it began:
  // those paths cannot be told apart from the parent's own edits.
  // git status catches deletions and tracked edits; the snapshot diff catches
  // what status cannot see — gitignored paths, and further edits to a path
  // that was already dirty.
  const files = [
    ...new Set([
      ...[...dirtyPaths(root)]
        .filter(([path, code]) => dirtyBefore.get(path) !== code && !isSkipped(path))
        .map(([path]) => path),
      ...snapshotChanges(treeBefore, treeSnapshot(root, skip)),
    ]),
  ].sort()
  const stat =
    files.length > 0 ? git(root, ['diff', '--stat', '--', ...files]).trim() : ''

  // A scout's scope is nothing: any path it changed is out of scope. A
  // worker's is its brief's globs. Reported, never reverted — whether to
  // keep a change is the parent's call. Neither may move a ref: a worker
  // never commits, so its work stays a working-tree diff the parent accepts.
  const refsMoved = refChanges(refsBefore, refSnapshot(root))
  let { status, reason } = statusOf(outcome, budgetHit)
  const outOfScope =
    config.mode === 'worker'
      ? files.filter((path) => !matchesAny(path, config.scope))
      : files
  const sensitive = config.mode === 'worker' ? sensitivePaths(files) : []

  // The checks run only on a finished run that changed something: on an
  // unfinished one they would grade half an edit, and on no change they
  // would grade the parent's tree.
  let checkResults: Check[] = []
  if (checks !== null && status === 'done') {
    if (files.length === 0) {
      status = 'no_change'
      reason = 'the worker finished without changing any file'
    } else {
      checkResults = await runChecks(checks, root, outDir, env)
      const failed = checkResults.filter((check) => check.exit !== 0)
      const [first] = failed
      if (first) {
        status = 'checks_failed'
        reason = `${failed.length} of ${checkResults.length} check(s) failed, first: \`${first.cmd}\` exited ${first.exit}`
      }
    }
  }

  // Outranks every other status, however the run ended: a run that timed
  // out after writing still left the writes, and `out_of_scope` is the status
  // whose handling is to look at them.
  if (outOfScope.length > 0 || refsMoved.length > 0) {
    const ended = status === 'done' ? '' : ` (the run itself ended ${status}: ${reason})`
    status = 'out_of_scope'
    // Worded as what was observed, not who did it: the diff cannot tell the
    // scout's writes from the parent's own edits made while it ran.
    const what = [
      outOfScope.length > 0
        ? `${outOfScope.length} path(s) ${config.mode === 'worker' ? 'outside the scope ' : ''}changed`
        : '',
      refsMoved.length > 0 ? `${refsMoved.length} git ref(s) moved` : '',
    ]
      .filter(Boolean)
      .join(' and ')
    const who = config.mode === 'worker' ? 'a worker ran' : 'a read-only scout ran'
    reason = `${what} while ${who}${ended}`
  }
  lock?.release()
  return {
    ...base,
    mode: config.mode,
    status,
    reason,
    finishedAt: isoNow(),
    // The key's usage is read around the whole run, so it is attributed to
    // the last attempt; a retried attempt ended in its first seconds.
    attempts: tries.map((attempt, i) => ({
      tier: ready.tier,
      slug: ready.slug,
      durationS: Math.round(attempt.durationS),
      exit: attempt.outcome.exit,
      costUsd: i === tries.length - 1 ? keyCost : null,
      harnessCostUsd: attempt.outcome.harnessCostUsd,
      tokens: attempt.outcome.tokens,
      // The checks graded the tree the last attempt left.
      checks: i === tries.length - 1 ? checkResults : [],
      retried: attempt.retried,
    })),
    diff: { files, stat, outOfScope, sensitive, refsMoved },
    workerClaims: truncateClaims(outcome.finalMessage),
    mossbear: { tracked: ready.tracked, agentSessionId: outcome.sessionId },
    paths: {
      brief: rel(briefPath),
      transcript: rel(transcriptPath),
      stderr: rel(stderrPath),
    },
  }
}

export function writeResult(outDir: string, result: Result): string {
  if (!STATUSES.includes(result.status)) {
    throw new Error(`refusing to write an unknown status: ${String(result.status)}`)
  }
  const checked = result
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(checked, null, 2)}\n`)
  const md = join(outDir, 'result.md')
  writeFileSync(md, renderResultMarkdown(checked))
  return md
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error(
      args.length === 0
        ? 'usage: bun <skill-dir>/scripts/index.ts <path/to/brief.md>'
        : 'one brief per run in this version — concurrent runs arrive in a later slice'
    )
    process.exit(2)
  }
  const briefPath = resolve(process.cwd(), args[0])
  if (!existsSync(briefPath)) {
    console.error(`no brief at ${args[0]}`)
    process.exit(2)
  }
  const result = await delegate(args[0], process.env, process.cwd())
  const md = writeResult(dirname(briefPath), result)
  console.log(`delegate: ${result.status} — ${relative(process.cwd(), md)}`)
  process.exit(0)
}

/**
 * The launcher end to end against a fake harness and a stub key endpoint, in a
 * throwaway git repo — every status path, with zero OpenRouter spend.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { Result } from '../../.agents/skills/delegate/scripts/result'

const LAUNCHER = join(import.meta.dir, '../../.agents/skills/delegate/scripts/index.ts')
const KEY = 'test-delegate-key'
const MOSSBEAR_TOKEN = 'test-mossbear-token'

// Behaviour picked by FAKE_MODE. It prints the event shapes a real
// `opencode run --format json` prints, and records what it was started with.
const FAKE_OPENCODE = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_LOG/argv"
[ "$OPENROUTER_API_KEY" = "${KEY}" ] && echo key-ok > "$FAKE_LOG/key" || echo key-wrong > "$FAKE_LOG/key"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$FAKE_LOG/config"
printf '%s' "$XDG_DATA_HOME" > "$FAKE_LOG/xdg-data"
ev() { printf '%s\\n' "$1"; }
case "$FAKE_MODE" in
  done)
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Two callers: a.ts:3, b.ts:9."}}'
    ev '{"type":"step_finish","sessionID":"ses_fake","part":{"type":"step-finish","messageID":"m1","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":0}},"cost":0.001}}'
    ;;
  work)
    mkdir -p src && echo feature > src/feature.txt
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Added src/feature.txt."}}'
    ;;
  workstray)
    mkdir -p src && echo feature > src/feature.txt
    echo stray >> tracked.txt
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  worksensitive)
    mkdir -p src/server && echo 'export {}' > src/server/handler.ts
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  edit)
    echo scribble > scribbled.txt
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  sneak)
    echo pwned > .env
    echo more >> ignored-before.log
    rm -f doomed.log
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Nothing to see."}}'
    ;;
  neighbour)
    # What a concurrent scout's launcher writes into its own run directory.
    mkdir -p .delegate/other
    echo '{}' > .delegate/other/result.json
    echo 'working' > .delegate/other/stderr.log
    echo '{}' >> .delegate/other/transcript.jsonl
    echo 'Next question.' > .delegate/other/brief.md
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  firststart)
    # OpenCode's first start in a checkout installing its plugin package.
    mkdir -p .opencode/node_modules/@opencode-ai/plugin
    echo '{}' > .opencode/node_modules/@opencode-ai/plugin/package.json
    echo '{"dependencies":{}}' > .opencode/package.json
    echo '{}' > .opencode/package-lock.json
    printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore' > .opencode/.gitignore
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  finishinstall)
    # Another run's OpenCode finishing an install this run found half done.
    for i in 1 2 3; do echo '{}' > .opencode/node_modules/dep$i.json; done
    echo '{"dependencies":{}}' > .opencode/package.json
    echo '{}' > .opencode/package-lock.json
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  pkgedit)
    echo '{"dependencies":{"planted":"1.0.0"}}' > .opencode/package.json
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  plugin)
    echo '// planted' > .opencode/plugins/extra.ts
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  locked|alwayslocked)
    # OpenCode losing the startup race for its SQLite database: the first
    # start fails at once; a second start succeeds, unless always locked.
    if [ "$FAKE_MODE" = alwayslocked ] || [ ! -e "$FAKE_LOG/locked-once" ]; then
      touch "$FAKE_LOG/locked-once"
      echo x >> "$FAKE_LOG/starts"
      printf 'Error: Unexpected error\ndatabase is locked\n' >&2
      exit 1
    fi
    echo x >> "$FAKE_LOG/starts"
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Answered on the second start."}}'
    ;;
  commit)
    git -c user.name=t -c user.email=t@example.com commit -qam 'scout was here'
    ev '{"type":"text","sessionID":"ses_fake","part":{"type":"text","messageID":"m1","text":"Done."}}'
    ;;
  writehang)
    echo half > half-written.txt
    sleep 60
    ;;
  hang)
    ev '{"type":"step_start","sessionID":"ses_fake","part":{"type":"step-start","messageID":"m1"}}'
    sleep 60
    ;;
  spend)
    ev '{"type":"step_finish","sessionID":"ses_fake","part":{"type":"step-finish","messageID":"m1","tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0}},"cost":0.9}}'
    sleep 60
    ;;
  fail)
    exit 3
    ;;
  silent)
    exit 0
    ;;
esac
`

let work: string
let server: ReturnType<typeof Bun.serve>
let usage = 0
let usageStep = 0

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'delegate-test-'))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'opencode'), FAKE_OPENCODE)
  writeFileSync(join(bin, 'mossbear-hook'), '#!/bin/sh\nexit 0\n')
  // On PATH so the `mossbear` MCP server always resolves, and the launcher's
  // override always carries at least one entry to assert on.
  writeFileSync(join(bin, 'mossbear'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'opencode'), 0o755)
  chmodSync(join(bin, 'mossbear-hook'), 0o755)
  chmodSync(join(bin, 'mossbear'), 0o755)

  server = Bun.serve({
    port: 0,
    fetch(request) {
      // Stands in for both OpenRouter's key endpoint and the Mossbear
      // dashboard's token check.
      if (new URL(request.url).pathname === '/api/v1/guides') {
        const ok = request.headers.get('authorization') === `Bearer ${MOSSBEAR_TOKEN}`
        return ok ? Response.json([]) : new Response('no', { status: 401 })
      }
      if (request.headers.get('authorization') !== `Bearer ${KEY}`) {
        return new Response('no', { status: 401 })
      }
      usage += usageStep
      return Response.json({ data: { usage } })
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(work, { recursive: true, force: true })
})

function makeRepo(name: string, { wired = true } = {}): string {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  if (wired) {
    mkdirSync(join(repo, '.opencode/plugins'), { recursive: true })
    writeFileSync(join(repo, '.opencode/plugins/mossbear.ts'), '// stub\n')
  }
  writeFileSync(join(repo, '.gitignore'), '.delegate/\n.env\n*.log\n')
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  return repo
}

type Run = { exit: number; result: Result; md: string; log: string }

async function launch(
  repo: string,
  mode: string,
  opts: {
    brief?: string
    briefAt?: string
    env?: Record<string, string | undefined>
  } = {}
): Promise<Run> {
  const briefAt = opts.briefAt ?? '.delegate/case/brief.md'
  const dir = dirname(join(repo, briefAt))
  // Outside the repo, so the fake's own records are not changes the run made.
  const log = join(work, `${basename(repo)}-fake-log`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(log, { recursive: true })
  writeFileSync(
    join(repo, briefAt),
    opts.brief ?? '---\nmode: scout\n---\nWho calls foo?\n'
  )
  const proc = Bun.spawn(['bun', LAUNCHER, briefAt], {
    cwd: repo,
    env: {
      PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      HOME: process.env.HOME,
      OR_DELEGATE_API_KEY: KEY,
      MOSSBEAR_TOKEN,
      MOSSBEAR_DASHBOARD_URL: server.url.origin,
      DELEGATE_OPENCODE_BIN: join(work, 'bin/opencode'),
      DELEGATE_OPENROUTER_BASE: server.url.origin,
      DELEGATE_POLL_MS: '100',
      DELEGATE_TIMEOUT_S: '2',
      FAKE_MODE: mode,
      FAKE_LOG: log,
      ...opts.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exit = await proc.exited
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Result
  const md = readFileSync(join(dir, 'result.md'), 'utf8')
  return { exit, result, md, log }
}

describe('delegate launcher', () => {
  it('runs a scout to done and reports only facts it observed', async () => {
    usage = 0
    usageStep = 0.002
    const repo = makeRepo('done')
    const run = await launch(repo, 'done')
    expect(run.exit).toBe(0)
    expect(run.result.status).toBe('done')
    expect(run.result.workerClaims).toBe('Two callers: a.ts:3, b.ts:9.')
    expect(run.result.mossbear.agentSessionId).toBe('ses_fake')
    expect(run.result.diff.files).toEqual([])
    const attempt = run.result.attempts[0]
    expect(attempt.slug).toBe('z-ai/glm-5.3-flash')
    expect(attempt.harnessCostUsd).toBeCloseTo(0.001, 10)
    expect(attempt.costUsd).not.toBeNull()
    expect(attempt.tokens).toEqual({ input: 100, output: 20, reasoning: 5, cacheRead: 0 })
    expect(run.md.startsWith('# delegate case: done')).toBe(true)

    // The child got the delegation key as OPENROUTER_API_KEY, a private
    // server, a title (so no title agent spends the key), the scout agent,
    // and the launcher's own generated config: its agents, the tier's model
    // settings, web search, and the mossbear MCP server as a whole 2.x entry.
    expect(readFileSync(join(run.log, 'key'), 'utf8').trim()).toBe('key-ok')
    // Never the XDG default, where 1.x keeps a database 2.x would make unreadable.
    expect(readFileSync(join(run.log, 'xdg-data'), 'utf8')).toBe(
      join(process.env.HOME ?? '', '.opencode/v2/data')
    )
    const argv = readFileSync(join(run.log, 'argv'), 'utf8').split('\n')
    expect(argv.slice(0, 6)).toEqual([
      'run',
      '--standalone',
      '--title',
      'delegate case',
      '--agent',
      'scout',
    ])
    expect(argv.slice(6, 8)).toEqual(['--model', 'openrouter/z-ai/glm-5.3-flash'])
    const config = JSON.parse(readFileSync(join(run.log, 'config'), 'utf8'))
    expect(Object.keys(config).sort()).toEqual(
      ['agent', 'mcp', 'permission', 'provider', 'websearch'].sort()
    )
    expect(config.websearch).toEqual({ provider: 'exa' })
    expect(config.agent.scout.permission.edit).toBe('deny')
    expect(Object.keys(config.provider.openrouter.models)).toEqual(['z-ai/glm-5.3-flash'])
    expect(config.mcp.servers).toEqual({
      mossbear: { type: 'local', command: ['mossbear', 'mcp'], disabled: false },
    })
    expect(run.result.mossbear.tracked).toBe(true)
  })

  it("denies the tools of the project's own MCP servers", async () => {
    usageStep = 0
    const repo = makeRepo('projectmcp')
    writeFileSync(
      join(repo, 'opencode.json'),
      JSON.stringify({ mcp: { writer: { type: 'local', command: ['w'], enabled: true } } })
    )
    const run = await launch(repo, 'done')
    expect(run.result.status).toBe('done')
    const config = JSON.parse(readFileSync(join(run.log, 'config'), 'utf8'))
    expect(config.agent.scout.permission['writer_*']).toBe('deny')
    expect(config.agent.worker.permission['writer_*']).toBe('deny')
  })

  it('reads a project tier file in place of the default', async () => {
    usageStep = 0
    const repo = makeRepo('projecttiers')
    mkdirSync(join(repo, '.delegate'), { recursive: true })
    writeFileSync(
      join(repo, '.delegate/tiers.json'),
      JSON.stringify({
        defaultTier: 'cheap',
        tiers: {
          cheap: {
            slug: 'acme/tiny-1',
            budgetUsd: 0.1,
            options: { reasoning: { effort: 'low' }, provider: { sort: 'price' } },
          },
          unrouted: { slug: 'acme/tiny-2', budgetUsd: 0.1, options: { reasoning: {}, provider: {} } },
        },
      })
    )
    const run = await launch(repo, 'done')
    expect(run.result.status).toBe('done')
    expect(run.result.attempts[0].slug).toBe('acme/tiny-1')
    const unrouted = await launch(repo, 'done', {
      brief: '---\nmode: scout\ntier: unrouted\n---\nWho calls foo?\n',
    })
    expect(unrouted.result.status).toBe('skipped')
    expect(unrouted.result.reason).toContain('routing')
  })

  it('flags a scout that changed the tree, and leaves the change in place', async () => {
    usageStep = 0
    const repo = makeRepo('edit')
    writeFileSync(join(repo, 'tracked.txt'), 'dirty before the run\n')
    const run = await launch(repo, 'edit')
    expect(run.result.status).toBe('out_of_scope')
    // Already dirty before the run, so not attributed to the scout.
    expect(run.result.diff.files).toEqual(['scribbled.txt'])
    expect(run.result.diff.outOfScope).toEqual(['scribbled.txt'])
    expect(existsSync(join(repo, 'scribbled.txt'))).toBe(true)
  })

  it('sees writes to and deletions of gitignored paths, which git status cannot', async () => {
    usageStep = 0
    const repo = makeRepo('sneak')
    writeFileSync(join(repo, 'ignored-before.log'), 'existing\n')
    writeFileSync(join(repo, 'doomed.log'), 'about to go\n')
    const run = await launch(repo, 'sneak')
    expect(run.result.status).toBe('out_of_scope')
    expect(run.result.diff.outOfScope).toEqual([
      '.env',
      'doomed.log',
      'ignored-before.log',
    ])
    expect(run.md).not.toContain('Tree changed: nothing')
  })

  it("ignores other scouts' runs landing under .delegate/ while it runs", async () => {
    usageStep = 0
    const run = await launch(makeRepo('neighbour'), 'neighbour')
    expect(run.result.status).toBe('done')
    expect(run.result.diff.files).toEqual([])
  })

  it("ignores OpenCode's own first-start install, but not a write to its plugins", async () => {
    usageStep = 0
    const install = await launch(makeRepo('firststart'), 'firststart')
    expect(install.result.status).toBe('done')
    expect(install.result.diff.files).toEqual([])
    const plugin = await launch(makeRepo('plugin'), 'plugin')
    expect(plugin.result.status).toBe('out_of_scope')
    expect(plugin.result.diff.outOfScope).toEqual(['.opencode/plugins/extra.ts'])

    // Half installed before the run (no lockfile yet): the rest of it is
    // still OpenCode's, whichever run's OpenCode writes it.
    const half = makeRepo('finishinstall')
    mkdirSync(join(half, '.opencode/node_modules'), { recursive: true })
    writeFileSync(join(half, '.opencode/node_modules/dep0.json'), '{}\n')
    const finished = await launch(half, 'finishinstall')
    expect(finished.result.status).toBe('done')
    expect(finished.result.diff.files).toEqual([])

    // Once installed, the install is watched like any other path.
    const repo = makeRepo('pkgedit')
    writeFileSync(join(repo, '.opencode/package.json'), '{"dependencies":{}}\n')
    writeFileSync(join(repo, '.opencode/package-lock.json'), '{}\n')
    const edited = await launch(repo, 'pkgedit')
    expect(edited.result.status).toBe('out_of_scope')
    expect(edited.result.diff.outOfScope).toEqual(['.opencode/package.json'])
  })

  it('retries once when OpenCode loses the startup race for its database', async () => {
    usageStep = 0
    const run = await launch(makeRepo('locked'), 'locked')
    expect(run.result.status).toBe('done')
    expect(run.result.workerClaims).toBe('Answered on the second start.')
    expect(readFileSync(join(run.log, 'starts'), 'utf8').trim().split('\n')).toHaveLength(
      2
    )
    const [first, second] = run.result.attempts
    expect(run.result.attempts).toHaveLength(2)
    expect(first.exit).toBe(1)
    expect(first.retried).toContain('database is locked')
    expect(first.retried).toContain('retried after')
    expect(second.exit).toBe(0)
    expect(second.retried).toBeNull()
    expect(run.md).toContain('database is locked')
  })

  it('reports a lock that persists after the retry as a harness error', async () => {
    usageStep = 0
    const run = await launch(makeRepo('alwayslocked'), 'alwayslocked')
    expect(run.result.status).toBe('harness_error')
    expect(run.result.reason).toContain('exited 1')
    expect(run.result.attempts).toHaveLength(2)
    expect(run.result.attempts[1].retried).toBeNull()
  })

  it('does not start the retry once the budget is passed during its delay', async () => {
    usage = 0
    usageStep = 0.3
    const run = await launch(makeRepo('lockedspend'), 'alwayslocked', {
      brief: '---\nmode: scout\nbudget_usd: 0.5\n---\nWho calls foo?\n',
    })
    expect(run.result.status).toBe('budget_exceeded')
    expect(run.result.reason).toContain('$0.5 budget')
    expect(readFileSync(join(run.log, 'starts'), 'utf8').trim().split('\n')).toHaveLength(
      1
    )
    expect(run.result.attempts).toHaveLength(1)
    expect(run.result.attempts[0].retried).toBeNull()
  })

  it('sees a scout that commits, though the tree ends up cleaner', async () => {
    usageStep = 0
    const repo = makeRepo('commit')
    writeFileSync(join(repo, 'tracked.txt'), 'the parent was mid-edit\n')
    const run = await launch(repo, 'commit')
    expect(run.result.status).toBe('out_of_scope')
    expect(run.result.reason).toContain('git ref(s) moved')
    expect(run.result.diff.refsMoved.some((line) => line.startsWith('HEAD:'))).toBe(true)
    expect(run.md).toContain('Git refs moved: ')
  })

  it('reports writes ahead of a timeout, keeping how the run ended', async () => {
    usageStep = 0
    const run = await launch(makeRepo('writehang'), 'writehang')
    expect(run.result.status).toBe('out_of_scope')
    expect(run.result.diff.outOfScope).toEqual(['half-written.txt'])
    expect(run.result.reason).toContain('ended timeout')
  })

  it('still sees ignored writes when the brief sits at the repo root', async () => {
    usageStep = 0
    const repo = makeRepo('rootbrief')
    const run = await launch(repo, 'sneak', { briefAt: 'brief.md' })
    expect(run.result.status).toBe('out_of_scope')
    expect(run.result.diff.outOfScope).toContain('.env')
  })

  it('kills a hung harness at the timeout', async () => {
    usageStep = 0
    const run = await launch(makeRepo('hang'), 'hang')
    expect(run.result.status).toBe('timeout')
    expect(run.result.attempts[0].durationS).toBeLessThan(15)
  })

  it('does not kill on the harness figure alone when the key is under budget', async () => {
    // The harness prices at list rates and runs high; the key decides.
    usage = 0
    usageStep = 0
    const run = await launch(makeRepo('spend'), 'spend', {
      brief: '---\nmode: scout\nbudget_usd: 0.5\n---\nWho calls foo?\n',
      env: { DELEGATE_POLL_MS: '600000' },
    })
    expect(run.result.status).toBe('timeout')
    expect(run.result.attempts[0].harnessCostUsd).toBeCloseTo(0.9, 10)
  })

  it('kills the run at once when the harness figure is confirmed by the key', async () => {
    usage = 0
    usageStep = 0.6
    const run = await launch(makeRepo('spendconfirmed'), 'spend', {
      brief: '---\nmode: scout\nbudget_usd: 0.5\n---\nWho calls foo?\n',
      // No poll lands inside the run, so only the harness figure can prompt
      // the key read that stops it.
      env: { DELEGATE_TIMEOUT_S: '30', DELEGATE_POLL_MS: '600000' },
    })
    expect(run.result.status).toBe('budget_exceeded')
    expect(run.result.reason).toContain('$0.5 budget')
    expect(run.result.attempts[0].durationS).toBeLessThan(15)
  })

  it('kills the run once key usage passes the budget, with no harness figure', async () => {
    usage = 0
    usageStep = 0.3
    const run = await launch(makeRepo('keyspend'), 'hang', {
      brief: '---\nmode: scout\nbudget_usd: 0.5\n---\nWho calls foo?\n',
      env: { DELEGATE_TIMEOUT_S: '30' },
    })
    expect(run.result.status).toBe('budget_exceeded')
    expect(run.result.attempts[0].durationS).toBeLessThan(15)
  })

  it('treats a nonzero exit, and a clean exit with nothing said, as harness errors', async () => {
    usageStep = 0
    const failed = await launch(makeRepo('fail'), 'fail')
    expect(failed.result.status).toBe('harness_error')
    expect(failed.result.reason).toContain('exited 3')
    // No lock in stderr, so no retry.
    expect(failed.result.attempts).toHaveLength(1)
    const silent = await launch(makeRepo('silent'), 'silent')
    expect(silent.result.status).toBe('harness_error')
    expect(silent.result.reason).toContain('without a final message')
  })

  it('skips, running nothing, when a preflight fails', async () => {
    const noKey = await launch(makeRepo('nokey'), 'done', {
      env: { OR_DELEGATE_API_KEY: '' },
    })
    expect(noKey.result.status).toBe('skipped')
    expect(noKey.result.reason).toContain('OR_DELEGATE_API_KEY')
    expect(existsSync(join(noKey.log, 'argv'))).toBe(false)

    const noToken = await launch(makeRepo('notoken'), 'done', {
      env: { MOSSBEAR_TOKEN: '' },
    })
    expect(noToken.result.status).toBe('skipped')
    expect(noToken.result.reason).toContain('MOSSBEAR_TOKEN is not set')

    const badToken = await launch(makeRepo('badtoken'), 'done', {
      env: { MOSSBEAR_TOKEN: 'revoked' },
    })
    expect(badToken.result.status).toBe('skipped')
    expect(badToken.result.reason).toContain('rejected MOSSBEAR_TOKEN')
    expect(existsSync(join(badToken.log, 'argv'))).toBe(false)

    // A project without Mossbear's plugin runs untracked, and says so; one
    // with the plugin but no hook on PATH is half wired, and skips.
    const untracked = await launch(makeRepo('untracked', { wired: false }), 'done', {
      env: { MOSSBEAR_TOKEN: '' },
    })
    expect(untracked.result.status).toBe('done')
    expect(untracked.result.mossbear.tracked).toBe(false)
    expect(untracked.md).toContain('not tracked')

    const noHook = await launch(makeRepo('nohook'), 'done', {
      env: { PATH: `${join(work, 'nohook-bin')}:/usr/bin:/bin:${dirname(process.execPath)}` },
    })
    expect(noHook.result.status).toBe('skipped')
    expect(noHook.result.reason).toContain('Mossbear is not wired')

    const rejected = await launch(makeRepo('rejected'), 'done', {
      env: { OR_DELEGATE_API_KEY: 'some-other-key' },
    })
    expect(rejected.result.status).toBe('skipped')
    expect(rejected.result.reason).toContain('401')

    const maxTier = await launch(makeRepo('max'), 'done', {
      brief: '---\nmode: scout\ntier: max\n---\nWho calls foo?\n',
    })
    expect(maxTier.result.status).toBe('skipped')

    const unchecked = await launch(makeRepo('unchecked'), 'work', {
      brief: '---\nmode: worker\nscope: ["src/**"]\n---\nDo a thing.\n',
    })
    expect(unchecked.result.status).toBe('skipped')
    expect(unchecked.result.reason).toContain('checks')
  })
})

const workerBrief = (checks: string[], scope = ['src/**']) =>
  `---\nmode: worker\nscope: ${JSON.stringify(scope)}\nchecks: ${JSON.stringify(checks)}\n---\nAdd src/feature.txt.\n`

describe('delegate launcher, worker mode', () => {
  it('runs a worker to done when every check passes, and leaves the edit for the parent', async () => {
    usageStep = 0
    const repo = makeRepo('worker-done')
    const run = await launch(repo, 'work', {
      brief: workerBrief(['test -f src/feature.txt', 'grep -q feature src/feature.txt']),
    })
    expect(run.result.status).toBe('done')
    expect(run.result.mode).toBe('worker')
    expect(run.result.diff.files).toEqual(['src/feature.txt'])
    expect(run.result.diff.outOfScope).toEqual([])
    expect(run.result.diff.sensitive).toEqual([])
    expect(run.result.attempts[0].checks.map((c) => [c.cmd, c.exit])).toEqual([
      ['test -f src/feature.txt', 0],
      ['grep -q feature src/feature.txt', 0],
    ])
    expect(run.md).toContain('Check: `test -f src/feature.txt` exited 0')
    // The edit stays uncommitted, and the lock is gone.
    expect(readFileSync(join(repo, 'src/feature.txt'), 'utf8')).toBe('feature\n')
    expect(existsSync(join(repo, '.delegate/worker.lock'))).toBe(false)
    const argv = readFileSync(join(run.log, 'argv'), 'utf8').split('\n')
    expect(argv.slice(4, 6)).toEqual(['--agent', 'worker'])
  })

  it('reports checks_failed with every check run and its log kept', async () => {
    usageStep = 0
    const repo = makeRepo('worker-failed')
    const run = await launch(repo, 'work', {
      brief: workerBrief(['echo first; exit 3', 'test -f src/feature.txt']),
    })
    expect(run.result.status).toBe('checks_failed')
    expect(run.result.reason).toContain('`echo first; exit 3` exited 3')
    const checks = run.result.attempts[0].checks
    expect(checks.map((c) => c.exit)).toEqual([3, 0])
    expect(readFileSync(join(repo, checks[0].tailPath), 'utf8')).toBe('first\n')
  })

  it('reports no_change, and runs no check, when the worker edits nothing', async () => {
    usageStep = 0
    const run = await launch(makeRepo('worker-nochange'), 'done', {
      brief: workerBrief(['true']),
    })
    expect(run.result.status).toBe('no_change')
    expect(run.result.attempts[0].checks).toEqual([])
  })

  it('flags a path outside the scope, and leaves it in place', async () => {
    usageStep = 0
    const repo = makeRepo('worker-stray')
    const run = await launch(repo, 'workstray', {
      brief: workerBrief(['test -f src/feature.txt']),
    })
    expect(run.result.status).toBe('out_of_scope')
    expect(run.result.diff.files).toEqual(['src/feature.txt', 'tracked.txt'])
    expect(run.result.diff.outOfScope).toEqual(['tracked.txt'])
    expect(run.result.reason).toContain('1 path(s) outside the scope changed')
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('original\nstray\n')
  })

  it('lists a sensitive path even when the checks pass', async () => {
    usageStep = 0
    const run = await launch(makeRepo('worker-sensitive'), 'worksensitive', {
      brief: workerBrief(['true']),
    })
    expect(run.result.status).toBe('done')
    expect(run.result.diff.sensitive).toEqual(['src/server/handler.ts'])
    expect(run.md).toContain('Sensitive (read these hunks before accepting)')
  })

  it('will not start on a scope that is already dirty', async () => {
    usageStep = 0
    const repo = makeRepo('worker-dirty')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src/feature.txt'), 'the parent was here\n')
    const run = await launch(repo, 'work', { brief: workerBrief(['true']) })
    expect(run.result.status).toBe('skipped')
    expect(run.result.reason).toContain('src/feature.txt')
    expect(readFileSync(join(repo, 'src/feature.txt'), 'utf8')).toBe(
      'the parent was here\n'
    )
  })

  it('refuses a second worker while one holds the lock, and takes over a dead one', async () => {
    usageStep = 0
    const held = makeRepo('worker-held')
    mkdirSync(join(held, '.delegate'), { recursive: true })
    // This test's own pid, which is alive for as long as the launcher runs.
    writeFileSync(join(held, '.delegate/worker.lock'), String(process.pid))
    const refused = await launch(held, 'work', { brief: workerBrief(['true']) })
    expect(refused.result.status).toBe('skipped')
    expect(refused.result.reason).toContain(`pid ${process.pid}`)

    const stale = makeRepo('worker-stale')
    mkdirSync(join(stale, '.delegate'), { recursive: true })
    writeFileSync(join(stale, '.delegate/worker.lock'), '2147483646')
    const ran = await launch(stale, 'work', { brief: workerBrief(['true']) })
    expect(ran.result.status).toBe('done')
    expect(existsSync(join(stale, '.delegate/worker.lock'))).toBe(false)
  })
})

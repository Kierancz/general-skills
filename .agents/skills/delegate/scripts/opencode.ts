/**
 * The OpenCode harness adapter: one headless `opencode run`, its JSON event
 * stream written to the transcript as it arrives, and the few facts the
 * launcher needs pulled out of it — the session id, the final message, and
 * OpenCode's own cost and token accounting.
 *
 * OpenCode 2.x, located or installed by `install.ts`. Its JSON
 * events keep the 1.x shape this parses: `{ type, sessionID, part }`, with
 * `text` parts carrying `messageID` and `step_finish` parts `cost` and `tokens`.
 *
 * The launcher owns the clock, not OpenCode. 1.x hung on a rejected key; 2.x
 * fails fast on one (measured at 2.0.18: a 401 is an `error` event and exit 1
 * within a second), but a start that never gets as far as the model was still
 * seen once, so the process gets its own process group and the whole group is
 * killed on timeout or budget — the private server, the MCP servers and the
 * shell commands it started go with it. Mossbear's upload is unaffected: the
 * committed plugin runs it in a process group of its own for exactly this
 * reason (a headless run kills its children on exit).
 */

import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

export type HarnessTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
}

export type HarnessRequest = {
  bin: string
  agent: string
  slug: string
  /** The session's title: the brief's id, so a run is findable by it. */
  title: string
  prompt: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutS: number
  transcriptPath: string
  stderrPath: string
  /** Called after every step with OpenCode's running cost total for the session. */
  onHarnessCost?: (totalUsd: number) => void
}

export type HarnessOutcome = {
  exit: number | null
  timedOut: boolean
  killedFor: string | null
  finalMessage: string | null
  sessionId: string | null
  harnessCostUsd: number | null
  tokens: HarnessTokens | null
}

export type HarnessHandle = {
  outcome: Promise<HarnessOutcome>
  kill: (reason: string) => void
}

type EventSummary = {
  sessionId: string | null
  costUsd: number | null
  tokens: HarnessTokens | null
  textByMessage: Map<string, string[]>
  lastTextMessage: string | null
}

export function newEventSummary(): EventSummary {
  return {
    sessionId: null,
    costUsd: null,
    tokens: null,
    textByMessage: new Map(),
    lastTextMessage: null,
  }
}

/**
 * Fold one line of `opencode run --format json` output into the summary.
 * Lines that are not JSON events are ignored: they are still in the
 * transcript, and nothing here depends on them.
 */
export function foldEvent(summary: EventSummary, line: string): void {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event === null || typeof event !== 'object') return
  const e = event as {
    type?: unknown
    sessionID?: unknown
    part?: Record<string, unknown>
  }
  if (typeof e.sessionID === 'string' && summary.sessionId === null) {
    summary.sessionId = e.sessionID
  }
  const part = e.part
  if (!part || typeof part !== 'object') return

  if (e.type === 'text' && typeof part.text === 'string') {
    const messageId = typeof part.messageID === 'string' ? part.messageID : ''
    const texts = summary.textByMessage.get(messageId) ?? []
    texts.push(part.text)
    summary.textByMessage.set(messageId, texts)
    summary.lastTextMessage = messageId
    return
  }

  if (e.type === 'step_finish') {
    if (typeof part.cost === 'number' && Number.isFinite(part.cost)) {
      summary.costUsd = (summary.costUsd ?? 0) + part.cost
    }
    const tokens = part.tokens as
      | { input?: number; output?: number; reasoning?: number; cache?: { read?: number } }
      | undefined
    if (tokens && typeof tokens === 'object') {
      const t = summary.tokens ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0 }
      t.input += tokens.input ?? 0
      t.output += tokens.output ?? 0
      t.reasoning += tokens.reasoning ?? 0
      t.cacheRead += tokens.cache?.read ?? 0
      summary.tokens = t
    }
  }
}

export function finalMessageOf(summary: EventSummary): string | null {
  if (summary.lastTextMessage === null) return null
  const text = (summary.textByMessage.get(summary.lastTextMessage) ?? []).join('').trim()
  return text.length > 0 ? text : null
}

/**
 * The data, state and cache directories OpenCode 2.x runs with: its own tree
 * under `~/.opencode/v2/`, never the XDG defaults it would share with 1.x.
 *
 * The two lines default to the same `~/.local/share/opencode/opencode.db`, and
 * a database 2.x creates is one 1.x refuses ("Database is not empty and has no
 * session table", measured with 2.0.18 and 1.18.32), so a scout that ran
 * first on a machine would break any 1.x tool there.
 * Config stays shared: the directory is read-only to both, and neither
 * needs anything there.
 *
 * Stable rather than per run, so a scout starts warm: OpenCode keeps its
 * database and model catalog here between runs.
 */
export function isolatedOpencodeDirs(home: string): Record<string, string> {
  const root = join(home, '.opencode/v2')
  return {
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
  }
}

const KILL_GRACE_MS = 5000

export function runOpencode(request: HarnessRequest): HarnessHandle {
  const transcript = createWriteStream(request.transcriptPath)
  const summary = newEventSummary()
  let killedFor: string | null = null
  let timedOut = false

  const child = Bun.spawn(
    [
      request.bin,
      'run',
      // A private server, owned by this process group. Without it 2.x runs
      // the session in its shared background service, which outlives the
      // group the timeout and budget kills reach, and reads its environment
      // (OPENCODE_CONFIG_CONTENT, the delegation key) from whichever process
      // started it first.
      '--standalone',
      // Naming the session skips 2.x's title agent, which otherwise spends
      // the delegation key on a model outside the tier file (measured at
      // 2.0.18: `openai/gpt-6-luna`, with no routing asserted).
      '--title',
      request.title,
      '--agent',
      request.agent,
      '--model',
      `openrouter/${request.slug}`,
      '--format',
      'json',
      // Approves permissions that are not explicitly denied. It does not reach
      // an agent's `deny`s, which is what keeps a scout read-only. Without it
      // a headless run blocks on the first tool prompt until the timeout.
      '--auto',
      request.prompt,
    ],
    {
      cwd: request.cwd,
      env: request.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: Bun.file(request.stderrPath),
      detached: true,
    }
  )

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }

  const kill = (reason: string) => {
    if (killedFor !== null || child.exitCode !== null) return
    killedFor = reason
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref()
  }

  const timer = setTimeout(() => {
    timedOut = true
    kill(`no result within ${request.timeoutS}s`)
  }, request.timeoutS * 1000)

  const pump = (async () => {
    const decoder = new TextDecoder()
    let buffered = ''
    for await (const chunk of child.stdout) {
      transcript.write(chunk)
      buffered += decoder.decode(chunk, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const before = summary.costUsd
        foldEvent(summary, buffered.slice(0, newline))
        if (summary.costUsd !== null && summary.costUsd !== before) {
          request.onHarnessCost?.(summary.costUsd)
        }
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    }
    if (buffered.length > 0) foldEvent(summary, buffered)
  })()

  const outcome = (async (): Promise<HarnessOutcome> => {
    const exit = await child.exited
    clearTimeout(timer)
    await pump.catch(() => undefined)
    await new Promise<void>((resolve) => transcript.end(resolve))
    // The group may still hold children the harness left behind (an MCP
    // server, a backgrounded shell). They belong to this run, so they end
    // with it.
    killGroup('SIGKILL')
    return {
      exit: killedFor === null ? exit : null,
      timedOut,
      killedFor,
      finalMessage: finalMessageOf(summary),
      sessionId: summary.sessionId,
      harnessCostUsd: summary.costUsd,
      tokens: summary.tokens,
    }
  })()

  return { outcome, kill }
}

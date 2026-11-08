/**
 * The OpenCode configuration a delegated run starts with, generated here and
 * handed to OpenCode as `OPENCODE_CONFIG_CONTENT` for that run only. It never
 * reads or writes the calling project's `opencode.json`: OpenCode merges this
 * over the project's file last, so the scout and worker agents, their
 * permissions and each tier's model settings are the launcher's whatever the
 * project declares.
 *
 * Agents, permissions and provider settings are written in OpenCode 1.x keys,
 * which 2.x normalizes in memory; `mcp` and `websearch` are 2.x-only and in its
 * own shape (measured at 2.0.18 with `opencode api --standalone config.get`).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ResolvedTier } from './tiers'

const SHARED_REACH =
  'You can reach more than the repo. Web search and fetch work. If the environment supplies a GitHub credential, GitHub\'s REST API answers with it for the repos it covers (send no token of your own, and use it to read, never to write); for any other repo the API returns 403, so do not retry it: read files from `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, and use web fetch or web search for releases, issues and the rest. Any `mossbear` MCP tools you have are its read-only ones.'

const SCOUT_PROMPT = [
  'You are a scout: a read-only research agent working for another agent in this repository. It handed you one question because answering it takes a lot of reading, and it cannot afford to do that reading itself. Your answer is the only part of your work it will see.',
  'You never change anything. Do not edit, create, move or delete files, in the repo or anywhere else, and do not run shell commands that write — no git commits, checkouts or stashes, no installs, no formatters, no code generators, no redirects into files. Read-only shell (grep, rg, find, git log, git show, git diff, cat) is how you work. If the question can only be answered by changing something, say so and stop. The launcher that started you diffs the working tree when you finish, and any change it finds is reported against you.',
  SHARED_REACH,
  "The project's agent instructions (`AGENTS.md`, `CLAUDE.md`), where it has them, are binding. Read the files the brief names before anything else.",
  'Answer the question you were asked, not a neighbouring one. Cite every claim about the code with a `path:line` you opened in this run, and mark anything you could not verify as unverified — a guess stated as a finding costs the reader more than no answer. Keep the reply under 1,500 characters: open with a one-line answer, then the evidence. Lists of paths beat prose.',
].join('\n\n')

const WORKER_PROMPT = [
  'You are a worker: an implementation agent working for another agent in this repository. It handed you one bounded change because making it takes a lot of reading and typing, and it would rather spend its budget deciding than doing. The brief names what to change, which paths you may touch, and the checks that decide whether you succeeded.',
  "The project's agent instructions (`AGENTS.md`, `CLAUDE.md`), where it has them, are binding — read them, and the files the brief names, before you edit.",
  'Edit only inside the brief\'s scope. The launcher that started you diffs the whole tree when you finish: a change to any path outside the scope is reported against you, and the run is marked out of scope however good the change is. When the task cannot be done without touching something outside the scope, stop and say which path and why.',
  'Do exactly what the brief asks and nothing else. A change nobody asked for is a diff somebody now has to review. When you notice something else worth fixing, spend a sentence on it at the end and leave the code alone.',
  "Run the brief's checks yourself before you stop, and fix what they report. The launcher runs them again after you finish, and their exit codes — not your summary — decide whether the run succeeded. Never make a check pass by weakening it: skipping a test, loosening an assertion or deleting a case is a worse outcome than reporting that you could not do this.",
  'Do not commit, push, stash, reset, or switch branches. Leave your work uncommitted in the working tree: the delegating agent reviews the diff and commits it. A moved git ref is reported against you like an out-of-scope edit.',
  SHARED_REACH,
  'Never leave a conflict marker, a debug statement or a commented-out block behind. Keep the reply under 1,500 characters: open with one line saying what you changed, then the files you touched and what the checks said. If you changed nothing, say that first, and say why.',
].join('\n\n')

// The read-only tools of the Mossbear MCP server. Its catch-all deny comes
// first: last match wins in both OpenCode lines, so the exceptions must follow.
const MOSSBEAR_READ_ONLY = [
  'mossbear_search',
  'mossbear_list_bundles',
  'mossbear_pull_bundle',
  'mossbear_list_inbox',
  'mossbear_pull_inbox',
  'mossbear_list_comments',
  'mossbear_artifact_feedback',
]

/**
 * The names of the MCP servers the project's own `opencode.json` declares, so
 * a run can deny their tools: a server enabled there would otherwise start
 * with its write tools allowed, and `--auto` approves whatever is not denied.
 * An unreadable or absent file means none.
 */
export function projectMcpServers(root: string): string[] {
  try {
    const mcp = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8')).mcp
    return mcp && typeof mcp === 'object' && !Array.isArray(mcp) ? Object.keys(mcp) : []
  } catch {
    return []
  }
}

function toolPermissions(projectServers: string[], mossbear: boolean) {
  const rules: Record<string, string> = {}
  for (const name of projectServers) rules[`${name}_*`] = 'deny'
  rules['mossbear_*'] = 'deny'
  if (mossbear) for (const tool of MOSSBEAR_READ_ONLY) rules[tool] = 'allow'
  // 2.x's browser tools, which the tree diff cannot see, and subagents.
  rules.browser = 'deny'
  rules.task = 'deny'
  return rules
}

export type GeneratedConfigInput = {
  tiers: ResolvedTier[]
  /** MCP servers the project declares, whose tools are all denied. */
  projectServers: string[]
  /** Whether to start the `mossbear` MCP server (its read-only tools). */
  mossbear: boolean
}

export function generatedConfig({ tiers, projectServers, mossbear }: GeneratedConfigInput) {
  const tools = toolPermissions(projectServers, mossbear)
  const models: Record<string, { options: unknown }> = {}
  for (const tier of tiers) models[tier.slug] = { options: tier.options }
  return {
    agent: {
      scout: {
        description:
          'Answers one read-only question for a delegating session: searches, reads, and summarizes. Never edits.',
        mode: 'primary',
        prompt: SCOUT_PROMPT,
        permission: { edit: 'deny', bash: 'allow', ...tools },
      },
      worker: {
        description:
          'Carries out one bounded edit for a delegating session, inside the paths its brief scopes. Edits and runs; never commits.',
        mode: 'primary',
        prompt: WORKER_PROMPT,
        permission: {
          edit: 'allow',
          bash: {
            '*': 'allow',
            'git commit*': 'deny',
            'git push*': 'deny',
            'git checkout*': 'deny',
            'git switch*': 'deny',
            'git reset*': 'deny',
            'git stash*': 'deny',
            'git rebase*': 'deny',
            'git merge*': 'deny',
          },
          ...tools,
        },
      },
    },
    permission: {
      external_directory: { '*': 'deny', '/tmp/*': 'allow' },
      doom_loop: 'allow',
    },
    provider: { openrouter: { models } },
    // Whole 2.x entries, because nothing shorter survives: 2.x drops an
    // enabled-only 1.x entry and skips a partial 2.x one, and either way the
    // server silently never starts.
    mcp: {
      servers: mossbear
        ? {
            mossbear: {
              type: 'local' as const,
              command: ['mossbear', 'mcp'],
              disabled: false,
            },
          }
        : {},
    },
    // Names the provider up front. With none chosen, 2.x's first search asks a
    // consent form, a headless run cancels it, and every search fails. Exa
    // answers with no account or key.
    websearch: { provider: 'exa' },
  }
}

/**
 * What OpenCode 2.x itself resolves from the config the launcher generates —
 * read back from the pinned binary, not inferred from the JSON.
 *
 * The agents, permissions and model settings are written in 1.x keys, which
 * 2.x normalizes in memory. That normalization is what a run actually starts
 * under, so it is what these assert: a 1.x key 2.x dropped or reshaped would
 * leave the config looking right and the scout running without the rule.
 *
 * Needs the binary the launcher installs (`~/.opencode/v2/bin/opencode`), and
 * skips without it rather than downloading 90 MB into every test run. Any
 * machine that has delegated on linux-x64 has it.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'

import { generatedConfig } from '../../.agents/skills/delegate/scripts/config'
import { OPENCODE_VERSION, pinnedBinPath } from '../../.agents/skills/delegate/scripts/install'
import { isolatedOpencodeDirs } from '../../.agents/skills/delegate/scripts/opencode'
import {
  DEFAULT_TIER_FILE,
  loadTierFile,
  resolveTier,
} from '../../.agents/skills/delegate/scripts/tiers'

const BIN = pinnedBinPath(homedir())

type Rule = { action: string; resource: string; effect: string }
type Document = { type: string; path?: string | null; info?: Record<string, any> }

function installed(): boolean {
  if (!existsSync(BIN)) return false
  const out = Bun.spawnSync([BIN, '--version'], { stdout: 'pipe', stderr: 'ignore' })
  return out.stdout.toString().trim() === `opencode v${OPENCODE_VERSION}`
}

describe.skipIf(!installed())('the generated config as the pinned OpenCode 2.x reads it', () => {
  const file = loadTierFile(DEFAULT_TIER_FILE)
  const tiers = Object.keys(file.tiers).flatMap((name) => {
    const resolved = resolveTier(file, name)
    return resolved.ok ? [resolved.value] : []
  })
  const config = generatedConfig({ tiers, projectServers: ['writer'], mossbear: true })

  // Read in `beforeAll`, not in the describe body: bun runs the body to
  // register the tests even when `skipIf` skips them.
  let exitCode: number | null = null
  let content: Record<string, any> = {}
  const rulesOf = (agent: string) => (content.agents?.[agent]?.permissions ?? []) as Rule[]
  const effectOf = (agent: string, action: string) =>
    rulesOf(agent).findLast((rule) => rule.action === action && rule.resource === '*')?.effect

  beforeAll(() => {
    // `api --standalone` answers from a private server that exits with the
    // command, from an empty directory so no project config is merged in.
    const read = Bun.spawnSync([BIN, 'api', '--standalone', 'config.get'], {
      cwd: mkdtempSync(`${tmpdir()}/delegate-v2-`),
      env: {
        ...process.env,
        ...isolatedOpencodeDirs(homedir()),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    exitCode = read.exitCode
    const documents = (read.exitCode === 0 ? JSON.parse(read.stdout.toString()) : []) as Document[]
    content = documents.find((d) => d.type === 'document' && d.path == null)?.info ?? {}
  })

  it('reads the 1.x keys as the shape 2.x normalizes', () => {
    expect(exitCode).toBe(0)
    expect(Object.keys(content)).toEqual(
      expect.arrayContaining(['agents', 'permissions', 'providers', 'mcp', 'websearch'])
    )
    expect(content.agents.scout.mode).toBe('primary')
    expect(content.agents.worker.mode).toBe('primary')
  })

  it('keeps the scout read-only, and denies what 2.x added', () => {
    expect(effectOf('scout', 'edit')).toBe('deny')
    expect(effectOf('worker', 'edit')).toBe('allow')
    for (const agent of ['scout', 'worker']) {
      // 1.x's `task`.
      expect(effectOf(agent, 'subagent')).toBe('deny')
      // 2.x's browser tools, which 1.x never had and the tree diff cannot see.
      expect(effectOf(agent, 'browser')).toBe('deny')
      expect(effectOf(agent, 'writer_*')).toBe('deny')
      // Last match wins, so the catch-all has to precede its exceptions.
      const rules = rulesOf(agent).filter((rule) => rule.action.startsWith('mossbear_'))
      expect(rules[0]).toEqual({ action: 'mossbear_*', resource: '*', effect: 'deny' })
      expect(rules.slice(1).every((rule) => rule.effect === 'allow')).toBe(true)
    }
  })

  it('denies the worker the git commands that move refs', () => {
    const shell = rulesOf('worker').filter((rule) => rule.action === 'shell')
    expect(shell.find((rule) => rule.resource === 'git commit*')?.effect).toBe('deny')
    expect(shell.find((rule) => rule.resource === 'git push*')?.effect).toBe('deny')
  })

  it("carries every tier's reasoning and routing through to the model settings", () => {
    const models = content.providers?.openrouter?.models ?? {}
    expect(tiers.length).toBeGreaterThan(0)
    for (const tier of tiers) {
      const settings = models[tier.slug]?.settings
      expect({ slug: tier.slug, reasoning: settings?.reasoning?.effort }).toEqual({
        slug: tier.slug,
        reasoning: expect.any(String),
      })
      expect(settings?.provider).toBeDefined()
    }
  })

  it('keeps the MCP servers and web search, which a malformed entry would lose', () => {
    expect(content.mcp?.servers).toEqual(config.mcp.servers)
    expect(content.websearch).toEqual({ provider: 'exa' })
  })
})

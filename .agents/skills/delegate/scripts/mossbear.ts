/**
 * Whether a delegated run can reach Mossbear. The plugin file and the hook
 * binary being present is not enough: with no usable token the hook logs
 * locally and uploads nothing, so the run would spend credits and never be
 * graded — while the result still named a session id that exists nowhere.
 *
 * Resolves the dashboard the way the CLI does (the environment, then
 * ~/.mossbear/config.json, then the default), so the probe hits the dashboard
 * the worker's hook will upload to, and asks it the same read-only question
 * `mossbear doctor` asks: does it accept this token.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DASHBOARD_URL = 'https://app.mossbear.io'

type Env = Record<string, string | undefined>

export function dashboardUrl(env: Env): string {
  const fromEnv = env.MOSSBEAR_DASHBOARD_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  try {
    const home = env.HOME ?? homedir()
    const config = JSON.parse(readFileSync(join(home, '.mossbear/config.json'), 'utf8'))
    if (typeof config.dashboardUrl === 'string' && config.dashboardUrl.length > 0) {
      return config.dashboardUrl.replace(/\/+$/, '')
    }
  } catch {
    // No config file is the ordinary case: fall through to the default.
  }
  return DEFAULT_DASHBOARD_URL
}

export type MossbearProbe = { ok: true } | { ok: false; reason: string }

export async function probeMossbear(env: Env, timeoutMs = 10000): Promise<MossbearProbe> {
  // An environment token or nothing: a missing MOSSBEAR_TOKEN means
  // local-only mode rather than a fall back to a token stored on disk, and a
  // delegated run follows that.
  const token = env.MOSSBEAR_TOKEN
  if (!token) {
    return {
      ok: false,
      reason: 'Mossbear cannot record this run: MOSSBEAR_TOKEN is not set',
    }
  }
  const url = dashboardUrl(env)
  let status: number
  try {
    const response = await fetch(`${url}/api/v1/guides`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    status = response.status
    await response.body?.cancel()
  } catch (error) {
    return {
      ok: false,
      reason: `Mossbear cannot record this run: ${url} could not be reached (${String(error)})`,
    }
  }
  if (status >= 200 && status < 300) return { ok: true }
  return {
    ok: false,
    reason:
      status === 401
        ? `Mossbear cannot record this run: ${url} rejected MOSSBEAR_TOKEN`
        : `Mossbear cannot record this run: ${url} answered ${status}`,
  }
}

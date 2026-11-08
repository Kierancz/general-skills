/**
 * OpenRouter's key endpoint: whether the delegation key is live, and how much
 * it has spent. `GET /api/v1/key` returns the key's cumulative usage in USD,
 * which is what the budget guard diffs against the pre-run snapshot.
 *
 * The key travels in a request header from this process — never in argv, where
 * any process on the box can read it out of /proc/<pid>/cmdline.
 */

/** The key's cumulative usage from a `GET /key` body, or null when it has none. */
export function usageOf(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (data === null || typeof data !== 'object') return null
  const usage = (data as { usage?: unknown }).usage
  return typeof usage === 'number' && Number.isFinite(usage) ? usage : null
}

export type KeyProbe =
  | { ok: true; usageUsd: number }
  | { ok: false; status: number | null; reason: string }

export function openRouterBase(env: Record<string, string | undefined>): string {
  // Overridable so the launcher's tests can stand up a stub endpoint and spend
  // nothing. Not a user-facing knob.
  return env.DELEGATE_OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1'
}

export async function probeKey(
  base: string,
  key: string,
  timeoutMs = 15000
): Promise<KeyProbe> {
  let response: Response
  try {
    response = await fetch(`${base}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      ok: false,
      status: null,
      reason: `could not reach OpenRouter (${String(error)})`,
    }
  }
  if (response.status !== 200) {
    return {
      ok: false,
      status: response.status,
      reason: `OpenRouter answered ${response.status}`,
    }
  }
  const usage = usageOf(await response.json().catch(() => null))
  if (usage === null) {
    return {
      ok: false,
      status: 200,
      reason: 'OpenRouter answered without a usage figure',
    }
  }
  return { ok: true, usageUsd: usage }
}

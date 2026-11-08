/**
 * Finds the OpenCode 2.x binary a run uses, installing the pinned,
 * digest-verified release when it is missing.
 *
 * In order: `DELEGATE_OPENCODE_BIN` when set; the pinned version under
 * `~/.opencode/v2/bin/`, downloaded and checked on linux-x64; otherwise an
 * `opencode` on PATH that reports a 2.x version, which is the machine owner's
 * own install. Anything else is a skip with the reason.
 *
 * Where the bytes come from. 2.x ships through npm: `@opencode/cli` is a shim
 * whose per-platform optionalDependency (`@opencode/cli-linux-x64`) carries the
 * binary, and upstream's own installer fetches that package's registry
 * tarball. This fetches the same tarball directly and checks it against a
 * digest pinned here: a mutable install script run on a machine holding an
 * OpenRouter key is exactly what a pin exists to remove.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const OPENCODE_VERSION = '2.0.18'

// Verified 2026-09-27 by downloading the tarball and running the binary inside
// it, which reported `opencode v2.0.18`; the same bytes match npm's published
// integrity for the package. linux-x64 only: a digest nobody verified is
// decoration.
const SHA256_LINUX_X64 = 'aa455d073b3a0733a6912f477b370f3d50ca7af44715bb7ccc41faa13b3cc2eb'

type Env = Record<string, string | undefined>

export type Located = { ok: true; bin: string } | { ok: false; reason: string }

export function pinnedBinPath(home: string): string {
  return join(home, '.opencode/v2/bin/opencode')
}

function versionOf(bin: string): string {
  try {
    const out = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'ignore' })
    return out.exitCode === 0 ? out.stdout.toString().trim() : ''
  } catch {
    return ''
  }
}

async function installPinned(bin: string): Promise<Located> {
  const url = `https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz`
  let bytes: Uint8Array
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) {
      return { ok: false, reason: `could not download opencode ${OPENCODE_VERSION} (HTTP ${response.status})` }
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    return { ok: false, reason: `could not download opencode ${OPENCODE_VERSION} (${String(error)})` }
  }
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== SHA256_LINUX_X64) {
    // Never install it anyway: a mismatch is a corrupted download or a
    // replaced package, and the second is the case this check exists for.
    return { ok: false, reason: `opencode ${OPENCODE_VERSION} failed its digest check (got ${got})` }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'delegate-opencode-'))
  try {
    await Bun.write(join(tmp, 'oc.tgz'), bytes)
    const tar = Bun.spawnSync(['tar', '-xzf', 'oc.tgz', 'package/bin/opencode'], {
      cwd: tmp,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    if (tar.exitCode !== 0) return { ok: false, reason: 'could not extract the opencode archive' }
    mkdirSync(join(bin, '..'), { recursive: true })
    renameSync(join(tmp, 'package/bin/opencode'), bin)
    chmodSync(bin, 0o755)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (versionOf(bin) !== `opencode v${OPENCODE_VERSION}`) {
    return { ok: false, reason: `opencode at ${bin} does not report v${OPENCODE_VERSION} after install` }
  }
  return { ok: true, bin }
}

export async function locateOpencode(env: Env, home: string): Promise<Located> {
  if (env.DELEGATE_OPENCODE_BIN) return { ok: true, bin: env.DELEGATE_OPENCODE_BIN }

  const pinned = pinnedBinPath(home)
  // `--version` prints `opencode v2.0.18`, not the bare version 1.x prints.
  if (existsSync(pinned) && versionOf(pinned) === `opencode v${OPENCODE_VERSION}`) {
    return { ok: true, bin: pinned }
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return installPinned(pinned)
  }

  const onPath = Bun.which('opencode', { PATH: env.PATH ?? '' })
  if (onPath && /^opencode v2\./.test(versionOf(onPath))) return { ok: true, bin: onPath }
  return {
    ok: false,
    reason: `no OpenCode 2.x: the pinned ${OPENCODE_VERSION} is verified for linux-x64 only, and no \`opencode\` on PATH reports a 2.x version (install one, or set DELEGATE_OPENCODE_BIN)`,
  }
}

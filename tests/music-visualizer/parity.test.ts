// The page and align.py must read a lyrics note the same way: same lines, same
// order, same fingerprint. If they drift, every page silently drops its
// timing and falls back to the note's own timestamps.
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skill = join(import.meta.dir, '../../.agents/skills/music-visualizer')
const template = readFileSync(join(skill, 'template.html'), 'utf8')

/** One named function's source, cut out of the template's script. */
function extract(name: string): string {
  const start = template.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`template.html has no function ${name}`)
  let depth = 0
  for (let i = template.indexOf('{', start); i < template.length; i++) {
    if (template[i] === '{') depth++
    else if (template[i] === '}' && --depth === 0) return template.slice(start, i + 1)
  }
  throw new Error(`function ${name} never closes`)
}

const page = new Function(`${extract('parseLyrics')}\n${extract('hash')}\nreturn { parseLyrics, hash }`)() as {
  parseLyrics: (text: string) => { entries: { t: number | null; text: string }[]; timed: boolean }
  hash: (text: string) => string
}

function python(text: string): { entries: [number | null, string][]; timed: boolean; fingerprint: string } {
  const run = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from align import parse_lyrics, fingerprint
entries, timed = parse_lyrics(sys.stdin.read())
print(json.dumps({"entries": entries, "timed": timed, "fingerprint": fingerprint([t for _, t in entries])}))
`, skill], { input: text, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(run.stderr)
  return JSON.parse(run.stdout)
}

function agree(text: string) {
  const js = page.parseLyrics(text)
  const py = python(text)
  expect(py.timed).toBe(js.timed)
  expect(py.entries.map(([t, line]) => [t === null ? null : Math.round(t * 1000), line]))
    .toEqual(js.entries.map((e) => [e.t === null ? null : Math.round(e.t * 1000), e.text]))
  expect(py.fingerprint).toBe(page.hash(js.entries.map((e) => e.text).join('\n')))
}

describe('lyrics parsing matches between template.html and align.py', () => {
  it('reads timed lines, skipping tags, plain lines and headings', () => {
    agree([
      '# Notes', 'A plain line that the timed ones outrank', '',
      '[ti: Example]', '[length: 03:28]',
      '[00:12.50]First line', '[00:15.04] Second, with a comma', '[00:20.00]',
      '[01:02:30]Colon-style hundredths', '[00:30.1][01:30.25]Sung twice',
    ].join('\n'))
  })

  it('reads plain lines when nothing is timed', () => {
    agree('﻿First line\r\n\r\n  Second line  \n## Chorus\nThird — with a dash\n')
  })

  it('fingerprints text outside the basic plane the same way', () => {
    agree('[00:01.00]Café ☕\n[00:02.00]Emoji 🎶 line\n[00:03.00]日本語の歌詞')
  })

  it('keeps notes with equal timestamps in their written order', () => {
    agree('[00:05.00]Later\n[00:01.00]A\n[00:01.00]B\n[00:01.00]C')
  })
})

#!/usr/bin/env node
// Open a built page in Chromium with a stand-in Mossbear runtime, the real
// track and the real lyrics, and report what it shows.
//
//   node check.cjs page.html track.mp3 [lyrics.md] --out <dir> [--at 30,61.5]
//
// Prints JSON: whether the track got ready, which timing the lyrics used, the
// line on screen at each sampled moment (each timed line by default), console
// errors, and the screenshots it wrote. Nothing leaves this machine: the page
// is served from 127.0.0.1 and the stand-in answers the page's reads locally.
// Needs Node and Playwright with Chromium.
'use strict'
const fs = require('fs')
const http = require('http')
const path = require('path')

let chromium
try { ({ chromium } = require('playwright')) } catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Playwright is not installed: npm i -g playwright && npx playwright install chromium' }))
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1] }
const outDir = flag('--out')
const at = flag('--at')
const [pagePath, audioPath, lyricsPath] = args
if (!pagePath || !audioPath || !outDir) {
  console.log(JSON.stringify({ ok: false, error: 'usage: check.cjs page.html track.mp3 [lyrics.md] --out <dir> [--at 30,61.5]' }))
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })
const page = fs.readFileSync(pagePath, 'utf8')
const lyrics = lyricsPath ? fs.readFileSync(lyricsPath, 'utf8') : null
const audio = fs.readFileSync(audioPath)
const audioType = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[path.extname(audioPath).toLowerCase()] || 'application/octet-stream'
const declaration = JSON.parse(page.match(/<script type="application\/json" id="mossbear">([\s\S]*?)<\/script>/)[1])

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page) }
  if (req.url === '/track') {
    // Ranges, so the audio element can seek.
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
    if (m) {
      const start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : audio.length - 1
      res.writeHead(206, { 'content-type': audioType, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${audio.length}`, 'content-length': end - start + 1 })
      return res.end(audio.subarray(start, end + 1))
    }
    res.writeHead(200, { 'content-type': audioType, 'accept-ranges': 'bytes', 'content-length': audio.length })
    return res.end(audio)
  }
  res.writeHead(404); res.end()
})

;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  const result = { ok: true, errors: [], screenshots: [] }
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } })
    const tab = await ctx.newPage()
    tab.on('pageerror', (e) => result.errors.push(String(e)))
    tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') result.errors.push(m.text()) })
    await tab.addInitScript(({ declaration, lyrics, trackUrl, audioType, bytes }) => {
      const item = (id, extra) => Object.assign({ state: 'loaded', id, name: 'stand-in', version: 1, contentHash: null, updatedAt: '', description: null }, extra)
      const data = {
        source(name) {
          const read = declaration.reads[name]
          if (!read) return undefined
          if (read.want === 'audio') return { binding: name, state: 'loaded', want: 'audio', bytes: 100, source: { kind: 'artifact', item: item(read.artifact, { kind: 'audio', audio: { mediaType: audioType, bytes, durationMs: 0, channels: 2, sampleRate: 44100 } }) } }
          if (read.want === 'text' && lyrics != null) return { binding: name, state: 'loaded', want: 'text', bytes: lyrics.length, source: { kind: 'artifact', item: item(read.artifact, { kind: 'markdown', text: lyrics }) } }
          return { binding: name, state: 'unavailable' }
        },
        audio() {
          return Promise.resolve({ state: 'loaded', mediaType: audioType, url: trackUrl, arrayBuffer: () => fetch(trackUrl).then((r) => r.arrayBuffer()) })
        },
      }
      Object.defineProperty(window, 'mossbear', { value: { use: () => Promise.resolve(data) }, writable: false, configurable: false })
    }, { declaration, lyrics, trackUrl: base + '/track', audioType, bytes: audio.length })

    await tab.goto(base + '/')
    await tab.waitForFunction(() => document.getElementById('status').textContent === 'Ready', null, { timeout: 20000 })
      .catch(() => {})
    result.status = await tab.textContent('#status')
    result.ready = result.status === 'Ready'
    result.lyrics = await tab.evaluate(() => ({
      shown: !document.getElementById('lyrToggle').hidden,
      hint: document.getElementById('lyrHint').textContent,
    }))

    // When to look: each timed line half a second in, unless --at says otherwise.
    const config = await tab.evaluate(() => { try { return JSON.parse(document.getElementById('page-config').textContent) } catch (e) { return {} } })
    const moments = at ? at.split(',').map(Number)
      : ((config.timing && config.timing.times) || []).filter((t) => t != null).map((t) => +(t + 0.5).toFixed(1))
    result.samples = []
    if (result.ready) {
      for (const t of moments) {
        await tab.evaluate((t) => { const a = document.getElementById('audio'); a.currentTime = t; return a.play().then(() => a.pause()) }, t)
        await tab.waitForTimeout(250)
        result.samples.push(Object.assign({ t }, await tab.evaluate(() => ({
          now: document.getElementById('lyrNow').textContent,
          next: document.getElementById('lyrNext').textContent,
        }))))
      }
      const shot = moments.length ? moments[Math.min(1, moments.length - 1)] : 30
      await tab.evaluate((t) => { const a = document.getElementById('audio'); a.currentTime = t; return a.play() }, shot)
      await tab.waitForTimeout(1500)
    }
    const desktop = path.join(outDir, 'desktop.png')
    await tab.screenshot({ path: desktop }); result.screenshots.push(desktop)
    await tab.setViewportSize({ width: 390, height: 780 })
    if (result.lyrics.shown) await tab.click('#lyrToggle')
    await tab.waitForTimeout(400)
    const phone = path.join(outDir, 'phone.png')
    await tab.screenshot({ path: phone }); result.screenshots.push(phone)
  } catch (e) {
    result.ok = false; result.error = String(e)
  } finally {
    await browser.close(); server.close()
  }
  result.ok = result.ok && result.ready && result.errors.length === 0
  console.log(JSON.stringify(result, null, 1))
  process.exit(result.ok ? 0 : 1)
})()

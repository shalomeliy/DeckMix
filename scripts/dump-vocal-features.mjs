/**
 * v0.9.10 research (01/10): run the real `vocalFeatures` (src/core/sound) on the 30 songs of the vocal tagging
 * round, in the browser the app runs in, and save the per-frame features plus the cost of each song, so the
 * score can be fitted offline on the owner's TRAINING clips without decoding again. The sealed songs are
 * dumped like the others, but the fitting script never reads their labels.
 *
 *   node scripts/dump-vocal-features.mjs   ->  %TEMP%/vocal-features.json   (needs npm run dev; DEV=http://localhost:<port> when it is not on 5173)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const DL = path.join(os.homedir(), 'Downloads')
const tags = JSON.parse(fs.readFileSync(process.env.TAGS ?? path.join(DL, 'deckmix-tags-2026-10-02- 100 vocals.json'), 'utf8'))
const byHash = new Map()
for (const v of tags.vocal) {
  if (!byHash.has(v.contentHash)) byHash.set(v.contentHash, { trackId: v.trackId, genre: v.genre, holdout: v.holdout, hash: v.contentHash })
}
const songs = [...byHash.values()]
console.log(`${songs.length} songs`)

const server = http.createServer((req, res) => {
  if (req.url === '/__blank') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>m</title>')
  const s = songs[Number(req.url.split('/').pop())]
  if (!s) return res.writeHead(404).end()
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
  fs.createReadStream(path.join(ROOT, s.trackId)).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'chrome' })
let page = await browser.newPage()
await page.goto(`${BASE}/__blank`)
const rows = []
for (let i = 0; i < songs.length; i++) {
  const r = await page
    .evaluate(
      async ({ i, base, dev }) => {
        const V = `${dev}/src`
        const { pcmFromAudioBuffer } = await import(`${V}/platform/analyzer-js/analyze.ts`)
        const { vocalFeatures } = await import(`${V}/core/sound/vocal-presence.ts`)
        const { repairWav } = await import(`${V}/core/wav-repair.ts`)
        const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
        const w = repairWav(new Uint8Array(bytes))
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(w ? w.buffer : bytes)
        const pcm = pcmFromAudioBuffer(audio)
        const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0
        const t0 = performance.now()
        const out = vocalFeatures(pcm)
        const ms = performance.now() - t0
        const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0
        if ('result' in out) return { state: out.result.state, ms, dur: audio.duration }
        const f = out.features
        const a = (x) => Array.from(x, (v) => Math.round(v * 1e4) / 1e4)
        return {
          dur: audio.duration,
          ms,
          heapMB: (heap1 - heap0) / 1e6,
          frameSec: f.frameSec,
          stereo: f.stereo,
          harmonic: a(f.harmonic),
          centre: a(f.centre),
          bright: a(f.bright),
          motion: a(f.motion),
          level: a(f.level),
          cues: { fluct: a(f.cues.fluct), consist: a(f.cues.consist), flat: a(f.cues.flat), mfcc: Array.from(f.cues.mfcc, (v) => Math.round(v * 1e3) / 1e3) },
        }
      },
      { i, base: BASE, dev: process.env.DEV ?? 'http://localhost:5173' },
    )
    .catch((e) => ({ error: String(e.message).split('\n')[0] }))
  rows.push({ s: songs[i], r })
  console.log(`  ${i + 1}/${songs.length} ${r.error ? 'ERROR ' + r.error : (r.ms / 1000).toFixed(1) + 's for ' + r.dur.toFixed(0) + 's' + (r.state ? ' ' + r.state : '')}`)
  if ((i + 1) % 10 === 0) {
    await page.close()
    page = await browser.newPage()
    await page.goto(`${BASE}/__blank`)
  }
}
await browser.close()
server.close()
fs.writeFileSync(path.join(process.env.TEMP ?? '.', 'vocal-features.json'), JSON.stringify(rows))
const ok = rows.filter((x) => x.r.ms)
const per300 = ok.map((x) => (x.r.ms / x.r.dur) * 300).sort((a, b) => a - b)
console.log(`cost per 5-minute track: median ${per300[per300.length >> 1].toFixed(0)} ms, max ${per300.at(-1).toFixed(0)} ms; errors ${rows.length - ok.length}`)

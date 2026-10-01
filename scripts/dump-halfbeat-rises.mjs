/**
 * v0.9.5 research (01/10): dump, for every dance song with an answer, the per-half-beat rise of each
 * onset band (the same `rise` detectBarOne uses), so "the 1 is a beat before the kick" can be
 * studied offline with cross-validation instead of by re-decoding 100 songs per idea.
 *   node scripts/dump-halfbeat-rises.mjs   ->  %TEMP%/halfbeat-rises.json
 * Original header follows: the shipped `core/downbeat.ts` against every answer Shalom gave on
 * 28/09, listening rounds applied, from two sources: `kickEnvelope` on the
 * decoded track (what ships — the deck runs it at load) and the cached
 * waveform's low band (measured worse, kept to show why). Read-only.
 *
 *   node scripts/measure-downbeat.mjs [--other]   (against npm run dev on :5173; --other = Hip Hop/Mizrahi)
 *
 * Sets: train (75, tuned on), sealed (30), fresh (43, the new round). Only the
 * last two say anything about songs the method was not fitted to.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const DL = path.join(os.homedir(), 'Downloads')
const read = (f) => JSON.parse(fs.readFileSync(path.join(DL, f), 'utf8'))
const t26 = read('deckmix-tags-2026-09-28 - 26 songs.json')
const t46 = read('deckmix-tags-2026-09-28 - 46 songs.json')
const decide = new Map(t26.decide.filter((d) => d.answer === 'marked').map((d) => [d.contentHash, d.markSec]))
// 01/10: the 272-song round. Only songs no earlier file had are 'fresh2' - the method was frozen
// (a746d1f) before this file was opened, and no listening round has touched these answers.
const t272 = read('deckmix-tags-2026-10-01 - 272 songs.json')
const songs = [
  ...t26.mark.filter((m) => m.detectorGrid).map((m) => ({ ...m, set: m.holdout ? 'sealed' : 'train', truthSec: decide.get(m.contentHash) ?? m.markSec })),
  ...t46.fresh.filter((m) => m.answer === 'marked' && m.detectorGrid).map((m) => ({ ...m, set: 'fresh', truthSec: m.markSec })),
]
const seen = new Set(songs.map((x) => x.contentHash))
for (const m of t272.fresh) {
  if (m.answer !== 'marked' || !m.detectorGrid || seen.has(m.contentHash)) continue
  seen.add(m.contentHash)
  songs.push({ ...m, set: 'fresh2', truthSec: m.markSec })
}
// the listening rounds: where the ears picked the other click, that is the answer
for (const f of ['deckmix-listen-2026-09-28.json', 'deckmix-listen-2026-09-28-test.json', 'deckmix-listen-2026-09-28-fresh.json']) {
  if (!fs.existsSync(path.join(DL, f))) continue
  for (const it of read(f).items) {
    const v = it.answer?.value
    if ((v !== 'a' && v !== 'b') || (v === 'a') === it.mineIsA) continue
    const s = songs.find((x) => x.contentHash === it.contentHash)
    if (s) s.truthSec = v === 'a' ? it.a : it.b
  }
}
const beatOf = (sec, g) => ((Math.round((sec - g.offsetSec) / (60 / g.bpm)) % 4) + 4) % 4

const DANCE = new Set(['House', 'Techno', 'Trance'])
for (let i = songs.length - 1; i >= 0; i--) if (!DANCE.has(songs[i].genre)) songs.splice(i, 1)

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
  const s = songs[i]
  const r = await page
    .evaluate(
      async ({ i, base, grid }) => {
        const V = 'http://localhost:5173/src'
        const { pcmFromAudioBuffer, buildOnsetEnvelope } = await import(`${V}/platform/analyzer-js/analyze.ts`)
        const { repairWav } = await import(`${V}/core/wav-repair.ts`)
        const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
        const w = repairWav(new Uint8Array(bytes))
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(w ? w.buffer : bytes)
        const env = buildOnsetEnvelope(pcmFromAudioBuffer(audio))
        const beatSec = 60 / grid.bpm
        const beats = Math.floor((audio.duration - grid.offsetSec) / beatSec)
        const perSec = env.framesPerSec
        const out = []
        for (const band of env.bands) {
          const rise = (sec) => {
            const c = Math.round(sec * perSec)
            const ww = Math.max(1, Math.round(0.025 * perSec))
            let best = 0
            for (let j = Math.max(1, c - ww); j <= Math.min(band.length - 1, c + ww); j++) best = Math.max(best, band[j] - band[j - 1])
            return best
          }
          const x = new Array(2 * beats)
          for (let k = 0; k < beats; k++) {
            const t = grid.offsetSec + k * beatSec
            x[2 * k] = rise(t)
            x[2 * k + 1] = rise(t + beatSec / 2)
          }
          out.push(x)
        }
        return { bands: out, nBands: env.bands.length }
      },
      { i, base: BASE, grid: s.detectorGrid },
    )
    .catch((e) => ({ error: String(e.message).split('\n')[0] }))
  rows.push({ s, r })
  if ((i + 1) % 15 === 0) {
    await page.close()
    page = await browser.newPage()
    await page.goto(`${BASE}/__blank`)
    console.log(`  ${i + 1}/${songs.length}`)
  }
}
await browser.close()
server.close()
const keep = rows.filter((x) => !x.r?.error && DANCE.has(x.s.genre)).map((x) => ({ id: x.s.trackId, set: x.s.set, genre: x.s.genre, grid: x.s.detectorGrid, truth: beatOf(x.s.truthSec, x.s.detectorGrid), bands: x.r.bands }))
fs.writeFileSync(path.join(process.env.TEMP ?? '.', 'halfbeat-rises.json'), JSON.stringify(keep))
console.log(`${keep.length} dance songs written`)

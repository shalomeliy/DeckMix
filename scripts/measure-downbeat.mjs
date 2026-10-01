/**
 * v0.9.5: the shipped `core/downbeat.ts` against every answer Shalom gave on
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

// 01/10 (later): 15 psytrance songs Shalom added and marked, the first genuinely unseen DANCE songs since 28/09
const tNew = read('deckmix-tags-2026-10-01 - NEW.json')
for (const m of tNew.mark) {
  if (m.answer !== 'marked' || !m.detectorGrid || seen.has(m.contentHash)) continue
  seen.add(m.contentHash)
  songs.push({ ...m, set: 'fresh3', truthSec: m.markSec })
}

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
        const { analyzeWaveform, pcmFromAudioBuffer, buildOnsetEnvelope } = await import(`${V}/platform/analyzer-js/analyze.ts`)
        const { detectBarOne } = await import(`${V}/core/downbeat.ts`)
        const { repairWav } = await import(`${V}/core/wav-repair.ts`)
        const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
        const w = repairWav(new Uint8Array(bytes))
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(w ? w.buffer : bytes)
        // analyzeTrack's own bucket count
        const buckets = Math.min(120_000, Math.max(2_000, Math.ceil(audio.duration * 200)))
        const { bands } = analyzeWaveform(pcmFromAudioBuffer(audio), buckets)
        const low = new Float32Array(bands.length / 3)
        for (let j = 0; j < low.length; j++) low[j] = bands[3 * j]
        const pcm = pcmFromAudioBuffer(audio)
        const t0 = performance.now()
        const env = buildOnsetEnvelope(pcm)
        const envMs = performance.now() - t0
        return { wave: detectBarOne(low, low.length / audio.duration, grid), kick: detectBarOne(env.bands[0], env.framesPerSec, grid), envMs, dur: audio.duration }
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

const DANCE = new Set(['House', 'Techno', 'Trance'])
const GENRE_SET = process.argv.includes('--other') ? 'other' : 'dance'
const all = rows
for (const src of ['wave', 'kick']) {
console.log(`
${src === 'wave' ? 'cached waveform low band (<200 Hz)' : 'kick band from the decoded track (<150 Hz, buildOnsetEnvelope)'}`)
const rowsSrc = all.map((x) => ({ s: x.s, r: x.r?.error ? x.r : x.r?.[src] }))
for (const set of ['train', 'sealed', 'fresh', 'fresh2', 'fresh3', 'unseen']) {
  const sel = rowsSrc.filter(({ s, r }) => !r?.error && DANCE.has(s.genre) === (GENRE_SET === 'dance') && (set === 'unseen' ? s.set !== 'train' : s.set === set))
  const ok = (x) => (x.r ? x.r.beat : 0) === beatOf(x.s.truthSec, x.s.detectorGrid)
  const first = sel.filter((x) => beatOf(x.s.truthSec, x.s.detectorGrid) === 0).length
  const sure = sel.filter((x) => x.r?.sure)
  // the unsure ones alone: the app moves the grid there too (chooseBarGrid) — is that better than the first beat?
  const unsure = sel.filter((x) => !x.r?.sure)
  const unsureFirst = unsure.filter((x) => beatOf(x.s.truthSec, x.s.detectorGrid) === 0).length
  console.log(
    `${set.padEnd(7)} ${GENRE_SET} ${sel.length}: detector ${sel.filter(ok).length}, first beat ${first}, sure ${sure.filter(ok).length}/${sure.length}; unsure ${unsure.length}: detector ${unsure.filter(ok).length}, first beat ${unsureFirst}`,
  )
}
}
const ms = all.filter((x) => x.r?.envMs).map((x) => (x.r.envMs / x.r.dur) * 300)
console.log(`
kick band cost, scaled to a 5-minute track: median ${ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)].toFixed(0)} ms`)
if (process.argv.includes('--fails')) {
  // every song the kick detector gets wrong, with where the ears put the "1" relative to the grid
  for (const { s, r } of rows) {
    const k = r?.kick
    if (!k) continue
    const truth = beatOf(s.truthSec, s.detectorGrid)
    if (k.beat !== truth) console.log(`FAIL ${s.set} ${s.genre} truth=${truth} got=${k.beat} margin=${k.margin.toFixed(2)} ${s.trackId}`)
  }
}
const errs = rows.filter((x) => x.r?.error)
if (errs.length) console.log('errors:', errs.map((x) => `${x.s.trackId}: ${x.r.error}`))

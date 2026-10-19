/**
 * v0.9.72 experiment, step 1 (on the owner's PC): per-beat features for EVERY song whose "1" Shalom has marked — all tag rounds and the
 * listening corrections, the same song set as `measure-downbeat.mjs` — plus what the shipped `detectBarOne` answers on each, so a learned
 * model can be compared with today's method on exactly the same songs. Read-only: files are read, never written.
 *
 *   npm run dev   (in one window), then:   node scripts/dump-barone-all.mjs
 *
 * Writes %TEMP%\barone-all.json. Send that file back; `scripts/fit-barone-model.py` does the rest anywhere.
 * Features per beat k, as in `dump-downbeat-features.mjs`: band energy e, onset rise on / half-beat oh, chroma, spectral flux.
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
const OUT = path.join(process.env.TEMP ?? '.', 'barone-all.json')
console.log(`${songs.length} marked songs`)

// 19/10: a song renamed or moved since it was marked crashed the whole run (an unhandled stream error). Look for it by name
// elsewhere in the library (also under another extension, after a v0.9.59 rename); if it is gone, leave it out and SAY so at the end.
const byStem = new Map()
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full)
    else {
      const stem = path.parse(ent.name).name.toLowerCase()
      if (!byStem.has(stem)) byStem.set(stem, [])
      byStem.get(stem).push(full)
    }
  }
}
walk(ROOT)
const moved = []
const missing = []
for (const s of songs) {
  const at = path.join(ROOT, s.trackId)
  if (fs.existsSync(at)) { s.filePath = at; continue }
  const found = byStem.get(path.parse(s.trackId).name.toLowerCase())
  if (found?.length === 1) { s.filePath = found[0]; moved.push(s.trackId) }
  else missing.push(s.trackId)
}

const server = http.createServer((req, res) => {
  if (req.url === '/__blank') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>measure</title>')
    return
  }
  const s = songs[Number(req.url.split('/').pop())]
  if (!s) return res.writeHead(404).end()
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' })
  if (!s.filePath) return res.writeHead(404).end()
  const stream = fs.createReadStream(s.filePath)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let browser = await chromium.launch({ channel: 'chrome' })
const openPage = async () => {
  const p = await browser.newPage()
  await p.goto(`${BASE}/__blank`)
  return p
}
let page = await openPage()

const rows = []
const t0 = Date.now()
const failed = []
for (let i = 0; i < songs.length; i++) {
  const s = songs[i]
  if (!s.filePath) continue
  const r = await page.evaluate(
    async ({ i, base, grid, genre }) => {
      const { buildOnsetEnvelope, pcmFromAudioBuffer } = await import('http://localhost:5173/src/platform/analyzer-js/analyze.ts')
      const { repairWav } = await import('http://localhost:5173/src/core/wav-repair.ts')
      const { detectBarOne } = await import('http://localhost:5173/src/core/downbeat.ts')
      const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
      // the same repair engine.decode does before decoding (core/wav-repair.ts)
      const wav = repairWav(new Uint8Array(bytes))
      const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(wav == null ? bytes : wav.buffer)
      const pcm = pcmFromAudioBuffer(audio)
      const { bands, framesPerSec } = buildOnsetEnvelope(pcm)
      const dur = audio.duration
      const beatSec = 60 / grid.bpm
      const nBeats = Math.floor((dur - grid.offsetSec) / beatSec)
      const nf = bands[0].length
      const e = bands.map(() => new Array(nBeats).fill(0))
      const on = bands.map(() => new Array(nBeats).fill(0))
      const oh = bands.map(() => new Array(nBeats).fill(0))
      const win = Math.round(0.025 * framesPerSec)
      const rise = (b, f) => {
        let best = 0
        for (let j = Math.max(1, f - win); j <= Math.min(nf - 1, f + win); j++) best = Math.max(best, bands[b][j] - bands[b][j - 1])
        return best
      }
      for (let k = 0; k < nBeats; k++) {
        const t = grid.offsetSec + k * beatSec
        const a = Math.round(t * framesPerSec)
        const z = Math.min(nf, Math.round((t + beatSec) * framesPerSec))
        for (let b = 0; b < 4; b++) {
          let sum = 0
          for (let j = a; j < z; j++) sum += bands[b][j]
          e[b][k] = sum / Math.max(1, z - a)
          on[b][k] = rise(b, a)
          oh[b][k] = rise(b, Math.round((t + beatSec / 2) * framesPerSec))
        }
      }
      // mono at 11025 (4-sample average — a crude low-pass, enough for chroma up to 2kHz)
      const chans = pcm.channels
      const srcRate = pcm.sampleRate
      const D = 4
      const rate = srcRate / D
      const len = Math.floor(chans[0].length / D)
      const x = new Float32Array(len)
      for (let n = 0; n < len; n++) {
        let v = 0
        for (let d = 0; d < D; d++) for (const c of chans) v += c[n * D + d]
        x[n] = v / (D * chans.length)
      }
      const N = 4096
      const hann = new Float32Array(N).map((_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N))
      const re = new Float64Array(N)
      const im = new Float64Array(N)
      const fft = () => {
        for (let a = 1, b = 0; a < N; a++) {
          let bit = N >> 1
          for (; b & bit; bit >>= 1) b ^= bit
          b ^= bit
          if (a < b) {
            ;[re[a], re[b]] = [re[b], re[a]]
            ;[im[a], im[b]] = [im[b], im[a]]
          }
        }
        for (let size = 2; size <= N; size <<= 1) {
          const ang = (-2 * Math.PI) / size
          for (let s = 0; s < N; s += size)
            for (let j = 0; j < size / 2; j++) {
              const wr = Math.cos(ang * j)
              const wi = Math.sin(ang * j)
              const p = s + j
              const q = p + size / 2
              const tr = re[q] * wr - im[q] * wi
              const ti = re[q] * wi + im[q] * wr
              re[q] = re[p] - tr
              im[q] = im[p] - ti
              re[p] += tr
              im[p] += ti
            }
        }
      }
      const binHz = rate / N
      const lo = Math.ceil(55 / binHz)
      const hi = Math.floor(2000 / binHz)
      const pcOf = []
      for (let bin = lo; bin <= hi; bin++) pcOf[bin] = ((Math.round(12 * Math.log2((bin * binHz) / 440)) % 12) + 12 + 9) % 12
      const chroma = []
      const flux = []
      let prev = null
      for (let k = 0; k < nBeats; k++) {
        const start = Math.round((grid.offsetSec + k * beatSec) * rate)
        for (let n = 0; n < N; n++) {
          re[n] = start + n < len ? x[start + n] * hann[n] : 0
          im[n] = 0
        }
        fft()
        const c = new Array(12).fill(0)
        const mag = new Float32Array(N / 2)
        for (let bin = 1; bin < N / 2; bin++) mag[bin] = Math.log1p(1000 * Math.hypot(re[bin], im[bin]))
        for (let bin = lo; bin <= hi; bin++) c[pcOf[bin]] += Math.hypot(re[bin], im[bin])
        let fl = 0
        if (prev) for (let bin = 1; bin < N / 2; bin++) fl += Math.max(0, mag[bin] - prev[bin])
        prev = mag
        chroma.push(c.map((v) => +v.toFixed(4)))
        flux.push(+fl.toFixed(3))
      }
      const r4 = (a) => a.map((v) => +v.toPrecision(4))
      // what ships today, on the same envelope the deck uses at load: the baseline the learned model must beat
      const current = detectBarOne(bands[0], framesPerSec, grid)
      // v0.9.74: the app's own singing detector, per beat — does singing start on the "1"? Frame score (the hand-weighted cue mix,
      // ~fine time steps), harmonic level, and the learned model's voice probability (half-second cells, so only about one per beat).
      const v = new Array(nBeats).fill(0)
      const vl = new Array(nBeats).fill(0)
      const vp = new Array(nBeats).fill(0)
      let vocalError = null
      let genreKnown = null
      try {
        // inside the try: a broken singing import costs this song's singing cues, not the whole run
        const { vocalFeatures, frameScores, VOCAL_PARAMS } = await import('http://localhost:5173/src/core/sound/vocal-presence.ts')
        const { cellFeatureRows, CELL_SEC } = await import('http://localhost:5173/src/core/sound/cell-features.ts')
        const { cellProbabilities, parseVocalModel } = await import('http://localhost:5173/src/core/sound/vocal-model.ts')
        const modelJson = (await import('http://localhost:5173/src/core/sound/vocal-model.json?import')).default
        const genreJson = (await import('http://localhost:5173/src/core/sound/vocal-genre-models.json?import')).default
        const vf = vocalFeatures(pcm)
        if ('features' in vf) {
          const f = vf.features
          const sc = frameScores(f, VOCAL_PARAMS)
          const cp = cellProbabilities(cellFeatureRows(f, dur), genre, parseVocalModel(modelJson, genreJson))
          const probs = cp.probs
          genreKnown = cp.genreKnown
          for (let k = 0; k < nBeats; k++) {
            const t = grid.offsetSec + k * beatSec
            const a = Math.floor(t / f.frameSec)
            const z = Math.min(f.frames, Math.floor((t + beatSec) / f.frameSec))
            let sv = 0
            let sl = 0
            for (let j = a; j < z; j++) {
              sv += sc[j]
              sl += f.level[j]
            }
            v[k] = sv / Math.max(1, z - a)
            vl[k] = sl / Math.max(1, z - a)
            vp[k] = probs[Math.min(probs.length - 1, Math.floor((t + beatSec / 2) / CELL_SEC))] ?? 0
          }
        } else vocalError = vf.result.state
      } catch (err) {
        vocalError = String(err?.message ?? err)
      }
      return { dur, nBeats, current, e: e.map(r4), on: on.map(r4), oh: oh.map(r4), chroma, flux, v: r4(v), vl: r4(vl), vp: r4(vp), vocalError, genreKnown }
    },
    { i, base: BASE, grid: s.detectorGrid, genre: s.genre ?? '' },
  ).catch((e) => ({ error: String(e?.message ?? e).split('\n')[0] }))
  if (r.error) {
    console.log(`  ✗ ${s.trackId}: ${r.error}`)
    failed.push(s.trackId)
  }
  if (!r.error) rows.push({ contentHash: s.contentHash, trackId: s.trackId, genre: s.genre, set: s.set, grid: s.detectorGrid, truthSec: s.truthSec, truthBeat: beatOf(s.truthSec, s.detectorGrid), ...r })
  if ((i + 1) % 15 === 0) {
    await page.close()
    page = await openPage()
    console.log(`  ${i + 1}/${songs.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
}
await browser.close()
server.close()
fs.writeFileSync(OUT, JSON.stringify(rows))
console.log(`wrote ${OUT}: ${rows.length} of ${songs.length} songs`)
if (moved.length) console.log(`found under a new place or extension: ${moved.length}`)
if (missing.length) console.log(`NOT FOUND in the library, left out: ${missing.length}\n  ${missing.join('\n  ')}`)
if (failed.length) console.log(`could not be read, left out: ${failed.length}`)

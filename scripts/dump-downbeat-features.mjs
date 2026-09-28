/**
 * v0.9.5 research harness, step 1: per-beat features for every song Shalom
 * tagged on 28/09, dumped once so the downbeat experiments
 * (`experiment-downbeat.mjs`) run in seconds instead of re-decoding 105 songs
 * each try. Read-only — files are read, never written.
 *
 *   node scripts/dump-downbeat-features.mjs [tags.json]   (against npm run dev on :5173)
 *
 * The beats are the detector's own grid from the tag file (`detectorGrid`), so
 * "which of the 4 is the 1" is asked on exactly the grid the answers were
 * scored against. Features per beat k (at offset + k·beat):
 *   e[b][k]   mean RMS of band b over the beat (the four `buildOnsetEnvelope` bands)
 *   on[b][k]  strongest rise of band b within ±25ms of the beat
 *   oh[b][k]  the same at the half-beat after it (hi-hat/off-beat pattern)
 *   chroma[k] 12 pitch classes from one 4096-point FFT over the beat, 11kHz
 *   flux[k]   log-spectral rise from beat k−1 to k
 * Same harness as measure-bpm-blind.mjs: real Chrome, files from a tiny HTTP server.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const TAGS = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'deckmix-tags-2026-09-28 - 26 songs.json')
const OUT = path.join(process.env.TEMP ?? '.', 'downbeat-features.json')
const tags = JSON.parse(fs.readFileSync(TAGS, 'utf8'))
const songs = tags.mark.filter((m) => m.detectorGrid)
console.log(`${songs.length} tagged songs`)

const server = http.createServer((req, res) => {
  if (req.url === '/__blank') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>measure</title>')
    return
  }
  const s = songs[Number(req.url.split('/').pop())]
  if (!s) return res.writeHead(404).end()
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' })
  fs.createReadStream(path.join(ROOT, s.trackId)).pipe(res)
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
for (let i = 0; i < songs.length; i++) {
  const s = songs[i]
  const r = await page.evaluate(
    async ({ i, base, grid }) => {
      const { buildOnsetEnvelope, pcmFromAudioBuffer } = await import('http://localhost:5173/src/platform/analyzer-js/analyze.ts')
      const { repairWav } = await import('http://localhost:5173/src/core/wav-repair.ts')
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
      return { dur, nBeats, e: e.map(r4), on: on.map(r4), oh: oh.map(r4), chroma, flux }
    },
    { i, base: BASE, grid: s.detectorGrid },
  ).catch((e) => ({ error: String(e?.message ?? e).split('\n')[0] }))
  if (r.error) console.log(`  ✗ ${s.trackId}: ${r.error}`)
  if (!r.error) rows.push({ contentHash: s.contentHash, trackId: s.trackId, genre: s.genre, holdout: s.holdout, grid: s.detectorGrid, ...r })
  if ((i + 1) % 15 === 0) {
    await page.close()
    page = await openPage()
    console.log(`  ${i + 1}/${songs.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
}
await browser.close()
server.close()
fs.writeFileSync(OUT, JSON.stringify(rows))
console.log(`wrote ${OUT}`)

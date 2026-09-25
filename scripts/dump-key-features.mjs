/**
 * v0.8.30 research: dump richer per-track features so key-detection ideas can
 * be tried offline, without decoding the library again for each one.
 *
 *   node scripts/dump-key-features.mjs      (against npm run dev on :5173; writes %TEMP%/key-features-bands.json)
 *
 * Read-only, real Chrome, same file server as measure-key-detect.mjs. Per track:
 * the tag key, and per ~12s segment a 120-bin pitch histogram (10 cents per bin,
 * one octave, each FFT frame normalised to sum 1 before it is added — the same
 * "one vote per frame" rule as `chroma`), per band (55–220, 220–500, 500–1000, 1000–2000 Hz).
 * Every bin is kept, off-centre ones included, so
 * tuning and centre-width can be chosen afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const limit = Number(process.argv[2]) || Infinity

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(ROOT)
const only = process.argv[3] // optional substring filter, e.g. "Trance"
if (only) files.splice(0, files.length, ...files.filter((f) => f.includes(only)))
files.splice(limit)
console.log(`${files.length} audio files under ${ROOT}`)

// Files come from a tiny local server, not `page.route`: run 3 showed every WAV
// over 100MB (the Trance originals, up to 164MB) killing the tab, because a
// routed body crosses the DevTools protocol in one piece. A plain HTTP stream
// has no such ceiling.
const server = http.createServer((req, res) => {
  if (req.url === '/__blank') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>measure</title>')
    return
  }
  const i = Number(req.url.split('/').pop())
  if (!files[i]) {
    res.writeHead(404) // favicon.ico and anything else that isn't a track index
    res.end()
    return
  }
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' })
  fs.createReadStream(files[i]).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const FILE_BASE = `http://127.0.0.1:${server.address().port}`

let browser = await chromium.launch({ channel: 'chrome' })
// A blank page on the dev server's origin, not the app: the modules are
// imported straight from Vite, and the app's own boot (storage migration,
// reloads) has no business running under a measurement. The first full run
// died on track 1 with "Target page … has been closed" while the app was loaded.
async function openPage() {
  const p = await browser.newPage()
  // The page lives on the file server's origin (same-origin fetch of the audio;
  // a cross-origin fetch from :5173 failed outright), and imports the app's
  // modules from Vite, which serves them with CORS open.
  await p.goto(`${FILE_BASE}/__blank`)
  return p
}
let page = await openPage()

const rows = []
const t0 = Date.now()
for (let i = 0; i < files.length; i++) {
  const rel = path.relative(ROOT, files[i])
  let r
  try {
    r = await page.evaluate(
      async ({ i, name, base }) => {
        const { fft, FFT_SIZE } = await import('http://localhost:5173/src/core/key-detect.ts')
        const { readTags } = await import('http://localhost:5173/src/platform/source-fsaccess/tags.ts')
        const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
        const tags = await readTags(new File([bytes], name))
        let audio
        try {
          audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0))
        } catch (e) {
          return { tag: tags.camelot ?? null, error: String(e?.message ?? e) }
        }
        const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c))
        const factor = Math.max(1, Math.floor(audio.sampleRate / 11025))
        const len = Math.floor(chans[0].length / factor)
        const x = new Float32Array(len)
        for (let k = 0; k < len; k++) {
          let s = 0
          for (const ch of chans) for (let j = 0; j < factor; j++) s += ch[k * factor + j]
          x[k] = s / (factor * chans.length)
        }
        const rate = audio.sampleRate / factor
        const binHz = rate / FFT_SIZE
        const lo = Math.ceil(55 / binHz)
        const hi = Math.floor(2000 / binHz)
        // band edges (Hz): bass, low-mid, mid, high — so each band's weight can be chosen offline
        const EDGES = [55, 220, 500, 1000, 2000]
        const bandOf = new Int8Array(hi + 1)
        for (let b = lo; b <= hi; b++) bandOf[b] = EDGES.findIndex((e, k) => k > 0 && b * binHz < e) - 1
        const pos = new Int16Array(hi + 1)
        for (let b = lo; b <= hi; b++) {
          const midi = 69 + 12 * Math.log2((b * binHz) / 440)
          pos[b] = ((Math.round(midi * 10) % 120) + 120) % 120
        }
        const hann = new Float64Array(FFT_SIZE)
        for (let k = 0; k < FFT_SIZE; k++) hann[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (FFT_SIZE - 1))
        const re = new Float64Array(FFT_SIZE)
        const im = new Float64Array(FFT_SIZE)
        const FRAMES_PER_SEG = Math.round((12 * rate) / (FFT_SIZE / 2))
        const segs = []
        const NB = 4
        let acc = Array.from({ length: NB }, () => new Float64Array(120))
        let n = 0
        const fr = Array.from({ length: NB }, () => new Float64Array(120))
        const fs_ = new Float64Array(NB)
        for (let start = 0; start + FFT_SIZE <= len; start += FFT_SIZE / 2) {
          for (let k = 0; k < FFT_SIZE; k++) {
            re[k] = x[start + k] * hann[k]
            im[k] = 0
          }
          fft(re, im)
          for (const f of fr) f.fill(0)
          fs_.fill(0)
          let sum = 0
          for (let b = lo; b <= hi; b++) {
            const m = Math.hypot(re[b], im[b])
            const k = bandOf[b]
            if (k < 0) continue
            fr[k][pos[b]] += m
            fs_[k] += m
            sum += m
          }
          // silence gate on the whole band, as in `chroma`; each band then gets its own one-vote-per-frame normalisation
          if (sum / (hi - lo + 1) >= 1e-4) {
            for (let k = 0; k < NB; k++) if (fs_[k] > 0) for (let p = 0; p < 120; p++) acc[k][p] += fr[k][p] / fs_[k]
          }
          if (++n === FRAMES_PER_SEG) {
            segs.push(acc.map((a) => Array.from(a, (v) => +v.toFixed(4))))
            acc = Array.from({ length: NB }, () => new Float64Array(120))
            n = 0
          }
        }
        if (n > FRAMES_PER_SEG / 3) segs.push(acc.map((a) => Array.from(a, (v) => +v.toFixed(4))))
        return { tag: tags.camelot ?? null, segs }
      },
      { i, name: path.basename(files[i]), base: FILE_BASE },
    )
  } catch (e) {
    r = { tag: null, error: `page crashed: ${String(e?.message ?? e).split('\n')[0]}` }
    await page.close().catch(() => {})
    if (!browser.isConnected()) browser = await chromium.launch({ channel: 'chrome' })
    page = await openPage()
  }
  rows.push({ rel, ...r })
  if ((i + 1) % 20 === 0) {
    await page.close().catch(() => {})
    page = await openPage()
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${files.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
server.close()
const out = path.join(process.env.TEMP ?? '.', 'key-features-bands.json')
fs.writeFileSync(out, JSON.stringify(rows))
console.log(`${rows.length} tracks, ${rows.filter((r) => r.error).length} errors → ${out}`)

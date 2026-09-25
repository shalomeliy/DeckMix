/**
 * Where does a re-analysis spend its time? (25/09: Shalom's Chrome re-analysed
 * ~3 tracks per 35s after ANALYZER_VERSION 4, and nobody knew which step was slow.)
 * Read-only — files are read, never written.
 *
 *   node scripts/measure-analysis-time.mjs [limit] [path-substring]   (against npm run dev on :5173)
 *
 * Times each stage the background queue (`queueLibraryAnalysis`) runs for a
 * cache miss, using the app's own modules: hash, decode, waveform, beat grid,
 * key, embedding. Stages run on the main thread here — the app sends the
 * numeric ones to Workers, which moves them off the UI thread but does not make
 * them cheaper, so the per-stage cost is the same number.
 *
 * Same harness as measure-key-detect.mjs: real Chrome (AAC), files from a tiny
 * local HTTP server (routed bodies over ~100MB killed the tab).
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const limit = Number(process.argv[2]) || Infinity
const only = process.argv[3]

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(ROOT)
if (only) files.splice(0, files.length, ...files.filter((f) => f.includes(only)))
// spread across the library rather than the first N of one folder
if (files.length > limit) {
  const step = files.length / limit
  const picked = Array.from({ length: limit }, (_, k) => files[Math.floor(k * step)])
  files.splice(0, files.length, ...picked)
}
console.log(`${files.length} audio files`)

const server = http.createServer((req, res) => {
  if (req.url === '/__blank') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>measure</title>')
    return
  }
  const i = Number(req.url.split('/').pop())
  if (!files[i]) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' })
  fs.createReadStream(files[i]).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const FILE_BASE = `http://127.0.0.1:${server.address().port}`

let browser = await chromium.launch({ channel: 'chrome' })
async function openPage() {
  const p = await browser.newPage()
  await p.goto(`${FILE_BASE}/__blank`)
  return p
}
let page = await openPage()

const STAGES = ['read', 'hash', 'decode', 'waveform', 'beatgrid', 'key', 'embed']
const rows = []
for (let i = 0; i < files.length; i++) {
  const rel = path.relative(ROOT, files[i])
  let r
  try {
    r = await page.evaluate(async ({ i, base }) => {
      const V = 'http://localhost:5173/src'
      const { hashBytes } = await import(`${V}/platform/source-fsaccess/hash.ts`)
      const { analyzeWaveform, detectBeatGrid, pcmFromAudioBuffer } = await import(`${V}/platform/analyzer-js/analyze.ts`)
      const { detectKey } = await import(`${V}/core/key-detect.ts`)
      const { computeClassicalEmbedding } = await import(`${V}/platform/embed-classical/analyze.ts`)
      const ms = {}
      let t = performance.now()
      const lap = (k) => {
        const n = performance.now()
        ms[k] = n - t
        t = n
      }
      const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
      lap('read')
      await hashBytes(bytes)
      lap('hash')
      let audio
      try {
        audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0))
      } catch (e) {
        return { error: String(e?.message ?? e) }
      }
      lap('decode')
      const pcm = pcmFromAudioBuffer(audio)
      const dur = audio.duration
      analyzeWaveform(pcm, Math.min(120_000, Math.max(2_000, Math.ceil(dur * 200))))
      lap('waveform')
      const g = detectBeatGrid(pcm)
      lap('beatgrid')
      detectKey(pcm.channels, pcm.sampleRate)
      lap('key')
      await computeClassicalEmbedding(pcm)
      lap('embed')
      return { ms, dur, mb: bytes.byteLength / 1e6, bpm: g?.grid.bpm ?? null }
    }, { i, base: FILE_BASE })
  } catch (e) {
    r = { error: `page crashed: ${String(e?.message ?? e).split('\n')[0]}` }
    await page.close().catch(() => {})
    if (!browser.isConnected()) browser = await chromium.launch({ channel: 'chrome' })
    page = await openPage()
  }
  rows.push({ rel, ...r })
  const tot = r.ms ? Object.values(r.ms).reduce((a, b) => a + b, 0) : 0
  console.log(`${String(i + 1).padStart(3)} ${(tot / 1000).toFixed(1).padStart(5)}s  ${r.bpm?.toFixed?.(1) ?? '-'} BPM  ${r.error ?? ''} ${rel}`)
  if ((i + 1) % 10 === 0) {
    await page.close().catch(() => {})
    page = await openPage()
  }
}
await browser.close()
server.close()

const ok = rows.filter((r) => r.ms)
console.log(`\n${ok.length} measured, ${rows.length - ok.length} errors`)
const total = ok.reduce((a, r) => a + Object.values(r.ms).reduce((x, y) => x + y, 0), 0)
for (const s of STAGES) {
  const v = ok.map((r) => r.ms[s])
  const sum = v.reduce((a, b) => a + b, 0)
  console.log(`  ${s.padEnd(9)} mean ${(sum / v.length).toFixed(0).padStart(6)}ms  max ${Math.max(...v).toFixed(0).padStart(6)}ms  ${((100 * sum) / total).toFixed(0).padStart(3)}%`)
}
console.log(`  per track mean ${(total / ok.length / 1000).toFixed(2)}s, audio mean ${(ok.reduce((a, r) => a + r.dur, 0) / ok.length).toFixed(0)}s`)

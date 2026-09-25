/**
 * How good is the *blind* tempo guess — the one a track gets when its file has
 * no BPM tag? (25/09: "Heal My Mind", an m4a with no tag, showed 175.25 in
 * Shalom's Chrome and 86.31 here: the same file decoded at 48kHz vs 44.1kHz.)
 * Read-only — files are read, never written.
 *
 *   node scripts/measure-bpm-blind.mjs [sampleRate] [limit] [path-substring]   (against npm run dev on :5173)
 *
 * Ground truth is the tracks that DO carry a BPM tag: each is analysed as if it
 * had none (`detectBeatGrid` without `hintBpm`) and compared to its tag. The
 * decode rate is a parameter because the app decodes at the output device's
 * rate (`engine.decode`), so the same library can read differently on two
 * machines. Buckets:
 *   exact   — within 1% of the tag
 *   double  — ~2× or ~½× the tag (right pulse, wrong octave)
 *   other   — wrong (includes 3/2, 4/3 and plain misses)
 *
 * Same harness as measure-key-detect.mjs: real Chrome (AAC), files from a tiny
 * local HTTP server.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const SR = Number(process.argv[2]) || 48000
const limit = Number(process.argv[3]) || Infinity
const only = process.argv[4]

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(ROOT)
if (only) files.splice(0, files.length, ...files.filter((f) => f.includes(only)))
if (files.length > limit) {
  const step = files.length / limit
  const picked = Array.from({ length: limit }, (_, k) => files[Math.floor(k * step)])
  files.splice(0, files.length, ...picked)
}
console.log(`${files.length} audio files, decoded at ${SR}Hz`)

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

const rows = []
const t0 = Date.now()
for (let i = 0; i < files.length; i++) {
  const rel = path.relative(ROOT, files[i])
  let r
  try {
    r = await page.evaluate(async ({ i, name, base, sr }) => {
      const V = 'http://localhost:5173/src'
      const { readTags } = await import(`${V}/platform/source-fsaccess/tags.ts`)
      const { detectBeatGrid, pcmFromAudioBuffer } = await import(`${V}/platform/analyzer-js/analyze.ts`)
      const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
      const tags = await readTags(new File([bytes], name))
      if (tags.bpm == null) return { tag: null }
      let audio
      try {
        audio = await new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes.slice(0))
      } catch (e) {
        return { tag: tags.bpm, error: String(e?.message ?? e) }
      }
      const g = detectBeatGrid(pcmFromAudioBuffer(audio))
      return { tag: tags.bpm, bpm: g?.grid.bpm ?? null, confident: g?.confident ?? false }
    }, { i, name: path.basename(files[i]), base: FILE_BASE, sr: SR })
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

const bucket = (tag, bpm) => {
  if (bpm == null) return 'other'
  const r = bpm / tag
  if (Math.abs(r - 1) <= 0.01) return 'exact'
  if (Math.abs(r - 2) <= 0.02 || Math.abs(r - 0.5) <= 0.005) return 'double'
  return 'other'
}
const measured = rows.filter((r) => r.tag != null && !r.error)
const b = { exact: 0, double: 0, other: 0 }
const conf = { exact: 0, double: 0, other: 0 }
for (const r of measured) {
  r.bucket = bucket(r.tag, r.bpm)
  b[r.bucket]++
  if (r.confident) conf[r.bucket]++
}
const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`
console.log(`\nTracks with a BPM tag: ${measured.length}  (no tag: ${rows.filter((r) => r.tag == null).length}, errors: ${rows.filter((r) => r.error).length})`)
for (const k of Object.keys(b)) console.log(`  ${k.padEnd(7)} ${String(b[k]).padStart(4)}  ${pct(b[k], measured.length)}   of which marked confident: ${conf[k]}`)
// Tempo error on the exact ones: a systematic bias shows up here, not in the buckets.
const errs = measured.filter((r) => r.bucket === 'exact').map((r) => (100 * (r.bpm - r.tag)) / r.tag)
if (errs.length) console.log(`  exact: mean error ${(errs.reduce((a, x) => a + x, 0) / errs.length).toFixed(3)}%`)
console.log('\nWrong (tag → blind):')
for (const r of measured.filter((r) => r.bucket !== 'exact')) console.log(`  ${r.tag} → ${r.bpm}${r.confident ? '' : ' ?'}  ${r.rel}`)
fs.writeFileSync(path.join(process.env.TEMP ?? '.', `bpm-blind-${SR}.json`), JSON.stringify(rows, null, 1))

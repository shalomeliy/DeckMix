/**
 * v0.8.37 groundwork: dump what the app's analysis stores for every track —
 * `analyzeWaveform`'s low/mid/high RMS per bucket (the waveform colours) plus
 * the grid BPM — so an energy measure can be tried offline against Shalom's
 * own 1–10 ratings without re-decoding the library. Read-only.
 *
 *   node scripts/dump-waveform-bands.mjs   (against npm run dev on :5173)
 *
 * Uses the app's own modules (`analyzeTrack`), decoded at 48kHz in real Chrome.
 * Writes %TEMP%/waveform-bands/<i>.bin (Float32 bands, 3 per bucket) + index.json.
 * Same harness as measure-key-detect.mjs: files from a tiny local HTTP server.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const OUT = path.join(process.env.TEMP ?? '.', 'waveform-bands')
fs.mkdirSync(OUT, { recursive: true })

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(ROOT)

const server = http.createServer((req, res) => {
  if (req.url === '/__blank') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>dump</title>')
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

const index = []
const t0 = Date.now()
for (let i = 0; i < files.length; i++) {
  const rel = path.relative(ROOT, files[i])
  let r
  try {
    r = await page.evaluate(async ({ i, name, base }) => {
      const { readTags } = await import('http://localhost:5173/src/platform/source-fsaccess/tags.ts')
      const { analyzeTrack, pcmFromAudioBuffer } = await import('http://localhost:5173/src/platform/analyzer-js/analyze.ts')
      const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
      const tags = await readTags(new File([bytes], name))
      const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice(0))
      const a = analyzeTrack(pcmFromAudioBuffer(audio), { hintBpm: tags.bpm ?? null })
      const u8 = new Uint8Array(a.bands.buffer, a.bands.byteOffset, a.bands.byteLength)
      let bin = ''
      for (let j = 0; j < u8.length; j += 0x8000) bin += String.fromCharCode(...u8.subarray(j, j + 0x8000))
      return { tag: tags.bpm ?? null, bpm: a.bpm, dur: a.durationSec, b64: btoa(bin) }
    }, { i, name: path.basename(files[i]), base: FILE_BASE })
  } catch (e) {
    // recorded against the track by name, never dropped from the index
    r = { error: String(e?.message ?? e).split('\n')[0] }
    await page.close().catch(() => {})
    if (!browser.isConnected()) browser = await chromium.launch({ channel: 'chrome' })
    page = await openPage()
  }
  if (r.b64) {
    fs.writeFileSync(path.join(OUT, `${i}.bin`), Buffer.from(r.b64, 'base64'))
    index.push({ i, rel, tag: r.tag, bpm: r.bpm, dur: r.dur })
  } else index.push({ i, rel, error: r.error })
  if ((i + 1) % 20 === 0) {
    await page.close().catch(() => {})
    page = await openPage()
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${files.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
server.close()
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1))
console.log(`${index.filter((x) => !x.error).length} tracks dumped to ${OUT}, ${index.filter((x) => x.error).length} errors`)

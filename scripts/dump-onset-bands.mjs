/**
 * v0.8.34 groundwork: dump per-band energy envelopes for every track with a BPM
 * tag, so tempo estimators can be tried offline in seconds instead of
 * re-decoding the library for each idea (the same split measure-key-detect.mjs
 * → fit-key-profiles.mjs made for key). Read-only — files are read, never written.
 *
 *   node scripts/dump-onset-bands.mjs [limit]   (against npm run dev on :5173)
 *
 * Decoded at 48kHz (the owner's device rate) in real Chrome. Per 240-sample
 * frame (exactly 200/s), the RMS of four bands split by one-pole low-passes at
 * 150Hz, 600Hz and 3kHz — cheap filters, the same kind analyze.ts already
 * uses for the waveform colour. Duplicated
 * in platform/analyzer-js/beat.ts — change both or neither. Written as Float32 to
 * %TEMP%/onset-bands/<i>.bin (4 interleaved bands per frame) plus index.json
 * with each track's tag BPM and path.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const OUT = path.join(process.env.TEMP ?? '.', 'onset-bands')
const limit = Number(process.argv[2]) || Infinity
fs.mkdirSync(OUT, { recursive: true })

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(ROOT)
files.splice(limit)

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
      const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
      const tags = await readTags(new File([bytes], name))
      if (tags.bpm == null) return { tag: null }
      const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice(0))
      const sr = audio.sampleRate
      const a = audio.getChannelData(0)
      const b = audio.numberOfChannels > 1 ? audio.getChannelData(1) : a
      const coeff = (hz) => {
        const rc = 1 / (2 * Math.PI * hz)
        return 1 / sr / (rc + 1 / sr)
      }
      const c1 = coeff(150), c2 = coeff(600), c3 = coeff(3000)
      let l1 = 0, l2 = 0, l3 = 0
      const frame = 240
      const n = Math.floor(a.length / frame)
      const out = new Float32Array(n * 4)
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, k = 0, f = 0
      for (let j = 0; j < n * frame; j++) {
        const v = (a[j] + b[j]) * 0.5
        l1 += c1 * (v - l1)
        l2 += c2 * (v - l2)
        l3 += c3 * (v - l3)
        s0 += l1 * l1
        s1 += (l2 - l1) * (l2 - l1)
        s2 += (l3 - l2) * (l3 - l2)
        s3 += (v - l3) * (v - l3)
        if (++k === frame) {
          out[f * 4] = Math.sqrt(s0 / frame)
          out[f * 4 + 1] = Math.sqrt(s1 / frame)
          out[f * 4 + 2] = Math.sqrt(s2 / frame)
          out[f * 4 + 3] = Math.sqrt(s3 / frame)
          s0 = s1 = s2 = s3 = 0
          k = 0
          f++
        }
      }
      // base64 so the bytes cross the protocol compactly
      const u8 = new Uint8Array(out.buffer)
      let bin = ''
      for (let j = 0; j < u8.length; j += 0x8000) bin += String.fromCharCode(...u8.subarray(j, j + 0x8000))
      return { tag: tags.bpm, sr, b64: btoa(bin) }
    }, { i, name: path.basename(files[i]), base: FILE_BASE })
  } catch (e) {
    r = { error: String(e?.message ?? e).split('\n')[0] }
    await page.close().catch(() => {})
    if (!browser.isConnected()) browser = await chromium.launch({ channel: 'chrome' })
    page = await openPage()
  }
  if (r.b64) {
    fs.writeFileSync(path.join(OUT, `${i}.bin`), Buffer.from(r.b64, 'base64'))
    index.push({ i, rel, tag: r.tag })
  } else if (r.error) index.push({ i, rel, error: r.error })
  if ((i + 1) % 20 === 0) {
    await page.close().catch(() => {})
    page = await openPage()
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${files.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
server.close()
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1))
console.log(`${index.filter((x) => x.tag).length} tracks dumped to ${OUT}, ${index.filter((x) => x.error).length} errors`)

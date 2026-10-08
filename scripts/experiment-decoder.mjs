/**
 * v0.9.64 — decoder experiment. Same MP3 bytes through the browser's decoder (what a deck load uses) and through the app's own
 * WASM decoder (minimp3, `platform/decode-worker`): time, and sample-by-sample difference. Read-only: files are read, never written.
 *
 *   node scripts/experiment-decoder.mjs <folder-with-mp3s> [max-files]
 *
 * Runs in a hidden Chromium against a throwaway Vite server (not the built app: only the decoder is measured). It times the
 * decode alone, not the whole deck load; the browser's decode is the main-thread number, ours is a Worker round trip.
 * Order is browser-then-ours for each file, so a cold cache favours neither more than the other on average.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const folder = process.argv[2]
const max = Number(process.argv[3]) || 20
const RATE = process.env.CTX_RATE ?? ''
if (!folder) {
  console.error('usage: node scripts/experiment-decoder.mjs <folder-with-mp3s> [max-files]')
  process.exit(2)
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const files = walk(folder).filter((f) => f.toLowerCase().endsWith('.mp3')).slice(0, max)
if (files.length === 0) {
  console.error('no .mp3 files under', folder)
  process.exit(2)
}

const fileServer = http.createServer((req, res) => {
  const f = files[Number(req.url.split('/')[1])]
  if (!f) return res.writeHead(404).end()
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size })
  fs.createReadStream(f).pipe(res)
})
await new Promise((r) => fileServer.listen(0, r))
const filePort = fileServer.address().port
const vite = await createServer({ root: path.resolve('scripts/decoder-compare'), configFile: path.resolve('vite.config.ts'), server: { port: 5199, strictPort: true, fs: { strict: false } }, logLevel: 'error' })
await vite.listen()
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('http://localhost:5199/' + (RATE ? `?rate=${RATE}` : ''))
  await page.waitForFunction(() => typeof window.runCompare === 'function')
  const urls = files.map((f, i) => `http://localhost:${filePort}/${i}/${encodeURIComponent(path.basename(f))}`)
  // the server keys on the first path segment; the file name after it is only for the label
  const rows = await page.evaluate((u) => window.runCompare(u), urls)
  const f1 = (n) => n.toFixed(1)
  console.log(`context rate ${RATE || 'default'}`)
  console.log('file'.padEnd(44), 'MB'.padStart(5), 'browser ms'.padStart(11), 'ours ms'.padStart(8), 'speedup'.padStart(8), 'frames Δ'.padStart(9), 'maxΔ'.padStart(9), 'SNR dB'.padStart(7), 'lag')
  const ok = rows.filter((r) => !r.error)
  for (const r of rows) {
    if (r.error) {
      console.log(r.name.slice(0, 44).padEnd(44), 'ERROR', r.error)
      continue
    }
    console.log(
      r.name.slice(0, 44).padEnd(44),
      f1(r.mb).padStart(5),
      f1(r.browserMs).padStart(11),
      f1(r.oursMs).padStart(8),
      (r.browserMs / r.oursMs).toFixed(2).padStart(8),
      String(r.oursFrames - r.browserFrames).padStart(9),
      r.maxDiff.toFixed(4).padStart(9),
      f1(r.snrDb).padStart(7),
      r.bestLag,
    )
  }
  const sum = (k) => ok.reduce((s, r) => s + r[k], 0)
  console.log(`\ntotal browser ${f1(sum('browserMs'))} ms · ours ${f1(sum('oursMs'))} ms · overall speedup ${(sum('browserMs') / sum('oursMs')).toFixed(2)}x over ${ok.length} files`)
  console.log(`worst max diff ${Math.max(...ok.map((r) => r.maxDiff)).toFixed(5)} · lowest SNR ${f1(Math.min(...ok.map((r) => r.snrDb)))} dB · page errors: ${errors.length}`)
  fs.mkdirSync('research/decoder-v0.9.64', { recursive: true })
  fs.writeFileSync('research/decoder-v0.9.64/result.json', JSON.stringify(rows, null, 1))
} finally {
  await browser.close()
  await vite.close()
  fileServer.close()
}

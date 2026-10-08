/**
 * v0.9.61 — the permanent speed measurement. Three numbers, same method as the v0.9.58 measurement (the whole built app in a
 * hidden browser, not one function):
 *
 *   1. open      — milliseconds from navigation until the library list shows (first "Load to deck" button in the DOM)
 *   2. load      — milliseconds from clicking "Load to deck A" until the row says "Loaded on deck A"
 *   3. frames    — during PLAYSEC seconds of playback, how many animation frames took more than 50 ms, and the longest;
 *                  plus the same count for the 3 seconds after a load onto deck B while A plays (the known 2–4 stutters)
 *
 *   node scripts/measure-speed.mjs [folder-with-songs] [seconds-of-playback]     (against the built app on :5173)
 *
 * Start the built app first (`npx vite build && npx vite preview --port 5173 --strictPort`, which is what start.bat does).
 * Measure the built app, never `npm run dev` — the dev server alone costs 17 slow frames a minute (v0.9.58).
 *
 * No folder given → 12 synthetic 3-minute WAV tracks are generated in a temp directory. That is a *comparison* tool for
 * before/after on one machine, not a statement about the owner's PC: his MP3s decode differently. For his numbers run it
 * with his folder: `node scripts/measure-speed.mjs C:\Users\Shalom\Music\Tracks`. Read-only — files are read, never written.
 * Files are served by a small local HTTP server; routing 100MB bodies through the browser killed the tab (measure-analysis-time).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL ?? 'http://localhost:5173/'
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const folderArg = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null
const PLAYSEC = Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a))) || 30
const SLOW_MS = 50

function synth(dir, n) {
  fs.mkdirSync(dir, { recursive: true })
  const sr = 22050
  const sec = 180
  for (let t = 0; t < n; t++) {
    const bpm = 120 + t * 2
    const beat = Math.round((60 / bpm) * sr)
    const pcm = Buffer.alloc(sr * sec * 2)
    for (let i = 0; i < sr * sec; i++) {
      const k = i % beat
      const kick = k < 2000 ? Math.sin(2 * Math.PI * 60 * (k / sr)) * (1 - k / 2000) * 20000 : 0
      const tone = Math.sin((2 * Math.PI * (200 + t * 17) * i) / sr) * 2500
      pcm.writeInt16LE(Math.round(kick + tone), i * 2)
    }
    const h = Buffer.alloc(44)
    h.write('RIFF', 0, 'latin1')
    h.writeUInt32LE(36 + pcm.length, 4)
    h.write('WAVEfmt ', 8, 'latin1')
    h.writeUInt32LE(16, 16)
    h.writeUInt16LE(1, 20)
    h.writeUInt16LE(1, 22)
    h.writeUInt32LE(sr, 24)
    h.writeUInt32LE(sr * 2, 28)
    h.writeUInt16LE(2, 32)
    h.writeUInt16LE(16, 34)
    h.write('data', 36, 'latin1')
    h.writeUInt32LE(pcm.length, 40)
    fs.writeFileSync(path.join(dir, `Synthetic Artist ${String(t + 1).padStart(2, '0')} - Track ${t + 1}.wav`), Buffer.concat([h, pcm]))
  }
}

const root = folderArg ?? path.join(os.tmpdir(), 'deckmix-speed-synth')
if (!folderArg && !fs.existsSync(root)) synth(root, 12)
const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(root)
if (files.length < 2) throw new Error(`need at least 2 songs under ${root}`)
const LIMIT = 40 // the library list is what we time; a few dozen rows is enough and keeps the background analysis comparable
files.splice(LIMIT)

const server = http.createServer((req, res) => {
  const f = files[Number(req.url.slice(1))]
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (!f) return res.writeHead(404).end()
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const names = files.map((f) => path.basename(f))
const harness = `(() => {
  const NAMES = ${JSON.stringify(names)};
  const PORT = ${port};
  const makeFile = (name, i) => ({ kind: 'file', name, getFile: async () => new File([await (await fetch('http://127.0.0.1:' + PORT + '/' + i)).blob()], name) });
  const makeDir = (name) => ({ kind: 'directory', name,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    entries: async function* () { for (let i = 0; i < NAMES.length; i++) yield [NAMES[i], makeFile(NAMES[i], i)]; } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map([['deckmix:libraryDir', makeDir('Tracks')]]);
  const fire = (o, p, v) => setTimeout(() => { o.result = v; o[p] && o[p](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { const req = {}; setTimeout(() => {
    req.result = { transaction: () => { const tx = {}; tx.objectStore = () => ({ transaction: tx,
      get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
      put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; } });
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 1); return tx; } };
    req.onsuccess && req.onsuccess(); }, 0); return req; } } });
  // 1. open: first moment a "Load to deck" button exists
  window.__libShown = null;
  new MutationObserver((_, obs) => {
    if (document.querySelector('button[aria-label="Load to deck A"]')) { window.__libShown = performance.now(); obs.disconnect(); }
  }).observe(document, { childList: true, subtree: true });
  // 3. frames: every animation-frame gap, with a timestamp so a window can be cut out afterwards
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], executablePath: process.env.PW_CHROME || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness)
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__libShown != null, null, { timeout: 60000 })
  const open = Math.round(await page.evaluate(() => window.__libShown))

  const timeLoad = async (deck, which) => {
    const t0 = await page.evaluate(() => performance.now())
    await page.locator(`button[aria-label="Load to deck ${deck}"]`).nth(which).click()
    await page.waitForSelector(`[aria-label="Loaded on deck ${deck}"]`, { timeout: 60000 })
    const t1 = await page.evaluate(() => performance.now())
    return { t0, ms: Math.round(t1 - t0) }
  }

  const a = await timeLoad('A', 0)
  await page.getByRole('button', { name: 'Play', exact: true }).first().click()
  const playStart = await page.evaluate(() => performance.now())
  await page.waitForTimeout((PLAYSEC / 2) * 1000)
  const b = await timeLoad('B', 1)
  await page.waitForTimeout(3000)
  await page.waitForTimeout((PLAYSEC / 2) * 1000)
  const playEnd = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(() => window.__frames)
  const slowIn = (from, to) => frames.filter(([t, gap]) => t >= from && t <= to && gap > SLOW_MS).map(([, gap]) => Math.round(gap))
  const all = slowIn(playStart, playEnd)
  const duringB = slowIn(b.t0, b.t0 + b.ms + 3000)

  console.log(`songs in library:        ${files.length}${folderArg ? '' : ' (synthetic 3-minute WAVs)'}`)
  console.log(`open (library shown):    ${open} ms`)
  console.log(`load to deck A:          ${a.ms} ms`)
  console.log(`load to deck B (A plays): ${b.ms} ms`)
  console.log(`frames > ${SLOW_MS} ms in ${PLAYSEC}s of playback: ${all.length}  longest ${all.length ? Math.max(...all) : 0} ms  [${all.join(', ')}]`)
  console.log(`  of which around the deck-B load (until 3 s after it): ${duringB.length} [${duringB.join(', ')}]`)
  const marks = await page.evaluate(() =>
  performance.getEntriesByType('mark').filter((m) => m.name.startsWith('deckload:')).map((m) => [m.name, Math.round(m.startTime), m.detail]))
for (const deck of ['A', 'B']) {
  const at = (step) => marks.find(([n]) => n === `deckload:${deck}:${step}`)
  const start = at('start')
  if (!start) continue
  const steps = ['read', 'hash', 'decode', 'ready'].map((st) => [st, at(st)]).filter(([, m]) => m)
  let prev = start[1]
  const parts = steps.map(([st, m]) => { const d = m[1] - prev; prev = m[1]; return `${st} ${d} ms` })
  console.log(`  deck ${deck} load steps: ${parts.join(' · ')}  (at start: library hashes read = ${start[2]?.hashesRead}, songs being analysed = ${start[2]?.analysing})`)
}
console.log(`page errors: ${errors.length}${errors[0] ? ' — ' + errors[0] : ''}`)

} finally {
  await browser.close()
  server.close()
}

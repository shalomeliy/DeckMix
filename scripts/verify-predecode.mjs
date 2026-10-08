/**
 * v0.9.66 — verifies the real feature in the built app (not the simulation of experiment-predecode.mjs): with Settings › "Decode the
 * next song ahead" ON, selecting a row and waiting past the dwell must leave the song decoded, so that loading it to deck B reports
 * `deckload:B:decode` with `predecoded: true` and a short load; with the switch OFF nothing is decoded ahead.
 *
 *   node scripts/verify-predecode.mjs [folder-with-songs]        (against the built app on :5173; same folder rules as measure-speed)
 *
 * Exit code 1 when a check fails. Read-only on the files.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL ?? 'http://localhost:5173/'
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const folderArg = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null
const WARM_SEC = 17 // deck A plays this long before the pre-decode starts
const BEFORE_B_SEC = 40 // ...and this long before B is loaded, so the pre-decode has finished even on a slow machine
const SLOW_MS = 50
const HITCH_MS = 100

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function synth(dir, n) {
  fs.mkdirSync(dir, { recursive: true })
  const sr = 44100
  const sec = 240
  const mp3 = hasFfmpeg()
  for (let t = 0; t < n; t++) {
    const bpm = 120 + t * 2
    const beat = Math.round((60 / bpm) * sr)
    const pcm = Buffer.alloc(sr * sec * 2)
    for (let i = 0; i < sr * sec; i++) {
      const k = i % beat
      const kick = k < 2000 ? Math.sin(2 * Math.PI * 60 * (k / sr)) * (1 - k / 2000) * 20000 : 0
      const tone = Math.sin((2 * Math.PI * (200 + t * 17) * i) / sr) * 2500 + Math.sin((2 * Math.PI * (1500 + t * 90) * i) / sr) * 900
      pcm.writeInt16LE(Math.round(kick + tone), i * 2)
    }
    const base = path.join(dir, `Synthetic Artist ${String(t + 1).padStart(2, '0')} - Track ${t + 1}`)
    const raw = `${base}.raw`
    fs.writeFileSync(raw, pcm)
    if (mp3) {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(sr), '-ac', '1', '-i', raw, '-b:a', '320k', `${base}.mp3`])
      fs.unlinkSync(raw)
    } else {
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
      fs.writeFileSync(`${base}.wav`, Buffer.concat([h, pcm]))
      fs.unlinkSync(raw)
    }
  }
}

const root = folderArg ?? path.join(os.tmpdir(), 'deckmix-predecode-synth')
if (!folderArg && !fs.existsSync(root)) synth(root, 6)
const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(root)
if (files.length < 2) throw new Error(`need at least 2 songs under ${root}`)
files.splice(40)

const server = http.createServer((req, res) => {
  const f = files[Number(req.url.slice(1))]
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (!f) return res.writeHead(404).end()
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const names = files.map((f) => path.basename(f))

const harness = (settingsJson) => `(() => {
  const NAMES = ${JSON.stringify(names)};
  const PORT = ${port};
  const urlOf = (i) => 'http://127.0.0.1:' + PORT + '/' + i;
  // lastModified fixed: a real file handle returns the same one every time, and the slot's key relies on it (a fresh Date.now() per getFile() made every load a miss)
  const makeFile = (name, i) => ({ kind: 'file', name, getFile: async () => new File([await (await fetch(urlOf(i))).blob()], name, { lastModified: 1700000000000 + i }) });
  const makeDir = (name) => ({ kind: 'directory', name,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    entries: async function* () { for (let i = 0; i < NAMES.length; i++) yield [NAMES[i], makeFile(NAMES[i], i)]; } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map([['deckmix:libraryDir', makeDir('Tracks')]]);
  if (${JSON.stringify(settingsJson)}) mem.set('deckmix:settings', JSON.parse(${JSON.stringify(settingsJson)}));
  const fire = (o, p, v) => setTimeout(() => { o.result = v; o[p] && o[p](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { const req = {}; setTimeout(() => {
    req.result = { transaction: () => { const tx = {}; tx.objectStore = () => ({ transaction: tx,
      get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
      put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; } });
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 1); return tx; } };
    req.onsuccess && req.onsuccess(); }, 0); return req; } } });
  window.__libShown = null;
  new MutationObserver((_, obs) => {
    if (document.querySelector('button[aria-label="Load to deck A"]')) { window.__libShown = performance.now(); obs.disconnect(); }
  }).observe(document, { childList: true, subtree: true });
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

})()`


async function run(browser, on) {
  const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(harness(on ? JSON.stringify({ version: 1, predecodeNext: true }) : ''))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__libShown != null, null, { timeout: 60000 })
    await page.locator('button[aria-label="Load to deck A"]').nth(0).click()
    await page.waitForSelector('[aria-label="Loaded on deck A"]', { timeout: 60000 })
    await page.getByRole('button', { name: 'Play', exact: true }).first().click()
    await page.waitForTimeout(3000)
    const btnB = page.locator('button[aria-label="Load to deck B"]').nth(1)
    // a click on the row (not on its button) selects it
    await btnB.evaluate((el) => (el.closest('[role="row"], tr, li') ?? el.parentElement.parentElement).click())
    // dwell (1.5 s) + the decode itself, with room for a slow machine
    await page.waitForTimeout(Number(process.env.WAIT_MS ?? 15000))
    if (process.env.DEBUG_PREDECODE) {
      console.log('selected rows:', await page.locator('[aria-selected="true"]').count())
      await page.getByRole('button', { name: /settings/i }).first().click()
      await page.waitForTimeout(1500)
      await page.getByLabel('Search settings').fill('decode the next')
      await page.waitForTimeout(500)
      const t = await page.locator('[id$="predecodeNext"]').first().innerText().catch(() => 'no field')
      console.log('settings field:', t.replace(/\n/g, ' | '))
      await page.keyboard.press('Escape')
    }
    const t0 = await page.evaluate(() => performance.now())
    await btnB.click()
    await page.waitForSelector('[aria-label="Loaded on deck B"]', { timeout: 60000 })
    const loadMs = Math.round((await page.evaluate(() => performance.now())) - t0)
    const decode = await page.evaluate(() => performance.getEntriesByType('mark').find((m) => m.name === 'deckload:B:decode')?.detail ?? null)
    return { loadMs, predecoded: decode?.predecoded === true, errors }
  } finally {
    await page.close()
  }
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], executablePath: process.env.PW_CHROME || undefined })
let off, on
try {
  off = await run(browser, false)
  on = await run(browser, true)
} finally {
  await browser.close()
  server.close()
}
console.log(`switch OFF: load B ${off.loadMs} ms, decoded ahead: ${off.predecoded}, page errors: ${off.errors.length}`)
console.log(`switch ON:  load B ${on.loadMs} ms, decoded ahead: ${on.predecoded}, page errors: ${on.errors.length}`)
const checks = [
  ['OFF: nothing decoded ahead', !off.predecoded],
  ['ON: the load took the buffer from the slot', on.predecoded],
  ['ON: no page errors', on.errors.length === 0 && off.errors.length === 0],
]
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)

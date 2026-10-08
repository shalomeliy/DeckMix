/**
 * v0.9.65 — experiment: would decoding the NEXT song in the background, while the current one plays, pay off?
 * Plan and the three pass/fail criteria: docs/research/predecode-next-plan.md (section 3). Changes nothing in the app.
 *
 *   node scripts/experiment-predecode.mjs [folder-with-songs] [runs-per-mode]       (against the built app on :5173)
 *
 * How it simulates the feature without building it: an init script wraps `BaseAudioContext.prototype.decodeAudioData`. In a
 * "pre" run, 17 s into deck A's playback the page decodes song B with the app's own AudioContext (same sample rate, same
 * decoder — what the real feature would do) and keeps the AudioBuffer in a one-slot cache. When the app then loads B to the
 * deck, `engine.decode` calls `decodeAudioData` with the same bytes and gets the cached buffer back, which is what a slot hit
 * would do. A "base" run is the same minute without the pre-decode. Runs alternate base, pre, base, pre... so drift hits both.
 * If a "pre" run's load never hit the cache it is reported as a failed run, not averaged in (the key is the file's size and its
 * first and last 64 bytes; an MP4/WAV repaired in `engine.decode` would miss).
 *
 * Measured per run: the load-to-deck-B time and its steps (the `deckload:` marks), animation frames over 50 ms and over 100 ms
 * in the window where the pre-decode ran (and the same window of the base runs), and the pre-decode's own length.
 * Memory is COMPUTED (samples x channels x 4 bytes of the pre-decoded buffer), not measured: the browser exposes no page-level
 * number for audio buffers here. Read-only: files are read, never written. Measure the built app, never `npm run dev`.
 *
 * No folder given → 6 synthetic 4-minute songs, encoded to MP3 with ffmpeg when it exists (MP3 is what the owner plays and what
 * decodes slowly), else WAV. Container numbers say whether the script works and give a direction; the owner's PC gives the real
 * numbers: `node scripts/experiment-predecode.mjs C:\Users\Shalom\Music\Tracks 3`.
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
const RUNS = Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a))) || 3
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

const harness = `(() => {
  const NAMES = ${JSON.stringify(names)};
  const PORT = ${port};
  const urlOf = (i) => 'http://127.0.0.1:' + PORT + '/' + i;
  const makeFile = (name, i) => ({ kind: 'file', name, getFile: async () => new File([await (await fetch(urlOf(i))).blob()], name) });
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
  window.__libShown = null;
  new MutationObserver((_, obs) => {
    if (document.querySelector('button[aria-label="Load to deck A"]')) { window.__libShown = performance.now(); obs.disconnect(); }
  }).observe(document, { childList: true, subtree: true });
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  // — the simulated one-slot pre-decode cache —
  const ctxs = [];
  const OrigAC = window.AudioContext;
  window.AudioContext = class extends OrigAC { constructor(...a) { super(...a); ctxs.push(this); } };
  const origDecode = BaseAudioContext.prototype.decodeAudioData;
  const keyOf = (ab) => { const u = new Uint8Array(ab); const n = u.length; let h = n;
    for (let i = 0; i < Math.min(64, n); i++) { h = (Math.imul(h, 31) + u[i]) >>> 0; h = (Math.imul(h, 31) + u[n - 1 - i]) >>> 0; }
    return h + ':' + n; };
  let slot = null; let useSlot = false; let hits = 0; let misses = 0;
  BaseAudioContext.prototype.decodeAudioData = function (ab, ok, err) {
    if (useSlot) { if (slot && slot.key === keyOf(ab)) { hits++; const b = slot.buffer; slot = null; return Promise.resolve(b); } misses++; }
    return origDecode.call(this, ab, ok, err);
  };
  window.__useSlot = (on) => { useSlot = on; };
  window.__slotStats = () => ({ hits, misses });
  window.__predecode = async (i) => {
    const ab = await (await fetch(urlOf(i))).arrayBuffer();
    const key = keyOf(ab);
    const ctx = ctxs[0];
    if (!ctx) throw new Error('the app has not created its AudioContext yet');
    const t0 = performance.now();
    const buffer = await origDecode.call(ctx, ab);
    const t1 = performance.now();
    slot = { key, buffer };
    return { t0, t1, bytes: buffer.length * buffer.numberOfChannels * 4, rate: buffer.sampleRate, seconds: buffer.duration };
  };
})()`

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function oneRun(browser, mode) {
  const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(harness)
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__libShown != null, null, { timeout: 60000 })

    await page.locator('button[aria-label="Load to deck A"]').nth(0).click()
    await page.waitForSelector('[aria-label="Loaded on deck A"]', { timeout: 60000 })
    await page.getByRole('button', { name: 'Play', exact: true }).first().click()
    const playStart = await page.evaluate(() => performance.now())

    // which file is the second row? Matched by the words of the file name against the row's text.
    const btnB = page.locator('button[aria-label="Load to deck B"]').nth(1)
    const rowText = (await btnB.evaluate((el) => (el.closest('[role="row"], tr, li') ?? el.parentElement.parentElement).innerText)).toLowerCase()
    const score = names.map((n) => {
      const words = n.replace(/\.[^.]+$/, '').toLowerCase().split(/[^a-z0-9\u0590-\u05ff]+/).filter((w) => w.length >= 3)
      return words.length ? words.filter((w) => rowText.includes(w)).length / words.length : 0
    })
    const best = score.indexOf(Math.max(...score))
    if (score[best] < 0.5) throw new Error(`could not tell which file the second row is (row text: ${JSON.stringify(rowText.slice(0, 80))})`)

    await page.waitForTimeout(WARM_SEC * 1000)
    let pre = null
    if (mode === 'pre') pre = await page.evaluate((i) => window.__predecode(i), best)
    await page.waitForTimeout(Math.max(0, BEFORE_B_SEC - WARM_SEC) * 1000)
    await page.evaluate((on) => window.__useSlot(on), mode === 'pre')

    const t0 = await page.evaluate(() => performance.now())
    await btnB.click()
    await page.waitForSelector('[aria-label="Loaded on deck B"]', { timeout: 60000 })
    const loadMs = Math.round((await page.evaluate(() => performance.now())) - t0)
    await page.waitForTimeout(3000)

    const frames = await page.evaluate(() => window.__frames)
    const stats = await page.evaluate(() => window.__slotStats())
    const marks = await page.evaluate(() =>
      performance.getEntriesByType('mark').filter((m) => m.name.startsWith('deckload:B:')).map((m) => [m.name.split(':')[2], m.startTime]),
    )
    const at = (s) => marks.find(([n]) => n === s)?.[1]
    const steps = {}
    let prev = at('start')
    for (const s of ['read', 'hash', 'decode', 'ready']) {
      const m = at(s)
      if (m != null && prev != null) {
        steps[s] = Math.round(m - prev)
        prev = m
      }
    }
    return { mode, loadMs, steps, pre, frames, playStart, loadStart: t0, stats, errors, file: names[best] }
  } finally {
    await page.close()
  }
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], executablePath: process.env.PW_CHROME || undefined })
const runs = []
try {
  for (let r = 0; r < RUNS; r++) {
    for (const mode of ['base', 'pre']) {
      process.stderr.write(`run ${r + 1}/${RUNS} ${mode}...\n`)
      runs.push(await oneRun(browser, mode))
    }
  }
} finally {
  await browser.close()
  server.close()
}

const base = runs.filter((r) => r.mode === 'base')
// A "pre" run counts only if the load really took the buffer from the slot — never averaged in silently.
const preAll = runs.filter((r) => r.mode === 'pre')
const pre = preAll.filter((r) => r.stats.hits > 0 && r.pre)
const failed = preAll.length - pre.length

const preMs = pre.map((r) => r.pre.t1 - r.pre.t0)
const windowMs = median(preMs) ?? 0
// The window a pre-decode occupies: from its start until it ends. Base runs get the same window (same offset from A's start, same median length).
const slowIn = (r, from, to, min) => r.frames.filter(([t, gap]) => t >= from && t <= to && gap > min).length
const winFor = (r) => (r.mode === 'pre' && r.pre ? [r.pre.t0, r.pre.t1] : [r.playStart + WARM_SEC * 1000, r.playStart + WARM_SEC * 1000 + windowMs])
const winSlow = (rs, min) => rs.map((r) => slowIn(r, ...winFor(r), min))
const loadSlow = (rs, min) => rs.map((r) => slowIn(r, r.loadStart, r.loadStart + r.loadMs + 3000, min))

const fmt = (xs) => (xs.length ? `${median(xs)}  [${xs.join(', ')}]` : 'n/a')
console.log(`songs in library: ${files.length}${folderArg ? '' : ' (synthetic 4-minute songs)'}   runs per mode: ${RUNS}   pre runs that really hit the slot: ${pre.length}/${preAll.length}`)
console.log(`pre-decode itself: ${fmt(preMs.map(Math.round))} ms   buffer ${pre[0] ? Math.round(pre[0].pre.bytes / 1048576) : '?'} MB (computed) at ${pre[0]?.pre.rate ?? '?'} Hz, ${pre[0] ? Math.round(pre[0].pre.seconds) : '?'} s`)
console.log(`load to deck B (median [each]), ms:   base ${fmt(base.map((r) => r.loadMs))}   pre ${fmt(pre.map((r) => r.loadMs))}`)
const stepMs = (rs, s) => rs.map((r) => r.steps[s]).filter((x) => x != null)
console.log(`  decode step ms:                     base ${fmt(stepMs(base, 'decode'))}   pre ${fmt(stepMs(pre, 'decode'))}`)
console.log(`frames > ${SLOW_MS} ms in the pre-decode window:  base ${fmt(winSlow(base, SLOW_MS))}   pre ${fmt(winSlow(pre, SLOW_MS))}`)
console.log(`frames > ${HITCH_MS} ms in the pre-decode window: base ${fmt(winSlow(base, HITCH_MS))}   pre ${fmt(winSlow(pre, HITCH_MS))}`)
console.log(`frames > ${HITCH_MS} ms around the B load (+3 s): base ${fmt(loadSlow(base, HITCH_MS))}   pre ${fmt(loadSlow(pre, HITCH_MS))}`)
console.log(`page errors: ${runs.reduce((n, r) => n + r.errors.length, 0)}${runs.find((r) => r.errors[0]) ? ' — ' + runs.find((r) => r.errors[0]).errors[0] : ''}`)

const baseDecode = median(stepMs(base, 'decode'))
const preDecode = median(stepMs(pre, 'decode'))
const saved = baseDecode && preDecode != null ? 1 - preDecode / baseDecode : null
const extraHitches = (median(winSlow(pre, HITCH_MS)) ?? 0) - (median(winSlow(base, HITCH_MS)) ?? 0)
const mb = pre[0] ? pre[0].pre.bytes / 1048576 : null
const verdict = (ok) => (ok == null ? 'NOT MEASURED' : ok ? 'PASS' : 'FAIL')
console.log('\ncriteria from docs/research/predecode-next-plan.md, section 3:')
console.log(`  1. decode step shrinks by >= 80%:                 ${saved == null ? 'n/a' : Math.round(saved * 100) + '%'}  ${verdict(saved == null ? null : saved >= 0.8)}`)
console.log(`  2. at most 1 extra frame > ${HITCH_MS} ms in the window:   ${extraHitches >= 0 ? '+' : ''}${extraHitches}  ${verdict(pre.length ? extraHitches <= 1 : null)}`)
console.log(`  3. buffer <= 250 MB (computed):                   ${mb == null ? 'n/a' : Math.round(mb) + ' MB'}  ${verdict(mb == null ? null : mb <= 250)}`)
if (failed > 0) console.log(`\n${failed} pre run(s) did not hit the slot and were left out (see the count at the top). Do not trust the verdicts above if that is most of them.`)

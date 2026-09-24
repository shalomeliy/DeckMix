/**
 * 24/09 browser verification: a hand-picked genre shows before the slow
 * analysis reaches its track.
 *
 *   node scripts/verify-genre-before-analysis.mjs    (against npm run dev; DECKMIX_URL overrides :5173)
 *
 * Genre picks are keyed by content hash, and the hash used to be computed
 * inside the analysis loop — so on a cold cache (ANALYZER_VERSION 3 re-analysing
 * Shalom's whole library) every row he had given a genre by hand showed none
 * until the queue reached it. Eight real mp3s from his House folder (read-only),
 * placed at the scan root so no folder name supplies a genre; every one carries
 * a saved pick. Passes only if every rendered row shows its pick while all eight are
 * still queued — before this fix the eighth hash came after six decodes.
 * (Rows are matched by count, not name: a tagged mp3 shows its title.)
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const DIR = String.raw`C:\Users\Shalom\Music\Tracks\House`
// the eight smallest mp3s: his 100MB+ WAVs held in this harness's memory crash the test page itself
const NAMES = fs
  .readdirSync(DIR)
  .filter((n) => n.toLowerCase().endsWith('.mp3'))
  .sort((a, b) => fs.statSync(path.join(DIR, a)).size - fs.statSync(path.join(DIR, b)).size)
  .slice(0, 8)
const BYTES = NAMES.map((n) => fs.readFileSync(path.join(DIR, n)))
const HASHES = BYTES.map((b) => crypto.createHash('sha256').update(b).digest('hex'))
const PICK = 'Techno' // not the folder's genre, so it can only come from the saved pick

const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const FILES = NAMES.map((name, i) => ({ name, url: `__track/${i}` }))
const harness = `(() => {
  const FILES = ${JSON.stringify(FILES)};
  const makeFile = (f) => ({ kind: 'file', name: f.name,
    getFile: async () => new File([await (await fetch('/' + f.url)).arrayBuffer()], f.name, { type: 'audio/mpeg' }) });
  const makeDir = (name) => ({ kind: 'directory', name,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    entries: async function* () { for (const f of FILES) yield [f.name, makeFile(f)]; } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  mem.set('deckmix:genreOverridesByHash', ${JSON.stringify(Object.fromEntries(HASHES.map((h) => [h, PICK])))});
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() {
    const req = {};
    setTimeout(() => {
      req.result = { transaction: () => {
        const tx = {};
        tx.objectStore = () => ({ transaction: tx,
          get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
          put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; } });
        setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
        return tx;
      } };
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  } } });
})()`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.route(/\/__track\/\d+$/, (route) => {
  route.fulfill({ status: 200, body: BYTES[Number(route.request().url().split('/').pop())], contentType: 'audio/mpeg' })
})
await page.addInitScript(harness)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction((n) => document.querySelectorAll('tbody tr').length === n, NAMES.length, { timeout: 15000 })

const state = (pick) =>
  page.evaluate((p) => {
    // rows with a genre select: the virtual list renders only what fits, plus spacer rows
    const rows = [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('select'))
    const badge = [...document.querySelectorAll('span')].find((s) => /^\d+ queued$/.test(s.textContent.trim()))
    return { rows: rows.length, picked: rows.filter((r) => r.querySelector('select').value === p).length, queued: badge ? Number.parseInt(badge.textContent) : 0 }
  }, pick)

const t0 = Date.now()
let seen = null
while (Date.now() - t0 < 120000) {
  const s = await state(PICK)
  if (s.rows >= 5 && s.picked === s.rows) {
    seen = { ...s, ms: Date.now() - t0 }
    break
  }
  await page.waitForTimeout(100)
}
ok('every saved genre pick shows', seen !== null, JSON.stringify(seen))
ok('…while every track is still queued for analysis', seen?.queued === NAMES.length, `${seen?.queued} of ${NAMES.length} queued at ${seen?.ms}ms`)

await page.waitForFunction(() => ![...document.querySelectorAll('span')].some((s) => /\d+ queued/.test(s.textContent || '')), null, { timeout: 180000 })
ok('the queue still finishes', true, `${Date.now() - t0}ms`)
ok('the picks survive the analysis merge', (await state(PICK)).picked >= 5)
ok('no page errors', errors.length === 0, errors[0])

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

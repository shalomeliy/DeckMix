/**
 * v0.8.27 browser verification: the key detector reaches the Key column.
 *
 *   node scripts/verify-key-detect-wiring.mjs      (against npm run dev; DECKMIX_URL overrides :5173)
 *
 * `core/key-detect.ts` has unit tests and `measure-key-detect.mjs` measured its
 * accuracy, but neither says the app *uses* it: that the analyzer returns a
 * key, the background queue carries it, the merge lets a key tag win, and the
 * column marks what came from the audio. This runs the app's real scan +
 * analysis on three files, read-only, from the owner's library:
 *   - an m4a with no key tag      → a detected key, marked `*` or `?`
 *   - an mp3 with a key tag       → the tag's key, unmarked
 *   - a file that is not audio    → Key `–` and BPM `n/a`, each with a tooltip saying why
 * Real Chrome (`channel: 'chrome'`): Playwright's Chromium has no AAC decoder.
 * Same fake `showDirectoryPicker`/`indexedDB` seam as verify-analysis-queue.mjs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const UNTAGGED = path.join(ROOT, 'Techno', 'Heal My Mind - Korolova.m4a')
const TAGGED = path.join(ROOT, 'House', '01. Pablo Fierro - Yababa (Tunisian Mix).mp3')

const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const FILES = [
  { name: path.basename(UNTAGGED), url: '__track/0', type: 'audio/mp4' },
  { name: path.basename(TAGGED), url: '__track/1', type: 'audio/mpeg' },
  { name: 'zz-not-audio.wav', url: '__track/2', type: 'audio/wav' },
]
const BYTES = [fs.readFileSync(UNTAGGED), fs.readFileSync(TAGGED), Buffer.from('this is not audio, at all')]

function harness(files) {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const FILES = ${JSON.stringify(files)};
  const makeFile = (f) => ({
    kind: 'file',
    name: f.name,
    getFile: async () => new File([await (await fetch('/' + f.url)).arrayBuffer()], f.name, { type: f.type }),
  });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const f of FILES) yield [f.name, makeFile(f)]; },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          transaction: () => {
            const tx = {};
            tx.objectStore = () => ({
              transaction: tx,
              get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
              put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; },
            });
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
            return tx;
          },
        };
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } });
})()`
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.route(/\/__track\/\d+$/, (route) => {
  const i = Number(route.request().url().split('/').pop())
  route.fulfill({ status: 200, body: BYTES[i], contentType: FILES[i].type })
})
await page.addInitScript(harness(FILES))
await page.goto(URL, { waitUntil: 'domcontentloaded' })

await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3, null, { timeout: 15000 })
await page.waitForFunction(
  () => ![...document.querySelectorAll('span')].some((s) => /\d+ queued/.test(s.textContent || '')),
  null,
  { timeout: 120000 },
)
await page.waitForTimeout(500)

/** The Key cell of the row naming `text`: its visible text and tooltip. */
async function keyCell(text) {
  return page.evaluate((t) => {
    const table = document.querySelector('table')
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
    const col = heads.findIndex((h) => /^Key/.test(h))
    const row = [...table.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(t))
    const cell = row?.children[col]
    const span = cell?.querySelector('[title]')
    return { text: cell?.textContent.trim() ?? null, title: span?.getAttribute('title') ?? null }
  }, text)
}

{
  const c = await keyCell('Heal My Mind')
  ok('untagged m4a: a key detected from the audio', /^[A-G][#b]?m?[*?] \(detected(, uncertain)?\)$/.test(c.text ?? ''), JSON.stringify(c))
  ok('untagged m4a: the tooltip says it came from the audio', /detected from the audio/.test(c.title ?? ''))
}
{
  const c = await keyCell('Yababa')
  ok('tagged mp3: the tag key, unmarked', /^[A-G][#b]?m?$/.test(c.text ?? ''), JSON.stringify(c))
  ok('tagged mp3: the tooltip does not claim detection', !/detected/.test(c.title ?? ''))
}
{
  const c = await keyCell('zz-not-audio')
  ok('undecodable file: no key, and says why', c.text === '–' && /could not decode/.test(c.title ?? ''), JSON.stringify(c))
  const bpm = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('zz-not-audio'))
    const span = [...row.querySelectorAll('span[title]')].find((s) => s.textContent.trim() === 'n/a')
    return span?.getAttribute('title') ?? null
  })
  ok('undecodable file: the BPM cell reads n/a, not a bare dash, and says why', /could not decode/.test(bpm ?? ''), bpm)
}

ok('no page errors', errors.length === 0, errors[0])
ok('no unhandled rejections', (await page.evaluate(() => window.__unhandled)).length === 0)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

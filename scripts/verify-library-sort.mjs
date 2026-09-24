/**
 * Verifies v0.8.0's column sort (workshop-output/FEATURE_SPEC.md,
 * workshop-output/PLAN.md step 6): clicking a sortable header orders the
 * library table by that column, a second click reverses it, a third click
 * returns to scan order.
 *
 * Runs against `npm run dev` on :5173:
 *
 *   node scripts/verify-library-sort.mjs
 *
 * Reuses the showDirectoryPicker/IndexedDB shim from
 * verify-load-failure-notice.mjs, but the fake files here carry a real,
 * hand-built ID3v2.3 tag (TBPM + TIT2 frames) so `tags.ts`'s actual byte-
 * range parser gives each track a real, distinct BPM and title — sorting
 * on empty/undefined fields would not exercise the comparator at all. No
 * real audio container follows the tag, so background analysis will fail
 * to decode these files; that is expected and does not affect the BPM
 * already read from the tag ("existing wins" merge, controls.ts).
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- minimal ID3v2.3 tag builder (TBPM + TIT2), plain-text frames only ----
function syncsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
}
function textFrame(id, text) {
  const payload = [0x00, ...Buffer.from(text, 'latin1')] // encoding byte 0 = latin1
  const size = payload.length
  return [...Buffer.from(id, 'ascii'), ...u32be(size), 0x00, 0x00, ...payload]
}
function u32be(n) {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
function buildTaggedMp3Bytes(title, bpm) {
  const frames = [...textFrame('TIT2', title), ...textFrame('TBPM', String(bpm))]
  const header = [...Buffer.from('ID3', 'ascii'), 3, 0, 0, ...syncsafe(frames.length)]
  return [...header, ...frames]
}

function harness(entries) {
  // entries: [{ name, bytes }]
  return `(() => {
  const FILES = ${JSON.stringify(entries)};
  const makeFile = (name, bytes) => ({
    kind: 'file',
    name,
    getFile: async () => new File([new Uint8Array(bytes)], name),
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      for (const f of FILES) yield [f.name, makeFile(f.name, f.bytes)];
    },
  });

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => makeDir('Tracks'),
  });

  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const req = {};
      setTimeout(() => {
        const db = { transaction: () => {
          const tx = {};
          tx.objectStore = () => ({
            transaction: tx,
            get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
            put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; },
          });
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
          return tx;
        } };
        req.result = db;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } });
})()`
}

const tracks = [
  { name: 'Zzz Track.mp3', title: 'Zzz Track', bpm: 128 },
  { name: 'Aaa Track.mp3', title: 'Aaa Track', bpm: 174 },
  { name: 'Mmm Track.mp3', title: 'Mmm Track', bpm: 90 },
]
const entries = tracks.map((t) => ({ name: t.name, bytes: buildTaggedMp3Bytes(t.title, t.bpm) }))

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness(entries))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500) // let the tag pass (readLibraryTags) finish — it's a byte-range read, not a decode, fast even for 3 rows

const rowTitles = () => page.locator('tbody tr td:first-child').allTextContents()

const scanOrder = await rowTitles()
ok('setup: 3 rows loaded with tags read', scanOrder.length === 3, scanOrder.join(', '))
// scanLibrary sorts by path (== filename here), so scan order is alphabetical by filename
ok('scan order is alphabetical by path before any sort click', scanOrder.join(',') === 'Aaa Track,Mmm Track,Zzz Track', scanOrder.join(', '))

const bpmHeader = page.getByRole('button', { name: 'BPM' })
await bpmHeader.click()
await page.waitForTimeout(200)
const ascOrder = await rowTitles()
ok('first click on BPM sorts ascending', ascOrder.join(',') === 'Mmm Track,Zzz Track,Aaa Track', ascOrder.join(', '))
const ascArrow = await page.locator('thead').getByText('▲').count()
ok('ascending arrow shown on the active column', ascArrow === 1)

await bpmHeader.click()
await page.waitForTimeout(200)
const descOrder = await rowTitles()
ok('second click on BPM reverses to descending', descOrder.join(',') === 'Aaa Track,Zzz Track,Mmm Track', descOrder.join(', '))

await bpmHeader.click()
await page.waitForTimeout(200)
const resetOrder = await rowTitles()
ok('third click on BPM returns to scan order', resetOrder.join(',') === scanOrder.join(','), resetOrder.join(', '))
const noArrow = await page.locator('thead').getByText(/[▲▼]/).count()
ok('no arrow shown once sort is off', noArrow === 0)

const titleHeader = page.getByRole('button', { name: 'Title' })
await titleHeader.click()
await page.waitForTimeout(200)
const titleAsc = await rowTitles()
ok('clicking a different column (Title) starts fresh at ascending', titleAsc.join(',') === 'Aaa Track,Mmm Track,Zzz Track', titleAsc.join(', '))

ok('no page error at any point', errors.length === 0, errors.join('; '))

await page.close()
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

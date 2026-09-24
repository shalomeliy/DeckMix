/**
 * Verifies the fix for a real bug an independent review caught in v0.8.0:
 * `moveSelection` (controls.ts, wired to ArrowUp/ArrowDown in App.tsx and
 * to the MIDI jog wheel in transport-webmidi/manager.ts) walked
 * `filteredTracks()` — scan order — instead of `sortedFilteredTracks()`.
 * Before this version the two were the same list, so nobody noticed; once
 * the table could be sorted by a column, ArrowDown moved the highlight to
 * whatever was next in scan order, not the row actually below the cursor
 * on screen.
 *
 * Runs against `npm run dev` on :5173:
 *
 *   node scripts/verify-library-sort-navigation.mjs
 *
 * Reuses the tagged-MP3 harness from verify-library-sort.mjs.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function syncsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
}
function u32be(n) {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
function textFrame(id, text) {
  const payload = [0x00, ...Buffer.from(text, 'latin1')]
  return [...Buffer.from(id, 'ascii'), ...u32be(payload.length), 0x00, 0x00, ...payload]
}
function buildTaggedMp3Bytes(title, bpm) {
  const frames = [...textFrame('TIT2', title), ...textFrame('TBPM', String(bpm))]
  const header = [...Buffer.from('ID3', 'ascii'), 3, 0, 0, ...syncsafe(frames.length)]
  return [...header, ...frames]
}

function harness(entries) {
  return `(() => {
  const FILES = ${JSON.stringify(entries)};
  const makeFile = (name, bytes) => ({ kind: 'file', name, getFile: async () => new File([new Uint8Array(bytes)], name) });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const f of FILES) yield [f.name, makeFile(f.name, f.bytes)]; },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
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

// Scan order (alphabetical by filename) is deliberately NOT bpm order,
// so a bug that ignores the sort is observable.
const tracks = [
  { name: 'Aaa Track.mp3', title: 'Aaa Track', bpm: 174 }, // scan-first, fastest
  { name: 'Mmm Track.mp3', title: 'Mmm Track', bpm: 90 }, // scan-middle, slowest
  { name: 'Zzz Track.mp3', title: 'Zzz Track', bpm: 128 }, // scan-last, middle
]
const entries = tracks.map((t) => ({ name: t.name, bytes: buildTaggedMp3Bytes(t.title, t.bpm) }))

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness(entries))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

await page.getByRole('button', { name: 'BPM', exact: true }).click() // sort ascending: Mmm(90), Zzz(128), Aaa(174)
await page.waitForTimeout(200)
const sortedTitles = await page.locator('tbody tr td:first-child').allTextContents()
ok('sorted ascending by BPM as expected', sortedTitles.join(',') === 'Mmm Track,Zzz Track,Aaa Track', sortedTitles.join(', '))

// select the first row in the SORTED view (Mmm Track, bpm 90)
await page.locator('tbody tr').first().click()
await page.waitForTimeout(100)
const selectedBefore = await page.locator('tbody tr[aria-selected="true"] td:first-child').textContent()
ok('selection starts on the first sorted row', selectedBefore === 'Mmm Track', selectedBefore ?? '')

// ArrowDown should move to the next row in the SORTED view (Zzz Track), not scan order
await page.keyboard.press('ArrowDown')
await page.waitForTimeout(100)
const selectedAfter = await page.locator('tbody tr[aria-selected="true"] td:first-child').textContent()
ok(
  'ArrowDown selects the next row in the sorted view, not the next in scan order',
  selectedAfter === 'Zzz Track',
  `expected Zzz Track, got ${selectedAfter}`,
)

ok('no page error at any point', errors.length === 0, errors.join('; '))

await page.close()
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

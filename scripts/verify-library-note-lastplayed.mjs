/**
 * Verifies v0.8.0's Note and Last-played columns (workshop-output/
 * PLAN.md step 8, FEATURE_SPEC.md's acceptance criteria):
 *
 *  - a note typed into the library table survives a rescan of the same,
 *    unmoved file (the hash-keyed merge in applyAnalysisQueue, not a
 *    field that lives on the scan-produced Track object itself)
 *  - lastPlayedAt updates the moment a track is loaded to a deck, not
 *    only after the next rescan (controls.ts's loadTrackToDeck now
 *    optimistically patches the store, the same way setTrackGenre/
 *    setTrackNote already do)
 *
 * Runs against `npm run dev` on :5173:
 *
 *   node scripts/verify-library-note-lastplayed.mjs
 *
 * Two different fake files on purpose: the note test doesn't care whether
 * the file decodes (an MP3 with a real ID3 tag but no real audio frames is
 * enough — same trick verify-library-sort.mjs uses), but the last-played
 * test needs an actual successful `decodeAudioData`, which needs a real,
 * if tiny and silent, WAV payload.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- minimal ID3v2.3 MP3 (tag only, no real audio frames) ----
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
function buildTaggedMp3Bytes(title) {
  const frames = textFrame('TIT2', title)
  const header = [...Buffer.from('ID3', 'ascii'), 3, 0, 0, ...syncsafe(frames.length)]
  return [...header, ...frames]
}

// ---- minimal decodable WAV: PCM16 mono, 8kHz, 100 silent samples ----
function u32le(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}
function u16le(n) {
  return [n & 0xff, (n >> 8) & 0xff]
}
function buildWavBytes() {
  const sampleRate = 8000
  const numSamples = 100
  const dataSize = numSamples * 2
  const fmt = [
    ...Buffer.from('fmt ', 'ascii'),
    ...u32le(16),
    ...u16le(1), // PCM
    ...u16le(1), // mono
    ...u32le(sampleRate),
    ...u32le(sampleRate * 2), // byte rate
    ...u16le(2), // block align
    ...u16le(16), // bits per sample
  ]
  const data = [...Buffer.from('data', 'ascii'), ...u32le(dataSize), ...new Array(dataSize).fill(0)]
  const riff = [...Buffer.from('RIFF', 'ascii'), ...u32le(4 + fmt.length + data.length), ...Buffer.from('WAVE', 'ascii')]
  return [...riff, ...fmt, ...data]
}

function harness(entries) {
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

const entries = [
  { name: 'Note Track.mp3', bytes: buildTaggedMp3Bytes('Note Track') },
  { name: 'Decodable Track.wav', bytes: buildWavBytes() },
]

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness(entries))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

const rowCount = await page.locator('tbody tr').count()
ok('setup: 2 rows loaded', rowCount === 2, `${rowCount}`)

// ---- part 1: note survives a rescan ----
const noteRow = page.locator('tbody tr', { hasText: 'Note Track' })
const noteInput = noteRow.locator('input')
await noteInput.fill('great intro, use it')
await noteInput.blur()
await page.waitForTimeout(400) // async persistTrackNote

// give analysis a moment to reach both tracks and compute their content hashes
await page.waitForTimeout(1500)

await page.getByRole('button', { name: 'Change folder' }).click()
await page.waitForTimeout(2500) // rescan + tag pass + analysis pass (hash needs to land before the merge can restore the note)

const noteRowAfterRescan = page.locator('tbody tr', { hasText: 'Note Track' })
const noteValueAfterRescan = await noteRowAfterRescan.locator('input').inputValue()
ok(
  'a note typed before a rescan is still there after it, on the same unmoved file',
  noteValueAfterRescan === 'great intro, use it',
  noteValueAfterRescan,
)

// ---- part 2: lastPlayedAt updates immediately on deck load, not only after a rescan ----
const beforeLoad = await page.locator('tbody tr', { hasText: 'Decodable Track' }).locator('td').nth(8).textContent()
ok('before any load, Played reads as unset', (beforeLoad ?? '').trim() === '–', beforeLoad ?? '')

await page.locator('tbody tr', { hasText: 'Decodable Track' }).dblclick()
await page.waitForTimeout(600) // decode + hash + the optimistic lastPlayedAt patch

const afterLoad = await page.locator('tbody tr', { hasText: 'Decodable Track' }).locator('td').nth(8).textContent()
ok(
  'immediately after loading to a deck, Played shows "just now" — no rescan needed',
  (afterLoad ?? '').trim() === 'just now',
  afterLoad ?? '',
)

ok('no page error at any point', errors.length === 0, errors.join('; '))

await page.close()
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

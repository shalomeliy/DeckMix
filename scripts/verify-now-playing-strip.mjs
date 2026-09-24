/**
 * v0.8.2 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-now-playing-strip.mjs
 *
 * The "now playing" A/B pill in Library.tsx has no unit test — it's a
 * two-line derived comparison (deck.track.contentHash === row.contentHash),
 * not an algorithm — so what actually matters is whether the real DOM shows
 * the right letter(s) on the right row after a real load/swap/dual-load, in
 * the real browser against real Chromium/IndexedDB. Same fake-
 * `showDirectoryPicker`/fake-`indexedDB` harness as the other verify-*.mjs
 * scripts (copied from verify-mix-assist-load.mjs).
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function syncsafe32(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}
function id3TextFrame(id, value) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), payload])
}
function id3Tag(bpm, camelot) {
  const frames = Buffer.concat([
    ...(bpm != null ? [id3TextFrame('TBPM', String(bpm))] : []),
    ...(camelot ? [id3TextFrame('TKEY', camelot)] : []),
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frames.length)])
  return Buffer.concat([header, frames])
}
// Distinct sine frequency per track so the WAV bytes (and therefore the
// content hash) actually differ — a "same track on both decks" scenario
// with identical audio would pass even if contentHash matching were broken.
function buildTaggedWav(bpm, camelot, freqHz, { durationSec = 6, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2
  const pcm = Buffer.alloc(dataSize)
  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const tag = id3Tag(bpm, camelot)
  const tagPadded = tag.length % 2 === 0 ? tag : Buffer.concat([tag, Buffer.from([0])])
  const chunk = (id, body) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const fmtChunk = chunk('fmt ', fmt)
  const dataChunk = chunk('data', pcm)
  const id3Chunk = chunk('ID3 ', tagPadded)
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, dataChunk, id3Chunk])
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body])
}

function harness(tracks) {
  const files = Object.fromEntries(Object.entries(tracks).map(([name, buf]) => [name, buf.toString('base64')]))
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const files = ${JSON.stringify(files)};
  const makeFile = (name) => ({
    kind: 'file', name,
    getFile: async () => {
      const bytes = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
      return new File([bytes], name, { type: 'audio/wav' });
    },
  });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const n of Object.keys(files)) yield [n, makeFile(n)]; },
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })

async function scenario(name, tracks, check) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(tracks))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  try {
    await check(page, errors)
    ok(`${name}: no console errors`, errors.length === 0, errors[0])
    const unhandled = await page.evaluate(() => window.__unhandled ?? [])
    ok(`${name}: no unhandled rejections`, unhandled.length === 0, unhandled[0])
  } finally {
    await page.close()
  }
}

const row = (page, text) => page.locator('tbody tr', { hasText: new RegExp(text) })
// App.tsx renders <Deck A/>, <Mixer/>, <Deck B/>, <Library/> as sibling
// top-level sections — deck B's section is index 2 (same convention as
// verify-mix-assist-load.mjs's deckHeader helper).
async function dragTrackToDeck(page, trackName, deckIndex) {
  await page.evaluate(
    ({ trackId, deckIndex }) => {
      const dt = new DataTransfer()
      dt.setData('application/x-soundgrid-track', trackId)
      const target = document.querySelectorAll('section')[deckIndex]
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
    },
    { trackId: trackName, deckIndex },
  )
  await page.waitForTimeout(300)
}

// 1. Loading a track to deck A (double-click, the default load target) shows
// the "A" pill on its own row and nothing on an unrelated row.
await scenario(
  'load to deck A marks the right row only',
  {
    'Track One.wav': buildTaggedWav(128, '8A', 220),
    'Track Two.wav': buildTaggedWav(128, '9A', 330),
  },
  async (page) => {
    await row(page, 'Track One').dblclick()
    await page.waitForTimeout(300)
    ok('Track One row shows "Loaded on deck A"', (await row(page, 'Track One').getByLabel('Loaded on deck A').count()) === 1)
    ok('Track One row has no "Loaded on deck B"', (await row(page, 'Track One').getByLabel('Loaded on deck B').count()) === 0)
    ok('Track Two row has no pill at all', (await row(page, 'Track Two').getByLabel(/Loaded on deck/).count()) === 0)
  },
)

// 2. Loading a different track onto the same deck moves the pill: it
// disappears from the old row and appears on the new one, immediately.
await scenario(
  'swapping the deck moves the pill, not duplicates it',
  {
    'Track One.wav': buildTaggedWav(128, '8A', 220),
    'Track Two.wav': buildTaggedWav(128, '9A', 330),
  },
  async (page) => {
    await row(page, 'Track One').dblclick()
    await page.waitForTimeout(300)
    await row(page, 'Track Two').dblclick()
    await page.waitForTimeout(300)
    ok('Track One row lost its pill', (await row(page, 'Track One').getByLabel(/Loaded on deck/).count()) === 0)
    ok('Track Two row now shows "Loaded on deck A"', (await row(page, 'Track Two').getByLabel('Loaded on deck A').count()) === 1)
  },
)

// 3. The same track loaded on both decks at once shows both letters on its
// one row (this is the case a naive "one deck at a time" implementation
// would get wrong).
await scenario(
  'same track on both decks shows both pills',
  { 'Both Decks.wav': buildTaggedWav(128, '8A', 220) },
  async (page) => {
    await row(page, 'Both Decks').dblclick() // loads to A
    await page.waitForTimeout(300)
    await dragTrackToDeck(page, 'Both Decks.wav', 2) // section 2 = deck B
    ok('row shows "Loaded on deck A"', (await row(page, 'Both Decks').getByLabel('Loaded on deck A').count()) === 1)
    ok('row shows "Loaded on deck B"', (await row(page, 'Both Decks').getByLabel('Loaded on deck B').count()) === 1)
  },
)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

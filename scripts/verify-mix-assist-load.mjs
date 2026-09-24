/**
 * v0.4.6 step 5 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-mix-assist-load.mjs
 *
 * `loadSuggestionToDeck` (controls.ts) itself has no unit test — it's a thin
 * wrapper around store state and `loadTrackToDeck`, and what actually matters
 * is whether double-clicking a *suggested* row in the real app lands the
 * track on the right (empty) deck and refuses cleanly when there isn't one.
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` harness as the other
 * verify-*.mjs scripts.
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
function buildTaggedWav(bpm, camelot, { durationSec = 6, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2
  const pcm = Buffer.alloc(dataSize)
  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 2 * i) / sampleRate)), i * 2)
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
  } finally {
    await page.close()
  }
}

const row = (page, text) => page.locator('tbody tr', { hasText: new RegExp(text) })
// App.tsx renders <Deck A/>, <Mixer/>, <Deck B/>, <Library/> as sibling
// top-level sections in that order — deck B is section index 2, not 1.
const deckHeader = (page, deckId) =>
  page.locator('section').nth(deckId === 'A' ? 0 : 2).locator('div.truncate.text-base.font-semibold').first()

async function loadAndPlayDeckA(page, trackName) {
  await row(page, trackName).dblclick()
  await page.waitForTimeout(200)
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(300)
}

// 1. Double-clicking a suggested row loads it onto the empty deck (B), not A.
await scenario(
  'loads onto the empty deck',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Compatible.wav': buildTaggedWav(128, '9A'),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    await row(page, 'Compatible').dblclick()
    await page.waitForTimeout(300)
    const deckBName = await deckHeader(page, 'B').textContent()
    ok('deck B now shows the suggested track', (deckBName ?? '').includes('Compatible'), deckBName ?? '')
    const deckAName = await deckHeader(page, 'A').textContent()
    ok('deck A is untouched', (deckAName ?? '').includes('Deck A Track'), deckAName ?? '')
  },
)

// 2. When the "other" deck already has a paused track loaded, the suggestion
// is refused with a notice rather than silently doing nothing or overwriting it.
await scenario(
  'refuses to overwrite a paused-but-loaded deck',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Compatible.wav': buildTaggedWav(128, '9A'),
    'Already On B.wav': buildTaggedWav(140, '1A'),
  },
  async (page) => {
    // Pre-load (but don't play) something onto deck B, simulating the
    // existing drag-and-drop load path (Deck.tsx's onDrop reads the same
    // 'application/x-soundgrid-track' mime type a real row drag sets).
    await page.evaluate(
      ({ trackId }) => {
        const dt = new DataTransfer()
        dt.setData('application/x-soundgrid-track', trackId)
        const target = document.querySelectorAll('section')[2] // Deck A, Mixer, Deck B, Library
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
      },
      { trackId: 'Already On B.wav' },
    )
    await page.waitForTimeout(300)
    const deckBNameBefore = await deckHeader(page, 'B').textContent()
    ok('setup: deck B has a track loaded (paused)', (deckBNameBefore ?? '').includes('Already On B'), deckBNameBefore ?? '')

    await loadAndPlayDeckA(page, 'Deck A Track')
    await row(page, 'Compatible').dblclick()
    await page.waitForTimeout(300)
    const deckBNameAfter = await deckHeader(page, 'B').textContent()
    ok('deck B still shows its own track, not overwritten', (deckBNameAfter ?? '').includes('Already On B'), deckBNameAfter ?? '')
    const notice = page.getByText(/already has a track loaded/)
    ok('a notice explains the refusal', (await notice.count()) > 0)
  },
)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

/**
 * v0.8.21 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-deck-pin.mjs
 *
 * Two things the owner reported: the deck's own track vanished from the table
 * the moment it started playing (Mix Only lists suggestions only), and the
 * "on deck A" box was the same faint blue as the "mixes with deck A" dot. The
 * pinning is unit-tested (`pinDeckTracks`); what only a real DOM shows is that
 * the row is actually drawn, first, with a solid badge, and that the
 * "no suggestions" sentence still appears under it. Harness copied from
 * verify-now-playing-strip.mjs.
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
// The dot's title became "Suggested · …" in v0.8.11; the older verify-*
// scripts still look for "Mixes with deck", which no longer exists.
const matchDot = (r) => r.locator('span[aria-hidden="true"][title^="Suggested"]')

async function loadAndPlayDeckA(page, trackName) {
  await row(page, trackName).dblclick()
  // background analysis rewrites BPM/key after load; checking sooner reads a list mid-update
  await page.waitForTimeout(1500)
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(1500)
}

await scenario(
  'playing track stays, pinned first, with a solid badge',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A', 220),
    'Compatible.wav': buildTaggedWav(128, '9A', 330),
    'Far Tempo.wav': buildTaggedWav(90, '8A', 440),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    const first = page.locator('tbody tr:not([aria-hidden])').first()
    ok('first row is the deck A track', ((await first.textContent()) ?? '').includes('Deck A Track'))
    ok('it carries the "Loaded on deck A" badge', (await first.getByLabel('Loaded on deck A').count()) === 1)
    ok('the suggestion is listed under it', (await row(page, 'Compatible').count()) === 1)
    ok('a non-suggestion stays hidden (Mix Only is on)', (await row(page, 'Far Tempo').count()) === 0)
    const badgeBg = await first.getByLabel('Loaded on deck A').evaluate((el) => getComputedStyle(el).backgroundColor)
    ok('badge is solid deck blue, not a tint', badgeBg === 'rgb(42, 199, 255)', badgeBg)
    const dot = matchDot(row(page, 'Compatible'))
    ok('the suggestion still has its own dot', (await dot.count()) === 1)
  },
)

await scenario(
  'no suggestions: the track and the sentence both show',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A', 220),
    'Far Tempo.wav': buildTaggedWav(90, '8A', 440),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    ok('deck A track row is drawn', (await row(page, 'Deck A Track').count()) === 1)
    const said = await page.getByText('No tracks currently mix with what’s playing').count()
    ok('the empty-state sentence is still there', said === 1, String(said))
  },
)

await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

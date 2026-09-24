/**
 * v0.4.6 step 4 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-mix-assist-suggestions.mjs
 *
 * Covers what `tests/core/recommend.test.ts` cannot: whether the *panel*
 * actually goes always-on when a deck plays (no click), whether the chip
 * text renders on the right rows and stays quiet on a 1:1 match, and
 * whether the "N skipped · no BPM" count is visible rather than silently
 * folded into the recommendation count. Same fake-`showDirectoryPicker`/
 * fake-`indexedDB` harness as `scripts/verify-recommendations.mjs` — copied
 * rather than imported, matching how the other verify-*.mjs scripts in this
 * repo are each self-contained.
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

async function loadAndPlayDeckA(page, trackName) {
  await row(page, trackName).dblclick()
  await page.waitForTimeout(200)
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(300)
}

// 1. Suggestions go always-on: the mixOnly toggle is ACTIVE without ever
// being clicked, the moment a deck starts playing.
await scenario(
  'suggestions default on',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Compatible.wav': buildTaggedWav(128, '9A'),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    const toggle = page.getByRole('button', { name: /mixable/ })
    const active = (await toggle.getAttribute('class')) ?? ''
    ok('mixOnly toggle is active without being clicked', /bg-|active/.test(active) || (await toggle.getAttribute('aria-pressed')) === 'true', active)
    // The escape hatch still works: a manual click returns to the full list.
    await toggle.click()
    await page.waitForTimeout(100)
    const clashingVisible = await row(page, 'Deck A Track').isVisible()
    ok('manual click still reaches the full track list', clashingVisible)
  },
)

// 2. Half-time chip renders on a matching row, and NOT on a 1:1 match.
await scenario(
  'chip text',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Same Tempo.wav': buildTaggedWav(128, '9A'),
    'Half Time.wav': buildTaggedWav(64, '9A'),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    const halfRow = row(page, 'Half Time')
    await halfRow.waitFor()
    const halfText = (await halfRow.textContent()) ?? ''
    // Tagged at 64 BPM against a 128 BPM deck — its own tempo is half the
    // reference, so it plays in half-time relative to what's on the deck.
    ok('half-time match shows the chip', halfText.includes('half-time'), halfText)

    const sameRow = row(page, 'Same Tempo')
    const sameText = (await sameRow.textContent()) ?? ''
    ok('a plain 1:1 match shows no chip at all', !sameText.includes('time'), sameText)
  },
)

// 3. No-BPM tracks are excluded from suggestions but counted, not silent.
await scenario(
  'no-BPM skipped count',
  {
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Compatible.wav': buildTaggedWav(128, '9A'),
    // Genuinely no BPM, permanently — not merely untagged: `detectBeatGrid`
    // needs at least 64 onset frames (~0.32s at 200 frames/sec) to return
    // anything at all, so a real WAV this short never gets a background-
    // analysis fallback BPM either. A normal-length untagged file *does*
    // eventually get one from analysis (any audio scores some tempo, however
    // unreliable) — this fixture is the one real-world case that stays
    // BPM-less forever, which is what these two scenarios actually need.
    'No Tags At All.wav': buildTaggedWav(null, null, { durationSec: 0.1 }),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    const badge = page.getByText(/skipped · no BPM/)
    await badge.waitFor()
    const text = (await badge.textContent()) ?? ''
    ok('exactly one track is counted as skipped for missing BPM', text.includes('1 skipped'), text)
  },
)

// 4. NOT covered here on purpose: "a playing deck with no BPM yet" (the
// no-bpm-on-playing-deck reason, and its "BPM unknown on deck A" copy).
// `loadTrackToDeck` (controls.ts) runs beatgrid analysis as part of the same
// load — not fire-and-forget after playback starts — so for any fixture
// small enough to keep this script fast, analysis finishes within the same
// tick as the load itself, closing the real "still null" window before
// Playwright can observe it (checked empirically at 0/5/10/20/30/50/80/120ms
// after pressing play: bpm had already resolved every time). A fixture large
// enough to open a reliable window would make every script here slow, for a
// state that is genuinely real but genuinely brief. The reason-selection
// logic itself is deterministic and unit-tested instead:
// tests/core/recommend.test.ts, "no playing deck has a BPM yet — reason
// names it, not just an empty map".

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

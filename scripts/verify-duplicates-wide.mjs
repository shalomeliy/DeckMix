/**
 * v0.9.24 verification — the wider duplicate search. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-duplicates-wide.mjs
 *
 * The owner's screenshot (05/10): two remixes of one song, no artist tag,
 * that v0.8.45's exact name+length match never put together.
 * 1. The header says there is a repeated song.
 * 2. "Duplicates only" lists both remixes, and not the unrelated track.
 * 3. Each row's chip says what differs: "other mix", and which is longer.
 * 4. The chip's tooltip names both files with their lengths.
 * Harness (tagged WAVs, in-memory IndexedDB) is `verify-deck-pin.mjs`'s.
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
  window.__import = (path) => {
    const loaded = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(loaded ?? path);
  };
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

const chip = (page, text) => page.locator('tbody tr', { hasText: text }).locator('span[role="img"]', { hasText: '×' })

const TRACKS = {
  'עדן חסון - צוחקת ובוכה (Dj Camelion Extended Remix) V2.wav': buildTaggedWav(128, '8A', 220, { durationSec: 10 }),
  'עדן חסון - צוחקת ובוכה (Hasod Remix).wav': buildTaggedWav(128, '8A', 330, { durationSec: 6 }),
  'Something Else Entirely.wav': buildTaggedWav(128, '8A', 440, { durationSec: 6 }),
}

await scenario('two remixes of one song', TRACKS, async (page) => {
  const button = page.getByRole('button', { name: /repeated song|other version/ })
  await button.waitFor({ timeout: 15000 })
  ok('header counts one song in another version', /1 in other version/.test((await button.textContent()) ?? ''), await button.textContent())
  await button.click()
  await page.waitForTimeout(300)
  const rows = await page.locator('tbody tr[aria-selected]').allTextContents()
  ok('Duplicates only lists the two remixes and nothing else', rows.length === 2 && rows.every((r) => /צוחקת ובוכה/.test(r)), rows.join(' | '))
  const longChip = (await chip(page, 'Camelion').textContent()) ?? ''
  const shortChip = (await chip(page, 'Hasod').textContent()) ?? ''
  ok('the long remix says V, other mix, longer', /^V×2/.test(longChip) && /other mix/.test(longChip) && /longer/.test(longChip), longChip)
  ok('the short remix says other mix, shorter', /other mix/.test(shortChip) && /shorter/.test(shortChip), shortChip)
  const tip = (await chip(page, 'Hasod').getAttribute('title')) ?? ''
  ok('tooltip names both files with their lengths', /0:10/.test(tip) && /0:06/.test(tip) && /Hasod Remix/.test(tip) && /Camelion/.test(tip), tip.replace(/\n/g, ' / '))
})

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

/**
 * v0.9.24 verification — the Genre column filter (▾). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-genre-filter.mjs
 *
 * Shalom, 05/10: "add filtering to the Genre column".
 * 1. The ▾ lists only the genres the library holds, each with its count, and "No genre".
 * 2. Ticking House leaves only House rows; ticking Techno too adds them.
 * 3. "No genre" picks out the tracks without one.
 * 4. The filter is named in the active-filter line, and "Show all genres" undoes it.
 * Harness (tagged WAVs, in-memory IndexedDB) is `verify-deck-pin.mjs`'s, with folders.
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
  // nested: a key "House/a.wav" is a file in a House folder — the genre comes from the folder
  const makeFile2 = (path) => ({ ...makeFile(path), name: path.split('/').pop() });
  const makeDir = (name, prefix = '') => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      const seen = new Set();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i < 0) yield [rest, makeFile2(p)];
        else if (!seen.has(rest.slice(0, i))) { seen.add(rest.slice(0, i)); yield [rest.slice(0, i), makeDir(rest.slice(0, i), prefix + rest.slice(0, i) + '/')]; }
      }
    },
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

const rowsText = (page) => page.locator('tbody tr[aria-selected]').allTextContents()
const names = async (page) => (await rowsText(page)).map((r) => (r.match(/(H\d|T\d|Loose)/) ?? ['?'])[0]).sort().join(',')

const TRACKS = {
  'House/H1.wav': buildTaggedWav(124, '8A', 220),
  'House/H2.wav': buildTaggedWav(124, '8A', 260),
  'Techno/T1.wav': buildTaggedWav(130, '8A', 300),
  'Loose.wav': buildTaggedWav(120, '8A', 340),
}

await scenario('genre filter', TRACKS, async (page) => {
  await page.locator('tbody tr', { hasText: 'T1' }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(500)
  ok('setup: all four tracks listed', (await names(page)) === 'H1,H2,Loose,T1', await names(page))
  const btn = page.getByRole('button', { name: 'Filter by genre' })
  await btn.click()
  const box = page.getByRole('group', { name: 'Genres to show' })
  const rect = await box.evaluate((b) => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight } })
  // the first run opened it below a header at y≈620 — off the 710px screen
  ok('the list opens fully on screen', rect.top >= 0 && rect.bottom <= rect.h, JSON.stringify(rect))
  const listed = (await box.locator('label').allTextContents()).join(' | ')
  ok('lists the genres held, with counts, and No genre', /House\s*2/.test(listed) && /Techno\s*1/.test(listed) && /No genre\s*1/.test(listed) && !/Trance/.test(listed), listed)
  await box.locator('label', { hasText: 'House' }).locator('input').check()
  await page.waitForTimeout(200)
  ok('House ticked: only House rows', (await names(page)) === 'H1,H2', await names(page))
  await box.locator('label', { hasText: 'Techno' }).locator('input').check()
  await page.waitForTimeout(200)
  ok('Techno added: House and Techno rows', (await names(page)) === 'H1,H2,T1', await names(page))
  await box.locator('label', { hasText: 'House' }).locator('input').uncheck()
  await box.locator('label', { hasText: 'Techno' }).locator('input').uncheck()
  await box.locator('label', { hasText: 'No genre' }).locator('input').check()
  await page.waitForTimeout(200)
  ok('No genre picks out the track without one', (await names(page)) === 'Loose', await names(page))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  ok('Esc closes the list', (await box.count()) === 0)
  const headerBtn = page.getByRole('button', { name: /Genre filter: No genre/ })
  ok('the ▾ shows a filter is on', (await headerBtn.count()) === 1 && /▾1/.test((await headerBtn.textContent()) ?? ''))
  await headerBtn.click()
  await page.getByRole('button', { name: 'Show all genres' }).click()
  await page.waitForTimeout(200)
  ok('Show all genres brings every row back', (await names(page)) === 'H1,H2,Loose,T1', await names(page))
  await page.keyboard.press('Escape')
  // a filter that matches nothing names itself in the empty state
  await page.getByRole('button', { name: 'Filter by genre' }).click()
  await box.locator('label', { hasText: 'House' }).locator('input').check()
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'Filter tracks' }).fill('T1')
  await page.waitForTimeout(300)
  const body = (await page.locator('main, body').first().textContent()) ?? ''
  ok('empty result names the genre filter', /Genre: House/.test(body))
})

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

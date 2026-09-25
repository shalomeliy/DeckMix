/**
 * v0.8.37 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-mix-assist-tempo.mjs
 *
 * The tempo buttons (faster / same / slower) next to Mix Only: what
 * `tests/core/recommend.test.ts` cannot see — that the buttons render when a
 * deck plays, reorder the actual table rows, say so in a filter chip and in
 * each row's reasons, and switch off on a second click. Harness copied from
 * verify-mix-assist-suggestions.mjs (each verify script is self-contained).
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
  // Waits on the app, not the clock (2026-09-24). Fixed 200/300 ms sleeps
  // passed in the Linux container these were written in and failed in Comet
  // on Windows: the load (read, hash, decode) was still running when KeyQ
  // arrived, so PLAY hit an empty deck and every "suggestion" check after it
  // failed for a reason that had nothing to do with suggestions.
  await row(page, trackName).dblclick()
  await page
    .locator('section')
    .nth(0)
    .locator('div.truncate.text-base.font-semibold')
    .first()
    .filter({ hasText: trackName })
    .waitFor({ timeout: 10000 })
  await page.keyboard.press('KeyQ')
  await page.waitForFunction(
    // either the Mix Only toggle switched itself on, or the app said outright
    // that nothing mixes — both mean the deck is playing and recs are computed
    () =>
      [...document.querySelectorAll('button')].some((b) => /mixable/.test(b.textContent ?? '') && b.getAttribute('aria-pressed') === 'true') ||
      document.body.textContent.includes('no mixable tracks'),
    null,
    { timeout: 10000 },
  )
  await page.waitForTimeout(300)
}


await scenario(
  'tempo buttons',
  {
    // All within 3% (one tier) and each file different: identical bytes share
    // a hash, and a copy of the deck's own track reads as "already loaded" —
    // the first run of this script tripped on exactly that.
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Up Small.wav': buildTaggedWav(129.5, '8A'),
    'Up Big.wav': buildTaggedWav(130.5, '9A'),
    'Same Tempo.wav': buildTaggedWav(127, '7A'),
    'Down Small.wav': buildTaggedWav(125, '8B'),
  },
  async (page) => {
    await loadAndPlayDeckA(page, 'Deck A Track')
    const names = async () =>
      (await page.locator('tbody tr').allInnerTexts())
        .map((t) => ['Deck A Track', 'Up Small', 'Up Big', 'Same Tempo', 'Down Small'].find((n) => t.includes(n)))
        .filter((n) => n && n !== 'Deck A Track')
    const button = (label) => page.getByRole('button', { name: label, exact: true })
    ok('the three buttons render while a deck plays', (await button('faster').count()) === 1 && (await button('slower').count()) === 1 && (await button('same').count()) === 1)

    await button('faster').click()
    await page.waitForTimeout(200)
    const faster = await names()
    ok('faster: the smallest faster step leads, then the bigger one', faster[0] === 'Up Small' && faster[1] === 'Up Big', JSON.stringify(faster))
    ok('faster: nothing hidden — all four suggestions still listed', faster.length === 4, String(faster.length))
    // the lit button is the indicator; the filter chips only render in the empty state
    ok('the faster button shows as pressed', (await button('faster').getAttribute('aria-pressed')) === 'true')
    const title = await page.locator('tbody tr', { hasText: 'Up Small' }).first().getAttribute('title').catch(() => null)
    const rowText = (await page.locator('tbody tr', { hasText: 'Up Small' }).first().innerHTML()) ?? ''
    ok("the row's reasons say its step", /\d% faster than deck A/.test(`${title ?? ''} ${rowText}`))

    await button('slower').click()
    await page.waitForTimeout(200)
    ok('slower: the slower track leads', (await names())[0] === 'Down Small', JSON.stringify(await names()))

    await button('same').click()
    await page.waitForTimeout(200)
    ok('same: the same-tempo track leads', (await names())[0] === 'Same Tempo', JSON.stringify(await names()))

    await button('same').click()
    await page.waitForTimeout(200)
    ok('a second click turns it off', (await button('same').getAttribute('aria-pressed')) === 'false')
  },
)

await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`
${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

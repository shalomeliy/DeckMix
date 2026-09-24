/**
 * v0.8.25 verification — the arrow keys walk the rows on screen, and the
 * search box can be limited to one column. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-column-search.mjs
 *
 * 1. Mix Only hides a track that clashes with deck A. Until v0.8.25 ↓ walked
 *    the full sorted list and the highlight landed on that hidden track —
 *    no row on screen was selected any more.
 * 2. ⌕ BPM, type 128: only 128 rows stay, a count says so, no deck moves.
 * 3. ⌕ Title, "love": word start — "Alpha Love" yes, "Beta Glove" no. A typed
 *    "q" in the box never starts deck A.
 * 4. Esc drops the column tag first, then the text.
 * 5. Nothing matches: every active filter is named, each with its own ✕.
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

const row = (page, text) => page.locator('tbody tr', { hasText: new RegExp(text) })
/** Position of the selected row among the drawn rows, or null when no drawn row is selected. */
const selectedName = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('tbody tr[aria-selected]')]
    const i = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true')
    return i < 0 ? null : `row ${i + 1}/${rows.length}`
  })
const deckAPlaying = (page) =>
  page.evaluate(() => /Pause/.test(document.querySelectorAll('section')[0]?.textContent ?? ''))

// Scan order puts the clashing track between two that mix, so the old
// full-list walk steps straight onto it.
const TRACKS = {
  'Deck Track.wav': buildTaggedWav(128, '8A', 220),
  'Alpha Love.wav': buildTaggedWav(128, '8A', 330),
  'Clash Ninety.wav': buildTaggedWav(90, '3B', 440),
  'Beta Glove.wav': buildTaggedWav(128, '9A', 550),
  'Gamma Groove.wav': buildTaggedWav(128, '8A', 660),
}

await scenario('arrows in Mix Only', TRACKS, async (page) => {
  await row(page, 'Deck Track').dblclick()
  await page.locator('section').nth(0).locator('div.truncate.text-base.font-semibold').filter({ hasText: 'Deck Track' }).waitFor({ timeout: 10000 })
  await page.keyboard.press('KeyQ')
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /mixable/.test(b.textContent ?? '') && b.getAttribute('aria-pressed') === 'true'),
    null,
    { timeout: 10000 },
  )
  await page.waitForTimeout(300)
  ok('setup: Mix Only hides the clashing track', (await row(page, 'Clash Ninety').count()) === 0)
  const bar = await page.evaluate(() => {
    const el = document.querySelector('input[aria-label="Filter tracks"]')?.closest('div')?.parentElement
    return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null
  })
  ok('layout: library header fits in Mix Only with the count shown', bar != null && bar.scroll <= bar.client, JSON.stringify(bar))
  await row(page, 'Alpha Love').click()
  let allOnScreen = true
  const seen = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(80)
    const s = await selectedName(page)
    seen.push(s ?? '(nothing on screen)')
    if (!s) allOnScreen = false
  }
  ok('↓ never selects a row that is not on screen', allOnScreen, seen.join(' → '))
  ok('↓ actually moves down the drawn rows', new Set(seen).size >= 2, seen.join(' → '))
  // Mix Only + a search that matches only the hidden track: the table draws
  // nothing, and ↓ used to fall back to the full list — landing on it.
  await page.getByRole('textbox', { name: 'Filter tracks' }).fill('Clash')
  await page.waitForTimeout(200)
  ok('setup: the table draws no rows', (await page.locator('tbody tr[aria-selected]').count()) === 0)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('ArrowDown')
  const picked = await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const s = useStore.getState().library
    return s.tracks.find((t) => t.id === s.selectedId)?.name ?? null
  })
  ok('empty Mix Only table: ↓ does not select the hidden track', !/Clash/.test(picked ?? ''), String(picked))
  await page.getByRole('textbox', { name: 'Filter tracks' }).fill('')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('KeyQ') // stop deck A again
})

await scenario('column search', TRACKS, async (page) => {
  await row(page, 'Alpha Love').waitFor()
  const total = await page.locator('tbody tr').count()

  // BPM
  await page.getByRole('button', { name: 'Search BPM only' }).click()
  const box = page.getByRole('textbox', { name: 'Search BPM only' })
  ok('⌕ BPM: the box is tagged and focused', (await box.count()) === 1 && (await box.evaluate((el) => el === document.activeElement)))
  await page.keyboard.type('128')
  await page.waitForTimeout(150)
  const names = await page.locator('tbody tr').allInnerTexts()
  ok('BPM 128: only the 128 tracks stay', names.length === 4 && !names.some((n) => n.includes('Clash Ninety')), `${names.length} of ${total}`)
  ok('count: says how many of how many', (await page.getByText(`4 of ${total}`).count()) === 1)
  const bar = await page.evaluate(() => {
    const el = document.querySelector('input[aria-label^="Search"]')?.closest('div')?.parentElement
    return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null
  })
  ok('layout: the library header still fits at 1536px with the tag and count', bar != null && bar.scroll <= bar.client, JSON.stringify(bar))
  ok('no deck moved while typing', !(await deckAPlaying(page)) && !/Deck Track|Alpha|Beta|Gamma/.test(await page.locator('section').nth(0).locator('div.truncate.text-base.font-semibold').first().innerText()))

  // Esc: tag first, then text
  await page.keyboard.press('Escape')
  ok('Esc 1: the column tag goes, the text stays', (await page.getByRole('textbox', { name: 'Filter tracks' }).inputValue()) === '128')
  await page.keyboard.press('Escape')
  ok('Esc 2: the text goes', (await page.getByRole('textbox', { name: 'Filter tracks' }).inputValue()) === '')

  // Title word-start, and a typed q stays in the box
  await page.getByRole('button', { name: 'Search Title only' }).click()
  await page.keyboard.type('love')
  await page.waitForTimeout(150)
  ok('Title "love": Alpha Love yes, Beta Glove no', (await row(page, 'Alpha Love').count()) === 1 && (await row(page, 'Beta Glove').count()) === 0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Search Title only' }).click()
  await page.keyboard.type('q')
  await page.waitForTimeout(200)
  ok('a "q" typed in the box does not start deck A', !(await deckAPlaying(page)))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // Nothing matches: name every filter
  await page.getByRole('button', { name: 'Search BPM only' }).click()
  await page.keyboard.type('200')
  await page.waitForTimeout(150)
  const chip = page.getByLabel('Active filters').getByRole('button', { name: /BPM: "200"/ })
  ok('empty: the BPM filter is named with its own ✕', (await chip.count()) === 1)
  // nothing on screen: ↓ must not pick a hidden track (it used to fall back
  // to the full list whenever the drawn list was empty)
  const selected = () =>
    page.evaluate(async () => {
      const { useStore } = await window.__import('/src/app/state/store.ts')
      return useStore.getState().library.selectedId
    })
  // out of the search box first — the box keeps arrows to itself
  await page.evaluate(() => document.activeElement?.blur())
  const before = await selected()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const after = await selected()
  ok('empty table: ↓ does not move the selection to a hidden track', after === before, `${before} -> ${after}`)
  await chip.click()
  await page.waitForTimeout(150)
  ok('empty: its ✕ brings every row back', (await page.locator('tbody tr').count()) === total)

  // a BPM search saved as a smart crate keeps its column
  await page.getByRole('button', { name: 'Search BPM only' }).click()
  await page.keyboard.type('128')
  page.once('dialog', (d) => d.accept('Tempo 128'))
  await page.getByRole('button', { name: /save search/i }).click()
  await page.waitForTimeout(200)
  const crate = await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    return [...useStore.getState().crates.values()].find((c) => c.name === 'Tempo 128') ?? null
  })
  ok('save as crate: the column is saved with the query', crate?.queryColumn === 'bpm' && crate?.query === '128', JSON.stringify(crate))
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

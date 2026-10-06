/**
 * v0.9.36 verification — a ▾ filter on every track-list column, and Type sorts.
 * Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-column-filters.mjs
 *
 * Shalom, 06/10: "add filtering and sorting to all the other columns".
 * Each column's ▾ opens on screen and narrows the rows the way its values call
 * for: text (Title, Artist incl. "Only No artist", Note), ticks (Type, Key,
 * Played), a range (BPM, Time). Two filters apply together, each names itself
 * as a chip, and its chip clears only it. Type sorts.
 * Harness (tagged WAVs, in-memory IndexedDB) is `verify-genre-filter.mjs`'s.
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
function id3Tag(bpm, camelot, artist) {
  const frames = Buffer.concat([
    ...(bpm != null ? [id3TextFrame('TBPM', String(bpm))] : []),
    ...(camelot ? [id3TextFrame('TKEY', camelot)] : []),
    ...(artist ? [id3TextFrame('TPE1', artist)] : []),
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frames.length)])
  return Buffer.concat([header, frames])
}
// Distinct sine frequency per track so the WAV bytes (and therefore the
// content hash) actually differ — a "same track on both decks" scenario
// with identical audio would pass even if contentHash matching were broken.
function buildTaggedWav(bpm, camelot, freqHz, { durationSec = 6, sampleRate = 8000, artist } = {}) {
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
  const tag = id3Tag(bpm, camelot, artist)
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


const ids = async (page) =>
  (await page.locator('tbody tr[aria-selected]').allTextContents())
    .map((r) => (r.match(/(Alpha|Bravo|Charlie|Delta)/) ?? ['?'])[0])
    .join(',')
const sorted = async (page) => (await ids(page)).split(',').sort().join(',')

const TRACKS = {
  'Alpha.wav': buildTaggedWav(122, '8A', 220, { durationSec: 4, artist: 'Avicii' }),
  'Bravo.wav': buildTaggedWav(128, '9A', 260, { durationSec: 8, artist: 'Boris' }),
  'Charlie.wav': buildTaggedWav(135, '8A', 300, { durationSec: 12 }),
  'Delta.mp3': buildTaggedWav(128, '3B', 340, { durationSec: 6, artist: 'Dana' }),
}

async function openFilter(page, name) {
  await page.getByRole('button', { name: `Filter by ${name}`, exact: true }).click()
  const box = page.getByRole('group', { name: `${name} filter` })
  await box.waitFor({ timeout: 2000 })
  const r = await box.evaluate((b) => { const q = b.getBoundingClientRect(); return { top: q.top, bottom: q.bottom, h: innerHeight } })
  ok(`${name}: list opens fully on screen`, r.top >= 0 && r.bottom <= r.h, JSON.stringify(r))
  return box
}
// Clears through each column's own ▾ ("Show all …" / "Show every …"), the way the owner would.
async function closeAndClear(page) {
  await page.keyboard.press('Escape')
  for (;;) {
    const on = page.getByRole('button', { name: /^(Title|Artist|Note|Type|Key|BPM|Time|Played) filter:/ })
    if ((await on.count()) === 0) break
    await on.first().click()
    await page.getByRole('group').getByRole('button', { name: /^Show (all|every)/ }).click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(150)
}

await scenario('column filters', TRACKS, async (page) => {
  await page.locator('tbody tr', { hasText: 'Delta' }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(800)
  ok('setup: four tracks', (await sorted(page)) === 'Alpha,Bravo,Charlie,Delta', await sorted(page))
  const ALL = 'Alpha,Bravo,Charlie,Delta'

  // Title: text anywhere in the cell
  let box = await openFilter(page, 'Title')
  await box.getByRole('textbox').fill('ar')
  await page.waitForTimeout(200)
  ok('Title "ar": only Charlie', (await sorted(page)) === 'Charlie', await sorted(page))
  await page.keyboard.press('Escape')
  const chip = page.locator('button', { hasText: 'Title: "ar" ✕' })
  ok('a filtered column names itself in the header ▾', (await page.getByRole('button', { name: /Title filter: "ar"/ }).count()) === 1)
  await page.getByRole('button', { name: /Title filter/ }).click()
  await page.getByRole('button', { name: 'Show every title' }).click()
  await page.waitForTimeout(150)
  ok('Show every title brings all back', (await sorted(page)) === ALL, await sorted(page))
  await closeAndClear(page)

  // Artist: Only "No artist"
  box = await openFilter(page, 'Artist')
  await box.getByRole('radio', { name: /Only "No artist"/ }).check()
  await page.waitForTimeout(200)
  ok('Artist only empty: Charlie', (await sorted(page)) === 'Charlie', await sorted(page))
  await box.getByRole('radio', { name: /Hide "No artist"/ }).check()
  await page.waitForTimeout(200)
  ok('Artist hide empty: the other three', (await sorted(page)) === 'Alpha,Bravo,Delta', await sorted(page))
  await closeAndClear(page)

  // Type: ticks, with counts
  box = await openFilter(page, 'Type')
  const types = (await box.locator('label').allTextContents()).join(' | ')
  ok('Type lists MP3 1 and WAV 3', /MP3\s*1/.test(types) && /WAV\s*3/.test(types), types)
  await box.locator('label', { hasText: 'MP3' }).locator('input').check()
  await page.waitForTimeout(200)
  ok('Type MP3: only Delta', (await sorted(page)) === 'Delta', await sorted(page))
  await closeAndClear(page)

  // Key: ticks in wheel order
  box = await openFilter(page, 'Key')
  const keys = (await box.locator('label').allTextContents()).map((s) => s.trim())
  ok('Key lists each key once with its count', keys.length === 3 && /2$/.test(keys.find((k) => /8A|Am/.test(k)) ?? ''), keys.join(' | '))
  await box.locator('label').filter({ hasText: /8A|Am/ }).locator('input').click()
  await page.waitForTimeout(300)
  await page.waitForTimeout(200)
  ok('Key 8A: Alpha and Charlie', (await sorted(page)) === 'Alpha,Charlie', await sorted(page))
  await closeAndClear(page)

  // BPM: range, and two filters together
  box = await openFilter(page, 'BPM')
  await box.getByRole('textbox', { name: 'BPM from' }).fill('125')
  await box.getByRole('textbox', { name: 'BPM to' }).fill('130')
  await page.waitForTimeout(200)
  ok('BPM 125–130: Bravo and Delta', (await sorted(page)) === 'Bravo,Delta', await sorted(page))
  await page.keyboard.press('Escape')
  box = await openFilter(page, 'Type')
  await box.locator('label', { hasText: 'WAV' }).locator('input').check()
  await page.waitForTimeout(200)
  ok('BPM 125–130 and WAV: only Bravo', (await sorted(page)) === 'Bravo', await sorted(page))
  await page.keyboard.press('Escape')
  ok('the header says how many rows are left', /1 of 4/.test((await page.locator('body').textContent()) ?? ''))
  box = await openFilter(page, 'Title')
  await box.getByRole('textbox').fill('zzz')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const chips = (await page.getByRole('group', { name: 'Active filters' }).or(page.locator('[aria-label="Active filters"]')).first().textContent()) ?? ''
  ok('nothing left: each filter is a chip', /BPM: 125–130/.test(chips) && /Type: WAV/.test(chips) && /Title: "zzz"/.test(chips), chips)
  await page.locator('button', { hasText: 'Title: "zzz" ✕' }).click()
  await page.locator('button', { hasText: 'Type: WAV ✕' }).waitFor({ state: 'detached', timeout: 1000 }).catch(() => {})
  await page.waitForTimeout(200)
  ok('the Title chip clears only Title', (await sorted(page)) === 'Bravo', await sorted(page))
  await closeAndClear(page)
  ok('all chips cleared: every row back', (await sorted(page)) === ALL, await sorted(page))

  // Time: m:ss range; an unreadable box says so
  box = await openFilter(page, 'Time')
  await box.getByRole('textbox', { name: 'length from' }).fill('0:07')
  await page.waitForTimeout(200)
  ok('Time from 0:07: Bravo and Charlie', (await sorted(page)) === 'Bravo,Charlie', await sorted(page))
  await box.getByRole('textbox', { name: 'length to' }).fill('zz')
  await page.waitForTimeout(150)
  ok('an unreadable box says it is not applied', (await box.textContent())?.includes("Can't read that") ?? false)
  await closeAndClear(page)

  // Played: periods with counts; nothing played yet
  box = await openFilter(page, 'Played')
  const periods = (await box.locator('label').allTextContents()).join(' | ')
  ok('Played: Never played 4, the rest 0', /Never played\s*4/.test(periods) && /Last 24 hours\s*0/.test(periods), periods)
  await box.locator('label', { hasText: 'Last 24 hours' }).locator('input').check()
  await page.waitForTimeout(200)
  ok('Played last 24 hours: none', (await ids(page)) === '', await ids(page))
  // the first run lost the list here: an empty table took the header, and the open ▾, with it
  ok('the ▾ list stays open when nothing is left', (await box.count()) === 1)
  await page.keyboard.press('Escape')
  const text = (await page.locator('body').textContent()) ?? ''
  ok('the empty list names the Played filter', /Played: Last 24 hours/.test(text))
  // review: with the search box empty this fell through to "No audio files found"
  ok('the empty list says the filters left nothing, not that the folder is empty', /No tracks match these filters/.test(text) && !/No audio files found/.test(text))
  await closeAndClear(page)

  // Note: Only "No note" keeps all four (none has a note)
  box = await openFilter(page, 'Note')
  await box.getByRole('radio', { name: /Only "No note"/ }).check()
  await page.waitForTimeout(200)
  ok('Note only empty: all four', (await sorted(page)) === ALL, await sorted(page))
  await closeAndClear(page)

  // Type sorts
  const typeHeader = page.locator('thead th', { hasText: 'Type' }).locator('button').first()
  await typeHeader.click()
  await page.waitForTimeout(200)
  const order = await ids(page)
  ok('Type ▲: MP3 first', order.startsWith('Delta'), order)
  await typeHeader.click()
  await page.waitForTimeout(200)
  ok('Type ▼: MP3 last', (await ids(page)).endsWith('Delta'), await ids(page))

  // Genre ▾ (v0.9.24) still works after the move to the shared component
  await page.getByRole('button', { name: 'Filter by genre', exact: false }).click()
  ok('Genre ▾ still opens', (await page.getByRole('group', { name: 'Genres to show' }).count()) === 1)
  await page.keyboard.press('Escape')
})

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

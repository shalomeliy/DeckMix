/**
 * v0.9.41 verification — artist suggestions. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-artist-suggest.mjs
 *
 * File names from the owner's library (06/10). One track carries its artist in
 * Windows-1255 inside a Latin-1 ID3 frame, the way his one such file does.
 * 1. That artist reads as Hebrew, not "àåùø ëäï".
 * 2. The header counts the tracks with no artist; its view lists only them.
 * 3. Each suggestion says where it came from; a track with no hint gets a box.
 * 4. ✓ keeps the artist (in IndexedDB too), ✕ never offers it again, typing works,
 *    and "✓ all … known" accepts the known ones.
 * 5. After a reload with hashing held back, nothing is offered until the saved
 *    answers are back on the tracks; then ↶ undoes an accepted artist.
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

/** A text frame with its bytes as given — encoding byte 0 (Latin-1), the way Israeli taggers write 1255 Hebrew. */
function rawFrame(id, bytes) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(bytes)])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), payload])
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
function id3Tag(bpm, camelot, artist1255) {
  const frames = Buffer.concat([
    ...(bpm != null ? [id3TextFrame('TBPM', String(bpm))] : []),
    ...(camelot ? [id3TextFrame('TKEY', camelot)] : []),
    ...(artist1255 ? [rawFrame('TPE1', artist1255)] : []),
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frames.length)])
  return Buffer.concat([header, frames])
}
// Distinct sine frequency per track so the WAV bytes (and therefore the
// content hash) actually differ — a "same track on both decks" scenario
// with identical audio would pass even if contentHash matching were broken.
function buildTaggedWav(bpm, camelot, freqHz, { durationSec = 6, sampleRate = 8000, artist1255 } = {}) {
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
  const tag = id3Tag(bpm, camelot, artist1255)
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
      const file = new File([bytes], name, { type: 'audio/wav' });
      // A whole-file read (the hash pass) held back, byte-range reads (tags) not:
      // the order a big real library gives, where tags finish long before hashes.
      if (sessionStorage.getItem('__slowHash')) {
        const whole = file.arrayBuffer.bind(file);
        file.arrayBuffer = () => new Promise((r) => setTimeout(r, 4000)).then(whole);
      }
      return file;
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
  window.__mem = mem;
  // survives a reload, so the next scan can be checked against what was saved
  const savedMeta = sessionStorage.getItem('__trackMeta');
  if (savedMeta) mem.set('deckmix:trackMeta', JSON.parse(savedMeta));
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
            put: (v, k) => { mem.set(k, v); if (k === 'deckmix:trackMeta') sessionStorage.setItem('__trackMeta', JSON.stringify(v)); const r = {}; fire(r, 'onsuccess', undefined); return r; },
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


// "אושר כהן" in Windows-1255
const OSHER_1255 = [0xe0, 0xe5, 0xf9, 0xf8, 0x20, 0xeb, 0xe4, 0xef]
const TRACKS = {
  'Tagged One.wav': buildTaggedWav(128, '8A', 220, { artist1255: OSHER_1255 }),
  'אושר כהן - פלסטרים (Dj Camelion Extended Mix) - 130 BPM.wav': buildTaggedWav(130, '8A', 260),
  'Noa Kirel- Pantera (ERA REDRUM).wav': buildTaggedWav(100, '8A', 300),
  'buzzpsy-rudra-166320.wav': buildTaggedWav(140, '8A', 340),
  'Freed From Desire (FAT TONY REMIX).wav': buildTaggedWav(128, '8A', 380),
}
const row = (page, text) => page.locator('tbody tr', { hasText: text })
const metaArtist = (page, name) =>
  page.evaluate((name) => {
    const meta = window.__mem.get('deckmix:trackMeta') ?? {}
    return Object.values(meta).map((m) => m.artist).filter(Boolean).includes(name)
  }, name)

await scenario('artist suggestions', TRACKS, async (page) => {
  const button = page.getByRole('button', { name: /no artist$/ })
  await button.waitFor({ timeout: 15000 })
  const tagged = (await row(page, 'Tagged One').textContent()) ?? ''
  ok('a 1255 Hebrew artist in a Latin-1 frame reads as Hebrew', tagged.includes('אושר כהן'), tagged)
  ok('the header counts the 4 tracks with no artist', ((await button.textContent()) ?? '').trim() === '4 no artist', await button.textContent())
  ok('the plain list shows no suggestion', (await page.locator('tbody i, tbody .italic').count()) === 0)
  await button.click()
  await page.waitForTimeout(300)
  const strip = (await page.getByText(/with no artist ·/).textContent()) ?? ''
  ok('the strip says 4 missing, 3 suggested, 1 with no hint', /4 with no artist · 3 suggested · 1 with no hint/.test(strip), strip)
  const rows = await page.locator('tbody tr[aria-selected]').count()
  ok('the view lists only the 4 tracks with no artist', rows === 4, String(rows))
  const osher = (await row(page, 'פלסטרים').textContent()) ?? ''
  ok('the Hebrew name is suggested as known (the tag of another track)', osher.includes('אושר כהן') && osher.includes('known'), osher)
  const noa = (await row(page, 'Pantera').textContent()) ?? ''
  ok('"Noa Kirel- Pantera" suggests Noa Kirel, from the file name', noa.includes('Noa Kirel') && noa.includes('file name'), noa)
  const pix = (await row(page, 'buzzpsy').textContent()) ?? ''
  ok('a Pixabay name suggests its uploader', pix.includes('buzzpsy') && pix.includes('Pixabay'), pix)
  ok('the track with no hint gets a box to type into', (await row(page, 'Freed From Desire').getByRole('textbox', { name: 'Type the artist' }).count()) === 1)

  await row(page, 'Pantera').getByRole('button', { name: 'Accept Noa Kirel as the artist' }).click()
  await page.waitForTimeout(500)
  ok('✓ takes the row out of the view and the count down', (await row(page, 'Pantera').count()) === 0 && ((await button.textContent()) ?? '').trim() === '3 no artist', await button.textContent())
  ok('✓ is kept in IndexedDB by content hash', await metaArtist(page, 'Noa Kirel'))

  await row(page, 'buzzpsy').getByRole('button', { name: 'Not buzzpsy' }).click()
  await page.waitForTimeout(500)
  ok('✕ leaves the row, now with a box instead of the rejected name', (await row(page, 'buzzpsy').getByRole('textbox', { name: 'Type the artist' }).count()) === 1 && !(((await row(page, 'buzzpsy').locator('td').nth(1).textContent()) ?? '').includes('Pixabay')))
  const strip2 = (await page.getByText(/with no artist ·/).textContent()) ?? ''
  ok('…and the strip counts it with no hint', /3 with no artist · 1 suggested · 2 with no hint/.test(strip2), strip2)

  const box = row(page, 'Freed From Desire').getByRole('textbox', { name: 'Type the artist' })
  await box.fill('Gala')
  await box.press('Enter')
  await page.waitForTimeout(500)
  ok('typing an artist and Enter keeps it', (await row(page, 'Freed From Desire').count()) === 0 && (await metaArtist(page, 'Gala')))

  await page.getByRole('button', { name: /✓ all 1 known/ }).click()
  await page.waitForTimeout(500)
  ok('"✓ all 1 known" accepts the known suggestion', (await row(page, 'פלסטרים').count()) === 0 && (await metaArtist(page, 'אושר כהן')))

  await page.getByRole('button', { name: /no artist$/ }).click()
  await page.waitForTimeout(300)
  const plain = (await row(page, 'Pantera').textContent()) ?? ''
  ok('back in the plain list the accepted artist is in the Artist column', plain.includes('Noa Kirel'), plain)

  // A fresh scan: the artist has to come back from IndexedDB, not from the page's memory.
  // Hashing held back, so the tags are in long before the saved answers are.
  await page.evaluate(() => sessionStorage.setItem('__slowHash', '1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const after = page.getByRole('button', { name: /no artist$/ })
  await page.waitForTimeout(2500)
  const early = await after.count()
  const tagsIn = ((await row(page, 'Tagged One').textContent()) ?? '').includes('אושר כהן')
  ok('before the saved answers are back, no "no artist" count is offered (tags already read)', early === 0 && tagsIn, `button ${early}, tags ${tagsIn}`)
  await after.waitFor({ timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1000)
  const again = (await row(page, 'Pantera').textContent()) ?? ''
  ok('after a rescan the accepted artist is back', again.includes('Noa Kirel'), again.slice(0, 60))
  const count = ((await after.textContent().catch(() => '')) ?? '').trim()
  ok('after a rescan only the rejected-and-untyped track is missing', count === '1 no artist', count)

  await row(page, 'Pantera').getByRole('button', { name: 'Undo the artist Noa Kirel' }).click()
  await page.waitForTimeout(500)
  const undone = ((await after.textContent().catch(() => '')) ?? '').trim()
  ok('↶ undo takes the artist off the row and out of IndexedDB', undone === '2 no artist' && !(await metaArtist(page, 'Noa Kirel')), undone)
  await after.click()
  await page.waitForTimeout(300)
  const back = (await row(page, 'Pantera').textContent()) ?? ''
  ok('…and the row is back among the suggestions', back.includes('Noa Kirel') && back.includes('file name'), back)

  // v0.9.41b: Settings can turn the whole thing off (Shalom 06/10)
  await page.evaluate(async () => {
    const { settings } = await window.__import('/src/platform/settings-idb/store.ts')
    await settings.set('artistSuggestions', false)
  })
  await page.waitForTimeout(500)
  const offButton = await page.getByRole('button', { name: /no artist$/ }).count()
  const offCells = await page.locator('tbody').getByRole('button', { name: /^Accept / }).count()
  const offStrip = await page.getByText('Artist suggestions').count()
  ok('turned off in Settings: no button, no strip, no suggestions in the rows', offButton === 0 && offCells === 0 && offStrip === 0, `button ${offButton}, cells ${offCells}, strip ${offStrip}`)
  const kept = (await row(page, 'פלסטרים').textContent()) ?? ''
  ok('…and an artist he already accepted stays, with no ↶', kept.includes('אושר כהן') && (await row(page, 'פלסטרים').getByRole('button', { name: /^Undo the artist/ }).count()) === 0, kept.slice(0, 80))
  await page.evaluate(async () => {
    const { settings } = await window.__import('/src/platform/settings-idb/store.ts')
    await settings.set('artistSuggestions', true)
  })
  await page.waitForTimeout(500)
  ok('turned back on, the button is back', (await page.getByRole('button', { name: /no artist$/ }).count()) === 1)
})

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

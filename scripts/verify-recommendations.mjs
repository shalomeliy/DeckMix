/**
 * v0.4.5 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-recommendations.mjs
 *
 * `core/recommend.ts` has real unit tests now (`tests/core/recommend.test.ts`),
 * but whether the library actually renders the right dot on the right row,
 * and how fast it updates when a deck's track changes, is only answerable
 * against the real running app. Same fake-`showDirectoryPicker`/fake-
 * `indexedDB` seam as the other verify scripts.
 *
 * BPM/key need to be exact and known at load time, with no wait for the
 * background analysis queue — so each WAV carries a real ID3v2.3 tag (TBPM +
 * TKEY) inside a RIFF `ID3 ` chunk, read by the same `readChunked`/`readId3`
 * path `tags.ts` already uses for WAV/AIFF (it looks for that chunk *after*
 * the audio payload, which is where DJ software writes it).
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── ID3v2.3 tag, minimal: TBPM + optional TKEY, latin1 text frames ─────────
function syncsafe32(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}

function id3TextFrame(id, value) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]) // encoding 0 = latin1
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0) // v2.3 frame sizes are a plain u32, not syncsafe
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), payload])
}

function id3Tag(bpm, camelot) {
  const frames = Buffer.concat([
    id3TextFrame('TBPM', String(bpm)),
    ...(camelot ? [id3TextFrame('TKEY', camelot)] : []),
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frames.length)])
  return Buffer.concat([header, frames])
}

// ── a short, real, decodable WAV with the ID3 tag appended as its own RIFF chunk ──
function buildTaggedWav(bpm, camelot, { durationSec = 6, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2 // 16-bit mono
  const pcm = Buffer.alloc(dataSize)
  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 2 * i) / sampleRate)), i * 2)
  }

  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2) // mono
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8) // byte rate
  fmt.writeUInt16LE(2, 12) // block align
  fmt.writeUInt16LE(16, 14) // bits per sample

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

// bpm 128 throughout: track fixtures differ only by key, so tempo alone never
// explains a match/no-match result — only the key relationship does.
const TRACKS = {
  'Deck A Track.wav': buildTaggedWav(128, '8A'),
  'Compatible.wav': buildTaggedWav(128, '9A'), // one step up the wheel from 8A -> compatible
  'Clashing.wav': buildTaggedWav(128, '2A'), // six steps away -> not compatible
  'Swap Target.wav': buildTaggedWav(128, '9A'),
}

function harness(tracks) {
  const files = Object.fromEntries(
    Object.entries(tracks).map(([name, buf]) => [name, buf.toString('base64')]),
  )
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const files = ${JSON.stringify(files)};
  const makeFile = (name) => ({
    kind: 'file',
    name,
    getFile: async () => {
      const bytes = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
      return new File([bytes], name, { type: 'audio/wav' });
    },
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      for (const n of Object.keys(files)) yield [n, makeFile(n)];
    },
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
  await page.waitForTimeout(1000) // let the folder-pick + tag pass settle
  try {
    await check(page, errors)
    ok(`${name}: no console errors`, errors.length === 0, errors[0])
  } finally {
    await page.close()
  }
}

// Case-sensitive on purpose: the string form of `hasText` is case-insensitive,
// and "Compatible" (a track name) is a substring of "key compatible" (another
// row's own match-reason text, lowercase) — a plain string filter for
// "Compatible" matched both rows. A regex with no `i` flag doesn't.
const row = (page, text) => page.locator('tbody tr', { hasText: new RegExp(text) })
const matchDot = (row) => row.locator('[title^="Mixes with deck"]')

async function loadAndPlayDeckA(page, trackName) {
  await row(page, trackName).dblclick()
  await page.waitForTimeout(200)
  await page.keyboard.press('KeyQ') // play deck A
  await page.waitForTimeout(300)
}

// 1. a track excluded from its own recommendations, once loaded+playing
await scenario('self-exclusion', TRACKS, async (page) => {
  await loadAndPlayDeckA(page, 'Deck A Track')
  const own = matchDot(row(page, 'Deck A Track'))
  ok('own track on deck carries no match dot', (await own.count()) === 0)
})

// 2. a compatible track renders a strong match: bold title + filled dot
await scenario('strong match renders', TRACKS, async (page) => {
  await loadAndPlayDeckA(page, 'Deck A Track')
  const r = row(page, 'Compatible')
  const cellClass = (await r.locator('td').first().getAttribute('class')) ?? ''
  ok('compatible: title cell is bold', /font-bold/.test(cellClass), cellClass)
  const dot = matchDot(r)
  ok('compatible: exactly one match dot, deck A', (await dot.count()) === 1)
  const title = (await dot.getAttribute('title')) ?? ''
  ok('compatible: reason says key compatible', title.includes('key compatible'), title)

  // "Swap Target.wav" has a space in its name — aria-describedby's value is a
  // whitespace-separated IDREF list, so a raw filename in the id/describedby
  // pair would silently break the association for a real file (almost every
  // real filename has a space). This is the regression check for that.
  const swapRow = row(page, 'Swap Target')
  const describedBy = await swapRow.getAttribute('aria-describedby')
  ok(
    'space-in-filename: aria-describedby has no embedded whitespace',
    !!describedBy && !/\s/.test(describedBy),
    describedBy ?? '(none)',
  )
  const resolved = await page.evaluate((id) => document.getElementById(id)?.textContent, describedBy)
  const swapDotTitle = await matchDot(swapRow).getAttribute('title')
  ok(
    'space-in-filename: aria-describedby actually resolves to the match reason',
    resolved === swapDotTitle && !!resolved,
    `resolved="${resolved}" title="${swapDotTitle}"`,
  )
})

// 3. a clashing-key track renders a loose match: not bold, dot present, reason says clash
await scenario('loose match renders', TRACKS, async (page) => {
  await loadAndPlayDeckA(page, 'Deck A Track')
  const r = row(page, 'Clashing')
  const cellClass = (await r.locator('td').first().getAttribute('class')) ?? ''
  ok('clashing: title cell is not bold', !/font-bold/.test(cellClass), cellClass)
  const dot = matchDot(r)
  const title = (await dot.getAttribute('title')) ?? ''
  ok('clashing: reason says key clashes', title.includes('key clashes'), title)
})

// 4. once a swapped-in track is actually loaded, the highlight set reacts in
// well under 100ms. Measured strictly between "deck A's displayed track name
// changed" and "the recommendation set caught up" — both observed with a
// single in-page MutationObserver, so the number is real render latency, not
// decode/load time (loading the audio itself is a separate, much slower,
// unrelated pipeline this version never claimed to speed up).
await scenario('deck-swap update latency', TRACKS, async (page) => {
  // "Lock the deck that is playing" defaults on (core/settings.ts) and
  // refuses exactly the load this scenario needs to trigger — turn it off
  // first, same Settings-screen interaction verify-cues.mjs's scenario 3
  // already uses for a different field.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Feel', exact: true }).click()
  const lockLabel = page.getByText('Lock the deck that is playing', { exact: true })
  await lockLabel.locator('xpath=ancestor::div[contains(@class,"rounded-")][1]').locator('input[type=checkbox]').uncheck()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)

  await loadAndPlayDeckA(page, 'Deck A Track')
  // Before the swap, "Swap Target" (128 BPM, 9A) mixes with the playing
  // 128/8A deck — it should carry a dot.
  ok('before swap: Swap Target already shows a match', (await matchDot(row(page, 'Swap Target')).count()) === 1)

  const [elapsed] = await Promise.all([
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const nameEl = document
            .querySelectorAll('section')[0]
            ?.querySelector('div.truncate.text-base.font-semibold')
          let t1 = null
          const timeout = setTimeout(() => {
            obs.disconnect()
            reject(new Error('timed out waiting for deck-swap + highlight update'))
          }, 5000)
          const obs = new MutationObserver(() => {
            if (t1 === null && nameEl?.textContent?.includes('Swap Target')) t1 = performance.now()
            if (t1 !== null) {
              const swapRow = [...document.querySelectorAll('tbody tr')].find((r) =>
                r.textContent?.includes('Swap Target'),
              )
              if (swapRow && !swapRow.querySelector('[title^="Mixes with deck"]')) {
                clearTimeout(timeout)
                obs.disconnect()
                resolve(performance.now() - t1)
              }
            }
          })
          obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
        }),
    ),
    row(page, 'Swap Target').dblclick(), // triggers the load; the observer above times the reaction to it
  ])
  console.log(`  measured: ${elapsed.toFixed(1)}ms from deck-swap taking effect to highlight-set update`)
  ok('deck swap updates highlights in under 100ms', elapsed < 100, `${elapsed.toFixed(1)}ms`)
})

// 5. a deck playing with nothing else in the library to recommend shows an
// explicit "no mixable tracks" label instead of the header control vanishing
await scenario('zero-state label', { 'Solo Track.wav': buildTaggedWav(128, '8A') }, async (page) => {
  await loadAndPlayDeckA(page, 'Solo Track')
  const zeroLabel = page.getByText('♫ no mixable tracks', { exact: true })
  ok('zero matches: explicit label is shown', (await zeroLabel.count()) > 0)
  const anyDot = matchDot(page.locator('tbody tr'))
  ok('zero matches: sanity check, no row actually carries a match dot', (await anyDot.count()) === 0)
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

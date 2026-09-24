/**
 * v0.4.0 step 6 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-cues.mjs
 *
 * `tests/core/hotcues.test.ts` covers the pure `moveHotCue` reducer, but
 * whether a hot cue and the CUE point actually survive a real page reload —
 * the acceptance criterion this whole sub-step exists for — is only
 * answerable with a real IndexedDB and a real decoded track. Same seam as
 * `verify-library-boot.mjs`: `showDirectoryPicker` and `indexedDB` are
 * replaced with an in-page fake; everything above those two is the real app.
 *
 * A tiny synthetic WAV (silence) stands in for a real track — `decodeAudioData`
 * only needs a valid header, and cue persistence doesn't depend on content.
 * Its exact bytes are hashed with Node's own SHA-256 up front so the seeded
 * `cues-idb` entry is planted under the *same* content-hash the app will
 * compute for it — this is what proves the identity-keyed lookup itself
 * works, not just that some cues render somewhere.
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── build one small, real, decodable WAV file (silence) ─────────────────────
function makeWav(durationSec, sampleRate) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2 // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  // Bytes past the header stay zero (silence) — decode + analysis both
  // tolerate silence, and cue persistence doesn't depend on content.
  return Buffer.from(buf)
}

const SAMPLE_RATE = 8000
const DURATION_SEC = 6
const wavBytes = makeWav(DURATION_SEC, SAMPLE_RATE)
const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
const WAV_BASE64 = wavBytes.toString('base64')

const SEEDED_CUE_POINT_SEC = 3
const SEEDED_HOT_CUE = { index: 0, positionSec: 4, label: '1', color: '#ff0055' }

function harness({ seedCues } = {}) {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const base64 = ${JSON.stringify(WAV_BASE64)};
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const makeFile = (name) => ({
    kind: 'file',
    name,
    getFile: async () => new File([bytes], name, { type: 'audio/wav' }),
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      yield ['silence.wav', makeFile('silence.wav')];
    },
  });

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => makeDir('Tracks'),
  });

  // --- IndexedDB shim: idb-keyval's default store, one key per record ---
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  ${
    seedCues
      ? `mem.set(${JSON.stringify('deckmix:cues:' + CONTENT_HASH)}, ${JSON.stringify({
          hotCues: [SEEDED_HOT_CUE],
          cuePointSec: SEEDED_CUE_POINT_SEC,
        })});`
      : ''
  }
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          transaction: () => {
            const tx = {};
            tx.objectStore = () => ({
              transaction: tx,
              get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
              put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; },
            });
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
            return tx;
          },
        };
        req.result = db;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } });

  // Reads back what got written to 'deckmix:cues:<hash>', for the test to
  // assert on directly rather than guessing at DOM text.
  window.__readCues = () => mem.get(${JSON.stringify('deckmix:cues:' + CONTENT_HASH)});
})()`
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
})

async function scenario(name, opts, check) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(opts))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  try {
    await check(page, errors)
  } finally {
    await page.close()
  }
}

const loadFirstTrackToDeckA = async (page) => {
  await page.locator('tbody tr').first().dblclick()
  await page.waitForTimeout(600)
}

// `<Deck deckId="A" />` is the first of the two decks in `App.tsx`
// (`main > Deck A, Mixer, Deck B`), and each is the only `<section>`
// ancestor of its own controls — so `section >> nth=0` scopes every locator
// below to deck A alone, never deck B's identical pad grid/readout.
const deckA = (page) => page.locator('section').nth(0)
const positionText = (page) =>
  deckA(page)
    .locator('[class="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted"]')
    .locator('span')
    .nth(2)
    .innerText()

// 1. no cues saved yet — a fresh track loads with an empty bank and CUE at 0
await scenario('fresh track', { seedCues: false }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const label = await deckA(page)
    .getByRole('button', { name: /Set hot cue 1|Jump to hot cue 1/ })
    .getAttribute('aria-label')
  ok('fresh: pad 1 starts empty', label === 'Set hot cue 1', label)
  const pos = await positionText(page)
  ok('fresh: playhead starts at 0:00', pos === '0:00', pos)
  ok('fresh: no console errors', errors.length === 0, errors[0])
})

// 2. a saved hot cue + CUE point restore the moment the same track loads
await scenario('restore on load', { seedCues: true }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const label = await deckA(page)
    .getByRole('button', { name: /Set hot cue 1|Jump to hot cue 1/ })
    .getAttribute('aria-label')
  ok('restore: pad 1 shows the restored hot cue', label === 'Jump to hot cue 1', label)

  // Default "On track load" is Start — a restored CUE point is remembered
  // in state (proven below) but must not silently move the playhead on its
  // own; only the "First cue point" setting (scenario 3) does that.
  const posOnLoad = await positionText(page)
  ok('restore: default Start setting still parks at 0:00 despite a saved cue', posOnLoad === '0:00', posOnLoad)

  // Jumping to the restored pad should land exactly where it was saved (4s).
  await deckA(page).getByRole('button', { name: 'Jump to hot cue 1' }).click()
  await page.waitForTimeout(150)
  const atHotCue = await positionText(page)
  ok('restore: jumping to the pad lands at the saved position (0:04)', atHotCue === '0:04', atHotCue)

  // KeyA is the keyboard CUE control (App.tsx) — while playing it pauses and
  // jumps to the stored cuePointSec, independent of the mouse hold-preview
  // gesture on the on-screen button.
  await page.keyboard.press('KeyQ') // play
  await page.waitForTimeout(120)
  await page.keyboard.press('KeyA') // cue: playing -> pause + seek to cuePointSec
  await page.waitForTimeout(150)
  const atCuePoint = await positionText(page)
  ok('restore: CUE jumps to the saved cue point (0:03)', atCuePoint === '0:03', atCuePoint)
  ok('restore: no console errors', errors.length === 0, errors[0])
})

// 3. Settings > On track load > First cue point actually seeks there on load
await scenario('onLoadPlayhead firstCue', { seedCues: true }, async (page, errors) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Feel', exact: true }).click()
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'First cue point' }) })
  await select.selectOption('firstCue')
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape') // close panel
  await page.waitForTimeout(100)

  await loadFirstTrackToDeckA(page)
  const atCuePoint = await positionText(page)
  ok('firstCue: track loads already parked at the saved cue point (0:03)', atCuePoint === '0:03', atCuePoint)
  ok('firstCue: no console errors', errors.length === 0, errors[0])
})

// 4. deleting a hot cue persists too — restoring a fresh deck load shows it gone
await scenario('delete persists', { seedCues: true }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  await deckA(page).getByRole('button', { name: 'Jump to hot cue 1' }).click({ modifiers: ['Shift'] })
  await page.waitForTimeout(150)
  const stored = await page.evaluate(() => window.__readCues())
  ok('delete: cues-idb no longer carries the deleted pad', (stored?.hotCues ?? []).length === 0,
    JSON.stringify(stored))
  ok('delete: no console errors', errors.length === 0, errors[0])
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

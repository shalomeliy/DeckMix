/**
 * v0.8.6 smoke check for the "FX beat-synced time doesn't follow SYNC/master
 * changes" debt (HANDOFF.md). `refreshFxTimeForMasterTempo` recomputes each
 * FX rack's beat time from `masterPlayingBpm()`, and was only ever called
 * from `setTempo` — this version adds the same call inside `syncDeck` (first
 * SYNC press, before any master existed) and `setMasterDeck` (master
 * reassigned). There is no DOM-visible readout of the computed seconds value
 * (the FX strip shows the beat *fraction*, e.g. "1/4", never the resolved
 * ms) — a synthetic mono WAV has no Web Audio Analyser signal worth reading
 * either. So unlike verify-cues.mjs/verify-tempo-persistence.mjs, this
 * cannot assert the actual number; what it proves is that both new call
 * sites run for real, against real deck/FX state, without throwing — the
 * concrete risk for a fix that is two added function calls, not new logic.
 *
 *   npm i -D playwright && node scripts/verify-fx-master-sync.mjs
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function makeWav(durationSec, sampleRate) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2
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
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  return Buffer.from(buf)
}

const SAMPLE_RATE = 8000
const WAV_A = makeWav(6, SAMPLE_RATE).toString('base64')

const harness = `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const makeFile = (name, b64) => ({
    kind: 'file',
    name,
    getFile: async () => new File([toBytes(b64)], name, { type: 'audio/wav' }),
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      yield ['track-a.wav', makeFile('track-a.wav', ${JSON.stringify(WAV_A)})];
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)

const deckSection = (page, i) => page.locator('section').nth(i)
const rows = page.locator('tbody tr')

// A double-click loads onto deck A (same convention verify-cues.mjs uses).
// Loading a second track onto deck B needs real drag-and-drop, which isn't
// worth scripting for a smoke check — with only deck A loaded, tapping SYNC
// exercises `syncDeck`'s "no master exists yet" guard/first-press path (the
// fix's first call site) without ever finding another deck to sync to, and
// long-pressing it still promotes deck A to master for real, exercising
// `setMasterDeck` (the fix's second call site) regardless of what deck B holds.
await rows.nth(0).dblclick()
await page.waitForTimeout(500)
ok('deck A loaded, no console errors yet', errors.length === 0, errors[0])

const syncButtonA = deckSection(page, 0).getByRole('button', { name: 'Sync' })

// Deck A alone has no "other" deck with a track, so a tap notices and
// refuses via a notice — still a real call into syncDeck's guarded path.
await syncButtonA.click()
await page.waitForTimeout(200)
ok('tap SYNC on the only loaded deck does not throw', errors.length === 0, errors[0])

// Long-press promotes deck A to master — this is `setMasterDeck`'s new
// `refreshFxTimeForMasterTempo()` call site, exercised for real.
await syncButtonA.dispatchEvent('pointerdown')
await page.waitForTimeout(650) // LONG_PRESS_MS + margin
await syncButtonA.dispatchEvent('pointerup')
await page.waitForTimeout(200)
ok('long-press SYNC (setMasterDeck) does not throw', errors.length === 0, errors[0])

const unhandled = await page.evaluate(() => window.__unhandled)
ok('no unhandled promise rejections', unhandled.length === 0, JSON.stringify(unhandled))

await page.close()
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

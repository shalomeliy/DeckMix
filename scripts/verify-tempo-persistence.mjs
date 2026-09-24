/**
 * v0.8.6 browser verification for the "no persistence for tempo between
 * loads" debt (HANDOFF.md). Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-tempo-persistence.mjs
 *
 * Same seam as `verify-cues.mjs`: `showDirectoryPicker` and `indexedDB` are
 * replaced with an in-page fake keyed by the same content-hash the app
 * computes for a tiny synthetic WAV, so this proves the identity-keyed
 * `tempo-idb` lookup itself works, not just that some number renders.
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

// ── build one small, real, decodable WAV file (silence) — same maker as verify-cues.mjs ──
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
const DURATION_SEC = 6
const wavBytes = makeWav(DURATION_SEC, SAMPLE_RATE)
const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
const WAV_BASE64 = wavBytes.toString('base64')
const SEEDED_TEMPO = 0.25
const TEMPO_KEY = 'deckmix:tempo2:' + CONTENT_HASH

function harness({ seedTempo } = {}) {
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

  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  ${seedTempo ? `mem.set(${JSON.stringify(TEMPO_KEY)}, ${SEEDED_TEMPO});` : ''}
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

  window.__readTempo = () => mem.get(${JSON.stringify(TEMPO_KEY)});
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

const deckA = (page) => page.locator('section').nth(0)
const tempoSlider = (page) => deckA(page).getByRole('slider', { name: 'Tempo' })

// 1. no stored tempo — a fresh track loads with the fader at 0 (untouched), not reset elsewhere
await scenario('fresh track', { seedTempo: false }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const now = await tempoSlider(page).getAttribute('aria-valuenow')
  ok('fresh: tempo starts at 0', Number(now) === 0, now)
  ok('fresh: no console errors', errors.length === 0, errors[0])
})

// 2. a saved tempo restores the moment the same track (by content hash) loads
await scenario('restore on load', { seedTempo: true }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const now = await tempoSlider(page).getAttribute('aria-valuenow')
  ok(`restore: tempo comes back at the saved value (${SEEDED_TEMPO})`, Math.abs(Number(now) - SEEDED_TEMPO) < 1e-6, now)
  ok('restore: no console errors', errors.length === 0, errors[0])
})

// 3. touching the fader schedules a debounced write, keyed by this track's content hash
await scenario('touch persists', { seedTempo: false }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  await tempoSlider(page).click()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(700) // > the 400ms debounce
  const stored = await page.evaluate(() => window.__readTempo())
  ok('touch: tempo-idb now carries a value close to what the fader shows', typeof stored === 'number' && stored > 0, stored)
  const now = await tempoSlider(page).getAttribute('aria-valuenow')
  ok('touch: stored value matches the fader readout', Math.abs(stored - Number(now)) < 1e-6, `stored=${stored} shown=${now}`)
  ok('touch: no console errors', errors.length === 0, errors[0])
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

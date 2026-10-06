/**
 * v0.8.6 browser verification for the "no persistence for tempo between
 * loads" debt (HANDOFF.md). v0.9.46: a tempo is kept only when the owner
 * presses "Save tempo" — moving the fader alone saves nothing (Shalom, 06/10),
 * and what v0.8.6–v0.9.45 saved on its own (`tempo2`) is not restored. Run against `npm run dev` on :5173:
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
const TEMPO_KEY = 'deckmix:tempo3:' + CONTENT_HASH
const OLD_TEMPO_KEY = 'deckmix:tempo2:' + CONTENT_HASH

function harness({ seedTempo, seedOld } = {}) {
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
  ${seedOld ? `mem.set(${JSON.stringify(OLD_TEMPO_KEY)}, ${SEEDED_TEMPO});` : ''}
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
              delete: (k) => { mem.delete(k); const r = {}; fire(r, 'onsuccess', undefined); return r; },
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
  window.__hasTempo = () => mem.has(${JSON.stringify(TEMPO_KEY)});
  window.__import = (path) => {
    const loaded = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(loaded ?? path);
  };
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

const notice = (page) => page.evaluate(async () => (await window.__import('/src/app/state/store.ts')).useStore.getState().notice?.text ?? '')
const saveButton = (page) => deckA(page).getByRole('button', { name: 'Save tempo' })

// 2b. a restored tempo is said on screen, never a silent offset
await scenario('restore is said', { seedTempo: true }, async (page) => {
  await loadFirstTrackToDeckA(page)
  ok('restore: the screen says the track starts at its saved tempo', /starts at \+2\.0% — the tempo you saved/.test(await notice(page)), await notice(page))
})

// 3. v0.9.46: what the fader saved on its own before is not restored
await scenario('old auto-saved tempo', { seedOld: true }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const now = await tempoSlider(page).getAttribute('aria-valuenow')
  ok('old auto-saved tempo (tempo2): ignored, the track loads at its own speed', Number(now) === 0, now)
  ok('old: no console errors', errors.length === 0, errors[0])
})

// 4. moving the fader saves nothing; "Save tempo" saves; "Forget tempo" at 0 removes it
await scenario('save only on request', { seedTempo: false }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  ok('untouched: no Save tempo button', (await saveButton(page).count()) === 0)
  await tempoSlider(page).click()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(700) // longer than the old 400ms debounce
  ok('touch: nothing is stored by moving the fader', (await page.evaluate(() => window.__hasTempo())) === false)
  ok('touch: the Save tempo button appears', (await saveButton(page).count()) === 1)
  const box = await saveButton(page).boundingBox()
  const sec = await saveButton(page).locator('xpath=ancestor::section[1]').boundingBox()
  await page.screenshot({ path: process.env.SHOT || '/tmp/save-tempo.png' })
  const fits = await saveButton(page).evaluate((b) => { const s = b.closest('section'); return { inside: s.scrollHeight <= s.clientHeight + 1, sh: s.scrollHeight, ch: s.clientHeight } })
  ok('the button sits inside the deck, which does not grow', box && sec && box.x >= sec.x && box.x + box.width <= sec.x + sec.width && fits.inside, JSON.stringify({ box, sec, fits }))
  await saveButton(page).click()
  await page.waitForTimeout(300)
  const stored = await page.evaluate(() => window.__readTempo())
  const now = await tempoSlider(page).getAttribute('aria-valuenow')
  ok('Save tempo: stored, equal to the fader', typeof stored === 'number' && Math.abs(stored - Number(now)) < 1e-6, `stored=${stored} shown=${now}`)
  ok('Save tempo: said on screen', /will start at \+1\.6% every time it loads/.test(await notice(page)), await notice(page))
  ok('saved: the button goes away', (await saveButton(page).count()) === 0)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).setTempo('A', 0))
  await deckA(page).getByRole('button', { name: 'Forget tempo' }).click()
  await page.waitForTimeout(300)
  ok('Forget tempo at 0: the record is gone', (await page.evaluate(() => window.__hasTempo())) === false)
  // SYNC's number belongs to the pairing: refused, said, nothing stored
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    useStore.getState().patchDeck('A', { tempo: 0.5, syncActive: true })
  })
  ok('synced: no Save tempo button', (await saveButton(page).count()) === 0)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).saveDeckTempo('A'))
  await page.waitForTimeout(200)
  ok('synced: saving is refused and said', (await page.evaluate(() => window.__hasTempo())) === false && /came from SYNC/.test(await notice(page)), await notice(page))
  // A mix leaves the incoming deck unsynced at the other song's speed (finishTransition, a released SYNC): still not a hand's number.
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).setTempo('A', 0.5, { byHand: false }))
  ok('left at a mix speed, unsynced: no Save tempo button', (await saveButton(page).count()) === 0)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).saveDeckTempo('A'))
  await page.waitForTimeout(200)
  ok('left at a mix speed: saving is refused and said', (await page.evaluate(() => window.__hasTempo())) === false && /SYNC or the mix/.test(await notice(page)), await notice(page))
  ok('save: no console errors', errors.length === 0, errors[0])
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

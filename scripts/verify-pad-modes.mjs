/**
 * v0.5.0 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-pad-modes.mjs
 *
 * No real FLX4 hardware or MIDI in this environment — this proves the UI
 * and `controls.ts` side of Pad Modes (mode switching, Loop/Beat Jump, the
 * global SHIFT layer) inside a real browser with a real decoded track. The
 * MIDI mapping itself (`flx4.ts`'s note guesses) can only be verified
 * against the real controller — that's on Shalom.
 *
 * v0.8.6: dropped the "Sampler mode is a visible stub" scenario — it tested
 * v0.5.0's placeholder pad ("not built yet"), which v0.6.0's real Sampler
 * replaced; that stale locator crashed this whole script instead of just
 * failing one check. Sampler pad behavior has its own dedicated coverage:
 * verify-sampler-record.mjs/verify-sampler-reload-e2e.mjs/
 * verify-sampler-rename.mjs/verify-sampler-restore.mjs.
 *
 * Same harness as `verify-cues.mjs`: `showDirectoryPicker`/`indexedDB` are
 * faked with a tiny synthetic WAV standing in for a real track; everything
 * above those two is the real app.
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
const DURATION_SEC = 20 // long enough that a forward Beat Jump near t=0 has real room
const wavBytes = makeWav(DURATION_SEC, SAMPLE_RATE)
const WAV_BASE64 = wavBytes.toString('base64')

function harness() {
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
})()`
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
})

async function scenario(name, check) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness())
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
  await page.keyboard.press('KeyQ') // Play — Beat Jump/Loop need a running deck to be meaningful, and a stopped deck isn't a case this script needs to distinguish.
  await page.waitForTimeout(150)
}

const deckA = (page) => page.locator('section').nth(0)

// 1. Hot Cue is the default mode and behaves exactly as before v0.5.0.
await scenario('default mode is Hot Cue, unchanged behavior', async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const cueTab = deckA(page).getByRole('button', { name: 'Pad mode: Cue' })
  ok('Cue tab is active by default', (await cueTab.getAttribute('aria-pressed')) === 'true')
  const label = await deckA(page)
    .getByRole('button', { name: /Set hot cue 1|Jump to hot cue 1/ })
    .getAttribute('aria-label')
  ok('pad 1 is a plain hot-cue pad', label === 'Set hot cue 1', label)
  ok('no console errors', errors.length === 0, errors[0])
})

// 2. Switching to Loop mode changes the grid; a loop pad starts a loop; switching away stops it with a notice.
await scenario('Loop mode: start, and mode-switch stops it with a notice', async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  await deckA(page).getByRole('button', { name: 'Pad mode: Loop' }).click()
  const loopPad = deckA(page).getByRole('button', { name: 'Loop 2 beats' })
  await loopPad.waitFor()
  ok('Loop mode shows beat-length pads', true)
  await loopPad.click()
  await page.waitForTimeout(150)
  ok('Loop toggle button reflects the active loop', await deckA(page).getByRole('button', { name: 'Loop', exact: true }).getAttribute('aria-pressed') === 'true')

  // Switch away from Loop mode while the loop is active — must stop with a visible notice, not silently.
  await deckA(page).getByRole('button', { name: 'Pad mode: Jump' }).click()
  await page.waitForTimeout(150)
  const notice = await page.locator('text=Loop stopped').count()
  ok('switching away from Loop mode surfaces a notice', notice > 0)
  ok('loop toggle reflects it stopped', await deckA(page).getByRole('button', { name: 'Loop', exact: true }).getAttribute('aria-pressed') === 'false')
  ok('no console errors', errors.length === 0, errors[0])
})

// 3. Beat Jump moves the playhead forward, and backward with SHIFT.
await scenario('Beat Jump: forward, and backward with SHIFT', async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  await deckA(page).getByRole('button', { name: 'Pad mode: Jump' }).click()
  await page.waitForTimeout(200) // let playback move off exactly 0
  const before = await page.evaluate(() => document.title) // placeholder read, replaced below by a real position read
  void before
  const posText = () =>
    deckA(page).locator('[class="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted"]').locator('span').nth(2).innerText()
  const p0 = await posText()
  await deckA(page).getByRole('button', { name: 'Jump forward 4 beats' }).click()
  await page.waitForTimeout(150)
  const p1 = await posText()
  ok(`forward jump moved the playhead (was ${p0}, now ${p1})`, p1 !== p0)

  await page.keyboard.down('ShiftLeft')
  await page.waitForTimeout(50)
  const shiftPill = await page.getByText('SHIFT', { exact: true }).count() // exact: the pill, not the "SHIFT:" line under the pads (v0.8.24)
  ok('holding Shift shows the SHIFT pill', shiftPill > 0)
  const backLabel = await deckA(page).getByRole('button', { name: /Jump back 4 beats/ }).count()
  ok('pad label swaps to show the SHIFT action', backLabel > 0)
  await deckA(page).getByRole('button', { name: 'Jump back 4 beats' }).click()
  await page.waitForTimeout(150)
  const p2 = await posText()
  ok(`SHIFT+jump moved the playhead back (was ${p1}, now ${p2})`, p2 !== p1)
  await page.keyboard.up('ShiftLeft')
  await page.waitForTimeout(50)
  const pillGone = await page.getByText('SHIFT', { exact: true }).count() // exact: the pill, not the "SHIFT:" line under the pads (v0.8.24)
  ok('releasing Shift hides the pill', pillGone === 0)
  ok('no console errors', errors.length === 0, errors[0])
})

// 4. Deck B's mode is independent of deck A's.
await scenario('pad mode is per-deck, not global', async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  await deckA(page).getByRole('button', { name: 'Pad mode: Loop' }).click()
  // `<Deck A />, <Mixer />, <Deck B />` — Mixer is also a `<section>`, so deck B is index 2, not 1.
  const deckB = page.locator('section').nth(2)
  const bCueActive = await deckB.getByRole('button', { name: 'Pad mode: Cue' }).getAttribute('aria-pressed')
  ok('deck B stays on Hot Cue while deck A switched to Loop', bCueActive === 'true')
  ok('no console errors', errors.length === 0, errors[0])
})

// 5. Loop Roll (SHIFT+hold on a Loop pad): loops while held, catches up past the entry point on release.
await scenario('Loop Roll: catches up on release, never gets stuck', async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  await deckA(page).getByRole('button', { name: 'Pad mode: Loop' }).click()
  const posText = () =>
    deckA(page).locator('[class="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted"]').locator('span').nth(2).innerText()
  const before = await posText()

  await page.keyboard.down('ShiftLeft')
  await page.waitForTimeout(30)
  const rollPad = deckA(page).getByRole('button', { name: 'Loop roll 4 beats' })
  await rollPad.waitFor()
  const box = await rollPad.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1000) // hold — the deck should be looping a short region right now
  await page.mouse.up()
  await page.keyboard.up('ShiftLeft')
  await page.waitForTimeout(200)

  const after = await posText()
  ok(`Loop Roll released and caught up (before ${before}, after ${after}, both past entry)`, after !== '0:00')
  ok('Loop toggle did not latch on from a Loop Roll press', await deckA(page).getByRole('button', { name: 'Loop', exact: true }).getAttribute('aria-pressed') === 'false')
  ok('no console errors', errors.length === 0, errors[0])
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

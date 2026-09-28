/**
 * v0.8.23 verification — the two grid bugs the owner found on 24/09. Run
 * against `npm run dev` on :5173:
 *
 *   node scripts/verify-grid-correction.mjs
 *
 * 1. "Set downbeat here" on beat 3 must put the yellow (bar) line on beat 3.
 *    Until v0.8.23 the mark was folded into one *beat*, so the line went back
 *    to wherever beat 1 had been.
 * 2. A hand-fixed grid must come back when the same track loads again. Until
 *    v0.8.23 it lived only in the deck's state.
 * 3. A saved record that can't be used is said on screen, not silently
 *    replaced by the detected grid.
 * 4. (v0.12.4) Closing the grid panel over an *unconfirmed* grid — "I checked
 *    it" — is saved too, and the pill stays gone at the next load. Until then
 *    it changed only the screen. Closing it over a trusted grid saves nothing,
 *    and only the ✕ counts — a click elsewhere just closes it (4b).
 *
 * The track is a real, decodable WAV with a click every half second (120 bpm)
 * and a TBPM tag, so the real analysis runs and lands a real grid. IndexedDB
 * is an in-memory stand-in (same one `verify-tempo-persistence.mjs` uses), so
 * the "reload" is a new page seeded with exactly what the first one saved.
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function syncsafe32(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}
function id3Tag(bpm) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(String(bpm), 'latin1')])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  const frame = Buffer.concat([Buffer.from('TBPM', 'ascii'), size, Buffer.from([0, 0]), payload])
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frame.length), frame])
}
function buildClickWav(bpm, { durationSec = 20, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const pcm = Buffer.alloc(numSamples * 2)
  const beatSamples = Math.round((60 / bpm) * sampleRate)
  for (let i = 0; i < numSamples; i++) {
    const inBeat = i % beatSamples
    const v = inBeat < 80 ? 20000 * Math.exp(-inBeat / 15) * (inBeat % 2 ? 1 : -1) : 0
    pcm.writeInt16LE(Math.round(v), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const tag = id3Tag(bpm)
  const tagPadded = tag.length % 2 === 0 ? tag : Buffer.concat([tag, Buffer.from([0])])
  const chunk = (id, body) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', pcm), chunk('ID3 ', tagPadded)])
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body])
}

const wavBytes = buildClickWav(120)
const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
const GRID_KEY = 'deckmix:gridCorrection:' + CONTENT_HASH

function harness(seed) {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const bytes = Uint8Array.from(atob(${JSON.stringify(wavBytes.toString('base64'))}), (c) => c.charCodeAt(0));
  const makeFile = (name) => ({ kind: 'file', name, getFile: async () => new File([bytes], name, { type: 'audio/wav' }) });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { yield ['clicks.wav', makeFile('clicks.wav')]; },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  ${seed !== undefined ? `mem.set(${JSON.stringify(GRID_KEY)}, ${JSON.stringify(seed)});` : ''}
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
  // The app's own module instance, not a second copy: Vite serves a file
  // edited since the dev server started as \`store.ts?t=…\`, and a plain
  // import('/src/app/state/store.ts') would get a fresh, empty store.
  window.__import = (path) => {
    const loaded = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(loaded ?? path);
  };
  window.__readGrid = () => mem.get(${JSON.stringify(GRID_KEY)});
})()`
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })

// 0. an edit made while the deck is still analysing is refused out loud, and
//    nothing is saved — it would be built on the tag's rounded bpm with no
//    detected phase, then win over the real analysis on every later load.
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.addInitScript(harness(undefined))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.locator('tbody tr').first().dblclick()
  let tried = null
  for (let i = 0; i < 200 && !tried; i++) {
    tried = await page.evaluate(async () => {
      const { useStore } = await window.__import('/src/app/state/store.ts')
      const d = useStore.getState().decks.A
      if (!d.track || d.loading || d.beatGrid) return null
      ;(await window.__import('/src/controls.ts')).setDownbeatHere('A')
      return { notice: useStore.getState().notice?.text ?? null, grid: useStore.getState().decks.A.beatGrid }
    })
    if (!tried) await page.waitForTimeout(10)
  }
  if (tried) {
    ok('during analysis: set downbeat is refused with a notice', /still analysing/.test(tried.notice ?? ''), tried.notice)
    ok('during analysis: nothing saved', (await page.evaluate(() => window.__readGrid())) === undefined)
  } else {
    console.log('SKIP  during analysis: the analysis finished before the window could be caught')
  }
  await page.close()
}

async function scenario(seed, check) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(seed))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  try {
    await page.locator('tbody tr').first().dblclick()
    // wait for the deck's own analysis to land — the grid is null until then.
    // Not `analysisState`: the library's background pass can already have
    // stamped the track 'analyzed' before the deck's pass has finished.
    // A polled loop, not `waitForFunction`: its predicate can't be async — an
    // async one returns a Promise, which is truthy, so it "passes" at once.
    for (let i = 0; i < 60; i++) {
      const has = await page.evaluate(async () => {
        const { useStore } = await window.__import('/src/app/state/store.ts')
        return useStore.getState().decks.A.beatGrid != null
      })
      if (has) break
      await page.waitForTimeout(250)
    }
    await check(page, errors)
  } finally {
    await page.close()
  }
}

const deckGrid = (page) =>
  page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const d = useStore.getState().decks.A
    return { grid: d.beatGrid, confirmed: d.beatGridConfirmed, notice: useStore.getState().notice?.text ?? null }
  })

// 1. mark beat 3 of bar 2 through the real button, and read where the bar line went
let saved
await scenario(undefined, async (page, errors) => {
  const before = await deckGrid(page)
  ok('fresh: analysis produced a grid', before.grid != null, JSON.stringify(before.grid))
  const beatSec = 60 / before.grid.bpm
  // beat 3 of bar 2, counted from the detected beat 0
  const markSec = before.grid.offsetSec + 6 * beatSec
  await page.evaluate(async (sec) => {
    const ctl = await window.__import('/src/controls.ts')
    ctl.seekDeck('A', sec)
  }, markSec)
  // The owner's own path: the BPM readout opens the panel, then the button.
  await page.getByRole('button', { name: 'Edit beat grid' }).first().click()
  await page.getByRole('button', { name: 'Set downbeat here' }).click()
  await page.waitForTimeout(300)
  const after = await deckGrid(page)
  const bar = await page.evaluate(async (g) => {
    const bg = await window.__import('/src/core/beatgrid.ts')
    return bg.nextBarLineSec(g.at - 0.05, g.grid)
  }, { grid: after.grid, at: markSec })
  ok(`set downbeat (button): a yellow line sits on the marked beat 3`, Math.abs(bar - markSec) < 0.01, `mark=${markSec.toFixed(3)} line=${bar.toFixed(3)}`)
  ok('set downbeat: offset is inside bar 1 but past beat 1 — the "1" was not folded away', after.grid.offsetSec > beatSec, `offset=${after.grid.offsetSec.toFixed(3)} beat=${beatSec.toFixed(3)}`)
  saved = await page.evaluate(() => window.__readGrid())
  ok('set downbeat: saved under this track\'s content hash, as the owner\'s', saved?.source === 'owner' && Math.abs(saved.grid.offsetSec - after.grid.offsetSec) < 1e-9, JSON.stringify(saved))
  ok('set downbeat: no page errors', errors.length === 0, errors[0])
})

// 2. a new page with exactly that record: the grid comes back, confirmed
await scenario(saved, async (page, errors) => {
  const g = await deckGrid(page)
  ok('reload: the corrected grid comes back', g.grid && Math.abs(g.grid.offsetSec - saved.grid.offsetSec) < 1e-9 && g.grid.bpm === saved.grid.bpm, JSON.stringify(g.grid))
  ok('reload: shown as checked, not as an unconfirmed guess', g.confirmed === true)
  ok('reload: no page errors', errors.length === 0, errors[0])
})

// 3. a damaged record is refused out loud, and the detected grid is used
await scenario({ schema: 1, grid: { bpm: 0, offsetSec: 1 }, source: 'owner', savedAt: 1 }, async (page, errors) => {
  const g = await deckGrid(page)
  ok('damaged: the detected grid is used', g.grid != null && g.grid.bpm > 0, JSON.stringify(g.grid))
  ok('damaged: the screen says the saved grid was not used', /saved beat grid was not used/.test(g.notice ?? ''), g.notice)
  ok('damaged: no page errors', errors.length === 0, errors[0])
})

// 4. v0.12.4: "checked, no edit" over an unconfirmed grid is saved and survives a reload
let confirmedSaved
await scenario(undefined, async (page, errors) => {
  // The click track is detected confidently; put the deck in the state the
  // pill is shown for, the way a doubtful detection leaves it.
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    useStore.getState().patchDeck('A', { beatGridConfirmed: false })
  })
  const before = await deckGrid(page)
  await page.getByRole('button', { name: 'Edit beat grid' }).first().click()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(300)
  const after = await deckGrid(page)
  ok('confirm: pill cleared on screen', after.confirmed === true)
  confirmedSaved = await page.evaluate(() => window.__readGrid())
  ok("confirm: the unedited grid is saved as the owner's", confirmedSaved?.source === 'owner' && Math.abs(confirmedSaved.grid.offsetSec - before.grid.offsetSec) < 1e-9 && confirmedSaved.grid.bpm === before.grid.bpm, JSON.stringify(confirmedSaved))
  ok('confirm: no page errors', errors.length === 0, errors[0])
})
// The click track is detected confidently, so the pill alone can't tell a
// reloaded record from a fresh detection — what this proves is that there is
// a record to reload; scenario 2 already proves a record comes back confirmed.
ok('confirm, reload: there is a saved record to come back', confirmedSaved != null)
await scenario(confirmedSaved, async (page, errors) => {
  const g = await deckGrid(page)
  ok('confirm, reload: no "unconfirmed grid" pill', g.confirmed === true)
  ok('confirm, reload: no page errors', errors.length === 0, errors[0])
})

// 4b. a click elsewhere only closes the panel — not "checked", nothing saved (Shalom, 28/09)
await scenario(undefined, async (page) => {
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    useStore.getState().patchDeck('A', { beatGridConfirmed: false })
  })
  await page.getByRole('button', { name: 'Edit beat grid' }).first().click()
  await page.waitForTimeout(100)
  await page.mouse.click(5, 700)
  await page.waitForTimeout(300)
  const open = await page.getByRole('button', { name: 'Set downbeat here' }).count()
  ok('click elsewhere: the panel closed', open === 0)
  ok('click elsewhere: the pill stays', (await deckGrid(page)).confirmed === false)
  ok('click elsewhere: nothing saved', (await page.evaluate(() => window.__readGrid())) === undefined)
})

// 5. closing the panel over a grid detection already trusted writes nothing
await scenario(undefined, async (page) => {
  const g = await deckGrid(page)
  ok('trusted grid: starts confirmed (precondition)', g.confirmed === true)
  await page.getByRole('button', { name: 'Edit beat grid' }).first().click()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(300)
  ok('trusted grid: closing the panel saves nothing', (await page.evaluate(() => window.__readGrid())) === undefined)
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

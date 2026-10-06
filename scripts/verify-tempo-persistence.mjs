/**
 * v0.8.6 browser verification for the "no persistence for tempo between
 * loads" debt (HANDOFF.md). v0.9.46: a tempo is kept only when the owner
 * presses "Save tempo" — moving the fader alone saves nothing (Shalom, 06/10),
 * and what v0.8.6–v0.9.45 saved on its own (`tempo2`) is not restored. v0.9.47: a saved speed is the track's own
 * (`trackMeta.playRate`) — the fader stays in the middle, the deck and the row show the new BPM. Run against `npm run dev` on :5173:
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

function harness({ seedTempo, seedOld, seedRate, seedPath, otherHash, breakMeta } = {}) {
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
  ${seedRate ? `mem.set('deckmix:trackMeta', { ${JSON.stringify(otherHash ? 'f'.repeat(64) : CONTENT_HASH)}: { playRate: ${seedRate}${seedPath ? `, playRatePath: ${JSON.stringify(seedPath)}` : ''} } });` : ''}
  // v0.9.48: every state of the row from the first moment the store exists — was the saved speed there before the file had a hash?
  window.__rows = [];
  const poll = setInterval(async () => {
    if (!window.__import) return;
    try {
      const { useStore } = await window.__import('/src/app/state/store.ts');
      clearInterval(poll);
      const rec = (s) => { const t = s.library.tracks[0]; if (t) window.__rows.push({ rate: t.playRate ?? null, hash: !!t.contentHash }); };
      rec(useStore.getState());
      useStore.subscribe(rec);
    } catch {}
  }, 5);
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
              get: (k) => { const r = {}; if (${breakMeta ? 'true' : 'false'} && k === 'deckmix:trackMeta') { setTimeout(() => { r.error = new Error('blocked'); r.onerror && r.onerror(); }, 0); return r; } fire(r, 'onsuccess', mem.get(k)); return r; },
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
  window.__readPath = () => mem.get('deckmix:trackMeta')?.[${JSON.stringify(CONTENT_HASH)}]?.playRatePath;
  window.__readRate = () => mem.get('deckmix:trackMeta')?.[${JSON.stringify(CONTENT_HASH)}]?.playRate;
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

const notice = (page) => page.evaluate(async () => (await window.__import('/src/app/state/store.ts')).useStore.getState().notice?.text ?? '')
const saveButton = (page) => deckA(page).getByRole('button', { name: 'Save tempo' })
const forgetButton = (page) => deckA(page).getByRole('button', { name: 'Forget tempo' })
const deckState = (page) => page.evaluate(async () => {
  const { useStore } = await window.__import('/src/app/state/store.ts')
  const { engine } = await window.__import('/src/platform/audio-webaudio/engine.ts')
  const d = useStore.getState().decks.A
  const row = useStore.getState().library.tracks[0]
  return { tempo: d.tempo, baseRate: d.baseRate, rate: engine.decks.A.rate, rowRate: row?.playRate ?? null }
})

// 2. v0.9.47: a speed v0.9.46 saved as a fader position (tempo3) is carried over once as the track's own speed — fader in the middle
await scenario('carry over tempo3', { seedTempo: true }, async (page, errors) => {
  await loadFirstTrackToDeckA(page)
  const st = await deckState(page)
  ok('carry-over: the fader is in the middle', st.tempo === 0, JSON.stringify(st))
  ok('carry-over: the deck plays at the saved speed (1.02)', Math.abs(st.baseRate - 1.02) < 1e-6 && Math.abs(st.rate - 1.02) < 1e-6, JSON.stringify(st))
  ok('carry-over: the row carries it too', Math.abs(st.rowRate - 1.02) < 1e-6, JSON.stringify(st))
  ok('carry-over: moved to playRate, the old record removed', Math.abs((await page.evaluate(() => window.__readRate())) - 1.02) < 1e-6 && (await page.evaluate(() => window.__hasTempo())) === false)
  ok('carry-over: said on screen', /plays at the speed you saved for it \(\+2\.0% of the file/.test(await notice(page)), await notice(page))
  ok('carry-over: no console errors', errors.length === 0, errors[0])
})

// 2b. a saved speed after a refresh: fader in the middle, deck and row at the saved speed, Forget offered (Shalom's three points, 06/10)
await scenario('saved speed after refresh', { seedRate: 0.92 }, async (page, errors) => {
  await page.waitForTimeout(800) // the analysis pass merges playRate onto the row
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const s = useStore.getState()
    s.setLibrary({ tracks: s.library.tracks.map((t) => ({ ...t, bpm: 150 })) })
  })
  await page.waitForTimeout(100)
  const cell = await page.locator('tbody tr').first().innerText()
  ok('row: shows 138 (150 × 0.92), not the file\'s 150', /\b138\b/.test(cell) && !/\b150\b/.test(cell), cell.replace(/\s+/g, ' '))
  await loadFirstTrackToDeckA(page)
  await page.evaluate(async () => (await window.__import('/src/app/state/store.ts')).useStore.getState().patchDeck('A', { bpm: 150 }))
  await page.waitForTimeout(100)
  const st = await deckState(page)
  ok('refresh: the fader is in the middle', st.tempo === 0 && (await tempoSlider(page).getAttribute('aria-valuenow')) === '0', JSON.stringify(st))
  ok('refresh: plays at 0.92', Math.abs(st.rate - 0.92) < 1e-6, JSON.stringify(st))
  ok('refresh: the deck says 138.0 BPM', /138\.0/.test(await deckA(page).innerText()))
  ok('refresh: Forget tempo is offered, Save is not', (await forgetButton(page).count()) === 1 && (await saveButton(page).count()) === 0)
  ok('refresh: no console errors', errors.length === 0, errors[0])
})

// 2b'. v0.9.48 (Shalom 06/10: "after a refresh it still shows the old BPM until I load it"): the row has the saved speed before the hash
await scenario('saved speed before the hash', { seedRate: 0.92, seedPath: 'silence.wav' }, async (page, errors) => {
  await page.waitForTimeout(800)
  const rows = await page.evaluate(() => window.__rows)
  const first = rows.find((r) => r.rate != null)
  ok('row: the saved speed is there before the file has a hash', !!first && first.hash === false && Math.abs(first.rate - 0.92) < 1e-9, JSON.stringify(rows.slice(0, 6)))
  ok('row: and stays after the hash pass', rows.at(-1)?.hash === true && Math.abs(rows.at(-1).rate - 0.92) < 1e-9, JSON.stringify(rows.at(-1)))
  ok('before hash: no console errors', errors.length === 0, errors[0])
})
await scenario('a different file at the saved path', { seedRate: 0.92, seedPath: 'silence.wav', otherHash: true }, async (page) => {
  await page.waitForTimeout(800)
  const rows = await page.evaluate(() => window.__rows)
  ok('another file at that path: the hash pass takes the guess back', rows.at(-1)?.hash === true && rows.at(-1).rate == null, JSON.stringify(rows.slice(-3)))
})
await scenario('load records where the file is', { seedRate: 0.92 }, async (page) => {
  await loadFirstTrackToDeckA(page)
  await page.waitForTimeout(200)
  const path = await page.evaluate(() => window.__readPath())
  ok('a load of a track saved before v0.9.48 records its path', path === 'silence.wav', String(path))
})

// 2c. mixes count from the saved speed (Shalom 06/10: "make sure it does not affect the mixes"): SYNC both ways, and the way back
await scenario('saved speed in a mix', { seedRate: 0.92 }, async (page, errors) => {
  await page.waitForTimeout(800)
  const r = await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const ctl = await window.__import('/src/controls.ts')
    const { engine } = await window.__import('/src/platform/audio-webaudio/engine.ts')
    const track = useStore.getState().library.tracks[0]
    await ctl.loadTrackToDeck('A', track)
    await ctl.loadTrackToDeck('B', track)
    const s = useStore.getState()
    // A: this track, 150 in the file, saved at 0.92 = 138. B: "another" track at 140, no saved speed.
    s.patchDeck('A', { bpm: 150, beatGrid: { bpm: 150, offsetSec: 0 }, beatGridConfirmed: true })
    engine.decks.B.setBaseRate(1)
    s.patchDeck('B', { bpm: 140, baseRate: 1, beatGrid: { bpm: 140, offsetSec: 0 }, beatGridConfirmed: true })
    ctl.setMasterDeck('A')
    ctl.syncDeck('B')
    const bToA = engine.decks.B.rate * 140
    ctl.syncDeck('B') // release
    ctl.setTempo('B', 0)
    ctl.setMasterDeck('B')
    ctl.syncDeck('A')
    const aToB = engine.decks.A.rate * 150
    const aSyncTempo = useStore.getState().decks.A.tempo
    ctl.syncDeck('A') // release
    ctl.setTempo('A', 0, { byHand: false }) // where the glide back ends
    return { bToA, aToB, aSyncTempo, aBack: engine.decks.A.rate, aBase: useStore.getState().decks.A.baseRate }
  })
  ok('SYNC to a deck with a saved speed: matches 138, not the file\'s 150', Math.abs(r.bToA - 138) < 0.05, JSON.stringify(r))
  ok('SYNC a deck with a saved speed to 140: plays at 140', Math.abs(r.aToB - 140) < 0.05, JSON.stringify(r))
  ok('back to its own speed = the saved one (0.92), not the file\'s', Math.abs(r.aBack - 0.92) < 1e-9 && r.aBase === 0.92, JSON.stringify(r))
  ok('mix: no console errors', errors.length === 0, errors[0])
})

// 2d. the saved-speed store cannot be read: said on screen, never a quiet "nothing saved" (v0.9.47 review)
await scenario('saved speed unreadable', { breakMeta: true }, async (page) => {
  // every notice shown, not only the last: the same broken store also fails the "last played" stamp, which warns right after
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    window.__notices = []
    useStore.subscribe((s) => { const t = s.notice?.text; if (t && window.__notices.at(-1) !== t) window.__notices.push(t) })
  })
  await loadFirstTrackToDeckA(page)
  const st = await deckState(page)
  const seen = await page.evaluate(() => window.__notices)
  ok('unreadable: plays at the file speed, and says the saved one could not be read', st.rate === 1 && seen.some((t) => /saved speed .* could not be read/.test(t)), JSON.stringify(seen))
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
  ok('touch: nothing is stored by moving the fader', (await page.evaluate(() => window.__hasTempo() || window.__readRate() !== undefined)) === false)
  ok('touch: the Save tempo button appears', (await saveButton(page).count()) === 1)
  const box = await saveButton(page).boundingBox()
  const sec = await saveButton(page).locator('xpath=ancestor::section[1]').boundingBox()
  await page.screenshot({ path: process.env.SHOT || '/tmp/save-tempo.png' })
  const fits = await saveButton(page).evaluate((b) => { const s = b.closest('section'); return { inside: s.scrollHeight <= s.clientHeight + 1, sh: s.scrollHeight, ch: s.clientHeight } })
  ok('the button sits inside the deck, which does not grow', box && sec && box.x >= sec.x && box.x + box.width <= sec.x + sec.width && fits.inside, JSON.stringify({ box, sec, fits }))
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const s = useStore.getState()
    s.setLibrary({ tracks: s.library.tracks.map((t) => ({ ...t, bpm: 150 })) })
    s.patchDeck('A', { bpm: 150 })
  })
  const before = await deckState(page)
  await saveButton(page).click()
  await page.waitForTimeout(300)
  const stored = await page.evaluate(() => window.__readRate())
  const st = await deckState(page)
  ok('Save tempo: stored as the speed heard', typeof stored === 'number' && Math.abs(stored - before.rate) < 1e-6, `stored=${stored} before=${JSON.stringify(before)}`)
  ok('Save tempo: the fader goes back to the middle', st.tempo === 0 && (await tempoSlider(page).getAttribute('aria-valuenow')) === '0', JSON.stringify(st))
  ok('Save tempo: the speed heard does not change', Math.abs(st.rate - before.rate) < 1e-9, JSON.stringify({ before, st }))
  ok('Save tempo: the row carries it and shows the new BPM', Math.abs(st.rowRate - stored) < 1e-9 && /\b152\b/.test(await page.locator('tbody tr').first().innerText()), JSON.stringify(st))
  ok('Save tempo: said on screen', /now plays at this speed every time \(152\.4 BPM\)/.test(await notice(page)), await notice(page))
  ok('saved: Save goes away, Forget appears', (await saveButton(page).count()) === 0 && (await forgetButton(page).count()) === 1)
  await forgetButton(page).click()
  await page.waitForTimeout(300)
  const back = await deckState(page)
  ok('Forget tempo: the record is gone, back to the file\'s speed', (await page.evaluate(() => window.__readRate())) === undefined && back.rate === 1 && back.baseRate === 1 && back.rowRate === null, JSON.stringify(back))
  ok('Forget tempo: the row says 150 again', /\b150\b/.test(await page.locator('tbody tr').first().innerText()))
  // SYNC's number belongs to the pairing: refused, said, nothing stored
  await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    useStore.getState().patchDeck('A', { tempo: 0.5, syncActive: true })
  })
  ok('synced: no Save tempo button', (await saveButton(page).count()) === 0)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).saveDeckTempo('A'))
  await page.waitForTimeout(200)
  ok('synced: saving is refused and said', (await page.evaluate(() => window.__readRate())) === undefined && /came from SYNC/.test(await notice(page)), await notice(page))
  // A mix leaves the incoming deck unsynced at the other song's speed (finishTransition, a released SYNC): still not a hand's number.
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).setTempo('A', 0.5, { byHand: false }))
  ok('left at a mix speed, unsynced: no Save tempo button', (await saveButton(page).count()) === 0)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).saveDeckTempo('A'))
  await page.waitForTimeout(200)
  ok('left at a mix speed: saving is refused and said', (await page.evaluate(() => window.__readRate())) === undefined && /SYNC or the mix/.test(await notice(page)), await notice(page))
  ok('save: no console errors', errors.length === 0, errors[0])
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

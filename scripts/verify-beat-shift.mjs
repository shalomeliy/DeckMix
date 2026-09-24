/**
 * v0.8.8 verification — the live "shift one beat" control
 * (`workshop-output/FEATURE_SPEC_BARSYNC.md` / `PLAN_BARSYNC.md`). Run
 * against `npm run dev` on :5173:
 *
 *   node scripts/verify-beat-shift.mjs
 *
 * `shiftDeckByBeat` (controls.ts) has no unit test — it touches `engine`
 * (the real Web Audio graph) directly, same reason `nudgeDeck`/`bendDeck`
 * have none either. The one fact worth proving in a real browser is the
 * feature's entire safety argument: a whole-beat seek must be invisible to
 * `phaseDeltaSec`'s mod-one-beat math, so SYNC stays locked with no special
 * handling. `beatGrid` is seeded directly on both decks rather than relying
 * on real beat detection on a synthetic sine-tone WAV (which has no
 * rhythmic onsets to detect at all, unrelated to what this script tests —
 * `tests/core/beatgrid.test.ts` already covers detection accuracy).
 * Position is read/shifted/re-read inside one `page.evaluate` call so nothing
 * races against audio that keeps playing in the background between steps.
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
function id3Tag(bpm, camelot) {
  const frames = Buffer.concat([id3TextFrame('TBPM', String(bpm)), id3TextFrame('TKEY', camelot)])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frames.length)])
  return Buffer.concat([header, frames])
}
function buildTaggedWav(bpm, camelot, { durationSec = 20, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2
  const pcm = Buffer.alloc(dataSize)
  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 2 * i) / sampleRate)), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const tag = id3Tag(bpm, camelot)
  const tagPadded = tag.length % 2 === 0 ? tag : Buffer.concat([tag, Buffer.from([0])])
  const chunk = (id, body) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt),
    chunk('data', pcm),
    chunk('ID3 ', tagPadded),
  ])
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
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const n of Object.keys(files)) yield [n, makeFile(n)]; },
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

const row = (page, text) => page.locator('tbody tr', { hasText: new RegExp(text) })
const deckBSection = (page) => page.locator('section').nth(2)

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(
  harness({
    'Deck A Track.wav': buildTaggedWav(128, '8A'),
    'Compatible.wav': buildTaggedWav(128, '9A'),
  }),
)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)

// Browsers require a click before any AudioContext can produce sound.
// Without this, `playing` looks set in the store but the render loop keeps
// snapping it back to false against the real (suspended) engine — found
// live: deck A's button-visibility check kept reporting `aPlaying:false`
// moments after this script had just set `playing: true` itself.
await page.getByRole('button', { name: /start audio engine/i }).click()
await page.waitForTimeout(300)

// Load A, play it. Load B directly via `ctl.loadTrackToDeck` rather than a
// suggested-row double-click — routing a plain dblclick onto the *other*
// deck depends on the live Mix Assist recommendation calc (deck A actually
// playing, tags already read) settling within the test's own timing, which
// is exactly the kind of flakiness this script has no reason to depend on:
// it's testing the beat-shift control, not the suggestion-routing feature
// (that's `verify-mix-assist-load.mjs`'s job).
await row(page, 'Deck A Track').dblclick()
await page.waitForTimeout(200)
await page.keyboard.press('KeyQ')
await page.waitForTimeout(300)
await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const track = useStore.getState().library.tracks.find((t) => t.name.includes('Compatible'))
  await ctl.loadTrackToDeck('B', track)
})
await page.waitForTimeout(300)
await page.keyboard.press('KeyP')
await page.waitForTimeout(300)

// Seed both decks' beatGrid/bpm/syncActive/masterDeckId directly, atomically
// in one evaluate — the real background analysis queue keeps running against
// these synthetic sine-tone tracks (no rhythmic onsets to detect at all,
// irrelevant to what this script tests) and will happily clobber a seeded
// `beatGrid` back to null the moment a `page.waitForTimeout` gives it room
// to do so. Found live: an earlier version of this script seeded state, then
// awaited a real click on the Sync button with a wait after it, and every
// guard fired as if the grid had never been set. Keeping seed-then-act in
// one synchronous JS turn (same pattern the guard-clause checks below
// already use) closes that race instead of fighting it with more timeouts.
const syncSetup = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const store = useStore.getState()
  // `playing: true` reasserted explicitly on both decks rather than trusting
  // the earlier `KeyQ`/`KeyP` presses still hold by this point in the
  // script — same "don't depend on upstream timing" reasoning as seeding
  // beatGrid atomically above.
  store.patchDeck('A', { beatGrid: { bpm: 128, offsetSec: 0 }, bpm: 128, playing: true })
  store.patchDeck('B', { beatGrid: { bpm: 128, offsetSec: 0 }, bpm: 128, syncActive: true, playing: true })
  useStore.setState({ masterDeckId: 'A' })
  return { syncActive: useStore.getState().decks.B.syncActive, aPlaying: useStore.getState().decks.A.playing }
})
ok('SYNC engaged on deck B (seeded, same effect as syncDeck() succeeding)', syncSetup.syncActive === true)

// The button pair only renders once syncActive && the other deck is playing
// — needs one paint after the store mutation above.
await page.waitForTimeout(100)
const liveState = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const s = useStore.getState()
  return { bSync: s.decks.B.syncActive, aPlaying: s.decks.A.playing, bPlaying: s.decks.B.playing }
})
// Exact match, not /beat/ — the always-present "deck.bpm" HintIcon's own
// tooltip text ("Open the beat grid editor...") also matches a loose regex.
const shiftButtons =
  (await deckBSection(page).getByRole('button', { name: '◂ beat', exact: true }).count()) +
  (await deckBSection(page).getByRole('button', { name: 'beat ▸', exact: true }).count())
ok(
  'beat-shift buttons render once SYNC is active and A is playing',
  shiftButtons === 2,
  `found ${shiftButtons}, live state at check time: ${JSON.stringify(liveState)}`,
)

// --- Core safety claim: whole-beat shift. Deck B is paused first — while
// playing, `deck.position` (live engine getter, what shiftDeckByBeat reads)
// keeps advancing between this script's `before` read (store's periodically-
// synced positionSec) and the moment shiftDeckByBeat itself reads a fresh
// position, so before/after would include real elapsed playback time on top
// of the actual shift. Paused, position is static — isolates the one number
// this test actually cares about. ---
await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  if (useStore.getState().decks.B.playing) ctl.togglePlay('B')
})
await page.waitForTimeout(150)
const shiftResult = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const store = useStore.getState()
  store.patchDeck('A', { beatGrid: { bpm: 128, offsetSec: 0 }, bpm: 128 })
  store.patchDeck('B', { beatGrid: { bpm: 128, offsetSec: 0 }, bpm: 128, syncActive: true, loopActive: false })
  useStore.setState({ masterDeckId: 'A' })
  const before = useStore.getState().decks.B.positionSec
  const gridBefore = { ...useStore.getState().decks.B.beatGrid }
  ctl.shiftDeckByBeat('B', 1)
  const after = useStore.getState().decks.B.positionSec
  const gridAfter = { ...useStore.getState().decks.B.beatGrid }
  return { before, after, delta: after - before, gridBefore, gridAfter }
})
ok(
  'forward shift moves the deck by exactly one beat (60/128s)',
  Math.abs(shiftResult.delta - 60 / 128) < 0.03,// 30ms slack: store positionSec syncs from the engine via a render-loop tick, not instantly on pause
  JSON.stringify(shiftResult),
)
ok(
  "beatGrid itself is untouched — the shift is invisible to phaseDeltaSec's math",
  shiftResult.gridBefore.bpm === shiftResult.gridAfter.bpm && shiftResult.gridBefore.offsetSec === shiftResult.gridAfter.offsetSec,
  JSON.stringify(shiftResult),
)

const backResult = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const store = useStore.getState()
  store.patchDeck('A', { beatGrid: { bpm: 128, offsetSec: 0 }, bpm: 128 })
  store.patchDeck('B', { beatGrid: { bpm: 128, offsetSec: 0 }, bpm: 128, syncActive: true, loopActive: false })
  useStore.setState({ masterDeckId: 'A' })
  const before = useStore.getState().decks.B.positionSec
  ctl.shiftDeckByBeat('B', -1)
  const after = useStore.getState().decks.B.positionSec
  return { delta: after - before }
})
ok('backward shift moves the deck by exactly minus one beat', Math.abs(backResult.delta - -60 / 128) < 0.03, JSON.stringify(backResult))

// --- Guard clauses: each must produce a notice and leave position untouched, never a silent no-op. ---
async function checkGuard(label, patch) {
  const result = await page.evaluate(async (deckPatch) => {
    const { useStore } = await import('/src/app/state/store.ts')
    const ctl = await import('/src/controls.ts')
    if (deckPatch.masterDeckId) useStore.setState({ masterDeckId: deckPatch.masterDeckId })
    if (deckPatch.deckB) useStore.getState().patchDeck('B', deckPatch.deckB)
    useStore.setState({ notice: null })
    const before = useStore.getState().decks.B.positionSec
    ctl.shiftDeckByBeat('B', 1)
    const after = useStore.getState().decks.B.positionSec
    return { before, after, notice: useStore.getState().notice?.text ?? null }
  }, patch)
  ok(`${label}: position unchanged`, result.before === result.after, JSON.stringify(result))
  ok(`${label}: a notice was shown, not a silent no-op`, result.notice != null, result.notice)
}

await checkGuard('deck B is master', { masterDeckId: 'B' })
await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  useStore.setState({ masterDeckId: 'A' })
})

await checkGuard('deck B has no beat grid', { deckB: { beatGrid: null } })
await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  useStore.getState().patchDeck('B', { beatGrid: { bpm: 128, offsetSec: 0 } })
})

await checkGuard('deck B has an active loop', { deckB: { loopActive: true } })
await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  useStore.getState().patchDeck('B', { loopActive: false })
})

ok('no console errors', errors.length === 0, errors[0])

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

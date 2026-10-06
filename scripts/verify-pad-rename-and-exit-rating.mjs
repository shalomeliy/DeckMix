/**
 * v0.5.3/v0.5.4 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-pad-rename-and-exit-rating.mjs
 *
 * Two independent owner requests verified end-to-end in one run (same
 * harness, cheaper than two scripts):
 *
 * v0.5.3 — any hot cue pad (plain or mix-entry) can be renamed to free text
 * via Alt-click, and whatever is saved always keeps the cue's own position
 * in the name (`renameHotCue`, `controls.ts`).
 *
 * v0.5.4 — starting a transition shows the *outgoing* deck's own suggested
 * exit point immediately (not just the incoming deck's entry candidates,
 * which v0.4.6/v0.4.7 already covered); once the crossfade finishes, a
 * rating prompt appears, and marking a point "excellent" makes it show up
 * highlighted the *next* time that same track becomes an outgoing deck —
 * this is the part that needs real IndexedDB persistence across a track
 * reload, not just in-memory state, so it can't be a unit test.
 *
 * Four *identical-bytes* files (`Track1..4.wav`) rather than reloading one —
 * the library auto-filters to "mixable" the instant any deck plays
 * (`Library.tsx`'s `wasPlayingForMixOnly`), and a track already on a deck is
 * always excluded from that list (`mixRecommendations`'s `onDeck` set). With
 * only one or two files, both decks eventually hold the only tracks that
 * exist and the library goes empty with no visible way back (the toggle
 * itself only renders when at least one match exists) — not a bug, just this
 * script's own fixture needing enough always-something-selectable slack.
 * Same bytes everywhere means the same detected BPM (so every pair mixes)
 * and the same content hash (so "excellent" marked against `Track1.wav` in
 * round 1 is still found against `Track3.wav` in round 2 — content hash
 * comes from file bytes, never the name). Each carries the same 5s quiet
 * intro + loud body shape, giving a real "energy-builds" candidate at sec 5.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function makeWav(segments, sampleRate) {
  const totalSamples = segments.reduce((a, s) => a + Math.round(s.sec * sampleRate), 0)
  const dataSize = totalSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  let sample = 0
  for (const { sec, amplitude } of segments) {
    const n = Math.round(sec * sampleRate)
    for (let i = 0; i < n; i++, sample++) {
      const v = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * sample) / sampleRate))
      buf.writeInt16LE(v, 44 + sample * 2)
    }
  }
  return buf
}

const SAMPLE_RATE = 8000
// 5s quiet intro -> "energy-builds" candidate at sec 5 -> loud body, long
// enough that the 8s crossfade plus setup delays never reach the tail guard.
// 80 s, not 30 (v0.9.26): since v0.9.23 an entry point needs 24 bars of the
// song left after the mix, or it is counted on screen instead of offered.
const TRACK_WAV = makeWav(
  [
    { sec: 5, amplitude: 800 },
    { sec: 80, amplitude: 8000 },
  ],
  SAMPLE_RATE,
)

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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(
  harness({
    'Track1.wav': TRACK_WAV,
    'Track2.wav': TRACK_WAV,
    'Track3.wav': TRACK_WAV,
    'Track4.wav': TRACK_WAV,
  }),
)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)

const row = (text) => page.locator('tbody tr', { hasText: new RegExp(text) })
const deckA = page.locator('section').nth(0)
const deckB = page.locator('section').nth(2) // Deck A, Mixer, Deck B, Library

// Loading uses select-then-`[`/`]` (App.tsx), not double-click: double-click
// on a row with a BPM match routes through `loadSuggestionToDeck` instead
// (onto whichever deck is *empty*, refusing if it isn't) — `[` always loads
// the selected row onto deck A, `]` onto deck B, regardless of what either
// deck currently holds.
// Clicking the row's own name cell specifically, not the row's bounding-box
// center: a row also holds a genre `<select>` whose cell stops the click's
// propagation (Library.tsx, "keeps opening it from also selecting the row"),
// and a plain center-click can land on exactly that cell on a row this wide.
const loadToA = async (name) => {
  await row(name).locator('td').first().click()
  await page.keyboard.press('BracketLeft')
  await page.waitForTimeout(900)
}
const loadToB = async (name) => {
  await row(name).locator('td').first().click()
  await page.keyboard.press('BracketRight')
  await page.waitForTimeout(900)
}

// ---------------------------------------------------------------- v0.5.3 —
// rename a plain pad on deck A first (no transition involved at all).
await loadToA('Track1')

const padA0 = deckA.getByRole('button', { name: 'Set hot cue 1' })
await padA0.click() // plain set (no modifiers) — ordinal label "1"
await page.waitForTimeout(200)
const plainAriaBefore = await deckA.getByRole('button', { name: /^Jump to hot cue 1$/ }).count()
ok('a freshly-set pad reads as a plain ordinal cue ("Jump to hot cue 1")', plainAriaBefore === 1)

await deckA.getByRole('button', { name: /^Jump to hot cue 1$/ }).click({ modifiers: ['Alt'] })
await page.waitForTimeout(150)
const renameBox = deckA.getByRole('textbox', { name: 'Rename hot cue 1' })
ok('Alt-click opens a rename box in place of the pad label', (await renameBox.count()) === 1)
await renameBox.fill('Vocal drop')
await renameBox.press('Enter')
await page.waitForTimeout(200)

const renamedPad = deckA.getByRole('button', { name: /^Jump to hot cue Vocal drop · 0:00$/ })
ok('renamed pad keeps the custom text and appends the exact second ("Vocal drop · 0:00")', (await renamedPad.count()) === 1)

// Escape must cancel without writing anything.
await renamedPad.click({ modifiers: ['Alt'] })
await page.waitForTimeout(150)
await deckA.getByRole('textbox', { name: 'Rename hot cue 1' }).fill('should not save')
await deckA.getByRole('textbox', { name: 'Rename hot cue 1' }).press('Escape')
await page.waitForTimeout(150)
const stillRenamed = await deckA.getByRole('button', { name: /^Jump to hot cue Vocal drop · 0:00$/ }).count()
ok('Escape cancels the rename — the label from before reopening it is unchanged', stillRenamed === 1)

// Clean up: this pad must not linger and be confused with the mix-in pad
// `saveMixEntryHotCue` creates later on this same deck once it becomes the
// *outgoing* side of a transition below.
await deckA.getByRole('button', { name: /^Jump to hot cue Vocal drop · 0:00$/ }).click({ modifiers: ['Shift'] })
await page.waitForTimeout(150)

// ---------------------------------------------------------------- v0.5.4 —
// Play deck A, then load a second (identical-content) track onto deck B
// (paused) so the transition-points panel opens, and use its one real
// candidate (the energy-builds point at sec 5) to start a transition *from*
// deck A.
await page.keyboard.press('KeyQ')
await page.waitForTimeout(300)
await loadToB('Track2')

const buildsButton = deckB.locator('div.absolute.left-0.top-full button').filter({ hasText: 'energy builds' })
ok('deck B shows its own "energy builds" candidate', (await buildsButton.count()) === 1)
await buildsButton.first().click()
await page.waitForTimeout(300)

const exitPill = deckA.getByText(/^suggested exit at \d+:\d{2}$/)
ok('deck A (the outgoing side) shows a suggested-exit indicator the moment the transition starts', (await exitPill.count()) === 1)

// Since v0.8.14 (bdcb913, Shalom's decision) a "Mix in" pad is saved only
// when the mix is rated Excellent, never on the candidate click itself. This
// script predates that and asserted the pad right here; it now asserts the
// opposite, and the rename round-trip below moved to after the rating
// (found 2026-09-24, the first run of the verify scripts as one suite).
ok(
  'no mix-entry pad yet: a candidate click alone does not save one (v0.8.14)',
  (await deckB.getByRole('button', { name: /^Start mix from Mix in · \d+:\d{2}$/ }).count()) === 0,
)

// Let the 8s crossfade (TRANSITION_CROSSFADE_SEC) finish.
// Waits on the prompt itself, up to 15 s: since v0.8.14 the crossfade only
// starts on deck A's next bar line (up to ~1.9 s later), so a fixed 8.5 s
// passed alone and failed inside the full suite (found 2026-09-24).
// 35 s, not 15 (v0.9.26): since v0.9.17 it starts on deck A's next phrase
// start — up to 8 bars, ~16 s at 120 BPM — and then fades for 8 s.
const ratingPrompt = page.getByText(/How did that exit from/)
await ratingPrompt.waitFor({ timeout: 35000 }).catch(() => {})
ok('a rating prompt appears once the crossfade completes', (await ratingPrompt.count()) === 1)

await page.getByRole('button', { name: 'Excellent', exact: true }).click()
await page.waitForTimeout(200)
ok('the rating prompt disappears after rating', (await page.getByText(/How did that exit from/).count()) === 0)

// v0.5.3/v0.5.4 interaction: renaming an *existing* Mix-Assist pad (not just
// a plain one) must not glue a second timestamp onto the first — the exact
// round-trip a change-reviewer pass caught before this script covered it.
const mixEntryPad = deckB.getByRole('button', { name: /^Start mix from Mix in · \d+:\d{2}$/ })
ok('rated Excellent: deck B now holds the mix-entry pad', (await mixEntryPad.count()) === 1)
await mixEntryPad.click({ modifiers: ['Alt'] })
await page.waitForTimeout(150)
const mixEntryRenameBox = deckB.getByRole('textbox', { name: /^Rename hot cue \d$/ })
const prefill = await mixEntryRenameBox.inputValue()
ok('reopening rename on a mix-entry pad pre-fills only "Mix in", not the timestamp too', prefill === 'Mix in', prefill)
await mixEntryRenameBox.press('Escape') // leave it exactly as saveMixEntryHotCue wrote it
await page.waitForTimeout(150)
const mixEntryUnchanged = await deckB
  .getByRole('button', { name: /^Start mix from Mix in · \d+:\d{2}$/ })
  .count()
ok('canceling out of that rename leaves the mix-entry pad and its label untouched', mixEntryUnchanged === 1)


// Load a *different* file with the same bytes onto deck A — same content
// hash as Track1.wav, so `loadTrackToDeck` re-reads the same
// `getExcellentPoints` record from the fake IndexedDB. This is the one step
// a unit test cannot cover: real persistence across a fresh load, not just
// in-memory state carried over from round 1. Deck A must be paused first:
// `lockPlayingDeck` defaults to on (`core/settings.ts`), and a load onto a
// playing deck is refused, not queued — the whole point of that default.
// Pause only if it is actually playing. The finished transition already
// stops the outgoing deck; clicking the toggle blindly then *started* deck A
// again and the lock refused the load (found 2026-09-24).
const aPlayingNow = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  return useStore.getState().decks.A.playing
})
if (aPlayingNow) {
  await deckA.getByRole('button', { name: /^(play|pause)$/i }).click()
  await page.waitForTimeout(150)
}
await loadToA('Track3')
const aName = await deckA.locator('.truncate.text-base').first().innerText()
ok('setup: deck A holds a freshly-loaded Track3.wav', aName.includes('Track3'))
await page.keyboard.press('KeyQ') // play deck A again
await page.waitForTimeout(300)

// Load a fourth, still-unused file onto deck B (also playing, also needs
// pausing first) to open the panel again and re-trigger the same candidate.
await deckB.getByRole('button', { name: /^(play|pause)$/i }).click()
await page.waitForTimeout(150)
await loadToB('Track4')
const secondBuilds = deckB.locator('div.absolute.left-0.top-full button').filter({ hasText: 'energy builds' })
await secondBuilds.first().click()
await page.waitForTimeout(300)

const knownGoodPill = deckA.getByText(/^★ exit at \d+:\d{2} — worked well before$/)
ok(
  'the same exit point now shows highlighted as previously "excellent" — the persisted-memory proof',
  (await knownGoodPill.count()) === 1,
)

ok('no console errors across the whole run', errors.length === 0, errors[0] ?? '')

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

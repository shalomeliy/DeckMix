/**
 * v0.4.7 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-mix-entry-energy.mjs
 *
 * `energyProximity`/`analyzeEnergyProfile` (core/structure.ts) and
 * `pickHotCueSlot` (core/hotcues.ts) have unit tests; what those can't cover
 * is whether the real `TransitionPointsPanel` actually renders the relative
 * comparison line against a real playing deck's live position, and whether
 * picking a point really lands a named hot cue on the Pad Grid — the two new
 * pieces this version adds on top of v0.4.6's already-verified panel/engine.
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` harness as the other
 * verify-*.mjs scripts.
 *
 * Deck A ("Flat.wav") is a constant-amplitude tone throughout, so wherever
 * its playhead happens to be when read, its own-peak-normalized level is
 * always ~1.0 — this makes the assertions independent of exact timing.
 * Deck B ("Candidate.wav") is quiet-intro / loud-body / mid-track breakdown /
 * loud-tail (same shape `tests/core/structure.test.ts` uses for its "mid-track
 * breakdown" case, v0.5.1), giving one candidate that reads "close" (the loud
 * "energy-builds" point) and one that reads "quieter" (the mid-track
 * "quiet-passage" breakdown) against Deck A's flat, always-loud reference —
 * both in the same panel, from one real analysis pass. v0.5.1 removed the old
 * end-of-track "energy-drops" scan entirely (it always trivially found the
 * final fade and was never a useful mix point), so this fixture's second
 * candidate now has to come from a genuine mid-track dip instead of a quiet
 * outro tail.
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
  // segments: [{ sec, amplitude }] — a pure tone whose amplitude steps
  // between segments, giving a real, analyzable loudness contour.
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
const FLAT_WAV = makeWav([{ sec: 20, amplitude: 8000 }], SAMPLE_RATE)
const CANDIDATE_WAV = makeWav(
  [
    { sec: 5, amplitude: 800 }, // quiet intro — "energy-builds" candidate lands here (sec 5)
    { sec: 25, amplitude: 8000 }, // loud body — builds the local baseline the breakdown below is judged against
    { sec: 6, amplitude: 5200 }, // mid-track breakdown (65% of the loud body) — "quiet-passage" candidate lands here (sec 30)
    { sec: 20, amplitude: 8000 }, // loud tail — clears the last-20s guard so the breakdown isn't suppressed as trivial
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
  harness({ 'Flat.wav': FLAT_WAV, 'Candidate.wav': CANDIDATE_WAV }),
)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)

const row = (text) => page.locator('tbody tr', { hasText: new RegExp(text) })

// Load Flat.wav onto deck A and play it (real per-deck analysis runs on load).
await row('Flat').dblclick()
await page.waitForTimeout(700)
await page.keyboard.press('KeyQ')
await page.waitForTimeout(300)

// Load Candidate.wav onto deck B (paused) — this is the panel's own deck.
await row('Candidate').dblclick()
await page.waitForTimeout(900)

const deckB = page.locator('section').nth(2) // Deck A, Mixer, Deck B, Library
const candidateButtons = deckB.locator('div.absolute.left-0.top-full button')
const count = await candidateButtons.count()
ok('transition points panel shows both candidates', count === 2, `found ${count}`)

const texts = []
for (let i = 0; i < count; i++) texts.push((await candidateButtons.nth(i).innerText()).trim())
console.log(texts.map((t) => `  · ${t.replace(/\n/g, ' / ')}`).join('\n'))

const hasClose = texts.some((t) => /close to what.s playing now/.test(t))
const hasQuieter = texts.some((t) => /quieter than what.s playing now/.test(t))
ok('the loud ("energy-builds") candidate reads close to deck A\'s flat level', hasClose)
ok('the mid-track breakdown candidate reads quieter than deck A\'s flat level', hasQuieter)

// Pick the "close" (energy-builds) candidate — should save a named hot cue
// on deck B regardless of whether the crossfade transition itself proceeds.
const buildsButton = candidateButtons.filter({ hasText: 'energy builds' })
await buildsButton.first().click()
await page.waitForTimeout(400)

const mixInPad = deckB.getByRole('button', { name: /^Start mix from Mix in · \d/ })
const padCount = await mixInPad.count()
ok('clicking a candidate saves a hot cue labeled "Mix in · <time>" on deck B', padCount > 0, `matches: ${padCount}`)
if (padCount > 0) {
  const padText = await mixInPad.first().innerText()
  // `innerText` also picks up the hover-reveal delete "×" span (opacity-only
  // hidden, not `display:none`), so anchor the start only. Same "<text> ·
  // m:ss" shape a manual rename (v0.5.3, `renameHotCue`) also produces —
  // one label format, not two.
  ok('the pad shows the track time, not a bare number', /^Mix in · \d+:\d{2}/.test(padText), padText)
}

// Pause deck B (cancels the transition the candidate click just started, per
// the existing cancel-on-touch rule) so the saved pad can be tested from a
// clean paused state — deck A is untouched and still playing throughout.
await deckB.getByRole('button', { name: /pause/i }).click()
await page.waitForTimeout(300)
const beforePress = (await deckB.getByRole('button', { name: /^(play|pause)$/i }).innerText()).toUpperCase()
ok('setup: deck B is paused before pressing the saved pad', beforePress === 'PLAY', beforePress)

// Pressing the saved "Mix <time>" pad (v0.4.7 `pressHotCue`) should re-run the
// full automatic transition — seek + phase-align + play — not just park the
// playhead the way a plain hot cue does.
await mixInPad.first().click()
await page.waitForTimeout(500)
const afterPress = (await deckB.getByRole('button', { name: /^(play|pause)$/i }).innerText()).toUpperCase()
ok(
  'pressing the saved "Mix <time>" pad starts deck B playing (full transition, not just a seek)',
  afterPress === 'PAUSE',
  afterPress,
)

// Deck B is now playing (from the press above). Pressing the SAME "Mix <time>"
// pad again in that state must NOT attempt another transition — it should
// fall back to a plain seek (v0.4.9 `shouldTriggerMixEntry`), exactly like
// any other pad, instead of becoming a dead button with just a warning.
await page.waitForTimeout(1200) // let the playhead move away from the cue's saved position
const posEl = deckB
  .locator('[class="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted"]')
  .locator('span')
  .nth(2)
const beforeSecondPress = await posEl.innerText()
await mixInPad.first().click()
await page.waitForTimeout(300)
const afterSecondPress = await posEl.innerText()
const stillPlaying = (await deckB.getByRole('button', { name: /^(play|pause)$/i }).innerText()).toUpperCase()
ok(
  'pressing the same pad while deck B already plays just seeks (no dead notice)',
  afterSecondPress !== beforeSecondPress && stillPlaying === 'PAUSE',
  `${beforeSecondPress} -> ${afterSecondPress}, transport: ${stillPlaying}`,
)
const warnNotice = await page.getByText(/isn.t start that transition/i).count()
ok('no "can\'t start transition" notice appears for the fallback seek', warnNotice === 0, `count: ${warnNotice}`)

ok('no console errors across the whole run', errors.length === 0, errors[0] ?? '')

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

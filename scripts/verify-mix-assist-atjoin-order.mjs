/**
 * v0.4.10 browser verification (synthetic audio, no real library needed —
 * runs in a sandboxed/remote session, unlike `verify-mix-assist-transition-
 * quality.mjs`). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-mix-assist-atjoin-order.mjs
 *
 * `tests/core/transition.test.ts` already covers `phaseAlignedEntrySec`'s
 * pure math and is untouched by this version — the fix is *when*
 * `startAutoTransition` (`controls.ts`) reads the position and writes to the
 * store, not what it computes. That ordering can only be observed with a
 * real Zustand store and a real React tree in the loop, so this drives the
 * actual, already-shipped `startAutoTransition` from inside the page (same
 * `import('/src/controls.ts')` / `import('/src/app/state/store.ts')`
 * technique as `verify-mix-assist-transition-quality.mjs`), on two silent
 * synthetic WAVs — the timing fix and the notice behaviour don't depend on
 * real audio content, only on real detection would, and detection is
 * bypassed here entirely: `beatGrid`/`beatGridConfirmed` are set directly via
 * `patchDeck` because a silent WAV never yields a confident (or any) real
 * grid on its own, and there is no UI path to force "detected but
 * unconfirmed" on demand.
 *
 * Two scenarios (SPEC's acceptance criteria #1 and #2):
 *   1. both decks' grids confirmed  -> no notice, deck B ends up playing.
 *   2. deck B's grid unconfirmed    -> a warn notice names deck B, and deck B
 *      *still* ends up playing (warn, not refuse).
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` harness as the other
 * verify-*.mjs scripts.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── one small, real, decodable WAV file (silence) — content doesn't matter,
// only that `decodeAudioData` accepts it and it's long enough to seek/play
// into without hitting the end.
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
  return Buffer.from(buf)
}

const SAMPLE_RATE = 8000
const DURATION_SEC = 20
const WAV_BASE64 = makeWav(DURATION_SEC, SAMPLE_RATE).toString('base64')

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
      yield ['trackA.wav', makeFile('trackA.wav')];
      yield ['trackB.wav', makeFile('trackB.wav')];
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })

async function scenario(name, { bConfirmed }, checks) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(harness())
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)

    const result = await page.evaluate(async ({ bConfirmed }) => {
      const { useStore } = await import('/src/app/state/store.ts')
      const ctl = await import('/src/controls.ts')

      const deadline = Date.now() + 10_000
      let trackA, trackB
      while (Date.now() < deadline) {
        const { tracks } = useStore.getState().library
        trackA = tracks.find((t) => t.name === 'trackA')
        trackB = tracks.find((t) => t.name === 'trackB')
        if (trackA && trackB) break
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!trackA || !trackB) {
        return { error: `library never listed both tracks (found: ${JSON.stringify(useStore.getState().library.tracks.map((t) => t.name))})` }
      }

      await ctl.loadTrackToDeck('A', trackA)
      await ctl.loadTrackToDeck('B', trackB)
      if (!useStore.getState().decks.A.track || !useStore.getState().decks.B.track) {
        return { error: `track failed to load — notice: ${useStore.getState().notice?.text ?? '(none)'}` }
      }

      // Bypass real detection entirely (silence never yields a confident, or
      // any, real grid) — the fix under test is ordering/notice behaviour,
      // not detection, so a hand-set grid is the right fake here.
      useStore.getState().patchDeck('A', { beatGrid: { bpm: 128, offsetSec: 0 }, beatGridConfirmed: true })
      useStore.getState().patchDeck('B', { beatGrid: { bpm: 128, offsetSec: 0 }, beatGridConfirmed: bConfirmed })

      ctl.togglePlay('A')
      await new Promise((r) => setTimeout(r, 300))
      if (!useStore.getState().decks.A.playing) {
        return { error: 'deck A did not start playing after togglePlay' }
      }

      useStore.setState({ notice: null })
      ctl.startAutoTransition('A', 'B', 0)
      await new Promise((r) => setTimeout(r, 50))

      const notice = useStore.getState().notice
      // Since v0.8.14 the incoming deck starts on the outgoing deck's next bar
      // line, not at once — up to one bar (1.875 s at 128 BPM) later. Checking
      // B at +50 ms, as this did before v0.8.14, read a mix that was merely
      // waiting as one that never started (found 2026-09-24).
      const until = performance.now() + 3000
      while (!useStore.getState().decks.B.playing && performance.now() < until) {
        await new Promise((r) => setTimeout(r, 50))
      }
      const bPlaying = useStore.getState().decks.B.playing

      ctl.cancelTransition()
      return { notice, bPlaying }
    }, { bConfirmed })

    checks(result, errors)
  } finally {
    await page.close()
  }
}

// 1. both grids confirmed — no change in visible behaviour: no notice, B plays.
await scenario('both confirmed', { bConfirmed: true }, (result, errors) => {
  ok('both confirmed: no error', !result.error, result.error)
  if (result.error) return
  // Since v0.9.22 Mix Assist also reports on the key (these synthetic songs have none, and that is said — never skipped silently). What
  // this case pins is unchanged: with both grids confirmed, no grid warning and nothing else from the transition itself.
  ok('both confirmed: no notice raised by the transition', result.notice === null || (result.notice.source === 'keylock' && /^Key sync לא זז: לשיר ב.* אין סולם\.$/.test(result.notice.text)), JSON.stringify(result.notice))
  ok('both confirmed: deck B ends up playing', result.bPlaying === true, String(result.bPlaying))
  ok('both confirmed: no console errors', errors.length === 0, errors[0])
})

// 2. deck B's grid unconfirmed — warn notice names deck B, transition still runs.
await scenario('deck B unconfirmed', { bConfirmed: false }, (result, errors) => {
  ok('B unconfirmed: no error', !result.error, result.error)
  if (result.error) return
  ok('B unconfirmed: warn notice raised', result.notice?.tone === 'warn', JSON.stringify(result.notice))
  ok('B unconfirmed: notice names deck B', /deck B\b/.test(result.notice?.text ?? ''), result.notice?.text)
  ok('B unconfirmed: notice source is sync', result.notice?.source === 'sync', result.notice?.source)
  ok('B unconfirmed: transition still proceeds (deck B plays, not refused)', result.bPlaying === true, String(result.bPlaying))
  ok('B unconfirmed: no console errors', errors.length === 0, errors[0])
})

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

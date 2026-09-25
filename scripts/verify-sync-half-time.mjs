/**
 * v0.8.36: SYNC on a half-time pair. A plays a 170, B holds an 85 — a pair
 * Mix Assist offers ("half-time" chip). Before, SYNC asked B for +100% (fader
 * clamped at +8%: 91.8 BPM, never locked) and the phase loop read every other
 * beat as half a beat off. Now B must sync at ~0 fader, say so, and hold phase
 * against A's beats read at A's rate.
 *   node scripts/verify-sync-half-time.mjs   (against npm run dev on :5173)
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
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness())
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

const r = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const { phaseDeltaSec } = await import('/src/core/beatgrid.ts')
  const deadline = Date.now() + 10_000
  let a, b
  while (Date.now() < deadline) {
    const { tracks } = useStore.getState().library
    a = tracks.find((t) => t.name === 'trackA')
    b = tracks.find((t) => t.name === 'trackB')
    if (a && b) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await ctl.loadTrackToDeck('A', a)
  await ctl.loadTrackToDeck('B', b)
  const s = useStore.getState()
  const gA = { bpm: 170, offsetSec: 0 }
  const gB = { bpm: 85, offsetSec: 0.1 } // deliberately off-phase: the loop has to pull it in
  s.patchDeck('A', { bpm: 170, beatGrid: gA, beatGridConfirmed: true })
  s.patchDeck('B', { bpm: 85, beatGrid: gB, beatGridConfirmed: true })
  ctl.togglePlay('A')
  await new Promise((r) => setTimeout(r, 300))
  ctl.togglePlay('B')
  ctl.syncDeck('B')
  const afterSync = useStore.getState()
  const bTempo = afterSync.decks.B.tempo
  const notice = afterSync.notice?.text ?? null
  // let the phase loop work, then read B against A at A's beat rate
  await new Promise((r) => setTimeout(r, 4000))
  const scaled = phaseDeltaSec(engine.decks.B.position, { ...gB, bpm: 170 }, engine.decks.A.position, gA)
  const st = useStore.getState()
  return { bTempo, notice, bSync: st.decks.B.syncActive, master: st.masterDeckId, scaled }
})
ok('B synced to A', r.bSync === true && r.master === 'A', JSON.stringify(r))
ok('B fader stays near zero — half-time, not a clamped +100%', Math.abs(r.bTempo) < 0.05, String(r.bTempo))
ok('the notice says half-time, so the 85/170 readouts do not look like a failed SYNC', /half-time/.test(r.notice ?? ''), r.notice)
ok("B's beats sit on A's beats after 4s (read at A's rate)", Math.abs(r.scaled) < 0.02, `${(r.scaled * 1000).toFixed(1)}ms`)
ok('no console errors', errors.length === 0, errors[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`
${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

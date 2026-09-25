/**
 * v0.8.39: auto SYNC in, glide back out (Shalom, 25/09). A plays a 128, B
 * holds a 120. Play on B must sync it with no SYNC press; A stopping ("the old
 * song is over") must hand master to B and glide B's fader back to 0 over
 * GLIDE_BACK_SEC — gradually, not in one step. With the setting off, Play must
 * not sync at all. Takes ~40 s: the glide is real time.
 *   node scripts/verify-auto-sync-glide.mjs   (against npm run dev on :5173)
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
const DURATION_SEC = 60
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
await page.goto(process.env.DECKMIX_URL || URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

const r = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const { settings } = await import('/src/platform/settings-idb/store.ts')
  const { GLIDE_BACK_SEC } = await import('/src/core/tempo-glide.ts')
  const wait = (ms) => new Promise((res) => setTimeout(res, ms))
  const deadline = Date.now() + 10_000
  let a, b
  while (Date.now() < deadline) {
    const { tracks } = useStore.getState().library
    a = tracks.find((t) => t.name === 'trackA')
    b = tracks.find((t) => t.name === 'trackB')
    if (a && b) break
    await wait(100)
  }
  const setup = async () => {
    await ctl.loadTrackToDeck('A', a)
    await ctl.loadTrackToDeck('B', b)
    const s = useStore.getState()
    s.patchDeck('A', { bpm: 128, beatGrid: { bpm: 128, offsetSec: 0 }, beatGridConfirmed: true })
    s.patchDeck('B', { bpm: 120, beatGrid: { bpm: 120, offsetSec: 0 }, beatGridConfirmed: true })
  }
  const out = {}

  // ── setting off: Play must not sync
  await settings.set('autoSyncGlide', false)
  await setup()
  ctl.togglePlay('A')
  await wait(200)
  ctl.togglePlay('B')
  out.offSync = useStore.getState().decks.B.syncActive
  ctl.pause('B')
  ctl.pause('A')

  // ── setting on (the default)
  await settings.set('autoSyncGlide', true)
  await setup()
  ctl.togglePlay('A')
  await wait(200)
  ctl.togglePlay('B') // no SYNC press
  let st = useStore.getState()
  out.onSync = st.decks.B.syncActive
  out.onTempo = st.decks.B.tempo
  out.onMaster = st.masterDeckId
  // A keeps playing: nothing may glide yet
  await wait(2500)
  out.stillSynced = useStore.getState().decks.B.syncActive
  out.tempoWhileBothPlay = useStore.getState().decks.B.tempo

  // ── the old song ends
  ctl.pause('A')
  await wait(3000) // the sync loop checks once a second, and wants "gone" twice in a row
  st = useStore.getState()
  out.masterAfter = st.masterDeckId
  out.bSyncAfter = st.decks.B.syncActive
  out.notice = st.notice?.text ?? null
  const samples = []
  const t0 = Date.now()
  while (Date.now() - t0 < (GLIDE_BACK_SEC + 2) * 1000) {
    samples.push(useStore.getState().decks.B.tempo)
    await wait(500)
  }
  out.samples = samples
  out.final = useStore.getState().decks.B.tempo

  // ── a track synced in *during* the glide lands exactly on the master's own tempo
  ctl.pause('B')
  await setup()
  ctl.togglePlay('A')
  await wait(200)
  ctl.togglePlay('B')
  ctl.pause('A')
  await wait(3000)
  out.glide2Master = useStore.getState().masterDeckId
  await ctl.loadTrackToDeck('A', a)
  useStore.getState().patchDeck('A', { bpm: 128, beatGrid: { bpm: 128, offsetSec: 0 }, beatGridConfirmed: true })
  ctl.togglePlay('A') // auto-syncs to B mid-glide
  out.followerSynced = useStore.getState().decks.A.syncActive
  await wait((GLIDE_BACK_SEC + 1) * 1000)
  out.followerFinal = useStore.getState().decks.A.tempo
  out.masterFinal2 = useStore.getState().decks.B.tempo
  ctl.pause('A')
  ctl.pause('B')

  // ── SYNC pressed on the gliding deck stops the glide, as the notice promises
  await setup()
  ctl.togglePlay('A')
  await wait(200)
  ctl.togglePlay('B')
  ctl.pause('A')
  await wait(3000)
  ctl.syncDeck('B')
  const frozen = useStore.getState().decks.B.tempo
  await wait(2000)
  out.frozenDrift = Math.abs(useStore.getState().decks.B.tempo - frozen)
  out.frozen = frozen
  out.unhandled = window.__unhandled
  return out
})
const s = r.samples
const steps = s.slice(1).map((v, i) => v - s[i])
const maxStep = Math.max(...steps.map(Math.abs))
ok('setting off: Play on B does not sync', r.offSync === false, String(r.offSync))
ok('setting on: Play on B syncs it with no SYNC press, A stays master', r.onSync === true && r.onMaster === 'A', JSON.stringify({ sync: r.onSync, master: r.onMaster }))
ok("B's fader is where SYNC puts a 120 under a 128 (+6.7%)", Math.abs(r.onTempo * 0.08 - 128 / 120 + 1) < 0.001, String(r.onTempo))
ok('while A still plays, B stays synced at the same tempo', r.stillSynced === true && Math.abs(r.tempoWhileBothPlay - r.onTempo) < 1e-6)
ok('A stopped → B becomes master, leaves SYNC', r.masterAfter === 'B' && r.bSyncAfter === false, JSON.stringify({ master: r.masterAfter, sync: r.bSyncAfter }))
ok('the glide is announced on screen', /gliding back to its own tempo/.test(r.notice ?? ''), r.notice)
ok('B only ever moves toward 0 — never back up', steps.every((d) => d <= 1e-9), steps.map((d) => d.toFixed(4)).join(' '))
ok('gradual: no 0.5 s step bigger than 1/40 of the distance', maxStep <= r.onTempo / 40 + 1e-6, `${maxStep.toFixed(5)} of ${r.onTempo.toFixed(4)}`)
ok('ends at exactly 0 — the track is back at its own 120', r.final === 0, String(r.final))
ok('a track synced in mid-glide follows it', r.glide2Master === 'B' && r.followerSynced === true, JSON.stringify({ m: r.glide2Master, s: r.followerSynced }))
ok('…and ends exactly where SYNC puts a 128 under a 120 — not a tick behind', Math.abs(r.followerFinal - (120 / 128 - 1) / 0.08) < 1e-6 && r.masterFinal2 === 0, `${r.followerFinal} (master ${r.masterFinal2})`)
ok('SYNC on the gliding deck stops the glide', r.frozen !== 0 && r.frozenDrift === 0, `tempo ${r.frozen}, moved ${r.frozenDrift}`)
ok('no console errors', errors.length === 0 && r.unhandled.length === 0, errors[0] ?? r.unhandled[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`
${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

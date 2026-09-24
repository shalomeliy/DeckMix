/**
 * Bar lines (every 4th beat) must be visible on the waveform canvas.
 *   node scripts/verify-waveform-bar-lines.mjs   (against npm run dev on :5173)
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
  const deadline = Date.now() + 10_000
  let a
  while (Date.now() < deadline) {
    a = useStore.getState().library.tracks.find((t) => t.name === 'trackA')
    if (a) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await ctl.loadTrackToDeck('A', a)
  useStore.getState().patchDeck('A', { bpm: 120, beatGrid: { bpm: 120, offsetSec: 0.5 }, beatGridConfirmed: true })
  await new Promise((r) => setTimeout(r, 400))
  const canvas = [...document.querySelectorAll('canvas')].find((c) => c.width > 300 && c.height > 40)
  const g = canvas.getContext('2d')
  const row = g.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data
  let amber = 0
  let white = 0
  for (let i = 0; i < row.length; i += 4) {
    if (row[i] > 240 && row[i + 1] > 170 && row[i + 2] < 110) amber++
    else if (row[i] > 90 && row[i] < 130 && Math.abs(row[i] - row[i + 2]) < 20) white++
  }
  return { amber, white, w: canvas.width, h: canvas.height }
})
ok('bar lines are drawn over the waveform (amber pixels on the middle row)', r.amber >= 2, JSON.stringify(r))
ok('no console errors', errors.length === 0, errors[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

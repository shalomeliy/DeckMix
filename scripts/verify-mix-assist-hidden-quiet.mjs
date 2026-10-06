/**
 * v0.9.29: Mix Assist leaves out entry points the incoming song ends too soon after, and no longer says how many it left out (the owner,
 * 06/10: "אין צורך להציג... שיש קטע שלא מוצג, פשוט אל תציג אותם"). Run with `npm run dev` up on 5173.
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
const FLAT_WAV = makeWav([{ sec: 90, amplitude: 8000 }], SAMPLE_RATE)
// Same shape as verify-mix-entry-energy's candidate, with a shorter tail: the build-up at 0:05 still has 24 bars after its mix, the
// breakdown at 0:30 does not. Late.wav is 20 s long, so its build-up does not either.
const shape = (tail) => makeWav([{ sec: 5, amplitude: 800 }, { sec: 25, amplitude: 8000 }, { sec: 6, amplitude: 5200 }, { sec: tail, amplitude: 8000 }], SAMPLE_RATE)

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
await page.addInitScript(harness({ 'Flat.wav': FLAT_WAV, 'Some.wav': shape(34), 'Late.wav': makeWav([{ sec: 5, amplitude: 800 }, { sec: 15, amplitude: 8000 }], SAMPLE_RATE) }))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
const row = (text) => page.locator('tbody tr', { hasText: new RegExp(text) })
await row('Flat').dblclick()
await page.waitForTimeout(700)
await page.keyboard.press('KeyQ')
await page.waitForTimeout(300)
const deckB = page.locator('section').nth(2)
const panel = deckB.locator('div.absolute.left-0.top-full')

for (const [name, want] of [['Some', 1], ['Late', 0]]) {
  // Eject first: a double-click loads only into an empty deck, and B already holds the first song on the second pass.
  await page.evaluate(async () => (await import('/src/controls.ts')).ejectDeck('B'))
  await page.waitForTimeout(300)
  await row(name).dblclick()
  await page.waitForTimeout(2000)
  const text = (await panel.innerText()).replace(/\n/g, ' / ')
  const shown = await panel.locator('button', { hasText: /energy builds|quieter passage|drop|energy/i }).count()
  console.log(`  ${name}: ${text}`)
  ok(`${name}: ${want} energy point offered`, shown === want, `found ${shown}`)
  ok(`${name}: nothing on screen counts hidden points`, !/לא מוצג|not shown/.test(text))
  ok(`${name}: no testid for a hidden-points line`, (await panel.locator('[data-testid$="too-late"]').count()) === 0)
  if (want === 0) ok(`${name}: the empty section still says why, without counting`, /No transition point leaves enough of this song after the mix/.test(text))
}
ok('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

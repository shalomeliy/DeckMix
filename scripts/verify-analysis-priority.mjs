/**
 * v0.8.32 verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-analysis-priority.mjs
 *
 * A track with no BPM/key tag must be analysed ahead of tracks whose tags
 * already carry both, even when it is last in folder order. The pure pick
 * (`core/analysis-order.ts`) has a unit test; this checks the part that test
 * can't: that `Library.tsx`'s `lacksBpmOrKey` sees the tag pass's results in
 * the live store by the time the analysis workers pick. If it didn't, every
 * track would look urgent and the queue would fall back to folder order —
 * which is the 25/09 bug, silently back.
 *
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` seam as
 * `verify-analysis-queue.mjs`. Tagged files carry a real ID3v2.3 `id3 ` chunk
 * (TBPM + TKEY), read by the app's own `readTags`.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function id3Chunk(bpm, key) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')])
    const h = Buffer.alloc(10)
    h.write(id, 0, 'latin1')
    h.writeUInt32BE(body.length, 4)
    return Buffer.concat([h, body])
  }
  const frames = Buffer.concat([frame('TBPM', String(bpm)), frame('TKEY', key)])
  const head = Buffer.alloc(10)
  head.write('ID3', 0, 'latin1')
  head[3] = 3
  const n = frames.length // syncsafe
  head[6] = (n >> 21) & 0x7f
  head[7] = (n >> 14) & 0x7f
  head[8] = (n >> 7) & 0x7f
  head[9] = n & 0x7f
  return Buffer.concat([head, frames])
}

function makeWav(durationSec, sampleRate, hz, tag) {
  const numSamples = Math.round(durationSec * sampleRate)
  const pcm = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * hz * i) / sampleRate)), i * 2)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(1, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(sampleRate * 2, 16)
  fmt.writeUInt16LE(2, 20)
  fmt.writeUInt16LE(16, 22)
  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0, 'latin1')
  dataHead.writeUInt32LE(pcm.length, 4)
  let extra = Buffer.alloc(0)
  if (tag) {
    let id3 = id3Chunk(tag.bpm, tag.key)
    if (id3.length % 2) id3 = Buffer.concat([id3, Buffer.from([0])])
    const h = Buffer.alloc(8)
    h.write('id3 ', 0, 'latin1')
    h.writeUInt32LE(id3.length, 4)
    extra = Buffer.concat([h, id3])
  }
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, dataHead, pcm, extra])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body]).toString('base64')
}

// Four complete tracks first in folder order, the untagged one last. Distinct
// tones so each hashes differently — identical bytes would share a cache entry
// and the later ones would settle instantly, hiding the order.
const FILES = [
  ['a1-tagged.wav', makeWav(40, 8000, 2, { bpm: 124, key: 'Am' })],
  ['a2-tagged.wav', makeWav(40, 8000, 3, { bpm: 125, key: 'C' })],
  ['a3-tagged.wav', makeWav(40, 8000, 4, { bpm: 126, key: 'Dm' })],
  ['a4-tagged.wav', makeWav(40, 8000, 5, { bpm: 127, key: 'G' })],
  ['z-untagged.wav', makeWav(40, 8000, 6, null)],
]

function harness() {
  return `(() => {
  const FILES = ${JSON.stringify(FILES)};
  const makeFile = (name, b64) => ({
    kind: 'file',
    name,
    getFile: async () => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'audio/wav' }),
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      for (const [n, b] of FILES) yield [n, makeFile(n, b)];
    },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
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
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } });
})()`
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness())
await page.goto(URL, { waitUntil: 'domcontentloaded' })

// Record the order tracks enter 'analyzing', from the app's own store module.
await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  window.__order = []
  const seen = new Set()
  const note = (s) => {
    for (const t of s.library.tracks) {
      if (t.analysisState === 'analyzing' && !seen.has(t.name)) {
        seen.add(t.name)
        window.__order.push({ name: t.name, bpm: t.bpm ?? null, camelot: t.camelot ?? null })
      }
    }
  }
  note(useStore.getState())
  useStore.subscribe(note)
})

const deadline = Date.now() + 60000
let order = []
while (Date.now() < deadline) {
  order = await page.evaluate(() => window.__order)
  if (order.length === FILES.length) break
  await page.waitForTimeout(200)
}
const names = order.map((o) => o.name)
ok('every track entered analysis', order.length === FILES.length, JSON.stringify(names))
const tagged = order.filter((o) => o.name.includes('-tagged'))
ok('tagged tracks had BPM and key in the store when picked', tagged.every((o) => o.bpm != null && o.camelot), JSON.stringify(tagged))
// Two workers start together, so the untagged track must be in the first pair.
const zAt = names.findIndex((n) => n.startsWith('z-untagged'))
ok('the untagged track (last in the folder) is among the first two analysed', zAt >= 0 && zAt < 2, `position ${zAt + 1} of ${names.length}`)
ok('no page errors', errors.length === 0, errors[0])

await browser.close()
process.exit(results.every((r) => r.pass) ? 0 : 1)

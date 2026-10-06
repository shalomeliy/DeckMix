/**
 * v0.9.45 verification — the deck said 75 BPM while the library row said 150 (Shalom, 06/10, a hip-hop WAV). Run against
 * `npm run dev` on :5173:
 *
 *   node scripts/verify-owner-bpm-grid.mjs
 *
 * Cause: a beat grid the owner had saved at 75 always won on the deck, over the 150 he later typed in "Check against Beatport" —
 * whose own message promised the new BPM "applies the next time you load this track". Each case seeds IndexedDB (in-memory stand-in,
 * the same one `verify-grid-correction.mjs` uses) and reads the deck's BPM off the screen. The track is a 150 bpm click WAV.
 * Also measures that the tempo fader moves the playback speed (the second half of the report).
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function syncsafe32(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}
function id3Tag(bpm) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(String(bpm), 'latin1')])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  const frame = Buffer.concat([Buffer.from('TBPM', 'ascii'), size, Buffer.from([0, 0]), payload])
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frame.length), frame])
}
function buildClickWav(bpm, { durationSec = 20, sampleRate = 8000, tagged = true } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const pcm = Buffer.alloc(numSamples * 2)
  const beatSamples = Math.round((60 / bpm) * sampleRate)
  for (let i = 0; i < numSamples; i++) {
    const inBeat = i % beatSamples
    const v = inBeat < 80 ? 20000 * Math.exp(-inBeat / 15) * (inBeat % 2 ? 1 : -1) : 0
    pcm.writeInt16LE(Math.round(v), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const tag = id3Tag(bpm)
  const tagPadded = tag.length % 2 === 0 ? tag : Buffer.concat([tag, Buffer.from([0])])
  const chunk = (id, body) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', pcm), ...(tagged ? [chunk('ID3 ', tagPadded)] : [])])
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body])
}

const TAGGED = buildClickWav(150, { durationSec: 40 })
const UNTAGGED = buildClickWav(150, { durationSec: 40, tagged: false })

function harness(seed, meta, wavBytes = TAGGED) {
  const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
  const GRID_KEY = 'deckmix:gridCorrection:' + CONTENT_HASH
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const bytes = Uint8Array.from(atob(${JSON.stringify(wavBytes.toString('base64'))}), (c) => c.charCodeAt(0));
  const makeFile = (name) => ({ kind: 'file', name, getFile: async () => new File([bytes], name, { type: 'audio/wav' }) });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { yield ['clicks.wav', makeFile('clicks.wav')]; },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  ${seed !== undefined ? `mem.set(${JSON.stringify(GRID_KEY)}, ${JSON.stringify(seed)});` : ''}
  ${meta ? `mem.set('deckmix:trackMeta', { [${JSON.stringify(CONTENT_HASH)}]: ${JSON.stringify(meta)} });` : ''}
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
  // The app's own module instance, not a second copy: Vite serves a file
  // edited since the dev server started as \`store.ts?t=…\`, and a plain
  // import('/src/app/state/store.ts') would get a fresh, empty store.
  window.__import = (path) => {
    const loaded = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(loaded ?? path);
  };
  window.__readGrid = () => mem.get(${JSON.stringify(GRID_KEY)});
})()`
}



const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const GRID75 = { schema: 1, grid: { bpm: 75, offsetSec: 0 }, source: 'owner', savedAt: 1 }
async function run(seed, meta, fn, wav) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(seed, meta, wav))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.locator('tbody tr').first().dblclick()
  for (let i = 0; i < 80; i++) {
    const has = await page.evaluate(async () => (await window.__import('/src/app/state/store.ts')).useStore.getState().decks.A.beatGrid != null)
    if (has) break
    await page.waitForTimeout(250)
  }
  const st = await page.evaluate(async () => {
    const s = (await window.__import('/src/app/state/store.ts')).useStore.getState()
    return { origin: s.decks.A.bpmOrigin, shown: document.querySelector('[aria-label="Edit beat grid"]')?.textContent, deckBpm: s.decks.A.bpm, rowBpm: s.library.tracks[0].bpm, notice: s.notice?.text ?? '' }
  })
  try {
    await fn(st, page)
  } finally {
    ok('no page errors', errors.length === 0, errors[0])
    await page.close()
  }
}
// Track seconds per second of the audio clock, not of the wall clock: headless Chromium's audio runs a few percent off wall time.
const rate = async (page) => {
  const p = () => page.evaluate(async () => { const { engine } = await window.__import('/src/platform/audio-webaudio/engine.ts'); return [engine.decks.A.position, engine.currentTime] })
  const [a, ta] = await p(); await page.waitForTimeout(2000); const [b, tb] = await p()
  return (b - a) / (tb - ta)
}

await run(GRID75, { owner: { bpm: 150 } }, async (st, page) => {
  ok('typed 150 over a grid saved at 75: the deck shows 150', st.shown === '150.0BPM' && st.deckBpm === 150, JSON.stringify(st))
  ok('typed 150: the row still shows 150', st.rowBpm === 150)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).togglePlay('A'))
  const r0 = await rate(page)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).setTempo('A', 1))
  const rUp = await rate(page)
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).setTempo('A', -1))
  const rDown = await rate(page)
  ok('tempo fader top: plays ~8% faster than at centre', Math.abs(rUp - 1.08) < 0.01, `${r0.toFixed(3)} → ${rUp.toFixed(3)}`)
  ok('tempo fader bottom: plays ~8% slower than at centre', Math.abs(rDown - 0.92) < 0.01, `${r0.toFixed(3)} → ${rDown.toFixed(3)}`)
})
// v0.9.45b — the owner's real case: nothing typed, a grid saved at 75 for its phase (a check, a nudge, a tagging answer), the song is 150.
await run(GRID75, undefined, async (st, page) => {
  ok('file tag 150, grid saved at 75 not by hand: the deck shows 150', st.shown === '150.0BPM' && st.rowBpm === 150, JSON.stringify(st))
  await page.getByRole('button', { name: 'Edit beat grid' }).first().click()
  const panel = await page.getByTestId('bpm-origin').textContent()
  ok('the grid panel says where the BPM came from and what each source said', /From: the beat grid you saved, counted like the file's tag/.test(panel) && /Saved grid 75 · File tag 150/.test(panel), panel)
  await page.getByTestId('bpm-origin').locator('xpath=..').getByRole('button', { name: '÷2' }).click()
  await page.waitForTimeout(300)
  const rec = await page.evaluate(() => window.__readGrid())
  ok('÷2 by hand is saved as a tempo set by hand', rec?.tempoByHand === true && rec.grid.bpm === 75, JSON.stringify(rec))
  await page.evaluate(async () => (await window.__import('/src/controls.ts')).nudgeBeatGrid('A', 0.01))
  await page.waitForTimeout(300)
  const rec2 = await page.evaluate(() => window.__readGrid())
  ok('a nudge after ÷2 keeps it a tempo set by hand', rec2?.tempoByHand === true && rec2.grid.bpm === 75, JSON.stringify(rec2))
  const panel2 = await page.getByTestId('bpm-origin').textContent()
  ok('after the edit the panel says the saved grid, no longer recounted', /From: the beat grid you saved/.test(panel2) && !/counted like/.test(panel2), panel2)
})
await run(GRID75, undefined, async (st) => {
  ok('no tag, the sound says 150, grid saved at 75 not by hand: the deck shows 150', st.shown === '150.0BPM', JSON.stringify(st))
}, UNTAGGED)
await run({ ...GRID75, tempoByHand: true }, undefined, async (st) => {
  ok('grid halved to 75 by hand: his 75 still wins over the tag', st.deckBpm === 75 && st.rowBpm === 75, JSON.stringify(st))
})
await run({ ...GRID75, tempoByHand: true }, { owner: { bpm: 150 } }, async (st) => {
  ok('÷2 by hand beats even a typed 150: the press is the later answer', st.deckBpm === 75, JSON.stringify(st))
})
await run(GRID75, { owner: { bpm: 100 } }, async (st) => {
  ok('typed 100 over a grid at 75 (not an octave): the checked grid stays', st.deckBpm === 75, JSON.stringify(st))
  ok('typed 100: the screen says the two disagree', /you set 100 BPM, but the beat grid you fixed says 75/.test(st.notice), st.notice)
})
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)

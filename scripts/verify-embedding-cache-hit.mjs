/**
 * v0.8.5 M3 step 2 verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-embedding-cache-hit.mjs
 *
 * The bug this checks for: before this fix, `queueLibraryAnalysis` only ever
 * set `embedding`/`embeddingState` on an analysis CACHE-MISS (a brand new
 * track). A track whose analysis was already cached — every track on a
 * second scan of the same folder, which is every track on a real reload —
 * never got its embedding surfaced at all, even though a valid vector was
 * already sitting in `embeddingCache`. Reproduced here by scanning the same
 * fake folder twice in one page session: the first scan is a genuine miss
 * (computes + caches both analysis and embedding), the second is a genuine
 * hit (the fake `indexedDB`'s backing `Map` persists across both calls) —
 * exactly the path that was silently dropping the embedding before this fix.
 *
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` harness as
 * `verify-analysis-queue.mjs`.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function makeWav(durationSec, sampleRate) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2
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
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  const view16 = new Int16Array(buf, 44)
  for (let i = 0; i < numSamples; i++) {
    view16[i] = Math.round(3000 * Math.sin((2 * Math.PI * 2 * i) / sampleRate))
  }
  return Buffer.from(buf)
}

const WAV_BASE64 = makeWav(45, 8000).toString('base64')

function harness() {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const bytes = Uint8Array.from(atob(${JSON.stringify(WAV_BASE64)}), (c) => c.charCodeAt(0));
  const makeFile = (name, bytes) => ({
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
      yield ['track-one.wav', makeFile('track-one.wav', bytes)];
    },
  });

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => makeDir('Tracks'),
  });

  // Persists across BOTH scans in this page session — the whole point:
  // the second scan's analysis cache lookup must genuinely hit what the
  // first scan wrote, not a fresh empty store.
  const mem = new Map();
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
await page.waitForTimeout(300)

const folderButton = page.getByRole('button', { name: /Load my music folder|Change folder/ }).first()

// `page.waitForFunction` with an async predicate was observed NOT to await
// the returned promise correctly in this harness (resolved on the first
// poll regardless of the real value) — manual polling via plain
// `page.evaluate` calls, confirmed against a standalone debug script, is
// what actually waits for the real state.
async function readTrack() {
  return page.evaluate(async () => {
    const { useStore } = await import('/src/app/state/store.ts')
    const t = useStore.getState().library.tracks.find((t) => t.name === 'track-one')
    return t
      ? {
          hasEmbedding: !!t.embedding && t.embedding.length > 0,
          embeddingState: t.embeddingState,
          embeddingError: t.embeddingError,
          analysisState: t.analysisState,
          analysisError: t.analysisError,
          contentHash: t.contentHash,
        }
      : null
  })
}

async function waitForEmbedded(opts = {}) {
  // `waitForReset`: for the second scan, the store still holds scan 1's
  // already-'analyzed' track for a moment after the click — without first
  // observing the fresh scan actually reset the state, this could read
  // scan 1's leftover result and never really exercise scan 2 at all.
  if (opts.waitForReset) {
    const resetDeadline = Date.now() + 3000
    while (Date.now() < resetDeadline) {
      const t = await readTrack()
      if (t?.analysisState !== 'analyzed') break
      await page.waitForTimeout(100)
    }
  }
  // v0.8.32: a cache MISS no longer computes the embedding in the analysis
  // pass — `queueEmbeddingBackfill` does it right after — so scan 1 waits for
  // the embedding to settle too. Scan 2 does not: on a hit the vector must
  // already be on the row the moment analysis settles, which is the bug above.
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const t = await readTrack()
    const settled = !opts.untilEmbedded || t?.embeddingState === 'embedded' || t?.embeddingState === 'failed'
    if (t?.analysisState === 'analyzed' && settled) return t
    await page.waitForTimeout(300)
  }
  throw new Error('timed out waiting for analysisState to reach "analyzed"')
}

// ── scan 1: genuine cache miss ──────────────────────────────────────────────
await folderButton.click()
const afterFirst = await waitForEmbedded({ untilEmbedded: true })
ok('scan 1 (miss): embedding present', afterFirst?.hasEmbedding === true, JSON.stringify(afterFirst))
ok('scan 1 (miss): embeddingState is embedded', afterFirst?.embeddingState === 'embedded', afterFirst?.embeddingState)

// ── scan 2: same folder, genuine cache hit ──────────────────────────────────
await folderButton.click()
const afterSecond = await waitForEmbedded({ waitForReset: true })
ok('scan 2 (hit): embedding present', afterSecond?.hasEmbedding === true, JSON.stringify(afterSecond))
ok('scan 2 (hit): embeddingState is embedded', afterSecond?.embeddingState === 'embedded', afterSecond?.embeddingState)

ok('no console errors', errors.length === 0, errors[0])
ok('no unhandled rejections', (await page.evaluate(() => window.__unhandled)).length === 0)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

/**
 * v0.4.0 step 8 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-analysis-queue.mjs
 *
 * `queueLibraryAnalysis` (source-fsaccess/library.ts) and the Library.tsx
 * icon/badges it drives have no automated test — they need a real scan, a
 * real decode, and real elapsed time to observe a "still running" state, not
 * just a settled one. Same fake-`showDirectoryPicker`/fake-`indexedDB` seam
 * as the other v0.4.0 verify scripts. One track is a real, sizeable WAV (long
 * enough that analysis takes a real, observable moment); one is deliberately
 * not a WAV at all, so `decodeAudioData` throws and the queue's per-track
 * try/catch has to prove it doesn't stall on it.
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
  // A faint tone rather than pure silence — gives detectBeatGrid's
  // autocorrelation real samples to chew on instead of an instant all-zero
  // return, which is what actually makes this track's analysis take a
  // real, observable moment.
  const view16 = new Int16Array(buf, 44)
  for (let i = 0; i < numSamples; i++) {
    view16[i] = Math.round(3000 * Math.sin((2 * Math.PI * 2 * i) / sampleRate))
  }
  return Buffer.from(buf)
}

const GOOD_WAV_BASE64 = makeWav(45, 8000).toString('base64')

function harness() {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const goodBase64 = ${JSON.stringify(GOOD_WAV_BASE64)};
  const goodBytes = Uint8Array.from(atob(goodBase64), (c) => c.charCodeAt(0));
  // Not a WAV at all — decodeAudioData rejects this, which is exactly what
  // this scenario needs from it.
  const brokenBytes = new TextEncoder().encode('this is not audio, at all');

  const FILES = [
    ['a-real-track.wav', goodBytes],
    ['b-real-track.wav', goodBytes],
    ['c-broken.wav', brokenBytes],
    ['d-vanished.wav', null],
  ];
  const makeFile = (name, bytes) => ({
    kind: 'file',
    name,
    // null bytes = a file that vanished or lost permission after the scan (v0.8.29 review):
    // getFile itself rejects, in the hash pass, before any decode
    getFile: async () => {
      if (bytes === null) throw new DOMException('A requested file or directory could not be found', 'NotFoundError');
      return new File([bytes], name, { type: 'audio/wav' });
    },
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      for (const [name, bytes] of FILES) yield [name, makeFile(name, bytes)];
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

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
})

const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness())
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)

const rows = page.locator('tbody tr')
ok('all four files are listed', (await rows.count()) === 4, `${await rows.count()} rows`)

const headerBadge = (text) => page.getByText(text, { exact: false })

// ── 1. the queue is genuinely still running shortly after the scan ─────────
{
  const queuedText = await headerBadge(/\d+ queued/).first().innerText().catch(() => null)
  ok('mid-run: header shows a live "N queued" badge', queuedText !== null, queuedText ?? 'not found')
}

// ── 2. wait for it to finish, then check the settled state ─────────────────
await page.waitForFunction(
  () => ![...document.querySelectorAll('span')].some((s) => /\d+ queued/.test(s.textContent || '')),
  { timeout: 20000 },
)
await page.waitForTimeout(200)

{
  const failedText = await headerBadge(/2 analysis failed/).first().innerText().catch(() => null)
  ok('settled: header shows exactly 2 analysis failed (bad audio + unreadable file)', failedText !== null, failedText ?? 'not found')
}

{
  const queuedGone = (await page.getByText(/\d+ queued/).count()) === 0
  ok('settled: the "queued" badge is gone once the queue drains', queuedGone)
}

// ── 3. the broken file's row names a reason, the good ones show no dot ─────
{
  const brokenRow = page.locator('tbody tr', { hasText: 'c-broken' })
  const dot = brokenRow.locator('[title^="Background analysis failed"]')
  ok('broken row: carries a failed-analysis dot', (await dot.count()) === 1)
  const title = await dot.getAttribute('title')
  ok('broken row: the tooltip names a reason, not just "failed"', (title?.length ?? 0) > 'Background analysis failed'.length,
    title ?? '')

  const vanishedDot = page.locator('tbody tr', { hasText: 'd-vanished' }).locator('[title^="Background analysis failed"]')
  ok('unreadable file: a failed dot too, not silently dropped', (await vanishedDot.count()) === 1)
  ok('unreadable file: the tooltip carries the read error', /could not be found/.test((await vanishedDot.getAttribute('title').catch(() => '')) ?? ''))

  const goodRow = page.locator('tbody tr', { hasText: 'a-real-track' })
  const goodDots = await goodRow.locator('[title="Analyzing…"], [title="Queued for background analysis"], [title^="Background analysis failed"]').count()
  ok('good row: no leftover queued/analyzing/failed dot once analyzed', goodDots === 0)
}

ok('no console errors across the whole run', errors.length === 0, errors[0])
ok('no unhandled rejections', (await page.evaluate(() => window.__unhandled)).length === 0)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

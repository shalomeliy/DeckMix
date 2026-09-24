/**
 * v0.4.0 step 7 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-padgrid.mjs
 *
 * `PadGrid.tsx`'s hover-`×`, kept `Shift`+click, and native drag-and-drop
 * relocate/swap have no automated test — jsdom has no drag events and no
 * hover state. Same fake-`showDirectoryPicker`/fake-`indexedDB` seam as
 * `verify-cues.mjs`, seeded this time with three hot cues so relocate and
 * swap both have something real to move.
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

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
  return Buffer.from(buf)
}

const SAMPLE_RATE = 8000
const DURATION_SEC = 6
const wavBytes = makeWav(DURATION_SEC, SAMPLE_RATE)
const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
const WAV_BASE64 = wavBytes.toString('base64')
const CUES_KEY = 'deckmix:cues:' + CONTENT_HASH

// Three seeded cues on pads 1/2/3 (0-indexed 0/1/2), each at a distinct,
// whole-second position so the mm:ss readout tells them apart unambiguously.
const SEEDED = {
  hotCues: [
    { index: 0, positionSec: 1, label: '1', color: '#ff0055' },
    { index: 1, positionSec: 2, label: '2', color: '#00c8ff' },
    { index: 2, positionSec: 5, label: '3', color: '#ffcc00' },
  ],
  cuePointSec: 0,
}

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
      yield ['silence.wav', makeFile('silence.wav')];
    },
  });

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => makeDir('Tracks'),
  });

  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  mem.set(${JSON.stringify(CUES_KEY)}, ${JSON.stringify(SEEDED)});
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

  window.__readCues = () => mem.get(${JSON.stringify(CUES_KEY)});
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
await page.waitForTimeout(1000)
await page.locator('tbody tr').first().dblclick()
await page.waitForTimeout(600)

// `<Deck deckId="A" />` renders first among the two `<section>` decks.
const deckA = page.locator('section').nth(0)
const pad = (i) => deckA.getByRole('button', { name: new RegExp(`(Jump to|Set) hot cue ${i + 1}$`) })
const del = (i) => deckA.getByRole('button', { name: `Delete hot cue ${i + 1}` })

// ── 1. hover reveals the × (opacity 0 -> 1), and it isn't visible at rest ──
{
  const before = await del(0).evaluate((el) => getComputedStyle(el).opacity)
  ok('at rest: delete × is not visible on an occupied pad', before === '0', before)
  await pad(0).hover()
  await page.waitForTimeout(150)
  const after = await del(0).evaluate((el) => getComputedStyle(el).opacity)
  ok('hover: delete × becomes visible', after === '1', after)
}

// ── 2. clicking the hover × deletes pad 1, and it persists ─────────────────
{
  await del(0).click()
  await page.waitForTimeout(150)
  const label = await pad(0).getAttribute('aria-label')
  ok('×: pad 1 is empty after clicking its ×', label === 'Set hot cue 1', label)
  const stored = await page.evaluate(() => window.__readCues())
  const still = (stored?.hotCues ?? []).some((c) => c.index === 0)
  ok('×: deletion persisted to cues-idb', !still, JSON.stringify(stored?.hotCues))
}

// ── 3. Shift+click still deletes (pad 2) ────────────────────────────────────
{
  await pad(1).click({ modifiers: ['Shift'] })
  await page.waitForTimeout(150)
  const label = await pad(1).getAttribute('aria-label')
  ok('shift-click: pad 2 is empty after shift-click', label === 'Set hot cue 2', label)
}

// Re-set pads 1 and 2 at known positions so drag tests below have two
// occupied pads to work with (pad 3 from the original seed is untouched).
{
  await pad(0).click() // sets pad 1 at whatever the current playhead is (0)
  await page.waitForTimeout(120)
  const label = await pad(0).getAttribute('aria-label')
  ok('setup: pad 1 re-armed for the drag tests', label === 'Jump to hot cue 1', label)
}

// ── 4. drag an occupied pad onto an EMPTY pad: relocate ─────────────────────
{
  // pad 2 (index 1) is empty (deleted in step 3); pad 3 (index 2) still
  // holds the original seeded cue at 5s. Drag pad 3 -> pad 2: relocate.
  await pad(2).dragTo(pad(1))
  await page.waitForTimeout(150)
  const sourceLabel = await deckA
    .getByRole('button', { name: /(Jump to|Set) hot cue 3$/ })
    .getAttribute('aria-label')
  ok('relocate: source pad 3 is empty after the drag', sourceLabel === 'Set hot cue 3', sourceLabel)
  const targetLabel = await pad(1).getAttribute('aria-label')
  ok('relocate: target pad 2 now holds the moved cue', targetLabel === 'Jump to hot cue 2', targetLabel)
  await pad(1).click()
  await page.waitForTimeout(150)
  const posEl = deckA
    .locator('[class="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted"]')
    .locator('span')
    .nth(2)
  const pos = await posEl.innerText()
  ok('relocate: the moved cue kept its original time (0:05)', pos === '0:05', pos)
}

// ── 5. drag an occupied pad onto ANOTHER occupied pad: swap ────────────────
{
  // pad 1 (index 0, at 0s from the re-arm in step 3) and pad 2 (index 1, at
  // 5s from the relocate in step 4) are both occupied. Drag pad 1 -> pad 2.
  await pad(0).dragTo(pad(1))
  await page.waitForTimeout(150)
  const label1 = await pad(0).getAttribute('aria-label')
  const label2 = await pad(1).getAttribute('aria-label')
  ok('swap: both pads still hold a cue after the swap', label1 === 'Jump to hot cue 1' && label2 === 'Jump to hot cue 2',
    `${label1} / ${label2}`)
  await pad(0).click()
  await page.waitForTimeout(150)
  const posEl = deckA
    .locator('[class="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted"]')
    .locator('span')
    .nth(2)
  const pos = await posEl.innerText()
  ok('swap: pad 1 now carries what pad 2 held (0:05)', pos === '0:05', pos)
}

ok('no console errors across the whole run', errors.length === 0, errors[0])

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

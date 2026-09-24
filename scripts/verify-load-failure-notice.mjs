/**
 * Verifies the fix for the "decode failure vanishes silently" bug reported
 * against `loadTrackToDeck` (src/controls.ts): a corrupt file — or one whose
 * extension matches AUDIO_EXT but whose bytes Chromium's decodeAudioData
 * can't actually play — used to reset the deck's `loading` flag and then
 * throw into an unawaited promise (every call site does `void
 * ctl.loadTrackToDeck(...)` with no `.catch`), so the failure only ever
 * showed up as an unhandled rejection in the console. The fix surfaces it
 * through the existing notice banner instead (the same mechanism
 * setTrackGenre already uses for its own async failure) and stops
 * re-throwing.
 *
 * Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-load-failure-notice.mjs
 *
 * Reuses the showDirectoryPicker / IndexedDB shim from verify-library-boot.mjs.
 * The harness's fake files are already undecodable (plain zero bytes, no
 * audio container), so no separate decodeAudioData shim is needed — picking
 * one of them to a deck IS the corrupt-file case this test exercises.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function harness(entries) {
  return `(() => {
  const FILES = ${JSON.stringify(entries)};
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const makeFile = (name) => ({
    kind: 'file',
    name,
    getFile: async () => new File([new Uint8Array(64)], name),
  });
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () {
      for (const f of FILES) yield [f, makeFile(f)];
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

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
})

// 1. double-click an undecodable row in the Library table (Library.tsx)
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(['Corrupt Track - One.mp3', 'Corrupt Track - Two.mp3']))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  const rows = await page.locator('tbody tr').count()
  ok('setup: library loaded with 2 rows', rows === 2, `${rows} rows`)

  await page.locator('tbody tr').first().dblclick()
  await page.waitForTimeout(600)

  const notice = await page.getByText(/Corrupt Track - One".*didn't load/).count()
  ok('double-click: the notice names the track and says it did not load', notice === 1)
  const stillLoading = await page.getByText(/Loading/i).count()
  ok('double-click: the deck is not stuck on "Loading"', stillLoading === 0)
  const unhandled = await page.evaluate(() => window.__unhandled)
  ok('double-click: no unhandled promise rejection', unhandled.length === 0, unhandled.join('; '))
  ok('double-click: no page error', errors.length === 0, errors.join('; '))

  await page.close()
}

// 2. drag a second undecodable row onto Deck B (Deck.tsx onDrop)
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(['Corrupt Track - One.mp3', 'Corrupt Track - Two.mp3']))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  const deckCount = await page.locator('section.panel').count()
  ok('setup: four panels found (deck A, mixer, deck B, library)', deckCount === 4, `${deckCount}`)

  // Synthesize the drag: fire a real 'dragstart' on the second row so the
  // app's own onDragStart handler (Library.tsx) is what populates the
  // DataTransfer with the track id — this test never has to know the id
  // itself. Then hand that same DataTransfer to a 'drop' on Deck B's panel
  // (the third `section.panel`: deck A, mixer, deck B, library, in DOM
  // order), which is exactly what Deck.tsx's onDrop reads from.
  await page.evaluate(() => {
    const row = document.querySelectorAll('tbody tr')[1]
    const target = document.querySelectorAll('section.panel')[2]
    const dt = new DataTransfer()
    const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragStart, 'dataTransfer', { value: dt })
    row.dispatchEvent(dragStart)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dt })
    target.dispatchEvent(drop)
  })
  await page.waitForTimeout(600)

  const notice = await page.getByText(/Corrupt Track - Two".*didn't load/).count()
  ok('drop: the notice names the dropped track and says it did not load', notice === 1)
  const unhandled = await page.evaluate(() => window.__unhandled)
  ok('drop: no unhandled promise rejection', unhandled.length === 0, unhandled.join('; '))
  ok('drop: no page error', errors.length === 0, errors.join('; '))

  await page.close()
}

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

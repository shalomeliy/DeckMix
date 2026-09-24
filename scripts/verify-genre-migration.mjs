/**
 * v0.4.0 step 9 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-genre-migration.mjs
 *
 * Two scenarios, both from `workshop-output/PLAN.md`'s own step 9
 * verification plan:
 *
 * 1. Migration mechanics: with a pre-existing path-keyed override present,
 *    scanning re-keys it into the hash-keyed store and leaves the original
 *    entry alone (Risk 3's stated rollback — non-destructive).
 * 2. The actual bug this fixes: a hash-keyed override on a file now sitting
 *    in a *different* genre folder than the one the override was made in
 *    still wins, once the background queue gives that file an identity to
 *    look the override up by — not the freshly-derived folder genre.
 *
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` seam as the other v0.4.0
 * verify scripts.
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

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
})

function harness({ folder, fileName, seedPathOverride, seedHashOverride }) {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));

  const FOLDER = ${JSON.stringify(folder)};
  const FILE_NAME = ${JSON.stringify(fileName)};
  const bytes = ${JSON.stringify(WAV_BASE64)};
  const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
  const makeFile = (name) => ({
    kind: 'file',
    name,
    getFile: async () => new File([raw], name, { type: 'audio/wav' }),
  });
  const leaf = (name) => ({ kind: 'directory', name, queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { yield [FILE_NAME, makeFile(FILE_NAME)]; } });
  const root = {
    kind: 'directory',
    name: 'Tracks',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { yield [FOLDER, leaf(FOLDER)]; },
  };

  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => root });

  const mem = new Map();
  mem.set('deckmix:libraryDir', root);
  ${seedPathOverride ? `mem.set('deckmix:genreOverrides', ${JSON.stringify(seedPathOverride)});` : ''}
  ${seedHashOverride ? `mem.set('deckmix:genreOverridesByHash', ${JSON.stringify(seedHashOverride)});` : ''}
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

  window.__readStore = (key) => mem.get(key);
})()`
}

const wavBytes = makeWav(3, 8000)
const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
const WAV_BASE64 = wavBytes.toString('base64')

// ── Scenario 1: migration mechanics — an unmoved file, old override present ─
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(
    harness({
      folder: 'House',
      fileName: 'track.wav',
      seedPathOverride: { 'House/track.wav': 'Trance' },
    }),
  )
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  // The row shows the override applied instantly, via the old path-keyed
  // store — proves nothing regressed for the common "hasn't moved" case.
  // The genre cell holds a controlled <select>, so its value (not innerText,
  // unreliable across browsers for a <select>) is the source of truth.
  const genreSelect = page.locator('tbody tr').first().locator('td').nth(2).locator('select')
  // Polls up to 5 s instead of reading once at +600 ms: the override is
  // applied after an async IndexedDB read, and a fixed wait passed three full
  // runs and failed the fourth (2026-09-24). "Immediately" here means without
  // waiting for analysis to hash the file, not within a set number of ms.
  await page
    .waitForFunction(
      () => document.querySelector('tbody tr td:nth-child(3) select')?.value === 'Trance',
      null,
      { timeout: 5000 },
    )
    .catch(() => {})
  ok('unmoved file: override applies immediately from the old store', (await genreSelect.inputValue()) === 'Trance')

  // Wait for the background queue to reach it and the migration to settle.
  await page.waitForFunction(
    () => ![...document.querySelectorAll('span')].some((s) => /\d+ queued/.test(s.textContent || '')),
    { timeout: 20000 },
  )
  await page.waitForTimeout(200)

  const oldStore = await page.evaluate(() => window.__readStore('deckmix:genreOverrides'))
  ok('migration: the old path-keyed store is untouched (Risk 3 rollback)',
    JSON.stringify(oldStore) === JSON.stringify({ 'House/track.wav': 'Trance' }), JSON.stringify(oldStore))

  const newStore = await page.evaluate(() => window.__readStore('deckmix:genreOverridesByHash'))
  ok('migration: the new hash-keyed store carries the re-keyed entry',
    newStore?.[CONTENT_HASH] === 'Trance', JSON.stringify(newStore))

  const migrated = await page.evaluate(() => window.__readStore('deckmix:genreOverrides:migratedToHash'))
  ok('migration: the guard flag is set so it never re-runs', migrated === true, String(migrated))

  ok('scenario 1: no console errors', errors.length === 0, errors[0])
  await page.close()
}

// ── Scenario 2: the actual fix — file now sits in a DIFFERENT genre folder ──
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(
    harness({
      // The same file content (same hash), now scanned from a different
      // folder than whatever it was in when the override was made — the
      // exact v0.3.2 scenario. No path-keyed override exists at all here;
      // only the hash-keyed one, as if it survived a real move + rescan.
      folder: 'House',
      fileName: 'track.wav',
      seedHashOverride: { [CONTENT_HASH]: 'Trance' },
    }),
  )
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  const genreSelect = page.locator('tbody tr').first().locator('td').nth(2).locator('select')

  // No path-keyed override exists in this scenario at all (only the
  // hash-keyed one), so whatever shows before analysis resolves this file's
  // identity has to be the plain folder-derived genre (House) — this
  // synthetic 3s file just analyzes fast enough that the window to observe
  // that transient state isn't reliably catchable here. What actually
  // matters, and is worth asserting, is the settled state below: it has to
  // be the override (Trance), which a folder-derived genre alone could never
  // produce for a file sitting in a "House" folder.

  // Once the background queue resolves this file's identity, the hash-keyed
  // override overrides the folder guess.
  await page.waitForFunction(
    () => ![...document.querySelectorAll('span')].some((s) => /\d+ queued/.test(s.textContent || '')),
    { timeout: 20000 },
  )
  await page.waitForTimeout(200)
  const after = await genreSelect.inputValue()
  ok('moved file: the hash-keyed override wins once analysis resolves it (Trance, not House)',
    after === 'Trance', after)

  ok('scenario 2: no console errors', errors.length === 0, errors[0])
  await page.close()
}

// ── Scenario 3: an orphaned entry (its file already moved) is REPORTED, ────
// not silently dropped — found in independent review: every other "some
// entries couldn't be carried forward" case in this app is a named, counted
// fact (skipped/unreadable/unrecognized-genre badges); the migration wasn't.
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(
    harness({
      folder: 'House',
      fileName: 'track.wav',
      seedPathOverride: {
        'House/track.wav': 'Trance', // matches — migrates cleanly
        'Techno/ghost.wav': 'Ambient', // no such file in this scan — orphaned
      },
    }),
  )
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  const notice = await page.getByText(/couldn.t be matched/).first().innerText().catch(() => null)
  ok('orphaned entry: the notice banner names how many could not be carried forward',
    notice?.includes('1 genre override'), notice ?? 'not found')

  ok('scenario 3: no console errors', errors.length === 0, errors[0])
  await page.close()
}

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

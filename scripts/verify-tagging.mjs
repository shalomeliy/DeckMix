/**
 * v0.9.0: the tagging screen, end to end in Chromium against the dev server.
 *   node scripts/verify-tagging.mjs   (against npm run dev on :5173)
 *
 * Library: 5 genre folders × 8 click-track WAVs (120 bpm, each a slightly
 * different length so each hashes differently). IndexedDB is an in-memory
 * stand-in with getAll/getAllKeys, so what the screen saves can be read back.
 *  1. Off by default: no "Tag" button until Settings › Library › Tagging is on.
 *  2. "Loud on 3" + "this is the 1" stores the answer (beat index 2) with the
 *     detector's grid, and moves the owner grid two beats (1.0 s at 120 bpm).
 *  3. Skip is stored as 'skip' and counted; vocal "yes" is stored.
 *  4. Export writes one JSON with both lists; decks were never touched.
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function harness() {
  window.__unhandled = []
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)))
  function wav(durationSec) {
    const rate = 8000
    const n = Math.round(durationSec * rate)
    const beat = rate / 2
    const buf = new ArrayBuffer(44 + n * 2)
    const v = new DataView(buf)
    const s = (o, t) => {
      for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i))
    }
    s(0, 'RIFF')
    v.setUint32(4, 36 + n * 2, true)
    s(8, 'WAVE')
    s(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, rate, true)
    v.setUint32(28, rate * 2, true)
    v.setUint16(32, 2, true)
    v.setUint16(34, 16, true)
    s(36, 'data')
    v.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) {
      const k = i % beat
      const x = k < 80 ? 20000 * Math.exp(-k / 15) * (k % 2 ? 1 : -1) : 0
      v.setInt16(44 + i * 2, Math.round(x), true)
    }
    return new Uint8Array(buf)
  }
  const makeFile = (name, bytes) => ({ kind: 'file', name, getFile: async () => new File([bytes], name, { type: 'audio/wav' }) })
  const GENRES = ['House', 'Techno', 'Trance', 'HipHop', 'Mizrahi']
  const perms = { queryPermission: async () => 'granted', requestPermission: async () => 'granted' }
  const makeGenre = (g, gi) => ({
    kind: 'directory',
    name: g,
    ...perms,
    entries: async function* () {
      for (let i = 0; i < 8; i++) yield [`${g}${i}.wav`, makeFile(`${g}${i}.wav`, wav(16 + gi * 0.8 + i * 0.1))]
    },
  })
  const makeDir = (name) => ({
    kind: 'directory',
    name,
    ...perms,
    entries: async function* () {
      for (let gi = 0; gi < GENRES.length; gi++) yield [GENRES[gi], makeGenre(GENRES[gi], gi)]
    },
  })
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') })
  window.__saved = null
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: async (o) => ({
      createWritable: async () => ({
        write: async (t) => {
          window.__saved = { name: o.suggestedName, text: t }
        },
        close: async () => {},
      }),
    }),
  })
  const mem = new Map()
  window.__mem = mem
  mem.set('deckmix:libraryDir', makeDir('Tracks'))
  const fire = (obj, prop, value) =>
    setTimeout(() => {
      obj.result = value
      obj[prop] && obj[prop]()
    }, 0)
  const req = (value) => {
    const r = {}
    fire(r, 'onsuccess', value)
    return r
  }
  Object.defineProperty(window, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const r = {}
        setTimeout(() => {
          r.result = {
            transaction: () => {
              const tx = {}
              tx.objectStore = () => ({
                transaction: tx,
                get: (k) => req(mem.get(k)),
                put: (v, k) => (mem.set(k, v), req(undefined)),
                delete: (k) => (mem.delete(k), req(undefined)),
                getAllKeys: () => req([...mem.keys()]),
                getAll: () => req([...mem.values()]),
              })
              setTimeout(() => tx.oncomplete && tx.oncomplete(), 1)
              return tx
            },
          }
          r.onsuccess && r.onsuccess()
        }, 0)
        return r
      },
    },
  })
  // The app's own module instance — an edited file is served as `?t=…`.
  window.__import = (path) => {
    const loaded = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => new URL(n).pathname === path)
    return import(loaded ?? path)
  }
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    return useStore.getState().library.tracks.length === 40
  },
  null,
  { timeout: 20000, polling: 300 },
)

const countText = () => page.getByTestId('tag-count').textContent()
const waitCount = (text) =>
  page
    .waitForFunction((t) => document.querySelector('[data-testid=tag-count]')?.textContent === t, text, { timeout: 8000 })
    .catch(() => {})

const tagButton = page.getByRole('button', { name: 'Tag', exact: true })
ok('off by default: no Tag button in the top bar', (await tagButton.count()) === 0)
await page.evaluate(async () => {
  const { settings } = await window.__import('/src/platform/settings-idb/store.ts')
  await settings.set('taggingMode', true)
})
await tagButton.waitFor({ timeout: 3000 })
ok('Settings › Library › Tagging on → Tag button appears', (await tagButton.count()) === 1)

await tagButton.click()
await waitCount('תויגו 0 מתוך 40')
ok('the screen opens with the count', (await countText()) === 'תויגו 0 מתוך 40', await countText())

await page.getByRole('button', { name: 'להתחיל' }).click()
await page.getByRole('button', { name: 'חזק על 3' }).waitFor({ timeout: 20000 })
await page.getByRole('button', { name: 'חזק על 3' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'זה ה-1 ✓' }).click()
await waitCount('תויגו 1 מתוך 40')
ok('answering counts it', (await countText()) === 'תויגו 1 מתוך 40', await countText())

const stored = await page.evaluate(() => {
  const mem = window.__mem
  const tags = [...mem.entries()].filter(([k]) => k.startsWith('deckmix:tag:bar:')).map(([, v]) => v)
  const t = tags[0]
  return { n: tags.length, t, corr: t ? mem.get('deckmix:gridCorrection:' + t.contentHash) : null }
})
const t = stored.t
ok(
  'the answer is stored as beat index 2, with the detector grid and the grid it was played on',
  stored.n === 1 && t.answer === 2 && !!t.detectorGrid && t.shownGrid.bpm > 0 && t.holdout === true,
  JSON.stringify(t && { answer: t.answer, det: t.detectorGrid, shown: t.shownGrid, genre: t.genre }),
)
const want = t ? (t.shownGrid.offsetSec + 2 * (60 / t.shownGrid.bpm)) % ((4 * 60) / t.shownGrid.bpm) : NaN
ok(
  '…and is the owner grid correction: the "1" moved two beats',
  stored.corr?.source === 'owner' && Math.abs(stored.corr.grid.offsetSec - want) < 1e-6,
  JSON.stringify(stored.corr),
)

await page.getByRole('button', { name: 'חזק על 1' }).waitFor({ timeout: 20000 })
await page.getByRole('button', { name: 'לא בטוח, דלג' }).click()
await waitCount('תויגו 2 מתוך 40')
const answers = await page.evaluate(() =>
  [...window.__mem.entries()].filter(([k]) => k.startsWith('deckmix:tag:bar:')).map(([, v]) => v.answer),
)
ok('skip is stored as "skip" and counted', (await countText()) === 'תויגו 2 מתוך 40' && answers.includes('skip'), JSON.stringify(answers))

await page.getByRole('button', { name: 'שירה', exact: true }).click()
await waitCount('תויגו 0 מתוך 10')
ok('vocal tab: 2 per genre (the 8 in each folder, after the 6 sealed for the "1"), none tagged', (await countText()) === 'תויגו 0 מתוך 10', await countText())
await page.getByRole('button', { name: 'להתחיל' }).click()
await page.getByRole('button', { name: '▶ נגן 5 שניות' }).waitFor({ timeout: 20000 })
await page.getByRole('button', { name: '▶ נגן 5 שניות' }).click()
await page.getByRole('button', { name: 'יש שירה' }).click()
await waitCount('תויגו 1 מתוך 10')
ok('vocal "yes" is stored and counted', (await countText()) === 'תויגו 1 מתוך 10', await countText())

// The race the review found: a "1" song still opening when the vocal tab
// opens its own. The late one must not become the song the answer is saved to.
await page.getByRole('button', { name: 'איפה ה-1', exact: true }).click()
await page.getByRole('button', { name: 'להמשיך' }).click()
await page.getByRole('button', { name: 'שירה', exact: true }).click()
await page.getByRole('button', { name: 'להמשיך' }).click()
await page.getByRole('button', { name: '▶ נגן 5 שניות' }).waitFor({ timeout: 20000 })
await page.waitForTimeout(4000) // the "1" song's analysis finishes meanwhile
const shownName = await page.locator('.text-base.font-bold').first().textContent()
await page.getByRole('button', { name: 'אין שירה' }).click()
await waitCount('תויגו 2 מתוך 10')
const lastVocal = await page.evaluate(() =>
  [...window.__mem.entries()].filter(([k]) => k.startsWith('deckmix:tag:vocal:')).map(([, v]) => v).find((v) => v.answer === 'no'),
)
ok('a song still opening on the other tab cannot take the answer', lastVocal?.name === shownName && (await countText()) === 'תויגו 2 מתוך 10', `shown ${shownName}, saved ${lastVocal?.name}`)

await page.getByRole('button', { name: 'ייצוא לקובץ' }).click()
await page.waitForFunction(() => window.__saved != null, null, { timeout: 5000 }).catch(() => {})
const saved = await page.evaluate(() => window.__saved)
const doc = saved ? JSON.parse(saved.text) : null
ok(
  'export writes one JSON with both lists, named deckmix-tags-*',
  /^deckmix-tags-\d{4}-\d\d-\d\d\.json$/.test(saved?.name ?? '') && doc?.bar.length === 2 && doc?.vocal.length === 2,
  saved?.name,
)

const decks = await page.evaluate(async () => {
  const { useStore } = await window.__import('/src/app/state/store.ts')
  const d = useStore.getState().decks
  return [d.A.track, d.B.track, d.A.playing, d.B.playing]
})
ok('the decks were never touched', decks.every((x) => !x), JSON.stringify(decks))

await page.keyboard.press('Escape')
ok('Esc closes the screen', (await page.getByTestId('tag-count').count()) === 0)
const unhandled = await page.evaluate(() => window.__unhandled)
ok('no page errors', errors.length === 0 && unhandled.length === 0, errors[0] ?? unhandled[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

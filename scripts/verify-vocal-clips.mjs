/**
 * v0.9.10: the vocal tagging round is three 5-second clips per song.
 *   node scripts/verify-vocal-clips.mjs   (against npm run dev on :5173; DECKMIX_URL overrides)
 * Same harness as verify-tagging.mjs (40 synthetic songs, fake IndexedDB). Checks that a song is counted only
 * after its third clip, that each clip is stored under its own key with its own spot, that a half-answered
 * song reopens on the missing clip, and that the definition of "vocal presence" is on screen.
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


await page.getByRole('button', { name: 'שירה', exact: true }).click()
await waitCount('תויגו 0 מתוך 10')
ok('vocal tab: 10 songs, none done', (await countText()) === 'תויגו 0 מתוך 10', await countText())
await page.getByRole('button', { name: 'להתחיל' }).click()
await page.getByRole('button', { name: '▶ נגן 5 שניות' }).waitFor({ timeout: 20000 })
const bodyText = () => page.locator('body').innerText()
ok('the definition of "vocal presence" is on screen', (await bodyText()).includes('קול רקע'))
ok('first clip says 1 of 3', (await bodyText()).includes('קטע 1 מתוך 3'))
const vocal = () => page.evaluate(() => [...window.__mem.entries()].filter(([k]) => k.startsWith('deckmix:tag:vocal:')).map(([k, v]) => ({ k, ...v })))
const firstName = await page.locator('.text-base.font-bold').first().textContent()

await page.getByRole('button', { name: '▶ נגן 5 שניות' }).click()
await page.getByRole('button', { name: 'יש שירה' }).click()
await page.getByText('קטע 2 מתוך 3').waitFor({ timeout: 5000 })
ok('after clip 1 the SAME song stays, on clip 2 — and it is not counted yet', (await countText()) === 'תויגו 0 מתוך 10' && (await page.locator('.text-base.font-bold').first().textContent()) === firstName, await countText())
await page.getByRole('button', { name: 'אין שירה' }).click()
await page.getByText('קטע 3 מתוך 3').waitFor({ timeout: 5000 })
await page.getByRole('button', { name: 'לא בטוח', exact: true }).click()
await waitCount('תויגו 1 מתוך 10')
ok('after the third clip the song is counted', (await countText()) === 'תויגו 1 מתוך 10', await countText())
const v = await vocal()
const mine = v.filter((x) => x.name === firstName).sort((a, b) => a.clipIndex - b.clipIndex)
ok(
  'three records, one per clip, each its own key, spot and answer, in order',
  mine.length === 3 && mine.every((x, i) => x.clipIndex === i && x.k.endsWith(':' + i) && x.schema === 2) && mine[0].atSec < mine[1].atSec && mine[1].atSec < mine[2].atSec && mine.map((x) => x.answer).join() === 'yes,no,unsure',
  JSON.stringify(mine.map((x) => [x.clipIndex, x.atSec.toFixed(1), x.answer])),
)
await page.getByText('קטע 1 מתוך 3').waitFor({ timeout: 20000 })
ok('the next song starts on clip 1', (await page.locator('.text-base.font-bold').first().textContent()) !== firstName)

// answer one clip of the second song, leave, come back: it must reopen on clip 2
const secondName = await page.locator('.text-base.font-bold').first().textContent()
await page.getByRole('button', { name: 'יש שירה' }).click()
await page.getByText('קטע 2 מתוך 3').waitFor({ timeout: 5000 })
await page.getByRole('button', { name: 'איפה ה-1', exact: true }).click()
await page.getByRole('button', { name: 'שירה', exact: true }).click()
await page.getByRole('button', { name: /להמשיך|להתחיל/ }).click()
await page.getByRole('button', { name: '▶ נגן 5 שניות' }).waitFor({ timeout: 20000 })
ok('a half-answered song reopens on its missing clip', (await page.locator('.text-base.font-bold').first().textContent()) === secondName && (await bodyText()).includes('קטע 2 מתוך 3'), undefined)
ok('still counted as 1 of 10, not 2', (await countText()) === 'תויגו 1 מתוך 10', await countText())

await page.getByRole('button', { name: 'ייצוא לקובץ' }).click()
await page.waitForFunction(() => window.__saved != null, null, { timeout: 5000 }).catch(() => {})
const saved = await page.evaluate(() => window.__saved)
const doc = saved ? JSON.parse(saved.text) : null
ok('export carries all 4 vocal clips with clipIndex', doc?.vocal?.length === 4 && doc.vocal.every((x) => typeof x.clipIndex === 'number'), String(doc?.vocal?.length))

const unhandled = await page.evaluate(() => window.__unhandled)
ok('no page errors', errors.length === 0 && unhandled.length === 0, errors[0] ?? unhandled[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`
${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

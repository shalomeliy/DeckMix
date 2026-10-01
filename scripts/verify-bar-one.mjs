/**
 * v0.9.5: the "bar 1 unsure" badge, end to end in Chromium against the dev server.
 *   node scripts/verify-bar-one.mjs   (against npm run dev on :5173)
 *
 * Same in-memory IndexedDB as verify-tagging.mjs, but its own 60 s songs: a
 * 60 Hz kick whose sections come back on two different beats, so neither "1"
 * wins and it is unsure — the badge must show. (verify-tagging's 16 s clicks
 * read as *sure*: one kick return out of nothing is all the votes there are.) Then every way the
 * owner can settle it must clear it, and it must stay cleared:
 *  1. unsure → badge + dashed lines (barOneUnsure true)
 *  2. a click outside the opened panel does not clear it
 *  3. the panel's ✕ clears it, saves the owner grid, and a reload of the
 *     song comes back without it
 *  4. "Set downbeat here" clears it
 *  5. ejecting the deck leaves no stale flag
 * The owner's real library is never touched — the review asked for this
 * evidence (v0.9.5, change-reviewer B1).
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
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
    // Not verify-tagging's clicks: a 60 Hz kick in sections that disagree —
    // it comes back on beat 34 (≡2) and on beat 81 (≡1), equally hard, so
    // neither "1" wins and the detector must say it is not sure.
    const on = (b) => b < 16 || (b >= 34 && b < 66) || b >= 81
    for (let i = 0; i < n; i++) {
      const b = Math.floor(i / beat)
      const k = i % beat
      const x = on(b) && k < 800 ? 20000 * Math.exp(-k / 200) * Math.sin((2 * Math.PI * 60 * k) / rate) : 0
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
      for (let i = 0; i < 8; i++) yield [`${g}${i}.wav`, makeFile(`${g}${i}.wav`, wav(60 + gi * 0.8 + i * 0.1))]
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
const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
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

const deckState = (id) =>
  page.evaluate(async (id) => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const d = useStore.getState().decks[id]
    return { unsure: d.barOneUnsure, grid: d.beatGrid, hash: d.track?.contentHash ?? null, track: d.track?.id ?? null }
  }, id)
const load = (id, idx) =>
  page.evaluate(
    async ([id, idx]) => {
      const { useStore } = await window.__import('/src/app/state/store.ts')
      const ctl = await window.__import('/src/controls.ts')
      let all = useStore.getState().library.tracks
      for (let i = 0; i < 50 && !all.length; i++) {
        await new Promise((r) => setTimeout(r, 200))
        all = useStore.getState().library.tracks
      }
      const t = all.filter((x) => x.genre === 'House')[idx]
      if (!t) throw new Error('no House track: ' + JSON.stringify(all.slice(0, 3).map((x) => [x.id, x.genre])))
      await ctl.loadTrackToDeck(id, t)
    },
    [id, idx],
  )
const badge = page.getByRole('button', { name: 'bar 1 unsure' })

await load('A', 0)
const s1 = await deckState('A')
ok('a song whose kick sections disagree loads with an unsure "1" and the badge', s1.unsure === true && (await badge.count()) === 1, JSON.stringify(s1))

await badge.click()
const setDownbeat = page.getByRole('button', { name: 'Set downbeat here' })
ok('the badge opens the beat grid panel', (await setDownbeat.count()) === 1)
await page.mouse.click(5, 700)
await page.waitForTimeout(200)
ok('a click outside closes it without clearing anything', (await setDownbeat.count()) === 0 && (await deckState('A')).unsure === true)

await badge.click()
await page.getByRole('button', { name: 'Close' }).click()
await page.waitForTimeout(300)
const s2 = await deckState('A')
const saved = await page.evaluate((h) => window.__mem.get('deckmix:gridCorrection:' + h), s2.hash)
ok('✕ clears it: no badge, the owner grid saved', s2.unsure === false && (await badge.count()) === 0 && saved?.source === 'owner', JSON.stringify(saved))

await load('A', 0)
const s3 = await deckState('A')
ok('…and reloading the song keeps it cleared, on the saved grid', s3.unsure === false && (await badge.count()) === 0 && Math.abs(s3.grid.offsetSec - saved.grid.offsetSec) < 1e-9, JSON.stringify(s3.grid))

await load('B', 1)
ok('another unsure song on deck B shows its badge', (await deckState('B')).unsure === true && (await badge.count()) === 1)
await badge.click()
await setDownbeat.click()
await page.waitForTimeout(300)
ok('"Set downbeat here" clears it', (await deckState('B')).unsure === false)

await load('B', 2)
ok('a third song is unsure again', (await deckState('B')).unsure === true)
await page.evaluate(async () => (await window.__import('/src/controls.ts')).ejectDeck('B'))
const s4 = await deckState('B')
ok('ejecting the deck leaves no stale flag', s4.track === null && s4.unsure === false, JSON.stringify(s4))

const unhandled = await page.evaluate(() => window.__unhandled)
ok('no page errors', errors.length === 0 && unhandled.length === 0, errors[0] ?? unhandled[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`
${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

/**
 * v0.9.0: the tagging screen, end to end in Chromium against the dev server.
 *   node scripts/verify-tagging.mjs   (against npm run dev on :5173)
 *
 * Library: 5 genre folders × 8 click-track WAVs (120 bpm, each a slightly
 * different length so each hashes differently). IndexedDB is an in-memory
 * stand-in with getAll/getAllKeys, so what the screen saves can be read back.
 *  1. Off by default: no "Tag" button until Settings › Library › Tagging is on.
 *  2. v0.9.1: the waveform shows with the yellow "1" on the computer's guess.
 *     → → moves it two beats (1.0 s at 120 bpm), Space plays and shows ■;
 *     "this is the 1" stores the mark, moved, plays=1, and the owner grid.
 *  3. A click on the waveform snaps to a beat; Shift+→ adds 0.01 s on top.
 *  4. Skip is stored as 'skip' and counted; vocal "yes" is stored.
 *  5. v0.12.8: with a 4-button answer that disagrees with a waveform one, a
 *     "הכרעה (1)" tab appears; its song opens with no marker, "this is the 1"
 *     is disabled, Space plays even clicks; a click marks and saves under
 *     deckmix:tag:decide: — the two answers it settles are left as they were.
 *  6. v0.9.5: a "סבב חדש (N)" tab with every dance song not answered yet, blind,
 *     saved under deckmix:tag:fresh:.
 *  7. Export writes one JSON with every list; decks were never touched.
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

const marks = () =>
  page.evaluate(() => [...window.__mem.entries()].filter(([k]) => k.startsWith('deckmix:tag:mark:')).map(([, v]) => v))
const wave = page.getByTestId('tag-waveform')

await page.getByRole('button', { name: 'להתחיל' }).click()
await wave.waitFor({ timeout: 20000 })
ok('the song opens on its waveform, with the "1" button', (await page.getByRole('button', { name: 'זה ה-1 ✓' }).count()) === 1)
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('Space')
await page.getByRole('button', { name: '■ עצור' }).waitFor({ timeout: 3000 }).catch(() => {})
ok('Space plays, and the button turns into stop', (await page.getByRole('button', { name: '■ עצור' }).count()) === 1)
await page.keyboard.press('Space')
await page.getByRole('button', { name: '▶ נגן מכאן' }).waitFor({ timeout: 3000 }).catch(() => {})
ok('…and Space again stops it', (await page.getByRole('button', { name: '▶ נגן מכאן' }).count()) === 1)
await page.getByRole('button', { name: 'זה ה-1 ✓' }).click()
await waitCount('תויגו 1 מתוך 40')
ok('answering counts it', (await countText()) === 'תויגו 1 מתוך 40', await countText())

const m1 = (await marks())[0]
const corr1 = m1 ? await page.evaluate((h) => window.__mem.get('deckmix:gridCorrection:' + h), m1.contentHash) : null
ok(
  'two arrow presses moved the "1" two beats from the computer\'s guess, and that is stored',
  m1 && m1.answer === 'marked' && Math.abs(m1.markSec - m1.startMarkSec - 1.0) < 1e-6 && m1.moved === true && m1.plays === 1 && m1.answerMs > 0 && !!m1.detectorGrid && m1.holdout === true,
  JSON.stringify(m1 && { mark: m1.markSec, start: m1.startMarkSec, moved: m1.moved, plays: m1.plays, ms: m1.answerMs }),
)
const bar1 = m1 ? (4 * 60) / m1.bpm : NaN
ok(
  '…and is the owner grid correction: its bar line is on the mark',
  corr1?.source === 'owner' && Math.abs(corr1.grid.offsetSec - (((m1.markSec % bar1) + bar1) % bar1)) < 1e-6,
  JSON.stringify(corr1),
)
ok('nothing was written under the old 4-button key', (await page.evaluate(() => [...window.__mem.keys()].filter((k) => k.startsWith('deckmix:tag:bar:')).length)) === 0)

await page.waitForFunction(() => document.querySelector('[data-testid=tag-waveform]'), null, { timeout: 20000 })
await page.waitForTimeout(300)
const box = await wave.boundingBox()
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2)
await page.keyboard.press('Shift+ArrowRight')
await page.getByRole('button', { name: 'זה ה-1 ✓' }).click()
await waitCount('תויגו 2 מתוך 40')
const m2 = (await marks()).find((m) => m.contentHash !== m1?.contentHash)
const beats2 = m2 ? (m2.markSec - 0.01 - m2.startMarkSec) / (60 / m2.bpm) : NaN
ok(
  'a click snaps to a beat, and Shift+→ moves it 0.01 s more',
  m2 && m2.moved && Math.abs(beats2 - Math.round(beats2)) < 1e-6 && Math.round(beats2) !== 0,
  JSON.stringify(m2 && { mark: m2.markSec, start: m2.startMarkSec, beats: beats2 }),
)

// v0.9.1 review: a press left of the first beat used to clamp to 0 s — off every beat — and save that as the grid.
await wave.waitFor({ timeout: 20000 })
await page.waitForTimeout(300)
const box3 = await wave.boundingBox()
await page.mouse.click(box3.x + 1, box3.y + box3.height / 2)
await page.getByRole('button', { name: 'זה ה-1 ✓' }).click()
await waitCount('תויגו 3 מתוך 40')
const m3 = (await marks()).find((m) => m.contentHash !== m1?.contentHash && m.contentHash !== m2?.contentHash)
const beats3 = m3 ? (m3.markSec - m3.startMarkSec) / (60 / m3.bpm) : NaN
ok(
  'a press at the very start of the song still lands on a beat, inside the song',
  m3 && m3.markSec >= 0 && Math.abs(beats3 - Math.round(beats3)) < 1e-6,
  JSON.stringify(m3 && { mark: m3.markSec, start: m3.startMarkSec, beats: beats3 }),
)

await wave.waitFor({ timeout: 20000 })
await page.getByRole('button', { name: 'לא בטוח, דלג' }).click()
await waitCount('תויגו 4 מתוך 40')
const answers = (await marks()).map((m) => m.answer)
ok('skip is stored as "skip" and counted', (await countText()) === 'תויגו 4 מתוך 40' && answers.includes('skip'), JSON.stringify(answers))

// v0.12.8: seed two v0.9.0 answers — m1's disagrees (the "1" on the start line, the mark is two beats on), m2's agrees.
await page.evaluate(
  ([a, b]) => {
    const old = (m, answer) => ({
      schema: 1, contentHash: m.contentHash, trackId: m.trackId, name: m.name, genre: m.genre, holdout: m.holdout,
      answer, detectorGrid: m.detectorGrid, shownGrid: m.shownGrid, taggedAt: 1,
    })
    window.__mem.set('deckmix:tag:bar:' + a.contentHash, old(a, 0))
    const beats = Math.round((b.markSec - 0.01 - b.startMarkSec) / (60 / b.bpm))
    window.__mem.set('deckmix:tag:bar:' + b.contentHash, old(b, ((beats % 4) + 4) % 4))
  },
  [m1, m2],
)
await page.keyboard.press('Escape')
await tagButton.click()
const decideTab = page.getByRole('button', { name: 'הכרעה (1)' })
await decideTab.waitFor({ timeout: 5000 }).catch(() => {})
ok('a disagreeing pair of answers shows a "הכרעה (1)" tab; an agreeing pair does not count', (await decideTab.count()) === 1)
await decideTab.click()
await waitCount('נענו 0 מתוך 1')
ok('the tie-break counter says answered, not decided', (await countText()) === 'נענו 0 מתוך 1', await countText())
await page.getByRole('button', { name: 'להתחיל' }).click()
await wave.waitFor({ timeout: 20000 })
const shown = await page.locator('.text-base.font-bold').first().textContent()
const saveBtn = page.getByRole('button', { name: 'זה ה-1 ✓' })
ok('the tie-break song is the disputed one, opened with nothing marked', shown === m1.name && (await saveBtn.isDisabled()), shown)
await page.keyboard.press('Space')
await page.getByRole('button', { name: '■ עצור' }).waitFor({ timeout: 3000 }).catch(() => {})
ok('unmarked, Space still plays (even clicks)', (await page.getByRole('button', { name: '■ עצור' }).count()) === 1)
await page.keyboard.press('Space')
await page.keyboard.press('ArrowRight')
ok('unmarked, an arrow places the "1" — the keyboard alone can answer', !(await saveBtn.isDisabled()))
// v0.12.8 review: the neutral start must be the computer's "1" shifted by the song's own 0–3 beats, never the "1" itself by rule.
const placed = Number((await wave.getAttribute('aria-label')).match(/marked at ([\d.]+) s/)?.[1])
const wantPlaced = await page.evaluate(async (m) => {
  const t = await window.__import('/src/core/tagging.ts')
  return { at: t.neutralSec(m.startMarkSec, m.trackId, m.bpm, 1e9), beats: t.blindOffsetBeats(m.trackId) }
}, m1)
ok(
  'the first arrow lands on the neutral start: the "1" of the computer, moved the blind beats of the song',
  Math.abs(placed - wantPlaced.at) < 0.006,
  `placed ${placed}, computer ${m1.startMarkSec}, blind beats ${wantPlaced.beats}`,
)
const box4 = await wave.boundingBox()
await page.mouse.click(box4.x + box4.width * 0.5, box4.y + box4.height / 2)
ok('a click moves it, and the answer can be saved', !(await saveBtn.isDisabled()))
await saveBtn.click()
await waitCount('נענו 1 מתוך 1')
ok('…and counts the answer', (await countText()) === 'נענו 1 מתוך 1', await countText())
const dec = await page.evaluate((h) => {
  const mem = window.__mem
  return { d: mem.get('deckmix:tag:decide:' + h), m: mem.get('deckmix:tag:mark:' + h), corr: mem.get('deckmix:gridCorrection:' + h) }
}, m1.contentHash)
const decBeats = dec.d ? (dec.d.markSec - dec.d.detectorGrid.offsetSec) / (60 / dec.d.bpm) : NaN
ok(
  'saved as a tie-break on a beat, the waveform answer untouched, the grid following the tie-break',
  dec.d?.answer === 'marked' && dec.d.startMarkSec === null && Math.abs(decBeats - Math.round(decBeats)) < 1e-6 &&
    dec.m?.markSec === m1.markSec && Math.abs(dec.corr.grid.offsetSec - (((dec.d.markSec % (240 / dec.d.bpm)) + 240 / dec.d.bpm) % (240 / dec.d.bpm))) < 1e-6,
  JSON.stringify({ decide: dec.d?.markSec, mark: dec.m?.markSec, corr: dec.corr?.grid }),
)

// v0.9.5: the fresh round — House/Techno/Trance songs with no "1" answer in any round, blind like the tie-break.
const DANCE = ['House', 'Techno', 'Trance']
const freshWant = await page.evaluate((dance) => {
  const answered = new Set(
    [...window.__mem.entries()].filter(([k]) => /^deckmix:tag:(mark|bar|decide):/.test(k)).map(([, v]) => v.trackId),
  )
  // since 01/10 every genre, not only dance: 5 folders × 8 songs, minus every song answered
  return 40 - answered.size
}, DANCE)
const freshTab = page.getByRole('button', { name: `סבב חדש (${freshWant})` })
ok(`a "סבב חדש (${freshWant})" tab: every song not answered yet`, (await freshTab.count()) === 1, await page.getByRole('dialog', { name: 'Tagging' }).locator('header').textContent())
await freshTab.click()
await waitCount(`נענו 0 מתוך ${freshWant}`)
await page.getByRole('button', { name: 'להתחיל' }).click()
await wave.waitFor({ timeout: 20000 })
const freshGenre = await page.getByRole('dialog', { name: 'Tagging' }).locator('.text-base.font-bold').first().locator('xpath=following-sibling::div[1]').textContent()
ok('the fresh song opens with nothing marked, and dance songs come first', (await saveBtn.isDisabled()) && DANCE.some((g) => freshGenre.startsWith(g)), freshGenre)
const box5 = await wave.boundingBox()
await page.mouse.click(box5.x + box5.width * 0.5, box5.y + box5.height / 2)
await saveBtn.click()
await waitCount(`נענו 1 מתוך ${freshWant}`)
const fresh = await page.evaluate(() => [...window.__mem.entries()].filter(([k]) => k.startsWith('deckmix:tag:fresh:')).map(([, v]) => v))
ok(
  'saved under deckmix:tag:fresh:, on a beat, and the song stays in the round (counted, not dropped)',
  fresh.length === 1 && fresh[0].answer === 'marked' && fresh[0].startMarkSec === null && (await countText()) === `נענו 1 מתוך ${freshWant}`,
  `${await countText()} ${JSON.stringify(fresh.map((f) => f.name))}`,
)

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
  'export writes one JSON with the marks, the old 4-button list, the tie-breaks and the vocals, named deckmix-tags-*',
  /^deckmix-tags-\d{4}-\d\d-\d\d\.json$/.test(saved?.name ?? '') && doc?.mark.length === 4 && doc?.bar.length === 2 && doc?.decide.length === 1 && doc?.fresh?.length === 1 && doc?.vocal.length === 2,
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

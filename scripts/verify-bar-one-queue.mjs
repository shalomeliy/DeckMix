/**
 * v0.9.71: the "check the 1" queue, end to end in Chromium against the dev server, on 40 synthetic songs.
 *   node scripts/verify-bar-one-queue.mjs   (against npm run dev on :5173; DECKMIX_URL and PW_CHROME override)
 *
 * Covers: weak genres first, answers saved as owner grids, Skip counted and not saved, Stop, no repeat of answered songs, refusal while
 * a deck plays, a double press counted once, and an answer refused (run stopped) when another song was loaded on the queue deck.
 * The owner's real library is never touched. In-memory IndexedDB with a cursor, so the saved-grid read works.
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
                // idb-keyval's entries() walks a cursor; the queue reads every saved grid that way.
                openCursor: () => {
                  const keys = [...mem.keys()]
                  const r = {}
                  let i = 0
                  const step = () => {
                    if (i >= keys.length) return fire(r, 'onsuccess', null)
                    const k = keys[i++]
                    fire(r, 'onsuccess', { key: k, value: mem.get(k), continue: step })
                  }
                  step()
                  return r
                },
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
for (let i = 0; i < 100; i++) {
  const n = await page.evaluate(async () => (await window.__import('/src/app/state/store.ts')).useStore.getState().library.tracks.length)
  if (n === 40) break
  await page.waitForTimeout(300)
}

const q = () =>
  page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    const s = useStore.getState()
    const dk = s.barOneQueue ? s.decks[s.barOneQueue.deckId] : null
    return { q: s.barOneQueue, track: dk?.track?.id ?? null, genre: dk?.track?.genre ?? null, hash: dk?.track?.contentHash ?? null, notice: s.notice?.text ?? null }
  })
const ready = async () => {
  for (let i = 0; i < 300; i++) {
    const r = await q()
    if (r.q?.phase === 'ready') return r
    if (!r.q) return r
    await page.waitForTimeout(200)
  }
  return q()
}
const ctl = (fn, arg) => page.evaluate(async ([fn, arg]) => (await window.__import('/src/controls.ts'))[fn](arg), [fn, arg])
const saved = () =>
  page.evaluate(() => [...window.__mem.entries()].filter(([k]) => String(k).startsWith('deckmix:gridCorrection:')).map(([k, v]) => [k.slice(23), v]))
const playing = () =>
  page.evaluate(async () => {
    const { engine } = await window.__import('/src/platform/audio-webaudio/engine.ts')
    return [engine.decks.A.playing, engine.decks.B.playing]
  })

// v0.9.73: the library knows how many songs are unchecked without the queue having run.
const ownerSet = () =>
  page.evaluate(async () => {
    const h = (await window.__import('/src/app/state/store.ts')).useStore.getState().ownerCheckedHashes
    return h ? [...h] : null
  })
let setBefore = null
for (let i = 0; i < 50 && setBefore === null; i++) {
  setBefore = await ownerSet()
  if (setBefore === null) await page.waitForTimeout(200)
}
ok('the checked-songs set is read without starting the queue', Array.isArray(setBefore) && setBefore.length === 0, JSON.stringify(setBefore))
ok('the Check button is on screen', (await page.getByRole('button', { name: /Check the 1/ }).count()) === 1)

await ctl('startBarOneQueue')
const r1 = await ready()
ok('the queue loads a first song and waits for an answer', r1.q?.phase === 'ready' && !!r1.track, JSON.stringify(r1.q))
ok('the first song is Hip Hop or Mizrahi (the genres the detector is worst on)', /hip|mizrahi/i.test(r1.genre ?? ''), String(r1.genre))
ok('the song is playing', (await playing()).some(Boolean))
ok('nothing is saved before an answer', (await saved()).length === 0)
ok('the bar is on screen', (await page.getByTestId('bar-one-queue').count()) === 1)

await ctl('answerBarOne', 'yes')
const r2 = await ready()
const s2 = await saved()
ok('"This is the 1" saves an owner grid for that song, even though nothing was edited', s2.length === 1 && s2[0][0] === r1.hash && s2[0][1].source === 'owner', JSON.stringify(s2.map((x) => x[0].slice(0, 8))))
ok('the answered song joins the checked set at once, with no re-read', (await ownerSet())?.includes(r1.hash) === true, String((await ownerSet())?.length))
ok('and loads the next song', r2.track && r2.track !== r1.track && r2.q?.checked === 1, JSON.stringify(r2.q))

await page.evaluate(async () => (await window.__import('/src/controls.ts')).seekDeck((await window.__import('/src/app/state/store.ts')).useStore.getState().barOneQueue.deckId, 33.3))
await ctl('answerBarOne', 'here')
const r3 = await ready()
const s3 = await saved()
const moved = s3.find(([h]) => h === r2.hash)
// The deck keeps playing between the seek and the press, so the playhead is a little past 33.3 s: within 0.4 s of it, on the grid's bar line.
const barFrac = moved ? ((((33.3 - moved[1].grid.offsetSec) / ((60 / moved[1].grid.bpm) * 4)) % 1) + 1) % 1 : 1
ok('"The 1 is here" saves a grid whose bar line is at the playhead', !!moved && (barFrac < 0.2 || barFrac > 0.8), JSON.stringify(moved && moved[1].grid))

await ctl('answerBarOne', 'skip')
const r4 = await ready()
ok('Skip saves nothing and is counted on screen', (await saved()).length === 2 && r4.q?.skipped === 1, JSON.stringify(r4.q))

await ctl('stopBarOneQueue')
const r5 = await q()
ok('Stop ends the run and the deck stops', r5.q === null && !(await playing()).some(Boolean))

await page.getByRole('button', { name: /^check the 1/i }).first().waitFor({ timeout: 5000 }).catch(() => {})
const labelNow = await page.getByRole('button', { name: /(stop checking|check) the 1/i }).first().innerText()
ok('after Stop the button counts the unchecked songs it knows', /check the 1 · \d+ new/i.test(labelNow), labelNow)
ok('and a row carries the "1?" marker', (await page.getByText('1?', { exact: true }).count()) > 0)

const showBtn = page.getByRole('button', { name: /Show \d+ unchecked/ })
const nShown = Number(((await showBtn.innerText()).match(/\d+/) ?? ['0'])[0])
await showBtn.click()
await page.waitForTimeout(400)
const rowsShown = await page.locator('tbody tr[data-track-id], tbody tr').count()
ok('the unchecked filter shows only those songs', nShown > 0 && rowsShown <= nShown + 2 && rowsShown >= 1, `button ${nShown}, rows ${rowsShown}`)
await showBtn.click()
await page.waitForTimeout(300)
ok('and a second press brings the whole list back', (await page.locator('tbody tr').count()) > rowsShown)

await ctl('startBarOneQueue')
const r6 = await ready()
ok('a new run does not offer the two answered songs again', r6.hash !== r1.hash && r6.hash !== r2.hash, String(r6.track))
await ctl('stopBarOneQueue')


// A double press on "This is the 1" saves and counts once.
await ctl('startBarOneQueue')
const d0 = await ready()
const before = (await saved()).length
await page.evaluate(async () => {
  const c = await window.__import('/src/controls.ts')
  await Promise.all([c.answerBarOne('yes'), c.answerBarOne('yes')])
})
const d1 = await ready()
ok('a double press saves and counts once', (await saved()).length === before + 1 && d1.q?.checked === 1, JSON.stringify(d1.q))

// Another song loaded on the queue deck: the answer is refused, the run stops, nothing is saved for either song.
const beforeForeign = (await saved()).length
await page.evaluate(async () => {
  const { useStore } = await window.__import('/src/app/state/store.ts')
  const c = await window.__import('/src/controls.ts')
  const dk = useStore.getState().barOneQueue.deckId
  c.togglePlay(dk)
  const other = useStore.getState().library.tracks.find((t) => t.genre === 'Techno')
  await c.loadTrackToDeck(dk, other)
  await c.answerBarOne('yes')
})
const d2 = await q()
ok('an answer after a foreign load stops the run and saves nothing', d2.q === null && (await saved()).length === beforeForeign && /stopped/i.test(d2.notice ?? ''), String(d2.notice))

await ctl('togglePlay', 'A')
await ctl('startBarOneQueue')
const r7 = await q()
ok('it refuses to start while a deck is playing, and says why', r7.q === null && /playing/i.test(r7.notice ?? ''), String(r7.notice))

ok('no page errors', errors.length === 0, errors.join(' | '))
const unhandled = await page.evaluate(() => window.__unhandled)
ok('no unhandled rejections', unhandled.length === 0, unhandled.join(' | '))
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)

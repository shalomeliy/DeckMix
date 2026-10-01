/**
 * v0.12.9: the loop band on the scrolling waveform.
 *   node scripts/verify-loop-band.mjs   (against npm run dev; DECKMIX_URL overrides :5173)
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
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
  for (let i = numSamples / 2; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 60 * i) / sampleRate) * 26000), true)
  }
  return Buffer.from(buf)
}

const SAMPLE_RATE = 8000
const DURATION_SEC = 20
const WAV_BASE64 = makeWav(DURATION_SEC, SAMPLE_RATE).toString('base64')

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
      yield ['trackA.wav', makeFile('trackA.wav')];
      yield ['trackB.wav', makeFile('trackB.wav')];
    },
  });

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => makeDir('Tracks'),
  });

  // IndexedDB is left real: the old in-page fake no longer satisfies idb-keyval,
  // and the analysis cache would wait on it forever.
})()`
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness())
// Vite stamps edited modules with ?t=..., and a plain import() of the same path would be
// a second copy with its own store. Import by the URL the page itself used.
await page.addInitScript(() => {
  window.mod = (p) => {
    const hit = performance.getEntriesByType('resource').map((e) => new URL(e.name)).find((u) => u.pathname === p)
    return import(hit ? hit.pathname + hit.search : p)
  }
})
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
// The fake IndexedDB no longer satisfies the library's boot restore, so the
// scan is driven directly: the deck only needs a Track with a file handle.
await page.evaluate(async () => {
  const lib = await window.mod('/src/platform/source-fsaccess/library.ts')
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const { tracks } = await lib.scanLibrary(await window.showDirectoryPicker())
  useStore.getState().setLibrary({ tracks })
})
await page.evaluate(async () => {
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const ctl = await window.mod('/src/controls.ts')
  const deadline = Date.now() + 10_000
  let a
  while (Date.now() < deadline) {
    a = useStore.getState().library.tracks.find((t) => t.name === 'trackA')
    if (a) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await ctl.loadTrackToDeck('A', a)
  const until = Date.now() + 10_000
  while (Date.now() < until && !useStore.getState().decks.A.peaks) await new Promise((r) => setTimeout(r, 100))
  ctl.seekDeckByHand('A', 5)
  await new Promise((r) => setTimeout(r, 300))
})

const state = () =>
  page.evaluate(async () => {
    const d = (await window.mod('/src/app/state/store.ts')).useStore.getState().decks.A
    return { range: d.loopRange, active: d.loopActive }
  })
// green-tinted pixels in the waveform's top row. The track is silent before 10 s, so above the
// body only the band's tint and edges can be green there (bar lines are yellow, cues are other hues).
const green = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas[data-deck="A"]')
    const row = c.getContext('2d').getImageData(0, 2, c.width, 1).data
    let n = 0
    for (let x = 0; x < c.width; x++) {
      const i = x * 4
      if (row[i + 1] > row[i] + 20 && row[i + 1] > row[i + 2] + 8) n++
    }
    return n
  })

let s = await state()
ok('no loop: nothing in the store', s.range === null && !s.active)
const before = await green()
ok('no loop: no green on the waveform', before === 0, `${before}px`)

await page.evaluate(async () => (await window.mod('/src/controls.ts')).toggleLoop('A'))
await page.waitForTimeout(300)
s = await state()
ok('toggleLoop puts the loop range in the store', !!s.range && s.range.endSec > s.range.startSec && s.active, JSON.stringify(s))
const on = await green()
ok('the loop band is drawn (paused deck)', on > 20, `${on}px`)

await page.evaluate(async () => (await window.mod('/src/controls.ts')).toggleLoop('A'))
await page.waitForTimeout(300)
s = await state()
ok('toggling off clears the range', s.range === null && !s.active)
ok('the band disappears', (await green()) === 0)

// Loop Roll never sets loopActive — it must still be on screen.
await page.evaluate(async () => {
  const ctl = await window.mod('/src/controls.ts')
  const { useStore } = await window.mod('/src/app/state/store.ts')
  useStore.getState().patchDeck('A', { padMode: 'loop' })
  ctl.setShiftHeld(true)
  window.__release = ctl.pressPad('A', 1)
  ctl.setShiftHeld(false)
})
await page.waitForTimeout(300)
s = await state()
ok('Loop Roll shows a range although loopActive stays false', !!s.range && !s.active, JSON.stringify(s))
ok('Loop Roll band is drawn', (await green()) > 20)
await page.evaluate(() => typeof window.__release === 'function' && window.__release())
await page.waitForTimeout(300)
s = await state()
ok('releasing the roll clears the range', s.range === null)

// A roll pressed over a normal loop must not leave the LOOP button lit when released.
await page.evaluate(async () => {
  const ctl = await window.mod('/src/controls.ts')
  ctl.toggleLoop('A')
  ctl.setShiftHeld(true)
  window.__release = ctl.pressPad('A', 1)
  ctl.setShiftHeld(false)
})
await page.evaluate(() => window.__release())
await page.waitForTimeout(300)
s = await state()
ok('roll released over an active loop: no range and LOOP button off', s.range === null && !s.active, JSON.stringify(s))

// A long loop (32 beats) with the playhead inside it: both edges are off-screen, the band must still draw.
await page.evaluate(async () => {
  const ctl = await window.mod('/src/controls.ts')
  ctl.setLoopBeats('A', 32)
  ctl.toggleLoop('A')
})
await page.waitForTimeout(300)
ok('a long loop with both edges off-screen still draws the band', (await green()) > 100, `${await green()}px`)
await page.evaluate(async () => {
  const ctl = await window.mod('/src/controls.ts')
  ctl.setLoopBeats('A', 8)
})
await page.waitForTimeout(300)
s = await state()
const bpmA = await page.evaluate(async () => (await window.mod('/src/app/state/store.ts')).useStore.getState().decks.A.bpm ?? 120)
const wantLen = (8 * 60) / bpmA
ok('changing the length while looping updates the range', !!s.range && Math.abs(s.range.endSec - s.range.startSec - wantLen) < 0.01, `${s.range && (s.range.endSec - s.range.startSec).toFixed(3)} s, want ${wantLen.toFixed(3)} s`)

await page.evaluate(async () => (await window.mod('/src/controls.ts')).ejectDeck('A'))
await page.waitForTimeout(200)
s = await state()
ok('ejecting the deck clears the range', s.range === null)

ok('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(`
${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)

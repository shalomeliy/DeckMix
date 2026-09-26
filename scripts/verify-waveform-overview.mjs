/**
 * v0.12.0: the whole-track overview strip above each deck's waveform.
 *   node scripts/verify-waveform-overview.mjs   (against npm run dev on :5173)
 *
 * The folding itself is unit-tested (`tests/core/waveform-overview.test.ts`);
 * this checks what only a real page can: the strip draws the track in the
 * right place, a click and a drag move the real deck, the SYNC lock holds,
 * the page still fits 710px, and the strip's canvas is NOT redrawn while the
 * deck plays — the whole point of drawing the playhead as an element.
 *
 * The WAV is 10 s of silence then 10 s of loud 60 Hz, so the right half of
 * the strip must be red and the left half must be empty.
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
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness())
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

ok('both decks show an overview strip', (await page.locator('canvas[data-overview]').count()) === 2)

await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
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
  await new Promise((r) => setTimeout(r, 300))
})

const pixels = await page.evaluate(() => {
  const c = document.querySelector('canvas[data-overview="A"]')
  const g = c.getContext('2d')
  const row = g.getImageData(0, Math.floor(c.height / 2) + 2, c.width, 1).data
  let redLeft = 0
  let redRight = 0
  for (let x = 0; x < c.width; x++) {
    const i = x * 4
    const red = row[i] > 180 && row[i + 1] < 120 && row[i + 2] < 120
    if (!red) continue
    if (x < c.width * 0.45) redLeft++
    else if (x > c.width * 0.55) redRight++
  }
  return { redLeft, redRight, w: c.width, h: c.getBoundingClientRect().height }
})
ok('the loud second half is drawn red on the right half of the strip', pixels.redRight > pixels.w * 0.35, JSON.stringify(pixels))
ok('the silent first half stays empty', pixels.redLeft === 0, JSON.stringify(pixels))

const layout = await page.evaluate(() => {
  const r = document.querySelector('canvas[data-overview="A"]').getBoundingClientRect()
  return {
    scrollH: document.documentElement.scrollHeight,
    wave: document.querySelector('canvas[data-deck="A"]').getBoundingClientRect().height,
    over: { x: r.x, y: r.y, width: r.width, height: r.height },
  }
})
ok('page still fits 710px with no scroll', layout.scrollH <= 710, `scrollHeight ${layout.scrollH}`)
ok('scrolling waveform keeps its 96px floor', layout.wave >= 96, `${layout.wave}px`)

const pos = () =>
  page.evaluate(async () => (await import('/src/app/state/store.ts')).useStore.getState().decks.A.positionSec)
const box = layout.over
const midY = box.y + box.height / 2
await page.mouse.click(box.x + box.width * 0.75, midY)
await page.waitForTimeout(150)
let p = await pos()
ok('click at 75% of the strip jumps to 15 s', Math.abs(p - 15) < 0.3, `${p.toFixed(2)} s`)

await page.mouse.move(box.x + box.width * 0.25, midY)
await page.mouse.down()
await page.mouse.move(box.x + box.width * 0.4, midY, { steps: 5 })
await page.mouse.move(box.x + box.width * 0.5, midY, { steps: 5 })
await page.waitForTimeout(100)
p = await pos()
ok('drag follows the pointer (ends at 10 s)', Math.abs(p - 10) < 0.3, `${p.toFixed(2)} s`)
await page.mouse.up()
await page.waitForTimeout(100)

const shade = await page.evaluate(() => {
  const wrap = document.querySelector('canvas[data-overview="A"]').parentElement
  const played = [...wrap.querySelectorAll('div')].find((d) => d.className.includes('bg-black/50'))
  return played ? played.getBoundingClientRect().width / wrap.getBoundingClientRect().width : -1
})
ok('the played part is shaded up to the playhead', Math.abs(shade - 0.5) < 0.02, shade.toFixed(3))

// The strip's canvas must not be repainted per frame while the deck plays.
const redraws = await page.evaluate(async () => {
  const ctl = await import('/src/controls.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  const c = document.querySelector('canvas[data-overview="A"]')
  let n = 0
  const orig = CanvasRenderingContext2D.prototype.fillRect
  CanvasRenderingContext2D.prototype.fillRect = function (...a) {
    if (this.canvas === c) n++
    return orig.apply(this, a)
  }
  const before = useStore.getState().decks.A.positionSec
  ctl.play('A')
  await new Promise((r) => setTimeout(r, 1200))
  const after = useStore.getState().decks.A.positionSec
  ctl.togglePlay('A')
  CanvasRenderingContext2D.prototype.fillRect = orig
  return { n, moved: after - before }
})
ok('deck actually played during the redraw check', redraws.moved > 0.5, `${redraws.moved.toFixed(2)} s`)
ok('overview canvas is not redrawn while playing', redraws.n === 0, `${redraws.n} fillRect calls`)

// SYNC lock: setting "blocked" + deck in SYNC → a click must not move it, and must say why.
const lockedAt = await page.evaluate(async () => {
  const { settings } = await import('/src/platform/settings-idb/store.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  await settings.set('waveformMouseInSync', 'blocked')
  useStore.getState().patchDeck('A', { syncActive: true })
  useStore.getState().setNotice(null)
  return useStore.getState().decks.A.positionSec
})
await page.mouse.click(box.x + box.width * 0.1, midY)
await page.waitForTimeout(150)
const afterLock = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const { settings } = await import('/src/platform/settings-idb/store.ts')
  const s = useStore.getState()
  const r = { pos: s.decks.A.positionSec, notice: s.notice?.text ?? null }
  await settings.set('waveformMouseInSync', 'likeJog')
  s.patchDeck('A', { syncActive: false })
  return r
})
// Measured against the click's target (2 s), not the position before it: a
// deck just paused may still be winding down by a few hundredths.
ok('SYNC lock: the click does not jump the deck', Math.abs(afterLock.pos - 2) > 5, `${lockedAt.toFixed(2)} → ${afterLock.pos.toFixed(2)}`)
ok('SYNC lock: and says why', !!afterLock.notice && afterLock.notice.includes('locked'), afterLock.notice)

// Lock switched on MID-drag (an FLX4 SYNC press): the drag stops moving the
// deck, and the notice is raised once — not again on every further move.
// Re-measured first: by now analysis has finished and the header gained its
// "unconfirmed grid" pill, which pushes the strip down — the old box is stale.
const box2 = await page.evaluate(() => {
  const r = document.querySelector('canvas[data-overview="A"]').getBoundingClientRect()
  return { x: r.x, y: r.y + r.height / 2, width: r.width, scrollH: document.documentElement.scrollHeight }
})
ok('page still fits 710px after analysis grows the header', box2.scrollH <= 710, `scrollHeight ${box2.scrollH}`)
await page.mouse.move(box2.x + box2.width * 0.3, box2.y)
await page.mouse.down()
await page.mouse.move(box2.x + box2.width * 0.35, box2.y, { steps: 2 })
await page.evaluate(async () => {
  const { settings } = await import('/src/platform/settings-idb/store.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  await settings.set('waveformMouseInSync', 'blocked')
  useStore.getState().patchDeck('A', { syncActive: true })
})
await page.mouse.move(box2.x + box2.width * 0.4, box2.y, { steps: 2 })
const midDrag = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const s = useStore.getState()
  const r = { pos: s.decks.A.positionSec, noticed: !!s.notice }
  s.setNotice(null)
  return r
})
await page.mouse.move(box2.x + box2.width * 0.6, box2.y, { steps: 5 })
await page.mouse.up()
const afterMid = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const { settings } = await import('/src/platform/settings-idb/store.ts')
  const s = useStore.getState()
  const r = { pos: s.decks.A.positionSec, notice: s.notice?.text ?? null }
  await settings.set('waveformMouseInSync', 'likeJog')
  s.patchDeck('A', { syncActive: false })
  return r
})
ok('mid-drag lock: the drag moved the deck before the lock (to ~7 s)', Math.abs(midDrag.pos - 7) < 0.3, midDrag.pos.toFixed(2))
ok('mid-drag lock: says why once', midDrag.noticed && afterMid.notice === null, JSON.stringify(afterMid.notice))
ok('mid-drag lock: the rest of the drag does not move the deck', Math.abs(afterMid.pos - 12) > 0.5 && Math.abs(afterMid.pos - midDrag.pos) < 0.2, `${midDrag.pos.toFixed(2)} → ${afterMid.pos.toFixed(2)}`)

// The hint badge sits beside the strip: on it, it hid the track's last seconds.
const gap = await page.evaluate(() => {
  const strip = document.querySelector('canvas[data-overview="A"]').getBoundingClientRect()
  const hint = document.querySelector('canvas[data-overview="A"]').parentElement.nextElementSibling
  return hint ? hint.getBoundingClientRect().left - strip.right : null
})
ok('hint badge does not cover the end of the strip', gap === null || gap >= 0, String(gap))

ok('no page errors', errors.length === 0, errors[0])
await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

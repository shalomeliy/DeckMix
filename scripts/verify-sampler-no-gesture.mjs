import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function makeWav() {
  const sr = 8000
  const n = Math.floor(sr * 0.05) // 0.05s, mono, 16-bit PCM — small and valid
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); writeStr(8, 'WAVE')
  writeStr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  writeStr(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3 * 32767), true)
  }
  return buf
}

// Chrome's autoplay rule, simulated: before the first touch on a page,
// `AudioContext.resume()` just waits. The automated browsers here did not
// hold it reliably, and the owner's own Chrome lets localhost start untouched
// (he plays there daily; measured 26/09). A fresh Chrome, a new machine or any
// other address does hold it — so this check holds resume() by hand until the
// script says the page was touched.
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage()
await page.addInitScript(() => {
  const real = AudioContext.prototype.resume
  let release
  const touched = new Promise((r) => (release = r))
  window.__touch = () => release()
  AudioContext.prototype.resume = function () {
    return touched.then(() => real.call(this))
  }
})
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)))
await page.goto(URL)
await page.waitForTimeout(500)

const wavB64 = Buffer.from(makeWav()).toString('base64')
const hash = await page.evaluate(async (b64) => {
  const { saveSamplerBank } = await import('/src/platform/sampler-idb/store.ts')
  const { hashBytes } = await import('/src/platform/source-fsaccess/hash.ts')
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const h = await hashBytes(bytes.buffer)
  await saveSamplerBank([
    { contentHash: h, trackName: 'No-gesture tone', bpm: 128, mode: 'oneShot', gain: 0.8, syncEnabled: false },
    ...Array(15).fill(null),
  ])
  return h
}, wavB64)

// Cold reload, and not one click from here on.
await page.reload()
await page.waitForTimeout(500)

// Through CDP with userGesture:false — Playwright's own page.evaluate runs
// WITH user activation, which is itself a "click" as far as Chrome's audio
// policy goes, and would start the context behind this check's back.
const cdp = await page.context().newCDPSession(page)
const noGestureEval = async (fn, arg) => {
  const res = await cdp.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
  return res.result.value
}
const r = await noGestureEval(async ({ hash, b64 }) => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'tone.wav', { type: 'audio/wav' })
  const track = { id: 'tone', name: 'tone.wav', path: 'tone.wav', kind: 'wav', contentHash: hash, handle: { getFile: async () => file } }
  useStore.getState().setLibrary({ tracks: [track] })
  const settled = await Promise.race([
    ctl.resolveSamplerSlots().then(() => true),
    new Promise((res) => setTimeout(() => res(false), 4000)),
  ])
  return {
    settled,
    ctxState: engine.ctx.state,
    trackId: useStore.getState().sampler.slots[0].trackId,
    hasBuffer: engine.sampler.hasBuffer(0),
    audioReady: useStore.getState().audioReady,
  }
}, { hash, b64: wavB64 })

ok('the page is untouched: the engine has not started', r.audioReady === false, JSON.stringify({ audioReady: r.audioReady }))
ok('resolving the saved bank finishes without waiting for a click', r.settled, JSON.stringify(r))
ok('slot 1 is linked to its track', r.trackId === 'tone', String(r.trackId))
ok('slot 1 has its audio loaded before any click', r.hasBuffer)

// A pad pressed before the engine runs (v0.12.1 review): it must not light up
// silently, and must name the way out.
const press = await noGestureEval(async () => {
  const ctl = await import('/src/controls.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  window.__touch()
  ctl.setPadMode('A', 'sampler')
  ctl.pressPad('A', 0)()
  await new Promise((r) => setTimeout(r, 700))
  const s = useStore.getState()
  return { playing: s.sampler.slots[0].playing, notice: s.notice?.text ?? null }
})
ok('pad pressed before the engine runs does not light up silently', press.playing === false, JSON.stringify(press))
ok('...and points at "Start audio engine"', !!press.notice && press.notice.includes('Start audio engine'), press.notice)

// Measured in this Chromium (the stub was already released by __touch above,
// so only the browser holds the start now): a real click on an empty spot did
// NOT release it — which is why the notice names the button.
const empty = await page.evaluate(() => {
  for (let y = 700; y > 0; y -= 10) for (let x = 1530; x > 0; x -= 10) {
    const el = document.elementFromPoint(x, y)
    if (el === document.body || el === document.documentElement || el?.id === 'root') return { x, y }
  }
  return { x: 2, y: 2 }
})
await page.mouse.click(empty.x, empty.y)
await page.waitForTimeout(500)
const afterEmpty = await noGestureEval(async () => (await import('/src/app/state/store.ts')).useStore.getState().audioReady)
ok('(measured, test Chromium) a click on empty page space does not start the held engine', afterEmpty === false, String(afterEmpty))

// The way out the notice names: the button, then the pad again.
await page.getByRole('button', { name: /Start audio engine/ }).click()
await page.waitForTimeout(800)
const started = await noGestureEval(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const s = useStore.getState()
  return { ctx: engine.ctx.state, audioReady: s.audioReady, playing: s.sampler.slots[0].playing, notice: s.notice?.text ?? null }
})
ok('"Start audio engine" starts it', started.ctx === 'running' && started.audioReady, JSON.stringify(started))
ok('the pad that waited does not go off by itself', started.playing === false, JSON.stringify(started))
ok('the "engine is off" notice is gone', !started.notice || !started.notice.includes('engine is off'), String(started.notice))

const second = await noGestureEval(async () => {
  const ctl = await import('/src/controls.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  let saw = false
  const unsub = useStore.subscribe((s) => { if (s.sampler.slots[0].playing) saw = true })
  ctl.pressPad('A', 0)()
  await new Promise((r) => setTimeout(r, 600))
  unsub()
  return { saw, playingNow: useStore.getState().sampler.slots[0].playing }
})
ok('pressed again, the pad plays', second.saw, JSON.stringify(second))
ok('the one-shot un-lights when it ends', second.playingNow === false, JSON.stringify(second))

// The fast path, as the owner meets it: no stub, a fresh page, and the very
// first touch is a real click ON the pad. That click lets the engine start at
// once, so the pad must play straight away — no notice, no second press.
{
  const ctx2 = await browser.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(URL)
  await p2.waitForTimeout(500)
  const cdp2 = await ctx2.newCDPSession(p2)
  const ev2 = async (fn, arg) => {
    const res = await cdp2.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true, userGesture: false })
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
    return res.result.value
  }
  await ev2(async ({ hash }) => {
    const { saveSamplerBank } = await import('/src/platform/sampler-idb/store.ts')
    await saveSamplerBank([
      { contentHash: hash, trackName: 'No-gesture tone', bpm: 128, mode: 'oneShot', gain: 0.8, syncEnabled: false },
      ...Array(15).fill(null),
    ])
  }, { hash })
  await p2.reload()
  await p2.waitForTimeout(500)
  await ev2(async ({ hash, b64 }) => {
    const { useStore } = await import('/src/app/state/store.ts')
    const ctl = await import('/src/controls.ts')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'tone.wav', { type: 'audio/wav' })
    useStore.getState().setLibrary({ tracks: [{ id: 'tone', name: 'tone.wav', path: 'tone.wav', kind: 'wav', contentHash: hash, handle: { getFile: async () => file } }] })
    await ctl.resolveSamplerSlots()
    ctl.setPadMode('A', 'sampler')
    window.__saw = false
    useStore.subscribe((st) => { if (st.sampler.slots[0].playing) window.__saw = true })
  }, { hash, b64: wavB64 })
  const before = await ev2(async () => (await import('/src/app/state/store.ts')).useStore.getState().audioReady)
  await p2.getByRole('button', { name: /^Sampler slot 1:/ }).first().click()
  await p2.waitForTimeout(700)
  const fast = await ev2(async () => {
    const s = (await import('/src/app/state/store.ts')).useStore.getState()
    return { saw: window.__saw, playingNow: s.sampler.slots[0].playing, audioReady: s.audioReady, notice: s.notice?.text ?? null }
  })
  ok('fast path: engine was off before the click', before === false, String(before))
  ok('fast path: one real click on the pad starts the engine and plays it', fast.saw && fast.audioReady, JSON.stringify(fast))
  ok('fast path: no "engine is off" notice, and the pad un-lights', fast.playingNow === false && !(fast.notice ?? '').includes('engine is off'), JSON.stringify(fast))
  await ctx2.close()
}

await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)

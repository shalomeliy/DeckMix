/**
 * v0.9.33 in the running app: the deck's isolator EQ and the master limiter, as Chromium actually builds them. Needs the dev server
 * (`deckmix-dev`, port 5173), started after the last edit: a module Vite has hot-swapped loads twice — once for the app and once for
 * this script's `import()` — and the script then talks to a second engine nobody hears (found 07/10).
 *   node scripts/verify-isolator.mjs [http://localhost:5173]
 *
 * 1. The app loads with no console error, the LIM light is on screen, and the engine reports a limiter reduction of 0 at rest; a hot tone
 *    lights it; the cue is delayed by exactly the limiter's look-ahead.
 * 2. The real `Deck` class (imported from the dev server, built on an OfflineAudioContext) is fed one sine inside each band (60 Hz, 1 kHz,
 *    10 kHz), with every knob in the middle, then each knob killed. What this pins: in the middle the deck
 *    is as loud as its input (the bands sum flat), and a kill takes its own band down by at least 30 dB while the other two move by less
 *    than 1 dB. The old shelf/peak EQ failed the second part on MID: −16 dB at 100 Hz (07/10).
 */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:5173'
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(url)
await page.waitForSelector('[data-testid="limiter-light"]', { timeout: 30000 })
let pass = 0
let fail = 0
const check = (ok, text) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`)
}
// Chromium's compressor reports a phantom reduction for its first second (−13 dB at load); the engine reads 0 until 3 s. Sampled across
// that window and after it, with nothing playing: the LIM light must never be lit.
const atRest = await page.evaluate(async () => {
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const seen = []
  for (let i = 0; i < 10; i++) {
    seen.push(engine.limiterReductionDb)
    await new Promise((r) => setTimeout(r, 400))
  }
  return Math.min(...seen)
})
check(atRest > -1, `limiter with nothing playing, over 4 s from load: lowest reading ${atRest.toFixed(2)} dB (the light needs −1)`)

const r = await page.evaluate(async () => {
  const { Deck } = await import('/src/platform/audio-webaudio/deck.ts')
  const SR = 48000
  const N = SR * 2
  // One sine per band, well inside it (the crossovers are 250 Hz and 3 kHz): what comes out is that band's gain, nothing to filter.
  const TONES = { low: 60, mid: 1000, high: 10000 }
  const tone = (hz) => {
    const buf = new AudioBuffer({ length: N, numberOfChannels: 1, sampleRate: SR })
    const d = buf.getChannelData(0)
    for (let i = 0; i < N; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR)
    return buf
  }
  const rmsDb = (x) => {
    let s = 0
    for (let i = SR / 2; i < N; i++) s += x[i] * x[i] // skip the first half second: the filters and knob ramps settling
    return 10 * Math.log10(s / (N - SR / 2))
  }
  // The yardstick: the deck's own resting filter knob (a 20 Hz highpass and a 22 kHz lowpass at Q 0.7 — on the dB reading of Q that puts
  // +0.5 dB at 60 Hz, there before v0.9.33 and not this check's business). Everything else on the deck must add nothing to it.
  async function throughRestFilters(input) {
    const ctx = new OfflineAudioContext(1, N, SR)
    const src = ctx.createBufferSource()
    src.buffer = input
    let node = src
    for (const [type, f] of [['highpass', 20], ['lowpass', 22050]]) {
      const b = ctx.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = 0.7
      node = node.connect(b)
    }
    node.connect(ctx.destination)
    src.start()
    return ctx.startRendering()
  }
  async function throughDeck(knobs, input) {
    const ctx = new OfflineAudioContext(1, N, SR)
    const deck = new Deck(ctx, 'A')
    for (const [band, k] of Object.entries(knobs)) deck.setEq(band, k)
    const src = ctx.createBufferSource()
    src.buffer = input
    src.connect(deck.trim)
    deck.faderGain.connect(ctx.destination)
    src.start()
    return ctx.startRendering()
  }
  const out = {}
  for (const [name, knobs] of Object.entries({ flat: {}, lowKill: { low: -1 }, midKill: { mid: -1 }, highKill: { high: -1 } })) {
    out[name] = {}
    for (const [band, hz] of Object.entries(TONES)) {
      const t = tone(hz)
      out[name][band] = rmsDb((await throughDeck(knobs, t)).getChannelData(0)) - rmsDb((await throughRestFilters(t)).getChannelData(0))
    }
  }
  return out
})
const f = (o) => Object.entries(o).map(([b, v]) => `${b} ${v.toFixed(2)}`).join(', ')
check(Object.values(r.flat).every((v) => Math.abs(v) < 0.1), `all knobs in the middle: ${f(r.flat)} dB (each band within 0.1 dB of the input)`)
for (const kill of ['low', 'mid', 'high']) {
  const row = r[`${kill}Kill`]
  const others = Object.entries(row).filter(([b]) => b !== kill)
  check(row[kill] < -30 && others.every(([, v]) => Math.abs(v) < 1), `${kill.toUpperCase()} killed: ${f(row)} dB (its band under −30, the others within 1 dB)`)
}
// A tone 10 dB over full scale into the live master bus: the limiter is in the path, it works, and the LIM light says so.
const hot = await page.evaluate(async () => {
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const ctx = engine.ctx
  await ctx.resume()
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  // The master bus gain sits between this and the limiter — on a stereo device (this headless one) the cue-mix fold puts it at 0.15
  // (`applyCueMix`) — so the tone is set from it, to arrive 10 dB over full scale.
  g.gain.value = 10 ** (10 / 20) / engine.masterBus.gain.value
  osc.connect(g).connect(engine.masterBus)
  osc.start()
  await new Promise((r) => setTimeout(r, 800))
  const reduction = engine.limiterReductionDb
  const light = document.querySelector('[data-testid="limiter-light"]')
  const lit = light?.getAttribute('title')?.includes('מוריד עכשיו') ?? false
  osc.stop()
  return { reduction, lit }
})
check(hot.reduction < -5 && hot.lit, `a tone 10 dB over full scale: the limiter takes off ${(-hot.reduction).toFixed(1)} dB, LIM light ${hot.lit ? 'on' : 'off'}`)
// The limiter's look-ahead, measured in this Chromium (an impulse through the same node), against the delay the engine puts on the cue:
// headphones and master must stay in step for beat-matching by ear.
const lag = await page.evaluate(async () => {
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const { MASTER_LIMITER: L } = await import('/src/core/constants.ts')
  const SR = 48000
  const ctx = new OfflineAudioContext(1, SR / 10, SR)
  const buf = new AudioBuffer({ length: SR / 10, numberOfChannels: 1, sampleRate: SR })
  buf.getChannelData(0)[1000] = 0.1
  const src = ctx.createBufferSource()
  src.buffer = buf
  const c = ctx.createDynamicsCompressor()
  c.threshold.value = L.thresholdDb
  c.knee.value = L.kneeDb
  c.ratio.value = L.ratio
  c.attack.value = L.attackSec
  c.release.value = L.releaseSec
  src.connect(c).connect(ctx.destination)
  src.start()
  const out = (await ctx.startRendering()).getChannelData(0)
  let at = 0
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[at])) at = i
  return { limiterSec: (at - 1000) / SR, cueSec: engine.cueOut.delayTime.value }
})
check(Math.abs(lag.limiterSec - lag.cueSec) < 0.0005, `limiter look-ahead ${(lag.limiterSec * 1000).toFixed(2)} ms, cue delayed ${(lag.cueSec * 1000).toFixed(2)} ms`)
check(errors.length === 0, `console errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
await browser.close()
console.log(`${pass}/${pass + fail}`)
process.exit(fail ? 1 : 0)

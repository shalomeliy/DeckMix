/**
 * v0.9.33 (07/10), a hot cue pressed on a SYNCed deck that is already playing keeps the beat.
 *   node scripts/verify-hotcue-sync-jump.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * The owner pressed the same "Mix in" pad a second time, on a deck already playing, and heard "two kicks one after the other". A pad on a
 * playing deck is a plain jump: it landed off the other deck's beat by up to half a beat, and SYNC pulls a deck back only by nudging its
 * speed. Measured on his own pair (Voyager -> The Light, 6 jumps): kicks 76-228 ms apart before, 8-11 ms after.
 *
 * Here with two synthetic songs only (no real music touched): "KL Click", a click on every whole second (its grid reads 120 BPM). Both
 * decks play it, B SYNCed to A; a pad on B half a beat off the grid is pressed; the clicks of the two decks must still come out together.
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.addInitScript(() => {
  window.mod = (p) => {
    const hit = performance.getEntriesByType('resource').map((e) => new URL(e.name)).find((u) => u.pathname === p)
    return import(hit ? hit.pathname + hit.search : p)
  }
})
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const lib = await root.getDirectoryHandle('Tracks', { create: true })
  const house = await lib.getDirectoryHandle('House', { create: true })
  const sr = 44100, dur = 40, n = sr * dur
  for (const name of ['KL Tone', 'KL Click']) {
    const pcm = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      let s
      if (name === 'KL Tone') s = 0.3 * Math.sin(2 * Math.PI * 440 * t)
      else { const f = t % 1; s = f < 0.003 ? 0.9 * Math.sin(2 * Math.PI * 2000 * f) : 0 }
      pcm[2 * i] = pcm[2 * i + 1] = Math.max(-1, Math.min(1, s)) * 32767
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf)
    const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true)
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    const ws = await (await house.getFileHandle(`${name}.wav`, { create: true })).createWritable()
    await ws.write(buf); await ws.close()
  }
  window.showDirectoryPicker = async () => lib
})
await page.getByRole('button', { name: /LOAD MY MUSIC FOLDER/i }).first().click()


const res = await page.evaluate(async () => {
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const ctl = await window.mod('/src/controls.ts')
  const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200) } return false }
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('KL ')).length === 2, 30000)
  const t = useStore.getState().library.tracks.find((x) => x.name.startsWith('KL Click'))
  for (const d of ['A', 'B']) {
    await ctl.loadTrackToDeck(d, t)
    await wait(() => !useStore.getState().decks[d].loading && useStore.getState().decks[d].beatGrid, 30000)
  }
  const sr = engine.ctx.sampleRate
  const record = async (ms) => {
    const ctx = engine.ctx
    const proc = ctx.createScriptProcessor(1024, 2, 1)
    const merger = ctx.createChannelMerger(2)
    const mute = ctx.createGain(); mute.gain.value = 0
    const ca = [], cb = []
    proc.onaudioprocess = (e) => { ca.push({ t: e.playbackTime, d: new Float32Array(e.inputBuffer.getChannelData(0)) }); cb.push({ t: e.playbackTime, d: new Float32Array(e.inputBuffer.getChannelData(1)) }) }
    engine.decks.A.faderGain.connect(merger, 0, 0); engine.decks.B.faderGain.connect(merger, 0, 1); merger.connect(proc); proc.connect(mute); mute.connect(ctx.destination)
    await sleep(ms)
    engine.decks.A.faderGain.disconnect(merger); engine.decks.B.faderGain.disconnect(merger); merger.disconnect(); proc.disconnect(); mute.disconnect()
    const clicks = (ch) => { const h = []; let last = -1; for (const c of ch) for (let j = 0; j < c.d.length; j++) { const tt = c.t + j / sr; if (Math.abs(c.d[j]) > 0.3 && tt - last > 0.3) { h.push(tt); last = tt } } return h }
    const ha = clicks(ca), hb = clicks(cb)
    // Offset of each B click from the nearest A click, folded onto the 0.5 s beat the grid reads (a click a whole beat away is on the beat).
    return hb.map((b) => { const a = ha.reduce((best, x) => (Math.abs(x - b) < Math.abs(best - b) ? x : best), ha[0]); let d = (b - a) / 0.5; d -= Math.round(d); return d * 500 })
  }
  const out = []
  for (let i = 0; i < 5; i++) {
    ctl.pause('A'); ctl.pause('B')
    ctl.seekDeck('A', 3 + i * 1.3)
    ctl.play('A')
    await sleep(300)
    ctl.seekDeck('B', 12 + i * 0.7)
    ctl.play('B')
    if (!useStore.getState().decks.B.syncActive) ctl.syncDeck('B')
    await sleep(3000)
    // A pad a quarter of a second off the grid's beat (half a beat at 120): a plain jump lands there, a synced one on the beat next to it.
    const cues = useStore.getState().decks.B.hotCues.filter((c) => c.index !== 0)
    useStore.getState().patchDeck('B', { hotCues: [...cues, { index: 0, positionSec: 20.25, label: '1', color: '#f00', createdAt: 1 }] })
    await sleep(100 + i * 70)
    ctl.pressHotCue('B', 0)
    await sleep(200)
    const offs = await record(4200)
    out.push({ offs, synced: useStore.getState().decks.B.syncActive, pos: engine.decks.B.position })
  }
  ctl.pause('A'); ctl.pause('B')
  return out
})
// The first click after a jump was up to 32 ms off in a headless run (the seek reaches the audio thread a few render quanta after the position it was
// worked out from); the SYNC loop then takes it in over its 1 s cycles. 40 / 12 ms: a plain jump off a half-beat pad is ~250 ms on every click.
let worstAny = 0, worstLast = 0
for (const r of res) {
  for (const o of r.offs) worstAny = Math.max(worstAny, Math.abs(o))
  worstLast = Math.max(worstLast, Math.abs(r.offs[r.offs.length - 1] ?? NaN))
  console.log(`  jump: B clicks ${r.offs.map((o) => o.toFixed(1)).join('/')} ms from A's (synced ${r.synced})`)
}
ok('a pad pressed on a playing, synced deck lands on the beat: every click within 40 ms of the other deck', res.length === 5 && worstAny < 40, `worst ${worstAny.toFixed(1)} ms (a plain jump: ~250)`)
// Recorded, not gated: how close the SYNC loop has brought it ~3 s on. 4–17 ms over four runs in review — the loop's own settling (1 s
// cycles, a 4 ms deadband), not this jump; a gate on it was flaky, and a flaky gate gets ignored.
console.log(`INFO  last click, ~3 s after the jump: worst ${worstLast.toFixed(1)} ms`)
ok('nothing throws', errors.length === 0, errors.slice(0, 2).join(' | '))
await browser.close()
process.exit(results.every((r) => r.pass) ? 0 : 1)

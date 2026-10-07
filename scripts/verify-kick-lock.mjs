/**
 * v0.9.33 (07/10), the incoming song waits silent until its kicks sit on the outgoing song's (`core/kick-lock.ts`).
 *   node scripts/verify-kick-lock.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * The owner: "why not line the kicks up while the volume is down, and bring the incoming song up only once you see they sit together?"
 * Two synthetic songs only ("KL Click", a click on every whole second, 120 BPM by its grid). A plain automatic transition A -> B, twice:
 * as it lands, and with B knocked 30 ms off right after the join (what a late seek or a key-locked deck can do). Each run records the two
 * decks before the crossfader and the crossfader itself; B's clicks from the moment B starts rising must sit on A's.
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
      else { const f = t % 1; s = f < 0.003 ? 0.9 * Math.sin(2 * Math.PI * 6000 * f) : 0 }
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
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50) } return false }
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('KL ')).length === 2, 30000)
  const t = useStore.getState().library.tracks.find((x) => x.name.startsWith('KL Click'))
  for (const d of ['A', 'B']) {
    await ctl.loadTrackToDeck(d, t)
    await wait(() => !useStore.getState().decks[d].loading && useStore.getState().decks[d].beatGrid, 30000)
  }
  const sr = engine.ctx.sampleRate
  const out = []
  const runs = []
  for (let rep = 0; rep < 2; rep++) for (const knock of [0, 0.03, -0.03]) runs.push({ knock, keyed: false })
  runs.push({ knock: 0, keyed: true }, { knock: 0.03, keyed: true })
  for (const { knock, keyed } of runs) {
    ctl.pause('A'); ctl.pause('B')
    if (useStore.getState().activeTransition) ctl.cancelTransition()
    if (!!useStore.getState().decks.B.keyLock !== keyed) await ctl.toggleKeyLock('B')
    ctl.seekDeck('B', 8)
    ctl.seekDeck('A', 3.3)
    ctl.play('A')
    await sleep(500)
    const ctx = engine.ctx
    const proc = ctx.createScriptProcessor(1024, 2, 1)
    const merger = ctx.createChannelMerger(2)
    const mute = ctx.createGain(); mute.gain.value = 0
    const ca = [], cb = [], xf = []
    proc.onaudioprocess = (e) => { ca.push({ t: e.playbackTime, d: new Float32Array(e.inputBuffer.getChannelData(0)) }); cb.push({ t: e.playbackTime, d: new Float32Array(e.inputBuffer.getChannelData(1)) }) }
    engine.decks.A.fxSeam.connect(merger, 0, 0); engine.decks.B.fxSeam.connect(merger, 0, 1); merger.connect(proc); proc.connect(mute); mute.connect(ctx.destination)
    let raf = true
    const poll = () => { if (!raf) return; xf.push({ t: ctx.currentTime, x: useStore.getState().mixer.crossfader, aligning: !!useStore.getState().activeTransition?.aligning }); requestAnimationFrame(poll) }
    requestAnimationFrame(poll)
    // The knock lands on the same tick as the join's own seek (the store says B plays right after it), before the gate's first reading.
    let knocked = !knock
    const unsub = useStore.subscribe((st) => {
      if (knocked || !st.decks.B.playing) return
      knocked = true
      engine.decks.B.seek(engine.decks.B.position + knock)
    })
    ctl.startAutoTransition('A', 'B', 10)
    await wait(() => !useStore.getState().activeTransition, 15000)
    unsub()
    await sleep(300)
    raf = false
    engine.decks.A.fxSeam.disconnect(merger); engine.decks.B.fxSeam.disconnect(merger); merger.disconnect(); proc.disconnect(); mute.disconnect()
    // Times from the sample count, not each buffer's playbackTime: headless, the stamps jump by whole render quanta (A's own clicks read
    // 991-1012 ms apart on a file that has them exactly 1000 ms apart), and a click pair split across two buffers took that error with it.
    const clicks = (ch) => { const h = []; let last = -1; const t0 = ch[0].t; let n = 0; for (const c of ch) for (let j = 0; j < c.d.length; j++, n++) { const tt = t0 + n / sr; if (Math.abs(c.d[j]) > 0.3 && tt - last > 0.3) { h.push(tt); last = tt } } return h }
    const ha = clicks(ca), hb = clicks(cb)
    const off = (b) => { const a = ha.reduce((best, x) => (Math.abs(x - b) < Math.abs(best - b) ? x : best), ha[0]); let d = (b - a) / 0.5; d -= Math.round(d); return d * 500 }
    const joinT = xf.find((f) => f.aligning)?.t ?? null
    const riseT = xf.find((f) => f.x > -0.999)?.t ?? null
    out.push({
      knock,
      keyed,
      holdMs: joinT != null && riseT != null ? (riseT - joinT) * 1000 : null,
      silent: hb.filter((b) => riseT != null && b < riseT).map(off),
      rising: hb.filter((b) => riseT != null && b >= riseT).slice(0, 4).map(off),
      notice: useStore.getState().notice?.text ?? '',
      all: hb.map((b) => [((b - (joinT ?? 0)) * 1000).toFixed(0), off(b).toFixed(1)].join(":")).join(" "),
    })
  }
  ctl.pause('A'); ctl.pause('B')
  return out
})
for (const r of res) {
  console.log(`  ${r.keyed ? 'key lock, ' : ''}knock ${(r.knock * 1000).toFixed(0)} ms: held ${r.holdMs?.toFixed(0)} ms; B clicks while silent ${r.silent.map((o) => o.toFixed(1)).join('/')} ms; once rising ${r.rising.map((o) => o.toFixed(1)).join('/')} ms`)
  console.log("    all " + r.all)
  if (/קיקים/.test(r.notice)) console.log(`  notice: ${r.notice}`)
}
const audible = res.flatMap((r) => r.rising)
const worst = Math.max(...audible.map(Math.abs))
ok('eight transitions ran, B rose in each', res.length === 8 && res.every((r) => r.holdMs != null && r.rising.length > 0))
ok('B was held down while a knocked-off gap was closed', res.filter((r) => r.knock).every((r) => r.holdMs > 300), res.map((r) => `${r.holdMs?.toFixed(0)}`).join(' / ') + ' ms')
// Measured 07/10, headless: with the wait, the first clicks heard as B rises 10-15 ms off (worst 14.9); with the wait taken out (the
// same three runs), 57 ms (no knock), 43 and 17. The 7-13 ms that stays is steady from the first click to the last and the same with or
// without the wait — SYNC's positions do not see it (recorded as debt in docs/handoff/v0.9.33.md), so the gate sits above it.
ok('every B click heard once B rises sits within 16 ms of A\'s', worst < 16, `worst ${worst.toFixed(1)} ms (no wait: up to 57)`)
ok('nothing throws', errors.length === 0, errors.slice(0, 2).join(' | '))
await browser.close()
process.exit(results.every((r) => r.pass) ? 0 : 1)

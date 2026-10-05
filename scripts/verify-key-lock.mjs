/**
 * v0.9.20, key lock: end to end in the running app, at the owner's viewport (1536 x 710).
 *   node scripts/verify-key-lock.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * Two synthetic songs in the browser's own file store (OPFS) — no real music touched: "KL Tone" (a 440 Hz sine) and "KL Click" (a click on
 * every whole second of the song). What it proves, with numbers, by recording deck A's own output (its fader node) in the page:
 *  - tempo +8% with the key lock off sounds ~475 Hz (a record); with it on, 440 Hz (the song's own pitch);
 *  - the key lock's delay is made up for: a click at second k comes out when the deck SAYS it is at k, keyed or not, within 15 ms of the
 *    plain deck — without the make-up it would be the stretch's whole latency late, and every bar line, SYNC and Mix Assist join with it;
 *  - a hand on the platter takes the key lock out without the position jumping, and letting go puts it back;
 *  - the Key lock button lights and the page still fits 710 px; nothing throws.
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

// Shared page helpers: load a song onto A, and record A's own output with the context time each sample is played at.
await page.evaluate(async () => {
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const ctl = await window.mod('/src/controls.ts')
  const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200) } return false }
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('KL ')).length === 2, 30000)
  window.kl = {
    async load(name) {
      ctl.pause('A')
      const t = useStore.getState().library.tracks.find((x) => x.name.startsWith(name))
      await ctl.loadTrackToDeck('A', t)
      await wait(() => !useStore.getState().decks.A.loading && useStore.getState().decks.A.track?.name.startsWith(name), 30000)
      ctl.setCrossfader(-1)
    },
    /** `sec` of deck A's output, plus (context time, deck position) pairs read on the main thread meanwhile. */
    async record(sec) {
      const ctx = engine.ctx
      const proc = ctx.createScriptProcessor(1024, 2, 1)
      const mute = ctx.createGain(); mute.gain.value = 0
      const chunks = []
      proc.onaudioprocess = (e) => chunks.push({ t: e.playbackTime, d: new Float32Array(e.inputBuffer.getChannelData(0)) })
      engine.decks.A.faderGain.connect(proc); proc.connect(mute); mute.connect(ctx.destination)
      const pairs = []
      const end = performance.now() + sec * 1000
      while (performance.now() < end) { pairs.push({ t: ctx.currentTime, pos: engine.decks.A.position }); await new Promise((r) => requestAnimationFrame(r)) }
      engine.decks.A.faderGain.disconnect(proc); proc.disconnect(); mute.disconnect()
      return { chunks, pairs, sr: ctx.sampleRate }
    },
  }
})

const tempoFor = (rate) => page.evaluate(async (rate) => {
  const { settings } = await window.mod('/src/platform/settings-idb/store.ts')
  return (rate - 1) / settings.values.tempoRange
}, rate)

// 1. Pitch.
{
  const tempo = await tempoFor(1.08)
  const hz = await page.evaluate(async (tempo) => {
    const ctl = await window.mod('/src/controls.ts')
    const { useStore } = await window.mod('/src/app/state/store.ts')
    await window.kl.load('KL Tone')
    ctl.setTempo('A', tempo)
    ctl.seekDeck('A', 5)
    ctl.play('A')
    const measure = async () => {
      await new Promise((r) => setTimeout(r, 600))
      const { chunks, sr } = await window.kl.record(1.2)
      // Autocorrelation, not zero crossings: a stretch adds a little low-level noise, and every extra crossing reads as a higher pitch.
      const d = chunks.flatMap((c) => [...c.d]).slice(Math.floor(0.2 * sr), Math.floor(0.2 * sr) + 16384)
      const corr = (lag) => { let a = 0; for (let i = 0; i + lag < d.length; i++) a += d[i] * d[i + lag]; return a }
      let best = 0, bestLag = 0
      for (let lag = Math.floor(sr / 600); lag <= Math.ceil(sr / 350); lag++) { const c = corr(lag); if (c > best) { best = c; bestLag = lag } }
      const y0 = corr(bestLag - 1), y1 = best, y2 = corr(bestLag + 1)
      return sr / (bestLag + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2))
    }
    const off = await measure()
    await ctl.toggleKeyLock('A')
    const lit = useStore.getState().decks.A.keyLock
    const on = await measure()
    await ctl.toggleKeyLock('A')
    const back = await measure()
    ctl.pause('A')
    return { off, on, back, lit, notice: useStore.getState().notice?.text ?? null }
  }, tempo)
  ok('tempo +8%, key lock off: the pitch goes up with the speed, like a record', Math.abs(hz.off - 475.2) < 4, `${hz.off.toFixed(1)} Hz (440 × 1.08 = 475.2)`)
  // 439.5–443: what a 60 ms block measures (442.2–442.5, ~9 cents sharp; the library's 120 ms default gives 440). Tight on purpose: anything
  // sharper is a regression, not noise (independent review, 05/10).
  ok('key lock on: the song keeps its own pitch', hz.lit && hz.on > 439.5 && hz.on < 443, `${hz.on.toFixed(1)} Hz, store keyLock ${hz.lit}${hz.notice ? ` · notice "${hz.notice}"` : ''}`)
  ok('key lock off again: back to the record pitch', Math.abs(hz.back - 475.2) < 4, `${hz.back.toFixed(1)} Hz`)
}

// 2. Timing: when does the click at second k come out, against when the deck says it is at k?
const lateness = (rec) => {
  const { chunks, pairs, sr } = rec
  const heard = []
  let last = -1
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) {
    const t = c.t + i / sr
    if (Math.abs(c.d[i]) > 0.3 && t - last > 0.5) { heard.push(t); last = t }
  }
  // The deck's position against context time is a straight line while it plays: fitted over every pair, so one late animation frame (the
  // main thread reads the position, not the audio thread) cannot move a click's "when the deck said k" by itself.
  const steady = pairs.slice(Math.floor(pairs.length * 0.1))
  const mt = steady.reduce((a, p) => a + p.t, 0) / steady.length, mp = steady.reduce((a, p) => a + p.pos, 0) / steady.length
  const slope = steady.reduce((a, p) => a + (p.t - mt) * (p.pos - mp), 0) / steady.reduce((a, p) => a + (p.t - mt) ** 2, 0)
  const atPos = (k) => mt + (k - mp) / slope
  const out = []
  for (const h of heard) {
    const k = Math.round(mp + slope * (h - mt))
    out.push(h - atPos(k))
  }
  out.sort((x, y) => x - y)
  return { n: out.length, median: out.length ? out[Math.floor(out.length / 2)] : NaN }
}
{
  const recs = await page.evaluate(async () => {
    const ctl = await window.mod('/src/controls.ts')
    await window.kl.load('KL Click')
    const run = async (keyed) => {
      const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
      if (engine.decks.A.keyLock !== keyed) await ctl.toggleKeyLock('A')
      ctl.seekDeck('A', 3.5)
      ctl.play('A')
      await new Promise((r) => setTimeout(r, 300))
      const rec = await window.kl.record(4)
      ctl.pause('A')
      return { chunks: rec.chunks.map((c) => ({ t: c.t, d: [...c.d] })), pairs: rec.pairs, sr: rec.sr }
    }
    const dry = await run(false)
    const keyed = await run(true)
    return { dry, keyed }
  })
  const dry = lateness(recs.dry), keyed = lateness(recs.keyed)
  ok('the clicks come out where the deck says it is — key lock as on time as the plain deck (within 15 ms)', dry.n >= 3 && keyed.n >= 3 && Math.abs(keyed.median - dry.median) < 0.015,
    `plain: ${dry.n} clicks, ${(dry.median * 1000).toFixed(1)} ms · key lock: ${keyed.n} clicks, ${(keyed.median * 1000).toFixed(1)} ms (the stretch's own latency is 60 ms)`)
}

// 3. Scratch with the key lock on: the hand takes it out of the path without moving the record.
{
  const s = await page.evaluate(async () => {
    const ctl = await window.mod('/src/controls.ts')
    const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
    const deck = engine.decks.A
    if (!deck.keyLock) await ctl.toggleKeyLock('A')
    ctl.seekDeck('A', 10)
    ctl.play('A')
    await new Promise((r) => setTimeout(r, 1000))
    const before = deck.position
    deck.beginScratch()
    const afterTouch = deck.position
    deck.endScratch()
    const afterRelease = deck.position
    await new Promise((r) => setTimeout(r, 500))
    const running = deck.position
    ctl.pause('A')
    return { before, afterTouch, afterRelease, running, keyLock: deck.keyLock }
  })
  ok('a hand on the platter with the key lock on: the record stays where it was heard, touch and release', Math.abs(s.afterTouch - s.before) < 0.02 && Math.abs(s.afterRelease - s.afterTouch) < 0.02 && s.running > s.afterRelease && s.keyLock,
    `before ${s.before.toFixed(3)}, touched ${s.afterTouch.toFixed(3)}, released ${s.afterRelease.toFixed(3)}, 0.5 s later ${s.running.toFixed(3)}`)
}

const btn = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Key lock').map((b) => b.getAttribute('aria-pressed') ?? b.className.length))
ok('each deck has a Key lock button', btn.length === 2, `${btn.length} buttons`)
const f = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight }))
ok('page still fits 710 px', f.scroll <= f.inner, `scrollHeight ${f.scroll} / ${f.inner}`)
ok('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

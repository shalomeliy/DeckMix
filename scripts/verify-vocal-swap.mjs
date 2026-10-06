/**
 * The vocal swap (core/vocal-swap-mix.ts), end to end in the running app at the owner's viewport (1536 x 710).
 *   node scripts/verify-vocal-swap.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * Two synthetic House songs in OPFS (no real music touched), FINISHED hand marks in the store: A sings 8–30 s, B sings 40–70 s. A plays
 * from 20 s, B is loaded paused. Sampled every 50 ms through one click on the panel's vocal-swap row:
 *  - B waits paused for A's voice-end line, then starts two bars before its own voice, silent (crossfader still fully on A);
 *  - A's MID goes down over the first bar, its HIGH over the second; then B's voice comes in alone (its LOW and HIGH killed) with the
 *    crossfader at the middle and A's LOW still open; on the swap A's LOW shuts, B's knobs come back, the crossfader goes to B;
 *  - never both LOWs open while both decks are audible; join to end 5–10 s; at the end A paused and every knob back; nothing throws.
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

const A_VOICE = [[8, 30]]
const B_VOICE = [[40, 70]]
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const lib = await root.getDirectoryHandle('Tracks', { create: true })
  const house = await lib.getDirectoryHandle('House', { create: true })
  // 100 s, not 70 (v0.9.23): Mix Assist now leaves out a point whose mix ends with less than 24 bars of B still to play, and at 70 s every
  // point here ended too close to B's end. The voices and the lift are where they were; only the quiet tail is longer.
  const sr = 22050, dur = 100, n = sr * dur, bpm = 124
  for (const [name, f] of [['Swap A', 220], ['Swap B', 330]]) {
    const pcm = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      const t = i / sr, beat = ((t * bpm) / 60) % 1
      // B lifts at 30 s (a loud high tone on top), so the energy heuristic has a point to offer and its vocal line can be read.
      const lift = name === 'Swap B' && t >= 30 ? 0.35 * Math.sin(2 * Math.PI * 2000 * t) + 0.3 * Math.sin(2 * Math.PI * 700 * t) : 0
      const s = Math.exp(-beat * 18) * Math.sin(2 * Math.PI * 55 * t) * 0.6 + 0.1 * Math.sin(2 * Math.PI * f * t) + lift
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

const setup = await page.evaluate(async ({ A_VOICE, B_VOICE }) => {
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const ctl = await window.mod('/src/controls.ts')
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)) } return false }
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('Swap')).length === 2 && useStore.getState().library.tracks.every((t) => t.contentHash), 30000)
  const tracks = useStore.getState().library.tracks
  const ta = tracks.find((t) => t.name.startsWith('Swap A'))
  const tb = tracks.find((t) => t.name.startsWith('Swap B'))
  if (!ta || !tb) return { error: `tracks not listed: ${tracks.map((t) => t.name).join(', ')}` }
  await ctl.loadTrackToDeck('A', ta)
  await ctl.loadTrackToDeck('B', tb)
  const ready = await wait(() => { const d = useStore.getState().decks; return !!(d.A.beatGrid && d.B.beatGrid && d.A.track?.contentHash && d.B.track?.contentHash && !d.A.loading && !d.B.loading) }, 30000)
  if (!ready) return { error: 'beat grids never arrived' }
  const s = useStore.getState()
  for (const [deck, voice] of [['A', A_VOICE], ['B', B_VOICE]]) {
    const t = s.decks[deck].track
    s.setVocalManual(t.contentHash, { schema: 1, contentHash: t.contentHash, trackId: t.id, name: t.name, genre: 'House', finished: true, updatedAt: Date.now(), regions: voice.map(([fromSec, toSec]) => ({ fromSec, toSec })) })
  }
  // From 6, not 12 (v0.9.17): the join is a whole phrase before A's voice end at 30, so the click has to come before that line for this run
  // to show B waiting for it rather than for A's next voice end.
  ctl.seekDeck('A', 20)
  ctl.play('A')
  await new Promise((r) => setTimeout(r, 1500))
  const d = useStore.getState().decks
  return { gridA: d.A.beatGrid, gridB: d.B.beatGrid, posA: d.A.positionSec }
}, { A_VOICE, B_VOICE })
if (setup.error) {
  ok('setup', false, setup.error)
} else {
  ok('setup: both songs loaded with grids, A playing', true, `A ${setup.gridA.bpm.toFixed(2)} BPM, B ${setup.gridB.bpm.toFixed(2)} BPM, A at ${setup.posA.toFixed(1)} s`)
  const barA = (60 / setup.gridA.bpm) * 4
  const rows = page.locator('[data-testid="swap-rows"] button')
  const rowCount = await rows.count()
  const note = rowCount ? '' : await page.evaluate(() => document.querySelector('[data-testid="swap-note"]')?.textContent ?? '')
  ok('the panel shows a vocal-swap row', rowCount >= 1, rowCount ? await rows.first().innerText() : `note: ${note}`)
  if (rowCount >= 1) {
    await rows.first().click()
    const run = await page.evaluate(async () => {
      const { useStore } = await window.mod('/src/app/state/store.ts')
      const samples = []
      const end = Date.now() + 40000
      const t0 = performance.now()
      while (Date.now() < end) {
        const s = useStore.getState()
        const ch = s.mixer.channels
        samples.push({ ms: performance.now() - t0, a: s.decks.A.positionSec, b: s.decks.B.positionSec, x: s.mixer.crossfader, aPlaying: s.decks.A.playing, bPlaying: s.decks.B.playing, active: !!s.activeTransition,
          aLow: ch.A.eqLow, aMid: ch.A.eqMid, aHigh: ch.A.eqHigh, bLow: ch.B.eqLow, bMid: ch.B.eqMid, bHigh: ch.B.eqHigh })
        if (!s.activeTransition && samples.length > 5) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const ch = useStore.getState().mixer.channels
      const d = useStore.getState().decks
      return { samples, final: { aPlaying: d.A.playing, bPlaying: d.B.playing, x: useStore.getState().mixer.crossfader, eq: [ch.A.eqLow, ch.A.eqMid, ch.A.eqHigh, ch.B.eqLow, ch.B.eqMid, ch.B.eqHigh] } }
    })
    const S = run.samples
    const firstB = S.find((s) => s.bPlaying)
    ok("B waits for A's voice-end line (the yellow line at or after 30 s), then starts two bars before the yellow line its voice (40 s) is on", !!firstB && firstB.a >= 30 - 0.05 && firstB.a < 30 + barA && firstB.b > 40 - 3 * barA && firstB.b <= 40 - 2 * barA + 0.1,
      firstB ? `B started with A at ${firstB.a.toFixed(2)} s, B at ${firstB.b.toFixed(2)} s` : 'B never played')
    const join = firstB?.a ?? 30
    const silent = S.filter((s) => s.bPlaying && s.a < join + 2 * barA - 0.1)
    ok('the first two bars: B is playing but silent (crossfader fully on A)', silent.length > 5 && silent.every((s) => s.x === -1), `${silent.length} samples, crossfader ${silent[0]?.x}`)
    const bar1end = S.filter((s) => s.a > join + barA + 0.1 && s.a < join + 2 * barA - 0.1)
    ok("A's MID is down after the first bar, its HIGH going down in the second", bar1end.length > 3 && bar1end.every((s) => s.aMid === -1 && s.aHigh < 0 && s.aLow === 0),
      bar1end[0] ? `A low ${bar1end[0].aLow}, mid ${bar1end[0].aMid}, high ${bar1end[0].aHigh.toFixed(2)}` : '')
    const alone = S.filter((s) => s.a > join + 2 * barA + barA / 4 + 0.1 && s.a < join + 4 * barA - 0.1)
    ok("B's voice alone over A's bass: crossfader middle, A LOW only, B MID only, B in its voice", alone.length > 5 && alone.every((s) => Math.abs(s.x) < 0.01 && s.aLow === 0 && s.aMid === -1 && s.aHigh === -1 && s.bLow === -1 && s.bMid === 0 && s.bHigh === -1 && s.b >= firstB.b + 2 * barA - 0.3 && s.b < 70),
      alone[0] ? `${alone.length} samples: x ${alone[0].x.toFixed(3)}, A ${alone[0].aLow}/${alone[0].aMid}/${alone[0].aHigh}, B ${alone[0].bLow}/${alone[0].bMid}/${alone[0].bHigh}, B at ${alone[0].b.toFixed(2)} s` : 'none')
    const after = S.filter((s) => s.active && s.a > join + 4 * barA + 0.1)
    ok('on the swap: A LOW shuts, B whole again, crossfader on its way to B', after.length > 0 && after.every((s) => s.aLow === -1 && s.bLow === 0 && s.bHigh === 0 && s.x >= 0),
      after[0] ? `A low ${after[0].aLow}, B ${after[0].bLow}/${after[0].bMid}/${after[0].bHigh}, x ${after[0].x.toFixed(2)}` : 'no sample in the last beat')
    const both = S.filter((s) => s.aPlaying && s.bPlaying && s.x > -1 && s.x < 1 && s.aLow > -1 && s.bLow > -1)
    ok('never both LOWs open while both decks are audible', both.length === 0, both.length ? JSON.stringify(both[0]) : `${S.length} samples`)
    const audibleFrom = S.find((s) => s.bPlaying)
    const lastActive = [...S].reverse().find((s) => s.active)
    const sec = audibleFrom && lastActive ? (lastActive.ms - audibleFrom.ms) / 1000 : NaN
    ok('join to end lasts about 5–10 seconds (4 bars and a beat)', sec >= 5 && sec <= 10.5, `${sec.toFixed(2)} s at ${setup.gridA.bpm.toFixed(1)} BPM`)
    ok('the mix finished: B playing, A paused, crossfader on B, every knob back', run.final.bPlaying && !run.final.aPlaying && run.final.x > 0.99 && run.final.eq.every((v) => v === 0), JSON.stringify(run.final))
  }
}
ok('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

/**
 * v0.9.15, Mix Assist by sound: the vocal handoff, end to end in the running app, at the owner's viewport (1536 x 710).
 *   node scripts/verify-vocal-handoff.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * Two synthetic House songs in the browser's own file store (OPFS) — no real music touched — with FINISHED hand marks put in the store, the
 * same path as his marked songs: A sings 8–30 s, B is quiet until 20 s and sings 20–55 s. A plays from 12 s, B is loaded paused.
 * What it proves, with numbers:
 *  - the Mix Assist panel shows a "vocal handoff" row (not just the energy points), and the energy points carry a separate vocal line;
 *  - one click on the row: B waits paused until the join line, then plays; the crossfader is about the middle on A's voice end and fully on B
 *    at the fade end; the transition finishes and A is paused;
 *  - sampled every 50 ms through the whole run: never a voice over a voice while both decks are audible (gain > 5% on both sides);
 *  - today's plain transition from B's 30 s point is flagged "שירה על שירה" in the panel;
 *  - nothing throws.
 * Content of a real strip is not judged here; the planner's numbers on his real marks are scripts/train/measure-handoff-marks.mjs.
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
const B_VOICE = [[20, 55]]
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const lib = await root.getDirectoryHandle('Tracks', { create: true })
  const house = await lib.getDirectoryHandle('House', { create: true })
  const sr = 22050, dur = 70, n = sr * dur, bpm = 124
  for (const [name, f] of [['Handoff A', 220], ['Handoff B', 330]]) {
    const pcm = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      const t = i / sr, beat = ((t * bpm) / 60) % 1
      // B lifts at 30 s (a loud high tone on top), so the energy heuristic has a point to offer and its vocal line can be read.
      const lift = name === 'Handoff B' && t >= 30 ? 0.35 * Math.sin(2 * Math.PI * 2000 * t) + 0.3 * Math.sin(2 * Math.PI * 700 * t) : 0
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
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('Handoff')).length === 2 && useStore.getState().library.tracks.every((t) => t.contentHash), 30000)
  const tracks = useStore.getState().library.tracks
  const ta = tracks.find((t) => t.name.startsWith('Handoff A'))
  const tb = tracks.find((t) => t.name.startsWith('Handoff B'))
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
  ctl.seekDeck('A', 12)
  ctl.play('A')
  await new Promise((r) => setTimeout(r, 1500))
  const d = useStore.getState().decks
  return { gridA: d.A.beatGrid, gridB: d.B.beatGrid, posA: d.A.positionSec }
}, { A_VOICE, B_VOICE })
if (setup.error) {
  ok('setup', false, setup.error)
} else {
  ok('setup: both songs loaded with grids, A playing', true, `A ${setup.gridA.bpm.toFixed(2)} BPM, B ${setup.gridB.bpm.toFixed(2)} BPM, A at ${setup.posA.toFixed(1)} s`)

  if (process.env.DEBUG) console.log(await page.evaluate(async () => {
    const core = await window.mod('/src/core/vocal-handoff.ts')
    const ctl = await window.mod('/src/controls.ts')
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const a = ctl.deckHandoffSide('A'), b = ctl.deckHandoffSide('B')
    const runs = (x) => { const r = []; x.timeline.cells.forEach((c, i) => { if (c && (!r.length || r[r.length - 1][1] !== i)) r.push([i, i + 1]); else if (c) r[r.length - 1][1] = i + 1 }); return r.map(([p, q]) => [p / 2, q / 2]) }
    const pos = useStore.getState().decks.A.positionSec
    return JSON.stringify({ pos, aDur: a.durationSec, aRuns: runs(a), bRuns: runs(b), starts: core.bVoiceStarts(b), plan: core.planHandoff(a, pos, b, core.bVoiceStarts(b)[0]) })
  }))
  const rows = page.locator('[data-testid="handoff-rows"] button')
  const rowCount = await rows.count()
  const note = rowCount ? '' : await page.locator('[data-testid="handoff-note"]').innerText({ timeout: 2000 }).catch(() => '')
  ok('the panel shows a vocal-handoff row', rowCount >= 1, rowCount ? await rows.first().innerText() : `note: ${note}`)
  // Read straight from the DOM: a locator that misses waits out its whole timeout while A keeps playing, and the click below would then land
  // half a minute later in A than this script planned for.
  const panelText = await page.evaluate(() => [...document.querySelectorAll('div')].find((d) => d.firstElementChild?.textContent === 'מסירת שירה — לפי הצליל')?.innerText ?? '')
  ok('energy points carry their own vocal line, separate from the energy dot (B\'s lift at 30 s: voice over voice)', /שירה על שירה ב-/.test(panelText), panelText.split('\n').filter((l) => l.includes('שירה')).slice(0, 3).join(' | '))
  const clashFlag = await page.evaluate(async () => {
    const core = await window.mod('/src/core/vocal-handoff.ts')
    const ctl = await window.mod('/src/controls.ts')
    const { useStore } = await window.mod('/src/app/state/store.ts')
    return core.plainTransitionClashSec(ctl.deckHandoffSide('A'), useStore.getState().decks.A.positionSec, ctl.deckHandoffSide('B'), 30, 8)
  })
  ok("today's plain transition from B's 30 s point would put a voice over a voice", clashFlag != null, `first clash at A ${clashFlag?.toFixed(1)} s`)

  if (rowCount >= 1) {
    await rows.first().click()
    const run = await page.evaluate(async ({ A_VOICE, B_VOICE }) => {
      const { useStore } = await window.mod('/src/app/state/store.ts')
      const voiced = (v, sec) => v.some(([a, b]) => sec >= a && sec < b)
      const at0 = useStore.getState().activeTransition
      const samples = []
      let clash = null
      const end = Date.now() + 60000
      while (Date.now() < end) {
        const s = useStore.getState()
        const x = s.mixer.crossfader // -1 = A only, +1 = B only
        const p = (x + 1) / 2
        const gA = Math.cos((p * Math.PI) / 2), gB = Math.sin((p * Math.PI) / 2)
        const a = s.decks.A, b = s.decks.B
        const ch = s.mixer.channels
        samples.push({ a: a.positionSec, b: b.positionSec, x, bPlaying: b.playing, aPlaying: a.playing, active: !!s.activeTransition, aMid: ch.A.eqMid, bMid: ch.B.eqMid })
        if (a.playing && b.playing && gA > 0.05 && gB > 0.05 && voiced(A_VOICE, a.positionSec) && voiced(B_VOICE, b.positionSec) && !clash) clash = { a: a.positionSec, b: b.positionSec, x }
        if (!s.activeTransition && samples.length > 5) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const ch = useStore.getState().mixer.channels
      return { at0, samples, clash, final: { aPlaying: useStore.getState().decks.A.playing, bPlaying: useStore.getState().decks.B.playing, x: useStore.getState().mixer.crossfader, aMid: ch.A.eqMid, bMid: ch.B.eqMid } }
    }, { A_VOICE, B_VOICE })
    const t = run.at0
    ok('one click starts a handoff that names its handoff second', !!t && t.handoffSec != null && t.waitingUntilSec != null, t ? `B joins at A ${t.waitingUntilSec?.toFixed(2)} s, handoff at A ${t.handoffSec?.toFixed(2)} s` : 'no transition')
    const firstB = run.samples.find((s) => s.bPlaying)
    ok('B stays paused until the join line, then plays', !!firstB && t && firstB.a >= t.waitingUntilSec - 0.6, firstB ? `B started with A at ${firstB.a.toFixed(2)} s` : 'B never played')
    ok('B starts in its quiet stretch (before its voice at 20 s)', !!firstB && firstB.b < 20, firstB ? `B at ${firstB.b.toFixed(2)} s` : '')
    if (t) {
      const near = run.samples.filter((s) => Math.abs(s.a - t.handoffSec) < 0.15)
      const mid = near.length ? near[Math.floor(near.length / 2)].x : NaN
      ok("on A's voice end the crossfader is about the middle", Math.abs(mid) < 0.15, `crossfader ${mid.toFixed(3)} at A ${t.handoffSec.toFixed(2)} s`)
      const handoffB = near.length ? near[Math.floor(near.length / 2)].b : NaN
      ok("B's voice comes in at the handoff (within a bar)", Math.abs(handoffB - 20) < 2.1 && handoffB <= 20.2, `B at ${handoffB.toFixed(2)} s at the handoff`)
    }
    ok('never a voice over a voice while both decks are audible', !run.clash, run.clash ? JSON.stringify(run.clash) : `${run.samples.length} samples every 50 ms`)
    // v0.9.16: the MID knobs. Under A, B's middle is down; one bar after the handoff they have swapped; at the end A's is back where it was.
    if (t) {
      const runway = run.samples.filter((s) => s.bPlaying && s.a < t.handoffSec - 0.2)
      ok("v0.9.16: while B plays under A, B's MID is down and A's untouched", runway.length > 5 && runway.every((s) => Math.abs(s.bMid + 0.4) < 0.01 && Math.abs(s.aMid) < 0.01), `${runway.length} samples, B mid ${runway[0]?.bMid}, A mid ${runway[0]?.aMid}`)
      const bar = (60 / setup.gridA.bpm) * 4
      const swapped = run.samples.filter((s) => s.active && s.a > t.handoffSec + bar + 0.2)
      ok('v0.9.16: a bar after the handoff the MIDs have swapped (A down, B back)', swapped.length > 5 && swapped.every((s) => Math.abs(s.aMid + 0.4) < 0.01 && Math.abs(s.bMid) < 0.01), `${swapped.length} samples, A mid ${swapped[0]?.aMid}, B mid ${swapped[0]?.bMid}`)
      ok("v0.9.16: when it finishes, A's MID is back where it was", run.final.aMid === 0 && run.final.bMid === 0, `A ${run.final.aMid}, B ${run.final.bMid}`)
    }
    ok('the transition finished: B playing, A paused, crossfader fully on B', run.final.bPlaying && !run.final.aPlaying && run.final.x > 0.99, JSON.stringify(run.final))
  }
}
// A loop on A after the join: the crossfader follows A's position, so a loop would hold it short of the handoff while B walks into its voice.
// The handoff must cancel and say why (review finding, 05/10).
if (!setup.error) {
  const loop = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const core = await window.mod('/src/core/vocal-handoff.ts')
    const s = useStore.getState()
    const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
    const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
    ctl.pause('B')
    await ctl.loadTrackToDeck('A', ta)
    await ctl.loadTrackToDeck('B', tb)
    const end = Date.now() + 20000
    while (Date.now() < end && !(useStore.getState().decks.A.beatGrid && useStore.getState().decks.B.beatGrid && !useStore.getState().decks.A.loading && !useStore.getState().decks.B.loading)) await new Promise((r) => setTimeout(r, 200))
    ctl.seekDeck('A', 12)
    ctl.play('A')
    await new Promise((r) => setTimeout(r, 300))
    ctl.startVocalHandoffAt('A', 'B', core.bVoiceStarts(ctl.deckHandoffSide('B'))[0])
    const t = useStore.getState().activeTransition
    if (!t) return { error: 'handoff did not start', notice: useStore.getState().notice?.text }
    while (Date.now() < end + 20000 && !useStore.getState().decks.B.playing) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 1000))
    ctl.toggleLoop('A')
    await new Promise((r) => setTimeout(r, 500))
    const after = useStore.getState()
    return { active: !!after.activeTransition, bPlaying: after.decks.B.playing, x: after.mixer.crossfader, notice: after.notice?.text, aMid: after.mixer.channels.A.eqMid, bMid: after.mixer.channels.B.eqMid }
  })
  ok('a loop on A mid-handoff cancels it, says so, leaves A alone on the crossfader, and puts both MIDs back', !loop.error && !loop.active && !loop.bPlaying && loop.x <= -0.99 && /לופ/.test(loop.notice ?? '') && loop.bMid === 0 && loop.aMid === 0, JSON.stringify(loop))
}

// v0.9.16: a MID knob he turns during the handoff is his (never moved or put back), and a cancel AFTER the swap puts A's back.
if (!setup.error) {
  const hand = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const core = await window.mod('/src/core/vocal-handoff.ts')
    const s = useStore.getState()
    const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
    const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
    ctl.cancelTransition()
    ctl.pause('A'); ctl.pause('B')
    await ctl.loadTrackToDeck('A', ta)
    await ctl.loadTrackToDeck('B', tb)
    const deadline = Date.now() + 90000
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    while (Date.now() < deadline && !(useStore.getState().decks.A.beatGrid && useStore.getState().decks.B.beatGrid && !useStore.getState().decks.A.loading && !useStore.getState().decks.B.loading)) await sleep(200)
    ctl.seekDeck('A', 12)
    ctl.play('A')
    await sleep(300)
    ctl.startVocalHandoffAt('A', 'B', core.bVoiceStarts(ctl.deckHandoffSide('B'))[0])
    const t = useStore.getState().activeTransition
    if (!t) return { error: 'handoff did not start' }
    while (Date.now() < deadline && !useStore.getState().decks.B.playing) await sleep(50)
    await sleep(500)
    const bCutBefore = useStore.getState().mixer.channels.B.eqMid
    ctl.setEq('B', 'mid', 0.2) // his hand, during the runway
    const bar = (60 / useStore.getState().decks.A.beatGrid.bpm) * 4
    while (Date.now() < deadline && useStore.getState().decks.A.positionSec < t.handoffSec + bar + 0.5) await sleep(50)
    const swapped = { a: useStore.getState().mixer.channels.A.eqMid, b: useStore.getState().mixer.channels.B.eqMid, active: !!useStore.getState().activeTransition }
    ctl.cancelTransition()
    const ch = useStore.getState().mixer.channels
    return { bCutBefore, swapped, afterCancel: { a: ch.A.eqMid, b: ch.B.eqMid } }
  })
  ok("v0.9.16: B's MID turned by hand during the runway stays his through the swap", !hand.error && hand.bCutBefore === -0.4 && hand.swapped.active && hand.swapped.b === 0.2 && hand.swapped.a === -0.4, JSON.stringify(hand))
  ok("v0.9.16: a cancel after the swap puts A's MID back and leaves his B knob alone", !hand.error && hand.afterCancel.a === 0 && hand.afterCancel.b === 0.2, JSON.stringify(hand.afterCancel ?? hand))
}

const resp = await page.evaluate(() => {
  const ctx = new OfflineAudioContext(1, 128, 44100)
  const n = ctx.createBiquadFilter()
  n.type = 'peaking'; n.frequency.value = 1000; n.Q.value = 0.9; n.gain.value = -0.4 * 70
  const hz = new Float32Array([100, 200, 500, 1000, 2000, 4000, 8000]), mag = new Float32Array(7), ph = new Float32Array(7)
  n.getFrequencyResponse(hz, mag, ph)
  return [...hz].map((h, i) => `${h} Hz ${(20 * Math.log10(mag[i])).toFixed(1)} dB`)
})
console.log(`INFO  the MID cut at -0.4 (deck.ts: peaking 1 kHz, Q 0.9): ${resp.join(' · ')}`)

const f = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight }))
ok('page still fits 710 px', f.scroll <= f.inner, `scrollHeight ${f.scroll} / ${f.inner}`)
ok('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

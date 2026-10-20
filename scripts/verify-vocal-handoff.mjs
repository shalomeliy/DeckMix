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
 *  - v0.9.17: neither kind of row comes in right away — a handoff joins a whole phrase before A's voice end, an energy point on A's next
 *    phrase start (counted from where A's voice starts), and the row says when; a Mix-in pad the same; in A's last bars, the next bar, said;
 *  - v0.9.63 (the owner, 07/10: "only after the singing in the outgoing song is over"): the handoff joins on the line where A's voice ends
 *    and B sings when A is out; an energy point and a Mix-in pad join where A is quiet for the whole mix, and the row says so; when A sings
 *    to its end the row is red and says it will come in over A's voice;
 *  - v0.9.18: the EQ mix — B under A has its LOW killed, the lows swap on the handoff line, never both open, A's HIGH leaves before the
 *    crossfader takes A out, every knob is back at the end; a plain transition does the same inside its 8 s, instant and gradual;
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
  // 100 s, not 70 (v0.9.23): Mix Assist now leaves out a point whose mix ends with less than 24 bars of B still to play, and at 70 s every
  // point here ended too close to B's end. The voices and the lift are where they were; only the quiet tail is longer.
  const sr = 22050, dur = 100, n = sr * dur, bpm = 124
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
  // From 6, not 12 (v0.9.17): the join is a whole phrase before A's voice end at 30, so the click has to come before that line for this run
  // to show B waiting for it rather than for A's next voice end.
  ctl.seekDeck('A', 6)
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
  // v0.12.13: the energy point joins on A's next phrase start, here inside A's verse, and its own line says A sings there.
  ok('energy points carry their own vocal line, separate from the energy dot (A sings during the mix: said)', /על השירה שלו/.test(panelText), panelText.split('\n').filter((l) => l.includes('שירה')).slice(0, 3).join(' | '))
  const clashFlag = await page.evaluate(async () => {
    const core = await window.mod('/src/core/vocal-handoff.ts')
    const ctl = await window.mod('/src/controls.ts')
    const { useStore } = await window.mod('/src/app/state/store.ts')
    return core.plainTransitionClashSec(ctl.deckHandoffSide('A'), useStore.getState().decks.A.positionSec, ctl.deckHandoffSide('B'), 30, 8)
  })
  ok("today's plain transition from B's 30 s point would put a voice over a voice", clashFlag != null, `first clash at A ${clashFlag?.toFixed(1)} s`)

  if (rowCount >= 1) {
    const clickA = await page.evaluate(async () => (await window.mod('/src/app/state/store.ts')).useStore.getState().decks.A.positionSec)
    await rows.first().click()
    const run = await page.evaluate(async ({ A_VOICE, B_VOICE }) => {
      const { useStore } = await window.mod('/src/app/state/store.ts')
      const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
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
        samples.push({ a: a.positionSec, b: b.positionSec, x, bPlaying: b.playing, aPlaying: a.playing, active: !!s.activeTransition, aMid: ch.A.eqMid, bMid: ch.B.eqMid, aLow: ch.A.eqLow, bLow: ch.B.eqLow, aHigh: ch.A.eqHigh, bHigh: ch.B.eqHigh, engA: engine.decks.A.faderGain.gain.value, engB: engine.decks.B.faderGain.gain.value })
        if (a.playing && b.playing && gA > 0.05 && gB > 0.05 && voiced(A_VOICE, a.positionSec) && voiced(B_VOICE, b.positionSec) && !clash) clash = { a: a.positionSec, b: b.positionSec, x }
        if (!s.activeTransition && samples.length > 5) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const ch = useStore.getState().mixer.channels
      return { at0, samples, clash, final: { aPlaying: useStore.getState().decks.A.playing, bPlaying: useStore.getState().decks.B.playing, x: useStore.getState().mixer.crossfader, aMid: ch.A.eqMid, bMid: ch.B.eqMid, eq: [ch.A.eqLow, ch.A.eqMid, ch.A.eqHigh, ch.B.eqLow, ch.B.eqMid, ch.B.eqHigh] } }
    }, { A_VOICE, B_VOICE })
    const t = run.at0
    ok('one click starts a handoff that names its handoff second', !!t && t.handoffSec != null && t.waitingUntilSec != null, t ? `B joins at A ${t.waitingUntilSec?.toFixed(2)} s, handoff at A ${t.handoffSec?.toFixed(2)} s` : 'no transition')
    const firstB = run.samples.find((s) => s.bPlaying)
    ok('B stays paused until the join line, then plays', !!firstB && t && firstB.a >= t.waitingUntilSec - 0.6, firstB ? `B started with A at ${firstB.a.toFixed(2)} s` : 'B never played')
    const barA = (60 / setup.gridA.bpm) * 4
    // v0.12.13 (the owner, 19/10): B's drums come in before A's last line ends (A sings to 30 s), A's transition plays, B sings on its end —
    // the bass swap — and A goes down over 4 bars after it.
    ok("v0.12.13: B joins before A's voice ends (A sings to 30 s), the swap at the end of A's transition, A out 4 bars later",
      !!t && !!firstB && firstB.a < 30 && firstB.a > 30 - 5 * barA && t.handoffSec > 30 && Math.abs(t.endSec - t.handoffSec - 4 * barA) < 0.05,
      t && firstB ? `click at A ${clickA.toFixed(2)} s, B in at A ${firstB.a.toFixed(2)} s, swap at A ${t.handoffSec.toFixed(2)} s, ${((t.handoffSec - t.waitingUntilSec) / barA).toFixed(2)} bars after the join` : '')
    ok('B starts in its quiet stretch (before its voice at 20 s)', !!firstB && firstB.b < 20, firstB ? `B at ${firstB.b.toFixed(2)} s` : '')
    if (t) {
      const near = run.samples.filter((s) => Math.abs(s.a - t.handoffSec) < 0.15)
      const mid = near.length ? near[Math.floor(near.length / 2)].x : NaN
      ok('on the bass swap the crossfader is about the middle', Math.abs(mid) < 0.15, `crossfader ${mid.toFixed(3)} at A ${t.handoffSec.toFixed(2)} s`)
      // v0.12.13: B's voice comes in on the end of A's transition: at the swap B is at its voice line (the line at or before 20 s).
      const atSwap = near.length ? near[Math.floor(near.length / 2)] : null
      ok("v0.12.13: B's voice line is where A's transition ends (within a bar)", !!atSwap && atSwap.b <= 20.3 && 20 - atSwap.b < (60 / setup.gridB.bpm) * 4 + 0.3, atSwap ? `B at ${atSwap.b.toFixed(2)} s when A is at ${atSwap.a.toFixed(2)} s` : '')
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
      // v0.9.18: the bass swap. B under A has no LOW; on the handoff line the lows trade places; never both open; A's HIGH is gone before the
      // crossfader takes A out; after the end every knob is back where it was.
      ok("v0.9.18: while B plays under A, B's LOW is killed and A's untouched", runway.length > 5 && runway.every((s) => s.bLow === -1 && s.aLow === 0), `${runway.length} samples, B low ${runway[0]?.bLow}, A low ${runway[0]?.aLow}`)
      const bothOpen = run.samples.filter((s) => s.bPlaying && s.aPlaying && s.aLow > -1 && s.bLow > -1)
      ok('v0.9.18: never both LOWs open (instant swap, the default)', bothOpen.length === 0, bothOpen.length ? JSON.stringify(bothOpen[0]) : `${run.samples.length} samples`)
      const afterSwap = run.samples.filter((s) => s.active && s.a > t.handoffSec + 0.1)
      const lastBefore = run.samples.filter((s) => s.a < t.handoffSec - 0.05).pop()
      ok('v0.9.18: the lows swap on the handoff line (A killed, B back)', afterSwap.length > 5 && afterSwap.every((s) => s.aLow === -1 && s.bLow === 0) && lastBefore?.aLow === 0 && lastBefore?.bLow === -1,
        `last sample before at A ${lastBefore?.a.toFixed(2)} (A ${lastBefore?.aLow}, B ${lastBefore?.bLow}); first after at A ${afterSwap[0]?.a.toFixed(2)} (A ${afterSwap[0]?.aLow}, B ${afterSwap[0]?.bLow}); handoff ${t.handoffSec.toFixed(2)}`)
      const goingOut = run.samples.filter((s) => s.active && s.x > 0.05)
      ok("v0.9.18: A's HIGH is gone before the crossfader takes A out, B's HIGH never touched", goingOut.length > 5 && goingOut.every((s) => s.aHigh === -1) && run.samples.every((s) => s.bHigh === 0),
        `${goingOut.length} samples past the middle, A high ${goingOut[0]?.aHigh}`)
      // v0.9.63: the run-in is 8 bars and the swap 4 bars in, so A goes out from 2 bars after the swap: two bars after the join through one bar
      // after the swap is well inside the hold.
      const hold = run.samples.filter((s) => s.active && s.bPlaying && s.a > t.waitingUntilSec + 2 * barA + 0.2 && s.a < t.handoffSec + barA)
      const off = hold.filter((s) => Math.abs(s.x) >= 0.01)
      ok('v0.9.18: the crossfader holds the middle from two bars after the join through the swap', hold.length > 10 && off.length === 0, `${hold.length} samples${off.length ? `, off: ${JSON.stringify(off[0])}` : ', all at the middle'}`)
      // v0.9.33 (the owner, 07/10: "the volume drops during the mix"): in the middle both decks play at full level, read from the engine's
      // own GainNodes — each is EQ'd down to the part of a song the other lacks, so −3 dB each (the hand crossfader's curve) was a hole.
      const lowA = Math.min(...hold.map((s) => s.engA)), lowB = Math.min(...hold.map((s) => s.engB))
      ok('v0.9.33: both decks at full level in the middle (engine gains, not −3 dB each)', hold.length > 10 && lowA > 0.99 && lowB > 0.99, `${hold.length} samples, lowest A ${lowA.toFixed(3)}, lowest B ${lowB.toFixed(3)}`)
      ok('v0.9.18: when it finishes, all six knobs are back where they were', run.final.eq.every((v) => v === 0), JSON.stringify(run.final.eq))
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

// v0.9.17, the owner: "the moment I clicked one of the Mix Assist options you mixed right away". An ENERGY point clicked in the panel now
// waits for A's next phrase start, counted from where A's voice starts (8 s) — not A's next yellow line.
if (!setup.error) {
  const prep = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const s = useStore.getState()
    const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
    const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
    ctl.cancelTransition()
    ctl.pause('A'); ctl.pause('B')
    await ctl.loadTrackToDeck('A', ta)
    await ctl.loadTrackToDeck('B', tb)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !(useStore.getState().decks.A.beatGrid && useStore.getState().decks.B.beatGrid && useStore.getState().decks.B.bands && !useStore.getState().decks.A.loading && !useStore.getState().decks.B.loading)) await new Promise((r) => setTimeout(r, 200))
    ctl.seekDeck('A', 10)
    ctl.play('A')
    await new Promise((r) => setTimeout(r, 1200))
    return true
  })
  const phraseLine = page.locator('[data-testid="phrase-join"]').first()
  const shown = await phraseLine.innerText({ timeout: 5000 }).catch(() => '')
  ok('v0.12.13: the energy points say when they come in — the next phrase start, not where A stops singing', /תחילת קטע/.test(shown) && !/כשהשירה שלו נגמרת/.test(shown), shown || 'no line')
  if (prep && shown) {
    const clickA = await page.evaluate(async () => (await window.mod('/src/app/state/store.ts')).useStore.getState().decks.A.positionSec)
    await phraseLine.locator('xpath=..').click()
    const run = await page.evaluate(async (clickA) => {
      const { useStore } = await window.mod('/src/app/state/store.ts')
      const ctl = await window.mod('/src/controls.ts')
      const core = await window.mod('/src/core/vocal-handoff.ts')
      const { TRANSITION_CROSSFADE_SEC } = await window.mod('/src/core/constants.ts')
      const side = ctl.deckHandoffSide('A')
      const expected = core.nextPhraseStartSec(side.grid, side.timeline, side.durationSec, clickA).sec
      const t = useStore.getState().activeTransition
      const notice = useStore.getState().notice?.text
      let firstB = null
      const end = Date.now() + 40000
      while (Date.now() < end && !firstB) {
        const d = useStore.getState().decks
        if (d.B.playing) firstB = d.A.positionSec
        await new Promise((r) => setTimeout(r, 20))
      }
      ctl.cancelTransition()
      return { expected, waitingUntilSec: t?.waitingUntilSec ?? null, notice, firstB }
    }, clickA)
    const barA = (60 / setup.gridA.bpm) * 4
    ok("v0.12.13: an energy point comes in on A's next phrase start, even during A's verse, and says A sings there",
      run.waitingUntilSec != null && Math.abs(run.waitingUntilSec - run.expected) < 0.05 && run.firstB != null && run.firstB < 30 && run.firstB >= run.expected - 0.1 && run.firstB < run.expected + barA && /על השירה שלו/.test(run.notice ?? ''),
      `click at A ${clickA.toFixed(2)} s, A's voice ends 30 s, join ${run.expected.toFixed(2)} s, B in at A ${run.firstB?.toFixed(2)} s · "${run.notice}"`)
  }
}

// v0.9.17 review: a Mix-in pad (the same start as the panel's click) waits for the phrase too; and a click in A's last bars, with no phrase
// start left before the end, joins on the next bar and says so — never a wait past the song's end that leaves the room silent.
if (!setup.error) {
  const pad = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const core = await window.mod('/src/core/vocal-handoff.ts')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const s = useStore.getState()
    const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
    const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
    const reset = async (aAt) => {
      ctl.cancelTransition()
      ctl.pause('A'); ctl.pause('B')
      await ctl.loadTrackToDeck('A', ta)
      await ctl.loadTrackToDeck('B', tb)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !(useStore.getState().decks.A.beatGrid && useStore.getState().decks.B.beatGrid && !useStore.getState().decks.A.loading && !useStore.getState().decks.B.loading)) await sleep(200)
      ctl.seekDeck('A', aAt)
      ctl.play('A')
      await sleep(400)
    }
    await reset(10)
    ctl.saveMixEntryHotCue('B', 30, 'Mix in')
    const idx = useStore.getState().decks.B.hotCues.find((c) => c.kind === 'mixEntry')?.index
    if (idx == null) return { error: 'no mix-in pad saved' }
    const side = ctl.deckHandoffSide('A')
    const clickA = useStore.getState().decks.A.positionSec
    ctl.pressHotCue('B', idx)
    const t = useStore.getState().activeTransition
    const { TRANSITION_CROSSFADE_SEC } = await window.mod('/src/core/constants.ts')
    const expected = core.nextPhraseStartSec(side.grid, side.timeline, side.durationSec, clickA).sec
    const padResult = { clickA, expected, waitingUntilSec: t?.waitingUntilSec ?? null, onPhrase: t?.onPhrase }
    // The crossfader moved by hand during the phrase wait: the cancel notice names the phrase wait, not an "excellent mix".
    ctl.setCrossfader(-1)
    await sleep(100)
    padResult.cancelNotice = useStore.getState().notice?.text
    padResult.cancelled = !useStore.getState().activeTransition

    await reset(94) // a 100 s song: no phrase start with 4 bars of A after it
    const clickEnd = useStore.getState().decks.A.positionSec
    ctl.startAutoTransitionOnPhrase('A', 'B', 30)
    const te = useStore.getState().activeTransition
    const endResult = { clickEnd, waitingUntilSec: te?.waitingUntilSec ?? null, notice: useStore.getState().notice?.text, nextBar: core.nextPhraseStartSec(side.grid, side.timeline, side.durationSec, clickEnd) }
    let bIn = null
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && bIn == null) { if (useStore.getState().decks.B.playing) bIn = useStore.getState().decks.A.positionSec; await sleep(20) }
    endResult.bIn = bIn
    ctl.cancelTransition()
    return { padResult, endResult }
  })
  const barA = (60 / setup.gridA.bpm) * 4
  const p = pad.padResult
  ok("v0.12.13: a Mix-in pad waits for the same join as the panel — A's next phrase start", !pad.error && p.onPhrase === true && Math.abs(p.waitingUntilSec - p.expected) < 0.05, JSON.stringify(pad.error ?? p))
  ok('v0.9.17: moving the crossfader during the phrase wait cancels it and says so in Hebrew — not "excellent mix"', !pad.error && p.cancelled && /תחילת הקטע/.test(p.cancelNotice ?? '') && !/Excellent/.test(p.cancelNotice ?? ''), p?.cancelNotice)
  const e = pad.endResult
  ok("v0.9.17: in A's last bars, with no phrase start left, B comes in on the next bar and the notice says why", !pad.error && e && e.nextBar.by === 'end' && e.bIn != null && e.bIn - e.clickEnd < barA + 0.3 && /אין עוד תחילת קטע/.test(e.notice ?? ''), JSON.stringify(e))
}

// A sings to its very end. The energy point is offered (never hidden) and says it runs over A's voice; the notice on the click says the same.
if (!setup.error) {
  const over = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    ctl.cancelTransition()
    const s = useStore.getState()
    const a = s.decks.A.track
    const before = s.vocalManual[a.contentHash]
    s.setVocalManual(a.contentHash, { ...before, regions: [{ fromSec: 8, toSec: 100 }], updatedAt: Date.now() })
    ctl.seekDeck('A', 12)
    if (!useStore.getState().decks.A.playing) ctl.play('A')
    await sleep(1500)
    const join = ctl.deckPhraseJoin('A', useStore.getState().decks.A.positionSec)
    const lines = [...document.querySelectorAll('[data-testid="phrase-join"]')].map((e) => e.parentElement?.innerText ?? '')
    ctl.startAutoTransitionOnPhrase('A', 'B', 30)
    const notice = useStore.getState().notice?.text
    ctl.cancelTransition()
    useStore.getState().setVocalManual(a.contentHash, before)
    return { join, line: lines[0] ?? '', notice }
  })
  ok('v0.12.13: A sings to its end — the energy point is offered, and both its line and its notice say it runs over the voice',
    over.join?.aVoiceSec != null && /על השירה שלו/.test(over.line) && /שר ב-/.test(over.line) && /על השירה שלו/.test(over.notice ?? ''),
    JSON.stringify({ aVoiceSec: over.join?.aVoiceSec, line: over.line.replace(/\n/g, ' | '), notice: over.notice }))
}

// v0.12.13: an excellent pair mixes at its saved exit second, singing or not (v0.9.63 moved it off A's voice; the owner dropped that, 19/10).
if (!setup.error) {
  const pair = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const run = async (regions) => {
      ctl.cancelTransition(); ctl.pause('A'); ctl.pause('B')
      const s = useStore.getState()
      const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
      const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
      await ctl.loadTrackToDeck('A', ta)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !(useStore.getState().decks.A.beatGrid && !useStore.getState().decks.A.loading)) await sleep(200)
      const hash = useStore.getState().decks.A.track.contentHash
      const before = useStore.getState().vocalManual[hash]
      if (regions) useStore.getState().setVocalManual(hash, { ...before, regions, updatedAt: Date.now() })
      ctl.seekDeck('A', 5); ctl.play('A')
      await sleep(300)
      await ctl.startExcellentPairTransition('A', hash, tb, tb.contentHash, 2, 12)
      const t = useStore.getState().activeTransition
      const out = { waitingUntilSec: t?.waitingUntilSec ?? null, notice: useStore.getState().notice?.text ?? '' }
      ctl.cancelTransition()
      if (regions) useStore.getState().setVocalManual(hash, before)
      return out
    }
    return { moved: await run(null), over: await run([{ fromSec: 8, toSec: 100 }]) }
  })
  ok("v0.12.13: an excellent pair saved at 0:12, inside A's singing, mixes where it was saved — no move off the voice",
    pair.moved.waitingUntilSec != null && Math.abs(pair.moved.waitingUntilSec - 12) < 0.05 && Math.abs(pair.over.waitingUntilSec - 12) < 0.05,
    JSON.stringify(pair))
}

// v0.9.18: a plain transition (energy point) mixes with the EQ too, inside its same 8 seconds — once with the instant swap, once gradual.
if (!setup.error) {
  for (const style of ['instant', 'gradual']) {
    const plain = await page.evaluate(async (style) => {
      const { useStore } = await window.mod('/src/app/state/store.ts')
      const ctl = await window.mod('/src/controls.ts')
      const { settings } = await window.mod('/src/platform/settings-idb/store.ts')
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      await settings.set('bassSwap', style)
      const s = useStore.getState()
      const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
      const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
      ctl.cancelTransition(); ctl.pause('A'); ctl.pause('B')
      await ctl.loadTrackToDeck('A', ta)
      await ctl.loadTrackToDeck('B', tb)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !(useStore.getState().decks.A.beatGrid && useStore.getState().decks.B.beatGrid && !useStore.getState().decks.A.loading && !useStore.getState().decks.B.loading)) await sleep(200)
      // Knobs flat first: the run above left B's MID where "his hand" put it (0.2), and that is his to keep — this run starts from flat.
      for (const d of ['A', 'B']) for (const band of ['low', 'mid', 'high']) ctl.setEq(d, band, 0)
      ctl.seekDeck('A', 40); ctl.play('A')
      await sleep(300)
      ctl.startAutoTransition('A', 'B', 2)
      const samples = []
      const end = Date.now() + 20000
      while (Date.now() < end) {
        const st = useStore.getState(), ch = st.mixer.channels
        samples.push({ a: st.decks.A.positionSec, bPlaying: st.decks.B.playing, active: !!st.activeTransition, x: st.mixer.crossfader, aLow: ch.A.eqLow, bLow: ch.B.eqLow, aHigh: ch.A.eqHigh, bMid: ch.B.eqMid, cd: document.querySelector('[data-testid="mix-countdown"]')?.textContent ?? null, t: performance.now() })
        if (!st.activeTransition && samples.length > 5) break
        await sleep(20)
      }
      const ch = useStore.getState().mixer.channels
      await settings.set('bassSwap', 'instant')
      return { samples, final: [ch.A.eqLow, ch.A.eqMid, ch.A.eqHigh, ch.B.eqLow, ch.B.eqMid, ch.B.eqHigh], bPlaying: useStore.getState().decks.B.playing }
    }, style)
    const live = plain.samples.filter((s) => s.active && s.bPlaying)
    const amp = (k) => 10 ** ((k * 70) / 20)
    const both = live.filter((s) => s.aLow > -1 && s.bLow > -1)
    const maxPower = Math.max(...live.map((s) => amp(s.aLow) ** 2 + amp(s.bLow) ** 2))
    const firstB = live[0]
    ok(`v0.9.18: plain transition, ${style} swap — B enters with LOW killed and MID cut`, !!firstB && firstB.bLow === -1 && Math.abs(firstB.bMid + 0.4) < 0.01, JSON.stringify(firstB))
    ok(style === 'instant' ? 'v0.9.18: plain, instant — never both LOWs open' : 'v0.9.18: plain, gradual — both LOWs open only for a while, their power never above one bass',
      style === 'instant' ? both.length === 0 : both.length > 0 && both.length < live.length / 2 && maxPower <= 1.01,
      `${live.length} samples, ${both.length} with both open, max summed power ${maxPower.toFixed(3)}`)
    if (style === 'instant') {
      // v0.9.33: the red button counts down to the end (whole seconds, never up), and the plain mix lasts 5 s, not 8.
      const secs = plain.samples.filter((s) => s.cd).map((s) => ({ n: Number(/(\d+) שנ/.exec(s.cd)?.[1]), t: s.t }))
      const first = plain.samples.find((s) => s.active && s.bPlaying), last = plain.samples.filter((s) => s.active).pop()
      ok('v0.9.33: the cancel button shows a countdown that only goes down', secs.length > 20 && secs.every((x, i) => i === 0 || x.n <= secs[i - 1].n) && secs[0].n <= 5 && secs[0].n >= 4, `${secs.length} readings, from ${secs[0]?.n} to ${secs.at(-1)?.n}; texts: ${[...new Set(plain.samples.map((s) => s.cd))].join(' | ')}`)
      ok('v0.9.33: a plain mix lasts about 5 seconds', !!first && !!last && (last.t - first.t) / 1000 > 3.5 && (last.t - first.t) / 1000 < 6.5, `${(((last?.t ?? 0) - (first?.t ?? 0)) / 1000).toFixed(2)} s from B's start to the end`)
      // The swap counts whole bars from the join; it must fall in the frame that crosses one of A's yellow lines, not tens of ms after it.
      const i = plain.samples.findIndex((s) => s.active && s.aLow === -1)
      const bar = (60 / setup.gridA.bpm) * 4
      const lineOf = (sec) => setup.gridA.offsetSec + Math.floor((sec - setup.gridA.offsetSec) / bar + 1e-9) * bar
      const line = i > 0 ? lineOf(plain.samples[i].a) : NaN
      ok('v0.9.18: plain, instant — A\'s bass shuts on one of A\'s yellow lines', i > 0 && plain.samples[i - 1].a < line && plain.samples[i].a - line < 0.06,
        i > 0 ? `before ${plain.samples[i - 1].a.toFixed(3)} (low ${plain.samples[i - 1].aLow}), after ${plain.samples[i].a.toFixed(3)}, line ${line.toFixed(3)}` : 'never shut')
    }
    ok(`v0.9.18: plain, ${style} — finishes on B with every knob back`, plain.bPlaying && plain.final.every((v) => v === 0), JSON.stringify(plain.final))
  }
}

// The owner, 06/10: a point Mix Assist leaves out is not counted on screen. With B's only voice this close to its end every handoff is too
// late, so the section has no row, and its note says the song's end is why — no "N not shown".
if (!setup.error) {
  const lateNote = await page.evaluate(async () => {
    const { useStore } = await window.mod('/src/app/state/store.ts')
    const ctl = await window.mod('/src/controls.ts')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const s = useStore.getState()
    const ta = s.library.tracks.find((t) => t.name.startsWith('Handoff A'))
    const tb = s.library.tracks.find((t) => t.name.startsWith('Handoff B'))
    ctl.cancelTransition(); ctl.pause('A'); ctl.pause('B')
    await ctl.loadTrackToDeck('A', ta)
    await ctl.loadTrackToDeck('B', tb)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !(useStore.getState().decks.A.beatGrid && useStore.getState().decks.B.beatGrid && !useStore.getState().decks.A.loading && !useStore.getState().decks.B.loading)) await sleep(200)
    const t = useStore.getState().decks.B.track
    useStore.getState().setVocalManual(t.contentHash, { schema: 1, contentHash: t.contentHash, trackId: t.id, name: t.name, genre: 'House', finished: true, updatedAt: Date.now(), regions: [{ fromSec: 70, toSec: 90 }] })
    ctl.seekDeck('A', 6); ctl.play('A')
    await sleep(1500)
    const panel = [...document.querySelectorAll('div')].find((d) => d.firstElementChild?.textContent === 'מסירת שירה — לפי הצליל')
    return { note: document.querySelector('[data-testid="handoff-note"]')?.textContent ?? null, rows: document.querySelectorAll('[data-testid="handoff-rows"] button').length, panel: panel?.innerText ?? '' }
  })
  ok('v0.9.29: every handoff too late — no row, and the note blames the song\'s end', lateNote.rows === 0 && lateNote.note === 'מסירת שירה: אין בשיר הזה נקודה שנשאר אחריה מספיק שיר', JSON.stringify({ rows: lateNote.rows, note: lateNote.note }))
  ok('v0.9.29: nothing in the panel counts points it left out', !/לא מוצג|מאוחרות יותר/.test(lateNote.panel), lateNote.panel.split('\n').filter((l) => /לא מוצג|מאוחרות/.test(l)).join(' | '))
  await page.evaluate(async () => { const ctl = await window.mod('/src/controls.ts'); ctl.pause('A') })
}

// Since v0.9.33 the EQ is an isolator (core/isolator.ts): the MID knob is the volume of the 250 Hz–3 kHz band, nothing else.
const resp = await page.evaluate(async () => {
  const { isolatorResponseDb, bandGain } = await window.mod('/src/core/isolator.ts')
  const mid = bandGain(-0.4, 26, 70)
  return [100, 200, 500, 1000, 2000, 4000, 8000].map((h) => `${h} Hz ${isolatorResponseDb(h, 44100, { low: 1, mid, high: 1 }).toFixed(1)} dB`)
})
console.log(`INFO  the MID cut at -0.4 (deck.ts: isolator, 250 Hz–3 kHz band): ${resp.join(' · ')}`)

const f = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight }))
ok('page still fits 710 px', f.scroll <= f.inner, `scrollHeight ${f.scroll} / ${f.inner}`)
ok('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

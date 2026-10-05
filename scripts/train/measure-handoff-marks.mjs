/**
 * Mix Assist by sound (v0.9.15): on the owner's own hand marks, how often is a clean vocal handoff there to take, how long does it make him
 * wait, and is it really clean? Runs the SHIPPED planner (core/vocal-handoff.ts) on every ordered pair of his finished Techno/House songs.
 *   node --import ./scripts/train/alias-register.mjs scripts/train/measure-handoff-marks.mjs <deckmix-vocal-marks-….json> <grids.tsv>
 * grids.tsv: hash-prefix(16) TAB duration-sec TAB bpm TAB a-bar-one-sec — durations by ffprobe on his files, BPM and bar one from his own
 * tagging exports (deckmix-tags-*.json); built on his machine, read only.
 *
 * For each pair, A is "clicked" every 15 s from 40% to 80% of A (where a DJ mixes out). Reported:
 *  - found: a plan exists (or B has no voice at all, which can never clash);
 *  - wait: from the click to the handoff, median and 90th percentile;
 *  - clean: every plan re-checked by an independent scan (not voiceRuns) of his marks with his 2 s rule — both decks audible from the join
 *    until A is out, never a voice over a voice. Must be 100%;
 *  - today: the plain transition (B from its first yellow line, next bar, 8 s fade) — how often it puts a voice over a voice. B's own intro
 *    is the kindest entry for it; the energy points would usually be later in B and clash more. Counted with the panel's own half-bar
 *    margin (plainTransitionClashSec).
 * 05/10, his 71 songs: found 89.0 / 91.7 / 84.5 / 96.1% (T→T, H→H, T→H, H→T), clean 100% of plans, wait median 0:18–0:19; today's
 * transition voice over voice 23.3 / 4.3 / 4.6 / 21.3% (22.6 / 4.3 / 4.6 / 21.0% before the margin).
 */
import fs from 'node:fs'
import { effectiveTimeline } from '../../src/core/sound/vocal-manual.ts'
import { CELL_NONE, VOCAL_CELL_SEC } from '../../src/core/sound/vocal-timeline.ts'
import { bVoiceStarts, planHandoff, plainTransitionClashSec } from '../../src/core/vocal-handoff.ts'

const [marksPath, gridsPath] = process.argv.slice(2)
const marks = JSON.parse(fs.readFileSync(marksPath, 'utf8')).marks
const grids = new Map(
  fs.readFileSync(gridsPath, 'utf8').trim().split('\n').map((l) => {
    const [h, d, bpm, one] = l.split('\t')
    return [h, { durationSec: +d, bpm: +bpm, one: +one }]
  }),
)
const songs = []
for (const m of marks) {
  if (!m.finished || !['Techno', 'House'].includes(m.genre)) continue
  const g = grids.get(m.contentHash.slice(0, 16))
  if (!g || !g.durationSec || !g.bpm) {
    console.log(`skipped (no duration or BPM): ${m.name}`)
    continue
  }
  const bar = (60 / g.bpm) * 4
  const timeline = effectiveTimeline(null, m, g.durationSec)
  songs.push({ name: m.name, genre: m.genre, side: { timeline, grid: { bpm: g.bpm, offsetSec: ((g.one % bar) + bar) % bar }, durationSec: g.durationSec } })
}

/** His rule, written out again on purpose: voice, or a gap of 2 s or less between two voices. */
function voicedCells(t) {
  const c = Array.from(t.cells, (v) => v !== CELL_NONE)
  let i = 0
  while (i < c.length) {
    if (c[i]) { i++; continue }
    let j = i
    while (j < c.length && !c[j]) j++
    if (i > 0 && j < c.length && (j - i) * VOCAL_CELL_SEC <= 2) c.fill(true, i, j)
    i = j
  }
  return c
}
for (const s of songs) s.voiced = voicedCells(s.side.timeline)
const voicedAt = (s, sec) => !!s.voiced[Math.floor(sec / VOCAL_CELL_SEC)]

const pct = (a, n) => (n ? ((100 * a) / n).toFixed(1) + '%' : '-')
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`

for (const pair of [['Techno', 'Techno'], ['House', 'House'], ['Techno', 'House'], ['House', 'Techno']]) {
  let clicks = 0, found = 0, clean = 0, plans = 0, onEnd = 0, todayClash = 0, todayN = 0
  const waits = []
  const runways = []
  const noPlanA = new Map()
  for (const a of songs.filter((s) => s.genre === pair[0])) {
    for (const b of songs.filter((s) => s.genre === pair[1] && s !== a)) {
      const starts = bVoiceStarts(b.side)
      const bSilent = !b.voiced.some(Boolean)
      for (let pos = 0.4 * a.side.durationSec; pos <= 0.8 * a.side.durationSec; pos += 15) {
        clicks++
        todayN++
        if (plainTransitionClashSec(a.side, pos, b.side, b.side.grid.offsetSec, 8) != null) todayClash++
        if (bSilent) { found++; continue }
        let best = null
        for (const v of starts) {
          const p = planHandoff(a.side, pos, b.side, v)
          if (p && (!best || p.handoffSec < best.handoffSec)) best = p
        }
        if (!best) { noPlanA.set(a.name, (noPlanA.get(a.name) ?? 0) + 1); continue }
        found++
        plans++
        if (best.onVoiceEnd) onEnd++
        waits.push(best.handoffSec - pos)
        runways.push(best.runwayBars)
        const ratio = a.side.grid.bpm / b.side.grid.bpm
        let ok = true
        for (let t = best.joinSec; t < best.fadeEndSec; t += 0.05) {
          if (voicedAt(a, t) && voicedAt(b, best.entrySec + (t - best.joinSec) * ratio)) { ok = false; break }
        }
        if (ok) clean++
      }
    }
  }
  console.log(`\n${pair[0]} -> ${pair[1]}: ${clicks} clicks`)
  console.log(`  handoff found: ${pct(found, clicks)} | clean (independent check): ${clean}/${plans} | on A's voice end: ${pct(onEnd, plans)}`)
  console.log(`  wait click->handoff: median ${mmss(q(waits, 0.5))}, 90% ${mmss(q(waits, 0.9))} | runway bars median ${q(runways, 0.5)}`)
  console.log(`  today's plain transition (B from its start, 8 s): voice over voice ${pct(todayClash, todayN)}`)
  const worst = [...noPlanA.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
  if (worst.length) console.log(`  most "no plan" as A: ${worst.map(([n, c]) => `${n.slice(0, 40)} (${c})`).join('; ')}`)
}

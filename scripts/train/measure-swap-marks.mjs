/**
 * The vocal swap (core/vocal-swap-mix.ts): on the owner's own hand marks, how often is it there to take, how long is it, and is it clean?
 * Runs the SHIPPED planner on every ordered pair of his finished Techno/House songs — the same harness as measure-handoff-marks.mjs.
 *   node --import ./scripts/train/alias-register.mjs scripts/train/measure-swap-marks.mjs <deckmix-vocal-marks-….json> <grids.tsv>
 * grids.tsv: hash-prefix(16) TAB duration-sec TAB bpm TAB grid-offset-sec. Built from his tagging exports (deckmix-tags-*.json, the grid he
 * was shown); the duration is the end of his last mark — a finished song is marked to its end, so this is at most a hair short.
 *
 * Reported per genre pair, A "clicked" every 15 s from 40% to 80% of A:
 *  - found: a plan exists;
 *  - seconds: join to end, min / median / max — the owner asked for 5–10;
 *  - clean, by an independent scan of his marks with his 2 s rule (not voiceRuns): A never sings from the join to the end, and B sings
 *    through its two bars alone — at least 90% of them, and at least 50%. A is checked strictly; B's share depends on where his marks
 *    sit: since 04/10 a mark snaps to the yellow line before it, but many earlier (mostly Techno) marks sit mid-bar on this grid, and B
 *    then starts on the line before the voice, so part of its first bar alone is still quiet;
 *  - per song as B: how many of his songs offer at least one entry, and why the rest do not.
 * 05/10, his export of that day: 72 songs used (41 Techno, 31 House). As B: 59/72 offer an entry (6 no voice, 5 only early, 4 only late).
 * Found 75.2 / 82.5 / 75.2 / 82.6% (T→T, H→H, T→H, H→T); 7.0–8.4 s; A quiet 100%; B sings ≥90% of its two bars: 65.7 / 100 / 100 / 65.6%,
 * ≥50%: 100% everywhere. Before the half-second-cell fix in swapEntries the ≥90% figure was 6–17%.
 */
import fs from 'node:fs'
import { effectiveTimeline } from '../../src/core/sound/vocal-manual.ts'
import { CELL_NONE, VOCAL_CELL_SEC } from '../../src/core/sound/vocal-timeline.ts'
import { planVocalSwap, swapEntries } from '../../src/core/vocal-swap-mix.ts'

const [marksPath, gridsPath] = process.argv.slice(2)
const marks = JSON.parse(fs.readFileSync(marksPath, 'utf8')).marks
const grids = new Map(
  fs.readFileSync(gridsPath, 'utf8').trim().split('\n').map((l) => {
    const [h, d, bpm, off] = l.split('\t')
    return [h, { durationSec: +d, bpm: +bpm, offsetSec: +off }]
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
  const timeline = effectiveTimeline(null, m, g.durationSec)
  songs.push({ name: m.name, genre: m.genre, side: { timeline, grid: { bpm: g.bpm, offsetSec: g.offsetSec }, durationSec: g.durationSec } })
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

console.log(`songs: ${songs.length} (${songs.filter((s) => s.genre === 'Techno').length} Techno, ${songs.filter((s) => s.genre === 'House').length} House)`)
let withEntry = 0
const why = { short: 0, early: 0, late: 0, none: 0 }
for (const s of songs) {
  const r = swapEntries(s.side)
  if (r.entries.length) withEntry++
  else if (!s.voiced.some(Boolean)) why.none++
  else { why.short += r.short ? 1 : 0; why.early += r.early ? 1 : 0; why.late += r.late ? 1 : 0 }
}
console.log(`as B: ${withEntry}/${songs.length} offer at least one entry; the rest — no voice at all ${why.none}, only short ${why.short}, only early ${why.early}, only late ${why.late}`)

for (const pair of [['Techno', 'Techno'], ['House', 'House'], ['Techno', 'House'], ['House', 'Techno']]) {
  let clicks = 0, found = 0, clean = 0, half = 0
  const secs = [], waits = []
  for (const a of songs.filter((s) => s.genre === pair[0])) {
    for (const b of songs.filter((s) => s.genre === pair[1] && s !== a)) {
      const { entries } = swapEntries(b.side)
      if (!entries.length) continue
      for (let pos = 0.4 * a.side.durationSec; pos <= 0.8 * a.side.durationSec; pos += 15) {
        clicks++
        let best = null
        for (const e of entries) {
          const p = planVocalSwap(a.side, pos, b.side, e)
          if (p && (!best || p.joinSec < best.joinSec)) best = p
        }
        if (!best) continue
        found++
        secs.push(best.endSec - best.joinSec)
        waits.push(best.joinSec - pos)
        const ratio = a.side.grid.bpm / b.side.grid.bpm
        let aQuiet = true
        for (let t = best.joinSec; t < best.endSec; t += 0.05) if (voicedAt(a, t)) { aQuiet = false; break }
        let sung = 0, n = 0
        for (let t = best.voiceSec; t < best.swapSec; t += 0.05, n++) if (voicedAt(b, best.bVoiceSec + (t - best.voiceSec) * ratio)) sung++
        if (aQuiet && sung / n >= 0.9) clean++
        if (aQuiet && sung / n >= 0.5) half++
      }
    }
  }
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`
  console.log(`\n${pair[0]} -> ${pair[1]}: ${clicks} clicks (B with an entry)`)
  console.log(`  swap found: ${pct(found, clicks)} | A quiet and B sings ≥90% of its two bars: ${pct(clean, found)} | ≥50%: ${pct(half, found)}`)
  console.log(`  seconds join->end: min ${Math.min(...secs).toFixed(1)}, median ${q(secs, 0.5).toFixed(1)}, max ${Math.max(...secs).toFixed(1)} | wait click->join median ${mmss(q(waits, 0.5))}, 90% ${mmss(q(waits, 0.9))}`)
}
